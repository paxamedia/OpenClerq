/**
 * Loads modules and plugins, gives each its context, and serves its routes at
 * `/api/modules/<id>`. This is the lifecycle (docs/PLUGINS.md):
 *
 *   found → validated → engine checked → [disabled | awaiting approval] →
 *   staged → imported → migrated → upgrade() → register() → start() → enabled
 *
 *   stop(): disable, the gateway's close(), or enforcement turned on for a
 *   plugin that was never approved. Whatever the plugin set up through its
 *   context is then taken away, and its routes stop answering.
 *
 * A plugin whose hook throws is `failed` with the error and gets no routes; the
 * gateway and the other plugins carry on. A module without `manifestVersion` is a
 * legacy module: it goes through `register` only, as it always did.
 *
 * Routes are served by one handler that looks the plugin up on every request, so
 * a plugin can be stopped and started again without restarting the gateway.
 */

import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type RequestHandler, type Router } from 'express';
import { audit, migrateModule, type Migration } from '@clerq/store';
import type { PluginPermissions } from '@clerq/plugin-sdk';
import { engineProblem, EMPTY_PERMISSIONS } from '@clerq/plugin-sdk/manifest';
import {
  PluginFilesError,
  permissionsHash as hashPermissions,
  pluginChecksumDetail,
} from '@clerq/plugin-sdk/node';
import { getStore } from '../store.js';
import { logger } from '../logger.js';
import { apiErrors } from '../error-handler.js';
import {
  discoverModules,
  discoverOne,
  importEntry,
  type DiscoveredModule,
  type LoadedModule,
  type ModuleKind,
} from '../module-loader.js';
import { createModuleContext, type ContextHandle } from './context.js';
import { ModuleTriggers, TriggerError } from './triggers.js';
import { ServiceError } from './services.js';
import {
  declaredPermissions,
  legacyView,
  parsePermissions,
  recordModule,
  type ModulePermissions,
} from './permissions.js';
import { parseExtensions, type Extensions } from './extensions.js';
import { unregisterSearch } from './search.js';
import { PluginGuard } from './plugin-guard.js';
import { stagePlugin } from './plugin-stage.js';
import {
  createPluginRow,
  enforcing,
  readPluginRow,
  saveApproval,
  setEnforcing,
  updatePluginRow,
  type PluginRow,
  type PluginStateName,
} from './plugin-state.js';
import { emit } from '../events.js';
import { actorOf } from '../records/routes.js';
import { revokeTokens } from '../security/scoped-tokens.js';

export type ModuleStatus = 'loaded' | 'failed';

/** Each plugin hook gets this long to finish; a legacy module's `register` is not timed, as before. */
export const HOOK_TIMEOUT_MS = 30_000;
/** `stop()` when the person disables a plugin. */
export const STOP_TIMEOUT_MS = 5_000;
/** `stop()` when the gateway closes: the server's own deadline leaves little room. */
export const CLOSE_STOP_TIMEOUT_MS = 2_000;

/** What the plugin's code and declarations are, as read from disk. */
export interface Facts {
  discovered: DiscoveredModule;
  declared: PluginPermissions;
  permissionsHash: string | null;
  checksum: string | null;
  /** Every file the checksum covers, with its own hash. */
  files: Array<{ path: string; sha256: string }>;
  /** Why part of the facts could not be read (the checksum), when it could not. */
  readProblem?: string;
}

export type ApprovalStatus = 'approved' | 'not_approved' | 'changed';

