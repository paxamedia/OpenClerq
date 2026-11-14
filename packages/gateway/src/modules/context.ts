/**
 * The context a plugin's (or legacy module's) hooks receive.
 *
 * Everything here is scoped by the module's id: its tables, its secrets, its
 * audit entries. It is a namespace, not a sandbox: module code runs in the
 * gateway process with the gateway's access. What goes through the context
 * (secrets, services, `exec`, `fetch`, `fs`) is checked against the declared
 * permissions by the plugin's guard, when the person has turned enforcement on.
 *
 * It also keeps track of what the plugin set up through it (routes, triggers,
 * event subscriptions, search and inbox handlers, timers, commands it started)
 * so `dispose()` can take all of it away, and refuses new registrations after.
 */

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { audit, clerqHome } from '@clerq/store';
import type {
  PluginContext,
  PluginPermissions,
  PluginTimer,
  ModuleRequest,
  ModuleResponse,
  RouteHandler,
} from '@clerq/plugin-sdk';
import { tablePrefix } from '@clerq/plugin-sdk';
import { getStore } from '../store.js';
import { logger } from '../logger.js';
import { getSecret, setSecret, deleteSecret, listSecrets } from '../secrets-vault.js';
import { requestApproval, waitForDecision } from '../approvals.js';
import { createRun, currentRunId, finishRun } from '../runs.js';
import { emit, subscribeEvents } from '../events.js';
import type { LoadedModule, ModuleRouteHandler } from '../module-loader.js';
import type { ModuleTriggers } from './triggers.js';
import { createNotify } from './notify.js';
import { ModuleServices, servicesOf } from './services.js';
import type { PluginGuard } from './plugin-guard.js';
import { createIo } from './plugin-io.js';
import * as records from '../records/records.js';
import { currentTenant, runInTenant } from '../tenant.js';
import { tenantTable } from './tenant-table.js';
import { registerSearch, unregisterSearch } from './search.js';
import * as inbox from '../inbox/inbox.js';

/** Gateway services a context is built over. */
export interface ContextDeps {
  triggers: ModuleTriggers;
  /** Checks what goes through `ctx.secrets`, `ctx.services`, `ctx.exec`, `ctx.fetch` and `ctx.fs`. */
  guard: PluginGuard;
  /** What the manifest declares, in full; `ctx.permissions`. */
  declared: PluginPermissions;
  /** For tests: the `fetch` behind `ctx.fetch`. */
  fetchImpl?: typeof fetch;
}

/** What the host keeps per module beside the context it hands out. */
export interface ContextHandle {
  ctx: PluginContext & { push(route: ModuleRouteHandler): void };
  router: Router;
  services: ModuleServices;
  /**
   * Undo what the module set up through its context: subscriptions, handlers,
   * triggers, timers, commands still running. After it the context refuses new
   * registrations, so a task that outlives the plugin cannot add more.
   */
  dispose(): void;
}

const TABLE_NAME = /^[a-z0-9_]+$/;

function checkTable(name: string): string {
  if (!TABLE_NAME.test(name)) throw new Error(`Invalid table name "${name}".`);
  return name;
}
const EVENT_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

/** `~/.clerq/modules/<id>.json` over the manifest's `config` defaults. */
function loadConfig(mod: LoadedModule): Record<string, unknown> {
  const defaults =
    mod.manifest.config && typeof mod.manifest.config === 'object' ? mod.manifest.config : {};
  const file = path.join(clerqHome(), 'modules', `${mod.id}.json`);
  let overrides: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    logger.warn('Module config file is not valid JSON; using defaults', {
      moduleId: mod.id,
      file,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return Object.freeze({ ...defaults, ...overrides });
}

/** A handler error answers 500 in the gateway's error shape, not an HTML page. */
function wrap(moduleId: string, handler: RouteHandler) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req as unknown as ModuleRequest, res as unknown as ModuleResponse);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('Module route failed', { moduleId, path: req.path, err: message });
      if (!res.headersSent) res.status(500).json({ error: 'module_error', message });
      else if (!res.writableEnded) res.end();
    }
  };
}

