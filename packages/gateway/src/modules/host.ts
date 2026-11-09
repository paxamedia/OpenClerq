/**
 * Loads modules, gives each its context, and mounts its routes at
 * `/api/modules/<id>`.
 *
 * A module whose register() throws is listed as failed and gets no routes;
 * the gateway and the other modules carry on.
 */

import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import { migrateModule, type Migration } from '@clerq/store';
import { getStore } from '../store.js';
import { logger } from '../logger.js';
import { loadModulesFromDir, type LoadedModule } from '../module-loader.js';
import { createModuleContext, type ContextHandle } from './context.js';
import { ModuleTriggers, TriggerError } from './triggers.js';
import { ServiceError } from './services.js';
import { parsePermissions, recordModule, type ModulePermissions } from './permissions.js';
import { parseExtensions, type Extensions } from './extensions.js';
import { unregisterSearch } from './search.js';

export type ModuleStatus = 'loaded' | 'failed';

export interface HostedModule {
  module: LoadedModule;
  status: ModuleStatus;
  error?: string;
  handle?: ContextHandle;
  /** Declared in the manifest; not enforced. */
  permissions: ModulePermissions;
  permissionWarnings: string[];
  extensions: Extensions;
  extensionWarnings: string[];
}

export class ModuleHost {
  private readonly hosted = new Map<string, HostedModule>();
  readonly triggers = new ModuleTriggers();

  constructor(private readonly app: Express) {}

  /** Load every module under `dir` (or the single module at `dir`). */
  async loadAll(dir?: string): Promise<void> {
    for (const mod of await loadModulesFromDir(dir)) await this.start(mod);
  }

  list(): HostedModule[] {
    return [...this.hosted.values()];
  }

  get(id: string): HostedModule | undefined {
    return this.hosted.get(id);
  }

  loaded(): LoadedModule[] {
    return this.list().map((h) => h.module);
  }

  private async start(mod: LoadedModule): Promise<void> {
    if (this.hosted.has(mod.id)) return;
    const { permissions, warnings } = parsePermissions(mod.manifest);
    const ext = parseExtensions(mod.manifest);
    const entry: HostedModule = {
      module: mod,
      status: 'loaded',
      permissions,
      permissionWarnings: warnings,
      extensions: ext.extensions,
      extensionWarnings: ext.warnings,
    };
    for (const w of ext.warnings) logger.warn('Module manifest', { moduleId: mod.id, problem: w });
    this.hosted.set(mod.id, entry);
    for (const w of warnings) logger.warn('Module manifest', { moduleId: mod.id, problem: w });
    if (mod.error) return this.fail(entry, mod.error);
    const handle = createModuleContext(mod, { triggers: this.triggers });
    entry.handle = handle;
    // Reserved below the module's own routes: fire a trigger by hand or by webhook.
    handle.router.post('/triggers/:triggerId', async (req, res) => {
      try {
        const runId = await this.triggers.fireNow(mod.id, String(req.params.triggerId), req.body);
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
          res.json(await handle.services[action](String(req.params.label)));
        } catch (e) {
          serviceError(res, e);
        }
      });
    }
    try {
      const ran = migrateModule(getStore(), mod.id, readMigrations(mod.dir));
      if (ran.length > 0) logger.info('Module migrated', { moduleId: mod.id, applied: ran });
      for (const r of mod.routeHandlers) handle.ctx.push(r);
      await mod.register?.(handle.ctx);
    } catch (e) {
      return this.fail(entry, e instanceof Error ? e.message : String(e));
    }
    // Mounted first, and answering every path under /ui itself: those paths
    // are public (see security/auth.ts), so none may fall through to the
    // module's own routes.
    const ui = uiDir(mod.dir);
    this.app.use(`/api/modules/${mod.id}/ui`, (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).json({ error: 'method_not_allowed' });
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      if (!ui) return res.status(404).json({ error: 'module_has_no_ui' });
      next();
    });
    if (ui) {
      this.app.use(
        `/api/modules/${mod.id}/ui`,
        express.static(ui, { fallthrough: false, dotfiles: 'deny' })
      );
    }
    this.app.use(`/api/modules/${mod.id}`, handle.router);
    this.record(entry);
    logger.info('Module loaded', { moduleId: mod.id, version: mod.manifest.version });
  }

  private record(entry: HostedModule): void {
    try {
      recordModule({
        id: entry.module.id,
        name: String(entry.module.manifest.name ?? entry.module.id),
        version: String(entry.module.manifest.version ?? '0.0.0'),
        dir: entry.module.dir,
        status: entry.status,
        error: entry.error,
        permissions: entry.permissions,
      });
    } catch (e) {
      logger.warn('Could not record module', {
        moduleId: entry.module.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private fail(entry: HostedModule, error: string): void {
    this.triggers.remove(entry.module.id);
    unregisterSearch(entry.module.id);
    entry.status = 'failed';
    entry.error = error;
    this.record(entry);
    logger.error('Module failed to load', { moduleId: entry.module.id, err: error });
  }
}

/** `<module>/dist/ui`, when the module ships a UI. */
export function uiDir(moduleDir: string): string | null {
  const dir = path.join(moduleDir, 'dist', 'ui');
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