export interface HostedModule {
  module: LoadedModule;
  discovered: DiscoveredModule;
  kind: ModuleKind;
  state: PluginStateName;
  /** Why it is not enabled: the error, the engine, what it is waiting for. */
  reason?: string;
  /** `loaded` when enabled, else `failed`: the two words `GET /modules` has always had. */
  status: ModuleStatus;
  /** Same as `reason` when failed, for `GET /modules`. */
  error?: string;
  handle?: ContextHandle;
  guard: PluginGuard;
  /** The first six permissions, as `GET /modules` shows them. */
  permissions: ModulePermissions;
  /** All of them, `api` and `memory` included. */
  declared: PluginPermissions;
  permissionWarnings: string[];
  manifestWarnings: string[];
  extensions: Extensions;
  extensionWarnings: string[];
  /** What the host decided on at the last refresh. */
  current: Facts;
  /** The code and declarations that are running; set while enabled. */
  loaded?: { checksum: string | null; permissionsHash: string | null };
  /** `start()` finished, so `stop()` is owed. */
  started: boolean;
  /** Work on this plugin, one step at a time. */
  queue: Promise<unknown>;
}

export class PluginError extends Error {
  constructor(
    readonly code: 'not_found' | 'stale' | 'not_approvable' | 'invalid',
    message: string
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface HostOptions {
  /** First-party plugins shipped with the gateway: id to the checksum they ship with. */
  bundled?: Readonly<Record<string, string>>;
  /** For tests: the `fetch` behind `ctx.fetch`. */
  fetchImpl?: typeof fetch;
  hookTimeoutMs?: number;
}

function withTimeout<T>(work: () => T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not finish in ${ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} milliseconds`}.`
          )
        ),
      ms
    );
  });
  return Promise.race([Promise.resolve().then(work), limit]).finally(() => clearTimeout(timer));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The code and declarations in a plugin's folder, read now. Never throws. */
export function readFacts(dir: string): Facts | { problem: string } {
  let discovered: DiscoveredModule | null;
  try {
    discovered = discoverOne(dir);
  } catch (e) {
    return { problem: message(e) };
  }
  if (!discovered) return { problem: `${dir} no longer holds a plugin.` };
  const declared =
    discovered.kind === 'plugin'
      ? (discovered.plugin?.permissions ?? EMPTY_PERMISSIONS)
      : declaredPermissions(discovered.manifest).permissions;
  let checksum: string | null = null;
  let files: Facts['files'] = [];
  let problem: string | undefined;
  try {
    const detail = pluginChecksumDetail(dir, {
      manifestText: discovered.manifestText,
      manifest: discovered.manifest,
    });
    checksum = detail.checksum;
    files = detail.files;
  } catch (e) {
    problem = e instanceof PluginFilesError ? e.message : message(e);
  }
  return {
    discovered,
    declared,
    permissionsHash: hashPermissions(declared),
    checksum,
    files,
    ...(problem ? { readProblem: problem } : {}),
  };
}

/** Where the approval stands for code and declarations as they are. */
export function approvalOf(
  row: PluginRow | undefined,
  facts: Pick<Facts, 'permissionsHash' | 'checksum'>
): {
  status: ApprovalStatus;
  changes: { code: boolean; permissions: boolean; version: boolean };
} {
  const a = row?.approval;
  if (!a) {
    return { status: 'not_approved', changes: { code: false, permissions: false, version: false } };
  }
  const code = a.checksum !== facts.checksum;
  const permissions = a.permissionsHash !== facts.permissionsHash;
  return {
    status: code || permissions ? 'changed' : 'approved',
    changes: { code, permissions, version: false },
  };
}

export class ModuleHost {
  private readonly entries = new Map<string, HostedModule>();
  /** What serves `/api/modules/<id>/…` right now, by lower-case id. */
  private readonly mounted = new Map<string, Router>();
  private dispatching = false;
  readonly triggers = new ModuleTriggers();
  private closing = false;

  constructor(
    private readonly app: Express,
    private readonly options: HostOptions = {}
  ) {}

  /**
   * Put the one handler that answers `/api/modules/<id>/…` in the middleware stack. Called
   * where the modules' routes belong in the order; a host that was not given a place
   * for it takes the end of the stack when the first module starts.
   */
  mountDispatcher(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    const dispatch: RequestHandler = (req, res, next) => {
      const router = this.mounted.get(String(req.params.pluginId).toLowerCase());
      if (!router) return next();
      router(req, res, next);
    };
    this.app.use('/api/modules/:pluginId', dispatch);
  }

