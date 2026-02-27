/**
 * Loads module manifests from config.
 * Uses Tauri read_module_manifest to read manifest.json from each module path.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ModuleManifest, ModuleConfigEntry } from '@clerq/module-schema';
import { moduleRegistry } from './moduleRegistry';

export interface LoadModulesResult {
  loaded: ModuleManifest[];
  errors: { id: string; path: string; error: string }[];
}

/**
 * Load modules from config.modulePaths.
 * Each entry with a path is loaded; manifest is read via Tauri.
 */
export async function loadModules(
  modulePaths: ModuleConfigEntry[]
): Promise<LoadModulesResult> {
  const loaded: ModuleManifest[] = [];
  const errors: { id: string; path: string; error: string }[] = [];

  for (const entry of modulePaths) {
    const path = entry.path ?? entry.url;
    if (!path) {
      errors.push({ id: entry.id, path: '', error: 'No path or url' });
      continue;
    }
    try {
      const raw = await invoke<string>('read_module_manifest', {
        modulePath: path,
      });
      const manifest = JSON.parse(raw) as ModuleManifest;
      if (!manifest.id || !manifest.slug || !manifest.name || !manifest.version) {
        errors.push({
          id: entry.id,
          path,
          error: 'Invalid manifest: missing required fields',
        });
        continue;
      }
      loaded.push(manifest);
    } catch (e) {
      errors.push({
        id: entry.id,
        path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  moduleRegistry.setModules(loaded);
  return { loaded, errors };
}
