/**
 * In-memory registry of loaded module manifests.
 * Used by the desktop to know which modules are available and their metadata.
 */

import type { ModuleManifest } from '@clerq/module-schema';

class ModuleRegistryImpl {
  private modules = new Map<string, ModuleManifest>();

  setModules(manifests: ModuleManifest[]): void {
    this.modules.clear();
    for (const m of manifests) {
      this.modules.set(m.id, m);
    }
  }

  getModule(id: string): ModuleManifest | undefined {
    return this.modules.get(id);
  }

  getAllModules(): ModuleManifest[] {
    return Array.from(this.modules.values());
  }

  hasModule(id: string): boolean {
    return this.modules.has(id);
  }
}

export const moduleRegistry = new ModuleRegistryImpl();