  /** Find and start every module and plugin under `dir` (or the single one at `dir`). */
  async loadAll(dir?: string): Promise<void> {
    for (const d of discoverModules(dir)) await this.add(d);
  }

  list(): HostedModule[] {
    return [...this.entries.values()];
  }

  get(id: string): HostedModule | undefined {
    return this.entries.get(id);
  }

  /**
   * Modules whose skills the gateway may use: the ones that run, and legacy ones that failed after
   * loading, as before. Only a module that was staged is here, and its skills are read from the copy.
   */
  loaded(): LoadedModule[] {
    return this.list()
      .filter(
        (h) =>
          h.module.stageDir !== undefined &&
          (h.state === 'enabled' || (h.state === 'failed' && h.kind === 'legacy'))
      )
      .map((h) => h.module);
  }

  enforcing(): boolean {
    return enforcing();
  }

  // -------------------------------------------------------------------------
  // The steps a person or the gateway asks for

  /** Turn a plugin on. With enforcement on and no approval it waits for one. */
  async enable(id: string, actor: string): Promise<HostedModule> {
    const entry = this.need(id);
    await this.serial(entry, async () => {
      this.refuseWhileClosing();
      updatePluginRow(id, { desired: 'enabled' });
      this.audit('plugin.enabled', id, actor, {});
      await this.settle(entry, true);
    });
    return entry;
  }

  /** Turn a plugin off: `stop()`, then everything it set up is removed. */
  async disable(id: string, actor: string): Promise<HostedModule> {
    const entry = this.need(id);
    await this.serial(entry, async () => {
      this.refuseWhileClosing();
      updatePluginRow(id, { desired: 'disabled' });
      this.audit('plugin.disabled', id, actor, {});
      await this.settle(entry, false);
    });
    return entry;
  }

  /**
   * Record that a person reviewed these declarations and this code, which must be what is on
   * disk now: an approval cannot cover a later change. Then start the plugin if it was waiting.
   */
  async approve(
    id: string,
    seen: { permissionsHash: unknown; checksum: unknown },
    actor: string
  ): Promise<HostedModule> {
    const entry = this.need(id);
    await this.serial(entry, async () => {
      this.refuseWhileClosing();
      const facts = readFacts(entry.discovered.dir);
      if ('problem' in facts) throw new PluginError('not_approvable', facts.problem);
      if (facts.discovered.id !== id) {
        throw new PluginError('not_approvable', 'The folder now holds a different plugin.');
      }
      if (facts.discovered.problems) {
        throw new PluginError(
          'not_approvable',
          `It cannot run, so there is nothing to approve: ${facts.discovered.problems.join(' ')}`
        );
      }
      const refused = this.engineOf(facts.discovered);
      if (refused) throw new PluginError('not_approvable', refused);
      if (facts.readProblem || !facts.checksum || !facts.permissionsHash) {
        throw new PluginError(
          'not_approvable',
          facts.readProblem ?? 'Its files could not be read.'
        );
      }
      if (seen.permissionsHash !== facts.permissionsHash || seen.checksum !== facts.checksum) {
        throw new PluginError(
          'stale',
          'The plugin changed since you reviewed it, so nothing was approved. Review it again.'
        );
      }
      const running = entry.state === 'enabled' && entry.handle !== undefined;
      saveApproval(id, {
        version:
          facts.discovered.plugin?.version ?? String(facts.discovered.manifest.version ?? ''),
        permissionsHash: facts.permissionsHash,
        checksum: facts.checksum,
        permissions: facts.declared,
        at: new Date().toISOString(),
        by: 'operator',
      });
      this.audit('plugin.approved', id, actor, {
        version: facts.discovered.manifest.version ?? null,
        permissionsHash: facts.permissionsHash,
        checksum: facts.checksum,
        permissions: facts.declared,
      });
      this.changed(id);
      // A plugin that is running other code than what was just approved is stopped and
      // started again with it: the approval is of that code, and the old code is no longer covered.
      if (
        running &&
        (entry.loaded?.checksum !== facts.checksum ||
          entry.loaded?.permissionsHash !== facts.permissionsHash)
      ) {
        await this.stopRunning(entry, STOP_TIMEOUT_MS);
      }
      await this.settle(entry, true);
    });
    return entry;
  }

