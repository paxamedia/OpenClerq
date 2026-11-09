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
  /** Defaults for `ctx.config`. */
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Result of loading a module. */
export interface LoadedModule {
  id: string;
  manifest: ModuleManifestStub;
  dir: string;
  /** Routes from a module that exports a `routes` array (the pre-0.6 contract). */
  routeHandlers: ModuleRouteHandler[];
  /** `register(ctx)`, from a module that exports one or a default `{ register }`. */
  register?: (ctx: unknown) => unknown;
  /** Why the server entry could not be imported. */
  error?: string;
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

/** Module ids double as URL segments and table prefixes. */
/** No `--` and no trailing `-`, so no module's table prefix covers another's (see the store). */
const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Import a module's server entry: the manifest's `entryPoints.routes[0]`, or
 * else dist/routes.js, dist/routes.cjs or build/routes.js.
 *
 * It may export `register(ctx)` (or a default `{ register }`), or a `routes`
 * array of handlers. A `register` written for the pre-0.6 contract, which took
 * an array and pushed handlers onto it, still works: the context has `push`.
 */
async function loadEntry(
  moduleDir: string,
  manifest: ModuleManifestStub
): Promise<Pick<LoadedModule, 'routeHandlers' | 'register' | 'error'>> {
  const declared = manifest.entryPoints?.routes?.[0];
  const candidates = declared
    ? [path.resolve(moduleDir, declared)]
    : [
        path.join(moduleDir, 'dist', 'routes.js'),
        path.join(moduleDir, 'dist', 'routes.cjs'),
        path.join(moduleDir, 'build', 'routes.js'),
      ];
  const p = candidates.find((c) => fssync.existsSync(c));
  if (!p) return { routeHandlers: [] };
  try {
    const mod = (await import(pathToFileURL(p).href)) as Record<string, unknown>;
    const def = mod.default as Record<string, unknown> | ((...a: unknown[]) => unknown) | undefined;
    const register =
      typeof mod.register === 'function'
        ? mod.register
        : typeof def === 'function'
          ? def
          : def && typeof def.register === 'function'
            ? (def.register as (ctx: unknown) => unknown).bind(def)
            : undefined;
    const routes = Array.isArray(mod.routes)
      ? mod.routes
      : Array.isArray(def)
        ? (def as unknown[])
        : [];
    return {
      routeHandlers: routes as ModuleRouteHandler[],
      register: register as LoadedModule['register'],
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[Clerq] Failed to load module entry ${p}:`, error);
    return { routeHandlers: [], error };
  }
}

async function loadOne(dir: string): Promise<LoadedModule | null> {
  const manifest = loadManifest(dir);
  if (!manifest) return null;
  if (!MODULE_ID.test(manifest.id)) {
    console.warn(
      `[Clerq] Skipping module in ${dir}: id "${manifest.id}" must be lower-case words joined by single hyphens`
    );
    return null;
  }
  return { id: manifest.id, manifest, dir, ...(await loadEntry(dir, manifest)) };
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
  const dirs = fssync.existsSync(manifestPath)
    ? [dir]
    : fssync
        .readdirSync(dir, { withFileTypes: true })
        .filter((ent) => ent.isDirectory())
        .map((ent) => path.join(dir, ent.name))
        .sort();
  for (const d of dirs) {
    const mod = await loadOne(d);
    if (!mod) continue;
    if (loaded.some((m) => m.id === mod.id)) {
      console.warn(`[Clerq] Skipping module in ${d}: id "${mod.id}" is already loaded`);
      continue;
    }
    loaded.push(mod);
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
