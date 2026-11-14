/**
 * Gateway module loader.
 * Finds modules and plugins in CLERQ_MODULES_DIR or config.modulesDir and imports
 * their server entry. Finding (`discoverModules`) reads only manifests: nothing of
 * a plugin's code runs until the host has decided it may (`importEntry`), which is
 * what lets enforcement keep an unapproved plugin from loading at all.
 * Modules can register routes at /api/modules/:moduleId/...
 */

import type { Request, Response } from 'express';
import type { Express } from 'express';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_ID, hasManifestVersion, validateManifest } from '@clerq/plugin-sdk/manifest';
import type { PluginManifest } from '@clerq/plugin-sdk/manifest';
import type { PluginDefinition } from '@clerq/plugin-sdk';

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

/** `plugin` has `"manifestVersion": 1`; `legacy` is a module written before it. */
export type ModuleKind = 'plugin' | 'legacy';

/** A module or plugin found on disk, its code not yet imported. */
export interface DiscoveredModule {
  id: string;
  kind: ModuleKind;
  manifest: ModuleManifestStub;
  /** `manifest.json` as it was read, so a checksum is of the text that was validated. */
  manifestText: string;
  dir: string;
  /** The manifest, validated; a plugin only, and only when it is valid. */
  plugin?: PluginManifest;
  /** Why a plugin's manifest is not valid: plain sentences. */
  problems?: string[];
  /** Notes on a valid plugin manifest. */
  manifestWarnings?: string[];
}

/** The hooks a plugin's server entry exports besides `register`. */
export type PluginHooks = Pick<PluginDefinition, 'start' | 'stop' | 'upgrade'>;