  /** Turn enforcement on or off, and bring every plugin into line with it now. */
  async setEnforce(on: boolean, actor: string): Promise<void> {
    this.refuseWhileClosing();
    const was = enforcing();
    setEnforcing(on);
    if (was !== on) this.audit('plugins.enforce.changed', 'plugins', actor, { enforce: on });
    this.changed('*');
    for (const entry of this.list()) {
      await this.serial(entry, () => this.settle(entry, true));
    }
  }

  /** A change that arrives once the gateway is closing is refused: it would start a plugin just before the store goes. */
  private refuseWhileClosing(): void {
    if (this.closing)
      throw new PluginError('invalid', 'OpenClerq is stopping; nothing was changed.');
  }

  /**
   * Stop every plugin that is running, for a gateway that is closing. They stop at the same
   * time, each with its own limit; what a plugin registered is removed after.
   */
  async stopAll(timeoutMs: number = CLOSE_STOP_TIMEOUT_MS): Promise<void> {
    this.closing = true;
    await Promise.all(
      this.list().map((entry) =>
        this.serial(entry, async () => {
          if (!entry.handle) return;
          await this.stopRunning(entry, timeoutMs);
        })
      )
    );
  }

  // -------------------------------------------------------------------------
  // Starting

  private need(id: string): HostedModule {
    const entry = this.entries.get(id);
    if (!entry) throw new PluginError('not_found', `No plugin "${id}".`);
    return entry;
  }

  /** One step at a time per plugin: a slow start must not be overtaken by a disable. */
  private serial<T>(entry: HostedModule, work: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(work, work);
    entry.queue = next.catch(() => undefined);
    return next;
  }

  private async add(d: DiscoveredModule): Promise<void> {
    if (this.entries.has(d.id)) return;
    const entry = this.makeEntry(d);
    this.entries.set(d.id, entry);
    this.ensureRow(entry);
    await this.serial(entry, () => this.settle(entry, true));
  }

  private makeEntry(d: DiscoveredModule): HostedModule {
    const facts = this.factsOf(d);
    const entry = {
      module: { id: d.id, manifest: d.manifest, dir: d.dir, kind: d.kind, routeHandlers: [] },
      discovered: d,
      kind: d.kind,
      state: 'disabled',
      status: 'failed',
      guard: undefined as unknown as PluginGuard,
      permissions: legacyView(facts.declared),
      declared: facts.declared,
      permissionWarnings: [],
      manifestWarnings: [],
      extensions: parseExtensions(d.manifest).extensions,
      extensionWarnings: [],
      current: facts,
      started: false,
      queue: Promise.resolve(),
    } as HostedModule;
    entry.guard = new PluginGuard({
      id: d.id,
      dir: d.dir,
      declared: () => entry.declared,
      enforcing,
    });
    this.apply(entry, facts);
    return entry;
  }

  private factsOf(d: DiscoveredModule): Facts {
    const read = readFacts(d.dir);
    return 'problem' in read
      ? {
          discovered: d,
          declared: EMPTY_PERMISSIONS,
          permissionsHash: null,
          checksum: null,
          files: [],
          readProblem: read.problem,
        }
      : read;
  }

