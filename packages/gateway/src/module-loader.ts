/**
 * Gateway module loader.
 * Loads modules from CLERQ_MODULES_DIR or config.modulesDir.
 * Modules can register routes at /api/modules/:moduleId/...
 */

import type { Request, Response } from 'express';
import type { Express } from 'express';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Handler for a module route. */
export interface ModuleRouteHandler {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  handler: (req: Request, res: Response) => Promise<void>;
}

/** Minimal manifest shape for gateway (avoids pulling full schema). */
export interface ModuleManifestStub {
  id: string;
  slug?: string;
  name?: string;
  version?: string;
  entryPoints?: { routes?: string[] };
}

/** Result of loading a module. */
export interface LoadedModule {
  id: string;
  manifest: ModuleManifestStub;
  dir: string;
  routeHandlers: ModuleRouteHandler[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getModulesDir(configuredDir?: string): string | null {
  const dir =
    configuredDir ??
    process.env.CLERQ_MODULES_DIR ??
    // Default to a generic modules directory in OSS builds; no built-in modules.
    path.resolve(__dirname, '..', '..', '..', 'modules');
  if (!fssync.existsSync(dir)) return null;
  const stat = fssync.statSync(dir);
  if (!stat.isDirectory()) return null;
  return dir;
}

/**
 * Load a single module's manifest from a directory.
 */
function loadManifest(moduleDir: string): ModuleManifestStub | null {
  const manifestPath = path.join(moduleDir, 'manifest.json');
  if (!fssync.existsSync(manifestPath)) return null;
  try {
    const raw = fssync.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as ModuleManifestStub;
    if (!manifest?.id) return null;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Try to load route handlers from a module.
 * Looks for dist/routes.js or build/routes.js (compiled output).
 */
async function loadRouteHandlers(moduleDir: string, manifest: ModuleManifestStub): Promise<ModuleRouteHandler[]> {
  const candidates = [
    path.join(moduleDir, 'dist', 'routes.js'),
    path.join(moduleDir, 'dist', 'routes.cjs'),
    path.join(moduleDir, 'build', 'routes.js'),
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) {
      try {
        const mod = await import(pathToFileURL(p).href);
        const routes = mod.routes ?? mod.default ?? mod.register;
        if (Array.isArray(routes)) return routes as ModuleRouteHandler[];
        if (typeof routes === 'function') {
          const out: ModuleRouteHandler[] = [];
          routes(out);
          return out;
        }
      } catch (e) {
        console.warn(`[Clerq] Failed to load routes from ${p}:`, e);
      }
      break;
    }
  }
  return [];
}

/**
 * Load all modules from a directory.
 * If dir points to a single module (contains manifest.json), load it.
 * If dir points to a parent of modules, scan subdirs for manifest.json.
 */
export async function loadModulesFromDir(modulesDir?: string): Promise<LoadedModule[]> {
  const dir = getModulesDir(modulesDir);
  if (!dir) return [];

  const loaded: LoadedModule[] = [];
  const manifestPath = path.join(dir, 'manifest.json');

  if (fssync.existsSync(manifestPath)) {
    const manifest = loadManifest(dir);
    if (manifest) {
      const routeHandlers = await loadRouteHandlers(dir, manifest);
      loaded.push({ id: manifest.id, manifest, dir, routeHandlers });
    }
  } else {
    const entries = fssync.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const subDir = path.join(dir, ent.name);
      const manifest = loadManifest(subDir);
      if (manifest) {
        const routeHandlers = await loadRouteHandlers(subDir, manifest);
        loaded.push({ id: manifest.id, manifest, dir: subDir, routeHandlers });
      }
    }
  }

  return loaded;
}

/**
 * Get skills directories from loaded modules (each module's skills/ subdir).
 */
export function getModuleSkillsDirs(modules: LoadedModule[]): string[] {
  const dirs: string[] = [];
  for (const mod of modules) {
    const skillsPath = path.join(mod.dir, 'skills');
    if (fssync.existsSync(skillsPath) && fssync.statSync(skillsPath).isDirectory()) {
      dirs.push(skillsPath);
    }
  }
  return dirs;
}

/**
 * Mount a module's routes on the Express app at /api/modules/:moduleId/...
 */
export function mountModuleRoutes(app: Express, module: LoadedModule): void {
  const base = `/api/modules/${module.id}`;
  for (const r of module.routeHandlers) {
    const fullPath = base + (r.path.startsWith('/') ? r.path : `/${r.path}`);
    const m = r.method.toUpperCase();
    if (m === 'GET') app.get(fullPath, r.handler);
    else if (m === 'POST') app.post(fullPath, r.handler);
    else if (m === 'PUT') app.put(fullPath, r.handler);
    else if (m === 'DELETE') app.delete(fullPath, r.handler);
    else if (m === 'PATCH') app.patch(fullPath, r.handler);
    else continue;
    console.log(`[Clerq] Mounted ${r.method} ${fullPath}`);
  }
}
