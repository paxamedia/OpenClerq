/**
 * The ModuleContext a module's `register(ctx)` receives.
 *
 * Everything here is scoped by the module's id: its tables, its secrets, its
 * audit entries. It is a namespace, not a sandbox — module code runs in the
 * gateway process with the gateway's access.
 */

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import { audit, clerqHome } from '@clerq/store';
import type { ModuleContext, ModuleRequest, ModuleResponse, RouteHandler } from '@clerq/module-sdk';
import { tablePrefix } from '@clerq/module-sdk';
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

/** Gateway services a context is built over. */
export interface ContextDeps {
  triggers: ModuleTriggers;
}

/** What the host keeps per module beside the context it hands out. */
export interface ContextHandle {
  ctx: ModuleContext & { push(route: ModuleRouteHandler): void };
  router: Router;
  services: ModuleServices;
}

const TABLE_NAME = /^[a-z0-9_]+$/;
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
  const route =
    (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (p: string, handler: RouteHandler) => {
      router[method](p.startsWith('/') ? p : `/${p}`, wrap(id, handler));
    };
  const log =
    (level: 'info' | 'warn' | 'error') => (message: string, meta?: Record<string, unknown>) =>
      logger[level](message, { moduleId: id, ...meta });

  const services = new ModuleServices(id, servicesOf(mod.manifest));

  const ctx: ContextHandle['ctx'] = {
    id,
    dir: mod.dir,
    version: String(mod.manifest.version ?? '0.0.0'),
    config: loadConfig(mod),
    routes: {
      get: route('get'),
      post: route('post'),
      put: route('put'),
      patch: route('patch'),
      delete: route('delete'),
    },
    store: {
      table(name) {
        if (!TABLE_NAME.test(name)) throw new Error(`Invalid table name "${name}".`);
        return `${prefix}${name}`;
      },
      prepare: (sql) => getStore().prepare(sql),
      exec: (sql) => getStore().exec(sql),
      transaction: (fn) => getStore().transaction(fn),
    },
    secrets: {
      get: (name) => getSecret(secretName(name)),
      set(name, value) {
        const out = setSecret(secretName(name), value);
        if (!out.ok) throw new Error(out.error ?? 'Could not store the secret.');
      },
      delete(name) {
        const out = deleteSecret(secretName(name));
        if (!out.ok) throw new Error(out.error ?? 'Could not delete the secret.');
      },
      list() {
        const all = listSecrets();
        if (!Array.isArray(all)) throw new Error(all.error);
        return all.filter((n) => n.startsWith(`${id}/`)).map((n) => n.slice(id.length + 1));
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
        return subscribeEvents((e) => {
          if (prefix === '*' || e.name.startsWith(prefix)) fn(e);
        });
      },
    },
    triggers: {
      register: (def) => deps.triggers.register(id, def),
    },
    notify: createNotify(id),
    services: {
      list: () => services.list(),
      status: (label) => services.status(label),
      start: (label) => services.start(label, `module:${id}`),
      stop: (label) => services.stop(label, `module:${id}`),
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
    // The pre-0.6 contract: register(out) pushed handlers onto an array.
    push(r: ModuleRouteHandler) {
      const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) return;
      route(method)(r.path, r.handler as unknown as RouteHandler);
    },
  };
  return { ctx, router, services };
}