  /** Take the manifest-derived fields from `facts`. */
  private apply(entry: HostedModule, facts: Facts): void {
    const d = facts.discovered;
    const ext = parseExtensions(d.manifest);
    entry.discovered = d;
    entry.kind = d.kind;
    entry.current = facts;
    entry.declared = facts.declared;
    entry.permissions = legacyView(facts.declared);
    entry.permissionWarnings = d.kind === 'legacy' ? parsePermissions(d.manifest).warnings : [];
    entry.manifestWarnings = d.manifestWarnings ?? [];
    entry.extensions = ext.extensions;
    entry.extensionWarnings = ext.warnings;
    entry.module = { ...entry.module, manifest: d.manifest, dir: d.dir, kind: d.kind };
  }

  /** Make the plugin's row if this is the first time it is seen. */
  private ensureRow(entry: HostedModule): PluginRow {
    return (
      readPluginRow(entry.module.id) ??
      createPluginRow({
        id: entry.module.id,
        kind: entry.kind,
        version: String(entry.discovered.manifest.version ?? '') || null,
      })
    );
  }

  /** Read the folder again and decide on what is there. Not while the plugin is running. */
  private adopt(entry: HostedModule, facts: Facts | { problem: string }): void {
    const d = entry.discovered;
    const next: Facts =
      'problem' in facts
        ? {
            discovered: d,
            declared: entry.declared,
            permissionsHash: entry.current.permissionsHash,
            checksum: null,
            files: [],
            readProblem: facts.problem,
          }
        : facts;
    this.apply(entry, next);
    const row = this.ensureRow(entry);
    const version = String(next.discovered.manifest.version ?? '') || null;
    // A change in what the plugin is or declares is audited (permissions as before: `module.permissions.changed`).
    if (
      next.checksum &&
      next.permissionsHash &&
      (row.checksum !== next.checksum || row.permissionsHash !== next.permissionsHash) &&
      (row.checksum !== null || row.permissionsHash !== null)
    ) {
      this.audit('plugin.changed', entry.module.id, 'gateway', {
        from: {
          version: row.version,
          checksum: row.checksum,
          permissionsHash: row.permissionsHash,
        },
        to: { version, checksum: next.checksum, permissionsHash: next.permissionsHash },
      });
    }
    updatePluginRow(entry.module.id, {
      kind: entry.kind,
      version,
      checksum: next.checksum,
      permissionsHash: next.permissionsHash,
    });
    // A first-party plugin that is exactly what shipped is approved when it is installed.
    const bundled = this.options.bundled?.[entry.module.id];
    if (bundled && next.checksum === bundled && next.permissionsHash) {
      const approval = readPluginRow(entry.module.id)?.approval;
      if (
        !approval ||
        approval.checksum !== next.checksum ||
        approval.permissionsHash !== next.permissionsHash
      ) {
        saveApproval(entry.module.id, {
          version,
          permissionsHash: next.permissionsHash,
          checksum: next.checksum,
          permissions: next.declared,
          at: new Date().toISOString(),
          by: 'bundled',
        });
        this.audit('plugin.approved', entry.module.id, 'gateway', {
          bundled: true,
          version,
          checksum: next.checksum,
          permissionsHash: next.permissionsHash,
        });
      }
    }
  }

  private engineOf(d: DiscoveredModule): string | null {
    return d.plugin ? engineProblem(d.plugin.engines.api) : null;
  }

