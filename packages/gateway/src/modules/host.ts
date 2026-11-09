/**
 * Loads modules, gives each its context, and mounts its routes at
 * `/api/modules/<id>`.
 *
 * A module whose register() throws is listed as failed and gets no routes;
 * the gateway and the other modules carry on.
 */

import type { Express } from 'express';
import { logger } from '../logger.js';
import { loadModulesFromDir, type LoadedModule } from '../module-loader.js';
import { createModuleContext, type ContextHandle } from './context.js';

export type ModuleStatus = 'loaded' | 'failed';

export interface HostedModule {
  module: LoadedModule;
  status: ModuleStatus;
  error?: string;
  handle?: ContextHandle;
}

export class ModuleHost {
  private readonly hosted = new Map<string, HostedModule>();

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
    const handle = createModuleContext(mod);
    entry.handle = handle;
    try {
      for (const r of mod.routeHandlers) handle.ctx.push(r);
      await mod.register?.(handle.ctx);
    } catch (e) {
      return this.fail(entry, e instanceof Error ? e.message : String(e));
    }
    this.app.use(`/api/modules/${mod.id}`, handle.router);
    logger.info('Module loaded', { moduleId: mod.id, version: mod.manifest.version });
  }

  private fail(entry: HostedModule, error: string): void {
    entry.status = 'failed';
    entry.error = error;
    logger.error('Module failed to load', { moduleId: entry.module.id, err: error });
  }
}
