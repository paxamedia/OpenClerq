/**
 * Loads modules, gives each its context, and mounts its routes at
 * `/api/modules/<id>`.
 *
 * A module whose register() throws is listed as failed and gets no routes;
 * the gateway and the other modules carry on.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { migrateModule, type Migration } from '@clerq/store';
import { getStore } from '../store.js';
import { logger } from '../logger.js';
import { loadModulesFromDir, type LoadedModule } from '../module-loader.js';
import { createModuleContext, type ContextHandle } from './context.js';
import { ModuleTriggers, TriggerError } from './triggers.js';

export type ModuleStatus = 'loaded' | 'failed';

export interface HostedModule {
  module: LoadedModule;
  status: ModuleStatus;
  error?: string;
  handle?: ContextHandle;
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
    const entry: HostedModule = { module: mod, status: 'loaded' };
    this.hosted.set(mod.id, entry);
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
    try {
      const ran = migrateModule(getStore(), mod.id, readMigrations(mod.dir));
      if (ran.length > 0) logger.info('Module migrated', { moduleId: mod.id, applied: ran });
      for (const r of mod.routeHandlers) handle.ctx.push(r);
      await mod.register?.(handle.ctx);
    } catch (e) {
      return this.fail(entry, e instanceof Error ? e.message : String(e));
    }
    this.app.use(`/api/modules/${mod.id}`, handle.router);
    logger.info('Module loaded', { moduleId: mod.id, version: mod.manifest.version });
  }

  private fail(entry: HostedModule, error: string): void {
    this.triggers.remove(entry.module.id);
    entry.status = 'failed';
    entry.error = error;
    logger.error('Module failed to load', { moduleId: entry.module.id, err: error });
  }
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