  /**
   * What this plugin should be doing, given the person's choice, the engine, the
   * approval and whether enforcement is on: and then do it.
   * `fresh` says the folder was read again just now (a start, an enable), which is
   * the only time the code on disk is allowed to replace what is running.
   */
  private async settle(entry: HostedModule, fresh: boolean, depth = 0): Promise<void> {
    // Nothing starts once the gateway is closing, whoever asked and however long they waited.
    if (this.closing) return;
    const id = entry.module.id;
    const row = readPluginRow(id) ?? this.ensureRow(entry);
    const running = entry.state === 'enabled' && entry.handle !== undefined;
    if (fresh && !running) {
      const facts = readFacts(entry.discovered.dir);
      this.adopt(
        entry,
        !('problem' in facts) && facts.discovered.id !== id
          ? { problem: `The folder now holds a different plugin ("${facts.discovered.id}").` }
          : facts
      );
    }
    // What the approval is compared with: what runs, or what would.
    const basis = running && entry.loaded ? entry.loaded : entry.current;
    const approval = approvalOf(readPluginRow(id), basis);

    let next: { state: PluginStateName; reason: string | null };
    const d = entry.discovered;
    const refused = this.engineOf(d);
    if (d.problems) {
      next = { state: 'failed', reason: `The manifest is not valid. ${d.problems.join(' ')}` };
    } else if (entry.current.readProblem && !running) {
      next = { state: 'failed', reason: entry.current.readProblem };
    } else if (refused) {
      next = { state: 'refused', reason: refused };
    } else if (row.desired === 'disabled') {
      next = { state: 'disabled', reason: null };
    } else if (enforcing() && approval.status !== 'approved') {
      next = {
        state: 'awaiting_approval',
        reason:
          approval.status === 'changed'
            ? 'It changed since you approved it. Review what changed and approve it to run it.'
            : 'It has not been approved yet. Review what it asks for and approve it to run it.',
      };
    } else {
      next = { state: 'enabled', reason: null };
    }

    if (running && next.state === 'enabled') return;
    if (running) {
      const failure = await this.stopRunning(entry, STOP_TIMEOUT_MS);
      // A `stop()` that threw leaves the plugin failed, with its error, whatever else was decided.
      if (failure) return this.setState(entry, 'failed', failure, row.state);
    }
    if (next.state === 'enabled') return this.activate(entry, depth);
    this.setState(entry, next.state, next.reason, row.state);
  }

  /** Record a state that is not `enabled` (or `failed` by a hook, which has its own path). */
  private setState(
    entry: HostedModule,
    state: PluginStateName,
    reason: string | null,
    before?: PluginStateName
  ): void {
    const id = entry.module.id;
    entry.state = state;
    entry.reason = reason ?? undefined;
    entry.status = state === 'enabled' ? 'loaded' : 'failed';
    entry.error = state === 'failed' ? (reason ?? undefined) : undefined;
    entry.loaded = state === 'enabled' ? entry.loaded : undefined;
    updatePluginRow(id, { state, reason });
    this.record(entry);
    this.changed(id);
    if (state !== before && (state === 'awaiting_approval' || state === 'refused')) {
      this.audit(`plugin.${state}`, id, 'gateway', { reason });
    }
    if (state === 'refused' || state === 'awaiting_approval') {
      logger.warn(state === 'refused' ? 'Plugin refused' : 'Plugin waiting for approval', {
        moduleId: id,
        reason,
      });
    }
  }