/** Result of loading a module. */
export interface LoadedModule {
  id: string;
  manifest: ModuleManifestStub;
  dir: string;
  kind?: ModuleKind;
  /** Routes from a module that exports a `routes` array (the pre-0.6 contract). */
  routeHandlers: ModuleRouteHandler[];
  /** `register(ctx)`, from a module that exports one or a default `{ register }`. */
  register?: (ctx: unknown) => unknown;
  /** `start`, `stop` and `upgrade`, from a plugin (not a legacy module). */
  hooks?: PluginHooks;
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
function loadManifest(moduleDir: string): { manifest: ModuleManifestStub; text: string } | null {
  const manifestPath = path.join(moduleDir, 'manifest.json');
  if (!fssync.existsSync(manifestPath)) return null;
  try {
    const text = fssync.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(text) as ModuleManifestStub;
    if (!manifest?.id) return null;
    return { manifest, text };
  } catch {
    return null;
  }
}

/** Module ids double as URL segments and table prefixes. */
/** No `--` and no trailing `-`, so no module's table prefix covers another's (see the store). */
const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Import a module's server entry: for a plugin the manifest's `entry.server`; for a
 * legacy module its `entryPoints.routes[0]`, or else dist/routes.js,
 * dist/routes.cjs or build/routes.js.
 *
 * It may export `register(ctx)` (or a default `{ register }`), or, for a legacy
 * module, a `routes` array of handlers. A `register` written for the pre-0.6
 * contract, which took an array and pushed handlers onto it, still works: the
 * context has `push`. A plugin may also export `start`, `stop` and `upgrade`.
 *
 * `bust` makes the import a fresh one: a plugin that was stopped and started again
 * must run the code that is on disk now, not the copy Node already holds.
 */
export async function importEntry(
  d: Pick<DiscoveredModule, 'kind' | 'manifest' | 'dir' | 'plugin'>,
  bust?: string
): Promise<Pick<LoadedModule, 'routeHandlers' | 'register' | 'hooks' | 'error'>> {
  const { dir: moduleDir, manifest } = d;
  const isPlugin = d.kind === 'plugin';
  const declared = isPlugin ? d.plugin?.entry.server : manifest.entryPoints?.routes?.[0];
  const candidates = declared
    ? [path.resolve(moduleDir, declared)]
    : isPlugin
      ? []
      : [
          path.join(moduleDir, 'dist', 'routes.js'),
          path.join(moduleDir, 'dist', 'routes.cjs'),
          path.join(moduleDir, 'build', 'routes.js'),
        ];
  const p = candidates.find((c) => fssync.existsSync(c));
  if (!p) {
    return isPlugin && declared
      ? { routeHandlers: [], error: `The server entry ${declared} does not exist.` }
      : { routeHandlers: [] };
  }
  try {
    const href = pathToFileURL(p).href + (bust ? `?v=${encodeURIComponent(bust)}` : '');
    const mod = (await import(href)) as Record<string, unknown>;
    const def = mod.default as Record<string, unknown> | ((...a: unknown[]) => unknown) | undefined;
    const pick = (name: string): ((...a: unknown[]) => unknown) | undefined => {
      if (typeof mod[name] === 'function') return mod[name] as (...a: unknown[]) => unknown;
      if (def && typeof def === 'object' && typeof def[name] === 'function') {
        return (def[name] as (...a: unknown[]) => unknown).bind(def);
      }
      return undefined;
    };
    const register =
      pick('register') ??
      (typeof def === 'function' ? (def as (c: unknown) => unknown) : undefined);
    if (isPlugin) {
      for (const name of ['register', 'start', 'stop', 'upgrade']) {
        const v = mod[name] ?? (def && typeof def === 'object' ? def[name] : undefined);
        if (v !== undefined && typeof v !== 'function') {
          return { routeHandlers: [], error: `The server entry's "${name}" is not a function.` };
        }
      }
      if (!register) {
        return {
          routeHandlers: [],
          error: `The server entry ${declared} does not export register(ctx). Export definePlugin({ register(ctx) { … } }) as its default.`,
        };
      }
    }
    const routes = Array.isArray(mod.routes)
      ? mod.routes
      : Array.isArray(def)
        ? (def as unknown[])
        : [];
    return {
      routeHandlers: routes as ModuleRouteHandler[],
      register: register as LoadedModule['register'],
      ...(isPlugin
        ? {
            hooks: {
              start: pick('start') as PluginHooks['start'],
              stop: pick('stop') as PluginHooks['stop'],
              upgrade: pick('upgrade') as PluginHooks['upgrade'],
            },
          }
        : {}),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[Clerq] Failed to load module entry ${p}:`, error);
    return { routeHandlers: [], error };
  }
}

/** Read one directory's manifest. Null when it is not a module: no manifest, not JSON, or no usable id. */
export function discoverOne(dir: string): DiscoveredModule | null {
  const found = loadManifest(dir);
  if (!found) return null;
  const { manifest, text } = found;
  if (hasManifestVersion(manifest)) {
    // A manifest that says it is version 1 is judged by version 1's rules. Without a usable
    // id it cannot be listed, so it is skipped with a word; with one, a problem is shown.
    if (typeof manifest.id !== 'string' || !PLUGIN_ID.test(manifest.id)) {
      console.warn(
        `[Clerq] Skipping plugin in ${dir}: "id" must be lower-case words joined by single hyphens`
      );
      return null;
    }
    const result = validateManifest(manifest);
    return result.ok
      ? {
          id: manifest.id,
          kind: 'plugin',
          manifest,
          manifestText: text,
          dir,
          plugin: result.manifest,
          manifestWarnings: result.warnings,
        }
      : {
          id: manifest.id,
          kind: 'plugin',
          manifest,
          manifestText: text,
          dir,
          problems: result.errors,
          manifestWarnings: result.warnings,
        };
  }
  if (!MODULE_ID.test(manifest.id)) {
    console.warn(
      `[Clerq] Skipping module in ${dir}: id "${manifest.id}" must be lower-case words joined by single hyphens`
    );
    return null;
  }
  return { id: manifest.id, kind: 'legacy', manifest, manifestText: text, dir };
}

/**
 * Find every module and plugin in a directory without importing any code.
 * If dir points to a single module (contains manifest.json), that one.
 * If dir points to a parent of modules, each subdirectory with a manifest.json.
 */
export function discoverModules(modulesDir?: string): DiscoveredModule[] {
  const dir = getModulesDir(modulesDir);
  if (!dir) return [];
  const found: DiscoveredModule[] = [];
  const manifestPath = path.join(dir, 'manifest.json');
  const dirs = fssync.existsSync(manifestPath)
    ? [dir]
    : fssync
        .readdirSync(dir, { withFileTypes: true })
        .filter((ent) => ent.isDirectory())
        .map((ent) => path.join(dir, ent.name))
        .sort();
  for (const d of dirs) {
    const mod = discoverOne(d);
    if (!mod) continue;
    if (found.some((m) => m.id === mod.id)) {
      console.warn(`[Clerq] Skipping module in ${d}: id "${mod.id}" is already loaded`);
      continue;
    }
    found.push(mod);
  }
  return found;
}

/**
 * Load all modules from a directory: find them, and import every server entry.
 * The gateway's host does not use this (it imports an entry only once the module
 * may run); it stays for callers that want the modules loaded as they always were.
 */
export async function loadModulesFromDir(modulesDir?: string): Promise<LoadedModule[]> {
  const loaded: LoadedModule[] = [];
  for (const d of discoverModules(modulesDir)) {
    if (d.problems) continue;
    loaded.push({
      id: d.id,
      manifest: d.manifest,
      dir: d.dir,
      kind: d.kind,
      ...(await importEntry(d)),
    });
  }
  return loaded;
}

/** `skills` for a legacy module; a plugin's manifest may name another directory. */
export function skillsDirOf(manifest: ModuleManifestStub): string {
  const named = manifest.manifestVersion !== undefined ? manifest.skills : undefined;
  return typeof named === 'string' && named.trim() !== '' ? named : 'skills';
}

/**
 * Get skills directories from loaded modules (each module's skills/ subdir).
 */
export function getModuleSkillsDirs(modules: LoadedModule[]): string[] {
  const dirs: string[] = [];
  for (const mod of modules) {
    const skillsPath = path.join(mod.dir, skillsDirOf(mod.manifest));
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
