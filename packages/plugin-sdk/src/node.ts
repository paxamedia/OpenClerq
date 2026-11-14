/**
 * @clerq/plugin-sdk/node: what needs the file system or `node:crypto`: the
 * checksum of a plugin's code, and the hash of what it declares.
 *
 * The gateway computes both when it loads a plugin, and a person approves a
 * plugin by naming the two values they reviewed, so what ran is what was
 * approved. An author can compute them too, to see what a user will be asked to
 * approve:
 *
 * ```ts
 * import { pluginChecksum } from '@clerq/plugin-sdk/node';
 * console.log(pluginChecksum('./my-plugin'));
 * ```
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginPermissions } from './index.js';
import { canonicalPermissions } from './manifest.js';

export {
  readSkillDir,
  skillChecksum,
  SkillFilesError,
  writeSkillChecksum,
  SKILL_MAX_BYTES,
  SKILL_MAX_FILES,
  type SkillFile,
  type SkillRead,
} from './skill-node.js';

/** Raised with a sentence that can be shown as it is. */
export class PluginFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginFilesError';
  }
}

/** Names the operating system adds to a folder on its own; they are not the plugin's. */
const IGNORED = (name: string) =>
  name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' || name.startsWith('._');

const MAX_FILES = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;

/** The legacy server entry candidates, in the order the gateway tries them. */
const LEGACY_ENTRIES = ['dist/routes.js', 'dist/routes.cjs', 'build/routes.js'];

const sha = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');

export interface ManifestFile {
  /** The file exactly as it is on disk. */
  text: string;
  json: Record<string, unknown>;
}

/** Read `<dir>/manifest.json`. Throws `PluginFilesError` when it is missing or not JSON. */
export function readManifestFile(dir: string): ManifestFile {
  const file = path.join(dir, 'manifest.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PluginFilesError(`There is no manifest.json in ${dir}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PluginFilesError('manifest.json is not valid JSON.');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new PluginFilesError('manifest.json must be a JSON object.');
  }
  return { text, json: json as Record<string, unknown> };
}

/**
 * The folder an entry file lives in, as the path whose whole tree is code (`dist` for
 * `dist/server.js`), or the file itself when it sits at the plugin's root: the whole plugin
 * folder is not code, so a root-level entry covers only itself.
 */
function entryTree(entry: string): string {
  const parts = entry.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0];
}

/**
 * The paths under a plugin's directory whose files are its code, relative and with `/`: the
 * **whole folder tree** the server entry is in (`dist` for `dist/server.js`; so what the entry
 * imports from its own folder is covered), the UI folder, the skills folder and `migrations`,
 * which run against the store. For a legacy module the entry is `entryPoints.routes` or the
 * default `dist/routes.js`, `dist/routes.cjs` and `build/routes.js`, the UI `dist/ui` and the
 * skills `skills`. Nothing else is code, and nothing else is copied when a plugin is staged.
 */
export function codePaths(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (manifest.manifestVersion !== undefined) {
    const entry = (manifest.entry ?? {}) as Record<string, unknown>;
    if (text(entry.server)) out.push(entryTree(entry.server));
    if (text(entry.ui)) out.push(entry.ui);
    if (text(manifest.skills)) out.push(manifest.skills);
  } else {
    const ep = (manifest.entryPoints ?? {}) as Record<string, unknown>;
    const declared = Array.isArray(ep.routes) ? ep.routes.filter(text) : [];
    out.push(
      ...(declared.length > 0 ? declared : LEGACY_ENTRIES).map(entryTree),
      'dist/ui',
      'skills'
    );
  }
  out.push('migrations');
  return [...new Set(out.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')))];
}

export interface ChecksumDetail {
  /** SHA-256, hex. */
  checksum: string;
  /** Every file it covers, by path, with its own SHA-256. A named path that does not exist covers nothing. */
  files: Array<{ path: string; sha256: string }>;
}

/**
 * The checksum of a plugin: a SHA-256 over its `manifest.json` and every file
 * under the paths its manifest names as code (see `codePaths`: the server entry's
 * whole folder, the UI, the skills and the migrations), by path. It changes when
 * any of those files changes, appears or goes. Files the operating system adds on
 * its own (`.DS_Store`, `Thumbs.db`) are not counted.
 *
 * It covers those folders and nothing outside them. The host copies exactly these
 * files, as hashed, and runs and serves the plugin from the copy.
 *
 * `manifestText` is the manifest the caller already read, so the value is of the
 * text it validated and not of a file that changed in between.
 */
export function pluginChecksumDetail(
  dir: string,
  opts: { manifestText?: string; manifest?: Record<string, unknown> } = {}
): ChecksumDetail {
  const root = path.resolve(dir);
  const manifestFile = opts.manifestText === undefined ? readManifestFile(root) : null;
  const text = opts.manifestText ?? (manifestFile as ManifestFile).text;
  const json = opts.manifest ?? manifestFile?.json ?? (JSON.parse(text) as Record<string, unknown>);

  const files = new Map<string, string>();
  files.set('manifest.json', sha(text));
  let count = 0;
  let bytes = 0;
  const seen = new Set<string>();

  const add = (rel: string, abs: string) => {
    if (files.has(rel)) return;
    if (++count > MAX_FILES) {
      throw new PluginFilesError(
        `The plugin has more than ${MAX_FILES} files under its code paths.`
      );
    }
    const data = fs.readFileSync(abs);
    bytes += data.length;
    if (bytes > MAX_BYTES) {
      throw new PluginFilesError('The plugin has more than 64 MiB of files under its code paths.');
    }
    files.set(rel, sha(data));
  };

  const walk = (rel: string, abs: string, depth: number) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (depth > MAX_DEPTH) throw new PluginFilesError(`${rel} is nested too deeply.`);
      const real = fs.realpathSync(abs);
      // A link back to a folder already walked would go round forever.
      if (seen.has(real)) return;
      seen.add(real);
      for (const name of fs.readdirSync(abs).sort()) {
        if (IGNORED(name)) continue;
        walk(`${rel}/${name}`, path.join(abs, name), depth + 1);
      }
      seen.delete(real);
    } else if (stat.isFile()) {
      add(rel, abs);
    }
  };

  for (const rel of codePaths(json)) {
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new PluginFilesError(`"${rel}" is outside the plugin directory.`);
    }
    if (fs.existsSync(abs)) walk(rel, abs, 0);
  }

  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = crypto.createHash('sha256');
  h.update('clerq-plugin-checksum-v1\n');
  for (const [p, digest] of sorted) h.update(`${p}\0${digest}\n`);
  return {
    checksum: h.digest('hex'),
    files: sorted.map(([p, digest]) => ({ path: p, sha256: digest })),
  };
}

/** The checksum of the plugin in `dir`. See {@link pluginChecksumDetail}. */
export function pluginChecksum(dir: string): string {
  return pluginChecksumDetail(dir).checksum;
}

/**
 * A SHA-256 of what a plugin declares: the same for permissions that mean the
 * same, whatever their order or repeats. A person approves this value together
 * with the checksum.
 */
export function permissionsHash(p: PluginPermissions): string {
  return sha(JSON.stringify(canonicalPermissions(p)));
}