  private async activate(entry: HostedModule, depth = 0): Promise<void> {
    const d = entry.discovered;
    const id = d.id;
    const row = readPluginRow(id) as PluginRow;
    const isPlugin = d.kind === 'plugin';
    const timeoutMs = this.options.hookTimeoutMs ?? HOOK_TIMEOUT_MS;
    const checksum = entry.current.checksum;

    // Copy exactly the files that were hashed, each checked against the hash recorded when the
    // decision was made, and run and serve everything from the copy. A file that is not what was
    // read (edited since, gone) means the decision is made again with what is there now.
    const staged = stagePlugin(d, entry.current);
    if ('changed' in staged) {
      if (depth >= 2) {
        return this.failEntry(entry, 'The plugin kept changing while it was being loaded.');
      }
      this.adopt(entry, readFacts(d.dir));
      return this.settle(entry, false, depth + 1);
    }
    if ('error' in staged) return this.failEntry(entry, staged.error);
    const stageDir = staged.dir;
    const loaded = await importEntry(d, { dir: stageDir });
    entry.module = {
      id,
      manifest: d.manifest,
      dir: d.dir,
      stageDir,
      kind: d.kind,
      ...loaded,
    };
    if (loaded.error) return this.failEntry(entry, loaded.error);

    const handle = createModuleContext(entry.module, {
      triggers: this.triggers,
      guard: entry.guard,
      declared: entry.declared,
      fetchImpl: this.options.fetchImpl,
    });
    entry.handle = handle;
    const ctx = handle.ctx;
    // Reserved below the module's own routes: fire a trigger by hand or by webhook.
    handle.router.post('/triggers/:triggerId', async (req, res) => {
      try {
        const runId = await this.triggers.fireNow(id, String(req.params.triggerId), req.body);
        res.status(202).json({ runId });
      } catch (e) {
        if (!(e instanceof TriggerError)) throw e;
        const status = { not_found: 404, busy: 409, paused: 503, invalid: 400 }[e.code];
        res
          .status(status)
          .json({ error: e.code === 'paused' ? 'triggers_paused' : e.code, message: e.message });
      }
    });
    // Reserved too: the services the manifest declares.
    const serviceError = (res: import('express').Response, e: unknown) => {
      if (!(e instanceof ServiceError)) throw e;
      const status = { not_declared: 404, unsupported: 501, failed: 502 }[e.code];
      res.status(status).json({ error: `service_${e.code}`, message: e.message });
    };
    handle.router.get('/services', async (_req, res) => {
      try {
        res.json({
          services: await Promise.all(
            handle.services.list().map((s) => handle.services.status(s.label))
          ),
        });
      } catch (e) {
        serviceError(res, e);
      }
    });
    for (const action of ['start', 'stop'] as const) {
      handle.router.post(`/services/:label/${action}`, async (req, res) => {
        try {
          // The audit names who asked: the operator, or the module's UI token.
          res.json(await handle.services[action](String(req.params.label), actorOf(res)));
        } catch (e) {
          serviceError(res, e);
        }
      });
    }

    const hooks = entry.module.hooks;
    const step = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
      try {
        return isPlugin ? await withTimeout(work, timeoutMs, `${name}()`) : await work();
      } catch (e) {
        throw isPlugin ? new Error(`${name}() failed: ${message(e)}`) : e;
      }
    };
    try {
      // A module that ships fewer migrations than its data has applied fails here, with its own message.
      // The migrations are the staged copy's, which are the files that were hashed.
      const ran = migrateModule(getStore(), id, readMigrations(stageDir));
      if (ran.length > 0) logger.info('Module migrated', { moduleId: id, applied: ran });
      const from = row.startedVersion;
      const version = String(d.manifest.version ?? '');
      if (isPlugin && hooks?.upgrade && from && from !== version) {
        await step('upgrade', () => hooks.upgrade?.(ctx, { from }));
      }
      for (const r of entry.module.routeHandlers) ctx.push(r);
      await step('register', () => entry.module.register?.(ctx));
      if (isPlugin && hooks?.start) await step('start', () => hooks.start?.(ctx));
      entry.started = true;
    } catch (e) {
      return this.failEntry(entry, message(e));
    }