export function createModuleContext(mod: LoadedModule, deps: ContextDeps): ContextHandle {
  const id = mod.id;
  const router = express.Router();
  const prefix = tablePrefix(id);
  const secretName = (name: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid secret name "${name}". Use alphanumeric, underscore, hyphen.`);
    }
    return `${id}/${name}`;
  };
  const log =
    (level: 'info' | 'warn' | 'error') => (message: string, meta?: Record<string, unknown>) =>
      logger[level](message, { moduleId: id, ...meta });

  const services = new ModuleServices(id, servicesOf(mod.manifest));
  const actor = `module:${id}`;
  const subscriptions = new Set<() => void>();
  const timers = new Set<NodeJS.Timeout>();
  const lifecycle = new AbortController();
  const { guard } = deps;
  const assertLive = () => {
    if (lifecycle.signal.aborted) {
      throw new Error(`The plugin "${id}" is stopped; it can no longer set anything up.`);
    }
  };
  const route =
    (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (p: string, handler: RouteHandler) => {
      assertLive();
      router[method](p.startsWith('/') ? p : `/${p}`, wrap(id, handler));
    };
  const io = createIo({
    id,
    guard,
    signal: lifecycle.signal,
    assertLive,
    fetchImpl: deps.fetchImpl,
  });
  const timer =
    (kind: 'interval' | 'timeout') =>
    (fn: () => unknown, ms: number): PluginTimer => {
      assertLive();
      if (typeof fn !== 'function') throw new Error('A timer needs a function to call.');
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1) {
        throw new Error('A timer needs a number of milliseconds, 1 or more.');
      }
      let busy = false;
      const failed = (e: unknown) =>
        logger.error('Plugin timer failed', {
          moduleId: id,
          err: e instanceof Error ? e.message : String(e),
        });
      const fire = () => {
        // Like a trigger: a call still going when the next is due is skipped, not queued.
        if (busy || lifecycle.signal.aborted) return;
        busy = true;
        try {
          const out = fn() as PromiseLike<unknown> | undefined;
          if (out && typeof out.then === 'function') {
            out.then(undefined, failed).then(() => (busy = false));
          } else {
            busy = false;
          }
        } catch (e) {
          busy = false;
          failed(e);
        }
      };
      const handle: NodeJS.Timeout =
        kind === 'interval'
          ? setInterval(fire, ms)
          : setTimeout(() => {
              timers.delete(handle);
              fire();
            }, ms);
      handle.unref();
      timers.add(handle);
      return {
        clear() {
          if (kind === 'interval') clearInterval(handle);
          else clearTimeout(handle);
          timers.delete(handle);
        },
      };
    };

  const ctx: ContextHandle['ctx'] = {
    id,
    // A plugin sees the staged copy: the files that were hashed and approved, and no others.
    dir: mod.kind === 'plugin' ? (mod.stageDir ?? mod.dir) : mod.dir,
    version: String(mod.manifest.version ?? '0.0.0'),
    config: loadConfig(mod),
    permissions: Object.freeze(deps.declared),
    get tenant() {
      return currentTenant();
    },
    withTenant: (tenantId, fn) => runInTenant(tenantId, fn),
    routes: {
      get: route('get'),
      post: route('post'),
      put: route('put'),
      patch: route('patch'),
      delete: route('delete'),
    },
    store: {
      table: (name) => `${prefix}${checkTable(name)}`,
      rows: (name) => tenantTable(`${prefix}${checkTable(name)}`),
      // The text of a statement is checked: a plugin's SQL may name only its own tables.
      prepare(sql) {
        guard.sql(sql);
        return getStore().prepare(sql);
      },
      exec(sql) {
        guard.sql(sql);
        getStore().exec(sql);
      },
      transaction: (fn) => getStore().transaction(fn),
    },
    secrets: {
      get(name) {
        const full = secretName(name);
        guard.secret(name, 'read');
        return getSecret(full);
      },
      set(name, value) {
        const full = secretName(name);
        guard.secret(name, 'write');
        const out = setSecret(full, value);
        if (!out.ok) throw new Error(out.error ?? 'Could not store the secret.');
      },
      delete(name) {
        const full = secretName(name);
        guard.secret(name, 'delete');
        const out = deleteSecret(full);
        if (!out.ok) throw new Error(out.error ?? 'Could not delete the secret.');
      },
      list() {
        const all = listSecrets();
        if (!Array.isArray(all)) throw new Error(all.error);
        return guard.visibleSecrets(
          all.filter((n) => n.startsWith(`${id}/`)).map((n) => n.slice(id.length + 1))
        );
      },
    },
    events: {
      emit(name, payload, context) {
        if (!EVENT_NAME.test(name)) {
          throw new Error(`Invalid event name "${name}". Use a-z, 0-9, ".", "_" and "-".`);
        }
        return emit(`module.${id}.${name}`, payload, { runId: context?.runId ?? currentRunId() });
      },
      subscribe(prefix, fn) {
        assertLive();
        const off = subscribeEvents((e) => {
          if (prefix === '*' || e.name.startsWith(prefix)) fn(e);
        });
        subscriptions.add(off);
        return () => {
          subscriptions.delete(off);
          off();
        };
      },
    },
    triggers: {
      register(def) {
        assertLive();
        deps.triggers.register(id, def);
      },
    },
    notify: createNotify(id),
    services: {
      list: () => guard.visibleServices(services.list()),
      status(label) {
        guard.service(label);
        return services.status(label);
      },
      start(label) {
        guard.service(label);
        return services.start(label, `module:${id}`);
      },
      stop(label) {
        guard.service(label);
        return services.stop(label, `module:${id}`);
      },
    },
    records: {
      ref(type, recordId) {
        if (!/^[a-z][a-z0-9_-]*$/.test(type)) throw new Error(`Invalid record type "${type}".`);
        return `${id}:${type}:${recordId}`;
      },
      resolve: (type, input) =>
        records.resolveRecord({
          type,
          name: input.name,
          data: input.data,
          identities: input,
          create: input.create,
          actor,
        }),
      get: (recordId) => records.getRecord(recordId),
      list: (opts) => records.listRecords(opts),
      update: (recordId, patch) => records.updateRecord(recordId, patch, actor),
      link: (from, to, kind) => records.link(from, to, kind, actor),
      unlink: (from, to, kind) => records.unlink(from, to, kind, actor),
      links: (ref) => records.linksOf(ref),
      addActivity: (input) => records.addActivity({ ...input, actor }),
      activities: (ref, limit) => records.activitiesOf(ref, limit),
    },
    search: {
      register(handler) {
        assertLive();
        registerSearch(id, handler);
      },
    },
    inbox: {
      add: (item) => inbox.addItem(id, item),
      resolve(key, status = 'done') {
        const item = inbox.findExternal(id, key) ?? inbox.getItem(key);
        if (!item || item.moduleId !== id) throw new Error(`No inbox item ${key} in ${id}.`);
        return inbox.setStatus(item.id, status, actor);
      },
      onRespond(handler) {
        assertLive();
        inbox.onRespond(id, handler);
      },
    },
    approvals: {
      async request(input) {
        // An approval belongs to a run. Outside one, the request gets a run of
        // its own, closed when someone decides.
        let runId = input.runId ?? currentRunId();
        const ownRun = !runId;
        if (!runId) {
          runId = createRun({
            trigger: 'manual',
            moduleId: id,
            input: `${id}: ${input.action}`,
            status: 'awaiting_approval',
          });
        }
        const req = requestApproval({
          runId,
          tool: `${id}.${input.action}`,
          tier: input.tier ?? 'medium',
          reason: input.reason,
          arguments: input.details,
        });
        if (ownRun) {
          const off = subscribeEvents((e) => {
            const p = e.payload as { id?: number; decision?: string; reason?: string };
            if (e.name !== 'approval.decided' || p.id !== req.id) return;
            off();
            finishRun(runId, p.decision === 'approved' ? 'done' : 'cancelled', p.reason);
          });
        }
        return { id: req.id };
      },
      wait: (approvalId, timeoutMs) => waitForDecision(approvalId, timeoutMs),
    },
    audit: {
      append(action, subject, detail) {
        audit(getStore(), {
          actor: `module:${id}`,
          action: `module.${id}.${action}`,
          subject,
          detail,
        });
      },
    },
    logger: {
      debug(message, meta) {
        if (process.env.CLERQ_LOG_DEBUG === '1') logger.info(message, { moduleId: id, ...meta });
      },
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    exec: io.exec,
    fetch: io.fetch,
    fs: io.fs,
    setInterval: timer('interval'),
    setTimeout: timer('timeout'),
    // The pre-0.6 contract: register(out) pushed handlers onto an array.
    push(r: ModuleRouteHandler) {
      const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) return;
      route(method)(r.path, r.handler as unknown as RouteHandler);
    },
  };
  const dispose = () => {
    lifecycle.abort();
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
    for (const off of subscriptions) off();
    subscriptions.clear();
    inbox.offRespond(id);
    unregisterSearch(id);
    deps.triggers.remove(id);
  };
  return { ctx, router, services, dispose };
}