    // Answering every path under /ui itself: those paths are public (see security/auth.ts),
    // so none may fall through to the module's own routes.
    const router = express.Router();
    const ui = uiDir(stageDir, d.plugin?.entry.ui);
    router.use('/ui', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'method_not_allowed' });
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      if (!ui) return res.status(404).json({ error: 'module_has_no_ui' });
      next();
    });
    if (ui) router.use('/ui', express.static(ui, { fallthrough: false, dotfiles: 'deny' }));
    // Each carries its own error handler, since these answer after the core's.
    router.use(handle.router, apiErrors);
    this.mountDispatcher();
    this.mounted.set(id.toLowerCase(), router);

    entry.loaded = { checksum, permissionsHash: entry.current.permissionsHash };
    entry.state = 'enabled';
    entry.status = 'loaded';
    entry.reason = undefined;
    entry.error = undefined;
    updatePluginRow(id, {
      state: 'enabled',
      reason: null,
      startedVersion: String(d.manifest.version ?? '') || null,
    });
    this.record(entry);
    this.changed(id);
    logger.info('Module loaded', { moduleId: id, version: d.manifest.version, kind: d.kind });
  }

  /**
   * Take a plugin down: nothing new reaches it, `stop()` runs (when `start()` had finished),
   * then everything it registered through the context goes. Returns what `stop()` threw, if it did.
   * The caller says what state the plugin is then in.
   */
  private async stopRunning(entry: HostedModule, timeoutMs: number): Promise<string | undefined> {
    const id = entry.module.id;
    this.mounted.delete(id.toLowerCase());
    try {
      revokeTokens('module', id);
    } catch {
      /* the store may be closing */
    }
    const handle = entry.handle;
    let failure: string | undefined;
    const stop = entry.module.hooks?.stop;
    if (handle && entry.started && stop) {
      try {
        await withTimeout(() => stop(handle.ctx), timeoutMs, 'stop()');
      } catch (e) {
        failure = `stop() failed: ${message(e)}`;
      }
    }
    handle?.dispose();
    this.triggers.remove(id);
    unregisterSearch(id);
    entry.handle = undefined;
    entry.started = false;
    entry.loaded = undefined;
    if (failure) {
      this.audit('plugin.failed', id, 'gateway', { reason: failure });
      logger.error('Plugin stop failed', { moduleId: id, err: failure });
    }
    return failure;
  }

  private failEntry(entry: HostedModule, error: string): void {
    const id = entry.module.id;
    // A hook that threw part-way may have left subscriptions and handlers behind.
    this.mounted.delete(id.toLowerCase());
    entry.handle?.dispose();
    entry.handle = undefined;
    entry.started = false;
    entry.loaded = undefined;
    this.triggers.remove(id);
    unregisterSearch(id);
    this.setState(entry, 'failed', error, entry.state);
    this.audit('plugin.failed', id, 'gateway', { reason: error });
    logger.error('Module failed to load', { moduleId: id, err: error });
  }

  private record(entry: HostedModule): void {
    try {
      recordModule({
        id: entry.module.id,
        name: String(entry.module.manifest.name ?? entry.module.id),
        version: String(entry.module.manifest.version ?? '0.0.0'),
        dir: entry.module.dir,
        // `modules.status` has only these two words; the plugin's own state is in `plugin_state`.
        status: entry.state === 'enabled' ? 'loaded' : 'failed',
        error: entry.state === 'enabled' ? undefined : entry.reason,
        permissions: entry.permissions,
      });
    } catch (e) {
      logger.warn('Could not record module', {
        moduleId: entry.module.id,
        err: message(e),
      });
    }
  }

  /** Tell the interface a plugin's state or approval changed: it reloads the list. */
  private changed(id: string): void {
    try {
      emit('plugin.changed', { id });
    } catch {
      /* the bus is not the plugin's concern */
    }
  }

  private audit(action: string, id: string, actor: string, detail: unknown): void {
    try {
      audit(getStore(), { actor, action, subject: id, detail });
    } catch (e) {
      logger.warn('Could not audit a plugin change', { moduleId: id, err: message(e) });
    }
  }
}

/** `<module>/dist/ui`, or the plugin's own `entry.ui`, when it ships a UI. */
export function uiDir(moduleDir: string, entryUi?: string): string | null {
  const dir = path.join(moduleDir, entryUi ?? path.join('dist', 'ui'));
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

const MIGRATION_FILE = /^(\d+)[_-]([\w-]+)\.sql$/;

/** `<module>/migrations/0001_name.sql`, …: the number is the id, in order. */
export function readMigrations(moduleDir: string): Migration[] {
  const dir = path.join(moduleDir, 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => ({ f, m: MIGRATION_FILE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => ({
      id: Number(m[1]),
      name: m[2],
      sql: fs.readFileSync(path.join(dir, f), 'utf8'),
    }))
    .sort((a, b) => a.id - b.id);
}

export type { ModulePermissions };
