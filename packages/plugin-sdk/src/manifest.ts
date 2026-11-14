/**
 * @clerq/plugin-sdk/manifest: the plugin manifest, version 1.
 *
 * A plugin is a directory with a `manifest.json`. A manifest that says
 * `"manifestVersion": 1` is checked by `validateManifest` below; one that does
 * not is a *legacy module* (see docs/MODULE_SYSTEM.md) and loads as it always
 * did. Errors are plain sentences with no line numbers, so they can be shown to
 * a person as they are.
 *
 * This file is pure: no Node APIs, so a browser can use it too. The checksum
 * and the hash of the declared permissions are in `@clerq/plugin-sdk/node`.
 */

import { SUPPORTED_API_VERSIONS } from '@clerq/gateway-client/protocol';
import type { PluginPermissions } from './index.js';

/** The manifest version this SDK reads. */
export const MANIFEST_VERSION = 1;

/** The memory types a plugin may name under `permissions.memory`. The same list as `MEMORY_TYPES` in `@clerq/policy`. */
export const MEMORY_TYPES = ['fact', 'preference', 'decision', 'procedure', 'note'] as const;

/** Lower-case words joined by single hyphens: `crm`, `crm-sync`. It is also a URL segment and a table prefix. */
export const PLUGIN_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Ids a plugin may not take: `core` is the prefix of the shared records' refs. */
export const RESERVED_IDS: readonly string[] = ['core'];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `METHOD /path`, where METHOD may be `*`, a `:name` segment is any one segment, and a trailing `/*` is anything below. */
export const API_SCOPE = /^(GET|POST|PUT|PATCH|DELETE|\*) (\/[^\s]*)$/;

const SERVICE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What an author writes under `permissions`: every key is optional. */
export interface PluginPermissionsInput {
  exec?: string[];
  fs?: { read?: string[]; write?: string[] };
  net?: string[];
  secrets?: string[];
  services?: string[];
  llm?: boolean;
  api?: string[];
  memory?: { read?: string[]; write?: string[] };
}

/** A manifest as an author writes it. */
export interface PluginManifestInput {
  manifestVersion: 1;
  /** Lower-case words joined by single hyphens. */
  id: string;
  name: string;
  /** Semantic version: `1.2.3`. */
  version: string;
  description: string;
  /** What the plugin needs of OpenClerq. `api` is the API version (`API_VERSION` in `@clerq/gateway-client`). */
  engines: { api: number };
  /** Paths relative to the plugin's directory. */
  entry?: {
    /** One self-contained ES module that exports `definePlugin({ ... })` as its default. */
    server?: string;
    /** A directory served at `/api/modules/<id>/ui/`, with an `index.html`. */
    ui?: string;
  };
  /** A directory of `SKILL.md` files. */
  skills?: string;
  /** Defaults for `ctx.config`. */
  config?: Record<string, unknown>;
  /** launchd agents the plugin may start and stop. */
  services?: Array<string | { label: string; name?: string; plist?: string }>;
  /** What the plugin needs. Required, even when it is `{}`: say that it needs nothing. */
  permissions: PluginPermissionsInput;
  /** What the plugin adds to the shell (`nav`, `home.tile`, `record.panel`, …); see docs/MODULE_SYSTEM.md. */
  extensions?: Record<string, unknown>;
}

export interface PluginServiceDecl {
  label: string;
  name?: string;
  plist?: string;
}

/** A manifest that passed `validateManifest`, with its permissions in full. */
export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  engines: { api: number };
  entry: { server?: string; ui?: string };
  skills?: string;
  config: Record<string, unknown>;
  services: PluginServiceDecl[];
  permissions: PluginPermissions;
  extensions?: Record<string, unknown>;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Whether a manifest says it is version 1 or later; without the key it is a legacy module. */
export function hasManifestVersion(raw: unknown): boolean {
  return isObject(raw) && raw.manifestVersion !== undefined;
}

export const EMPTY_PERMISSIONS: PluginPermissions = Object.freeze({
  exec: [],
  fs: Object.freeze({ read: [], write: [] }),
  net: [],
  secrets: [],
  services: [],
  llm: false,
  api: [],
  memory: Object.freeze({ read: [], write: [] }),
}) as PluginPermissions;

const KNOWN_PERMISSIONS = new Set([
  'exec',
  'fs',
  'net',
  'secrets',
  'services',
  'llm',
  'api',
  'memory',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown, where: string, warnings: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnings.push(`permissions.${where} should be a list of strings.`);
    return [];
  }
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (out.length !== v.length)
    warnings.push(`permissions.${where} has entries that are not strings.`);
  return [...new Set(out.map((x) => x.trim()))];
}

/** Whether `METHOD /path` names part of the API: its first segment is fixed, not `*` or `:name`. */
export function declarableApi(scope: string): boolean {
  const m = API_SCOPE.exec(scope);
  if (!m) return false;
  const first = m[2].split('/').filter(Boolean)[0];
  return first !== undefined && first !== '*' && !first.startsWith(':');
}

/**
 * Read a `permissions` value, keeping what is well formed and saying what is
 * not. Never throws. The messages are the ones a legacy module has always had,
 * in the same order, plus those for `api` and `memory`.
 */
export function readPermissions(raw: unknown): {
  permissions: PluginPermissions;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (raw === undefined) return { permissions: EMPTY_PERMISSIONS, warnings };
  if (!isObject(raw)) {
    return { permissions: EMPTY_PERMISSIONS, warnings: ['permissions should be an object.'] };
  }
  const p = raw;
  for (const key of Object.keys(p)) {
    if (!KNOWN_PERMISSIONS.has(key)) warnings.push(`permissions.${key} is not a known permission.`);
  }
  const fs = (p.fs ?? {}) as Record<string, unknown>;
  if (p.fs !== undefined && (typeof p.fs !== 'object' || Array.isArray(p.fs))) {
    warnings.push('permissions.fs should be { "read": [...], "write": [...] }.');
  }
  if (p.llm !== undefined && typeof p.llm !== 'boolean')
    warnings.push('permissions.llm should be true or false.');
  const permissions: PluginPermissions = {
    exec: strings(p.exec, 'exec', warnings),
    fs: {
      read: strings(typeof p.fs === 'object' ? fs.read : undefined, 'fs.read', warnings),
      write: strings(typeof p.fs === 'object' ? fs.write : undefined, 'fs.write', warnings),
    },
    net: strings(p.net, 'net', warnings),
    secrets: strings(p.secrets, 'secrets', warnings),
    services: strings(p.services, 'services', warnings),
    llm: p.llm === true,
    api: strings(p.api, 'api', warnings).filter((s) => {
      if (declarableApi(s)) return true;
      warnings.push(
        `permissions.api "${s}" is not a method and path with a fixed first segment, like "GET /runs/:id".`
      );
      return false;
    }),
    memory: { read: [], write: [] },
  };
  if (p.memory !== undefined) {
    if (!isObject(p.memory)) {
      warnings.push('permissions.memory should be { "read": [...], "write": [...] }.');
    } else {
      const known: readonly string[] = MEMORY_TYPES;
      for (const kind of ['read', 'write'] as const) {
        permissions.memory[kind] = strings(p.memory[kind], `memory.${kind}`, warnings).filter(
          (t) => {
            if (known.includes(t)) return true;
            warnings.push(
              `permissions.memory.${kind} names "${t}", which is not a memory type (${MEMORY_TYPES.join(', ')}).`
            );
            return false;
          }
        );
      }
      for (const key of Object.keys(p.memory)) {
        if (key !== 'read' && key !== 'write') {
          warnings.push(`permissions.memory.${key} is not a known permission.`);
        }
      }
    }
  }
  return { permissions, warnings };
}

/** Permissions with every list sorted and free of repeats, so two that mean the same are equal. */
export function canonicalPermissions(p: PluginPermissions): PluginPermissions {
  const list = (xs: readonly string[]) => [...new Set(xs)].sort();
  return {
    exec: list(p.exec),
    fs: { read: list(p.fs.read), write: list(p.fs.write) },
    net: list(p.net),
    secrets: list(p.secrets),
    services: list(p.services),
    llm: p.llm === true,
    api: list(p.api),
    memory: { read: list(p.memory.read), write: list(p.memory.write) },
  };
}

/** A relative path that stays inside the plugin: not absolute, no `..`, no NUL. */
export function relativePathProblem(p: string): string | null {
  if (p.trim() === '') return 'is empty';
  if (p.includes('\0')) return 'has a NUL character';
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) {
    return 'is not relative to the plugin directory';
  }
  if (p.split(/[\\/]/).some((s) => s === '..')) return 'leaves the plugin directory with ".."';
  return null;
}

/** Whether `api` is a version this OpenClerq serves; otherwise a plain sentence saying why not. */
export function engineProblem(
  api: number,
  supported: readonly number[] = SUPPORTED_API_VERSIONS
): string | null {
  if (supported.includes(api)) return null;
  const serves =
    supported.length === 1
      ? `version ${supported[0]}`
      : `versions ${supported.slice(0, -1).join(', ')} and ${supported[supported.length - 1]}`;
  const newest = Math.max(...supported);
  return api > newest
    ? `This plugin needs OpenClerq API version ${api}, and this OpenClerq serves ${serves}. Update OpenClerq, or use an older release of the plugin.`
    : `This plugin was written for OpenClerq API version ${api}, which this OpenClerq no longer serves (it serves ${serves}). Ask the plugin's author for a newer release.`;
}

const TOP_LEVEL = new Set([
  'manifestVersion',
  'id',
  'name',
  'version',
  'description',
  'engines',
  'entry',
  'skills',
  'config',
  'services',
  'permissions',
  'extensions',
]);

/** Fields people put in a manifest out of habit; they are allowed and ignored. */
const INFORMATIONAL = new Set([
  '$schema',
  'author',
  'license',
  'homepage',
  'repository',
  'keywords',
  'bugs',
]);

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  errors: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(
        `"${where}.${key}" is not something this OpenClerq knows. A newer plugin may need a newer OpenClerq.`
      );
    }
  }
}

/**
 * Check a parsed `manifest.json` that says `"manifestVersion": 1`. Never throws.
 * It checks the manifest's shape, not what is on disk (that the entry files exist is
 * the gateway's job) and not whether this OpenClerq serves `engines.api` (see `engineProblem`).
 */
export function validateManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(raw)) {
    return { ok: false, errors: ['The manifest must be a JSON object.'], warnings };
  }

  const mv = raw.manifestVersion;
  if (mv !== MANIFEST_VERSION) {
    errors.push(
      typeof mv === 'number' && Number.isInteger(mv) && mv > MANIFEST_VERSION
        ? `This plugin was written for manifest version ${mv}; this OpenClerq reads version ${MANIFEST_VERSION}.`
        : `"manifestVersion" must be ${MANIFEST_VERSION}.`
    );
  }

  const id = raw.id;
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
    errors.push(
      '"id" must be lower-case words joined by single hyphens, starting with a letter, like "my-plugin".'
    );
  } else if (id.length > 64) {
    errors.push('"id" must be 64 characters or fewer.');
  } else if (RESERVED_IDS.includes(id)) {
    errors.push(`"id" cannot be "${id}": that name is kept for OpenClerq itself.`);
  }

  const text = (key: 'name' | 'description', max: number) => {
    const v = raw[key];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`"${key}" must be a sentence.`);
    else if (v.length > max) errors.push(`"${key}" must be ${max} characters or fewer.`);
  };
  text('name', 100);
  text('description', 500);

  if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) {
    errors.push('"version" must be a semantic version such as "1.2.3".');
  }

  let api = 0;
  if (!isObject(raw.engines)) {
    errors.push(
      '"engines" is required and must say which API version the plugin needs: { "api": 1 }.'
    );
  } else {
    checkKeys(raw.engines, ['api'], 'engines', errors);
    const a = raw.engines.api;
    if (typeof a !== 'number' || !Number.isInteger(a) || a < 1) {
      errors.push('"engines.api" must be a whole number of 1 or more, such as 1.');
    } else {
      api = a;
    }
  }

  const entry: { server?: string; ui?: string } = {};
  if (raw.entry !== undefined) {
    if (!isObject(raw.entry)) {
      errors.push('"entry" must be an object: { "server": "dist/server.js", "ui": "dist/ui" }.');
    } else {
      checkKeys(raw.entry, ['server', 'ui'], 'entry', errors);
      for (const key of ['server', 'ui'] as const) {
        const v = raw.entry[key];
        if (v === undefined) continue;
        const problem = typeof v === 'string' ? relativePathProblem(v) : 'is not a path';
        if (problem) errors.push(`"entry.${key}" ${problem}.`);
        else entry[key] = (v as string).replace(/\\/g, '/');
      }
    }
  }

  let skills: string | undefined;
  if (raw.skills !== undefined) {
    const problem =
      typeof raw.skills === 'string' ? relativePathProblem(raw.skills) : 'is not a path';
    if (problem) errors.push(`"skills" ${problem}.`);
    else skills = (raw.skills as string).replace(/\\/g, '/');
  }

  let config: Record<string, unknown> = {};
  if (raw.config !== undefined) {
    if (!isObject(raw.config)) errors.push('"config" must be an object of default settings.');
    else config = raw.config;
  }

  const services: PluginServiceDecl[] = [];
  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services)) {
      errors.push('"services" must be a list of launchd labels, or of { "label": "…" } objects.');
    } else {
      for (const s of raw.services) {
        const label = typeof s === 'string' ? s : isObject(s) ? s.label : undefined;
        if (typeof label !== 'string' || !SERVICE_LABEL.test(label)) {
          errors.push(
            '"services" has an entry without a usable label (letters, digits, ".", "_" and "-").'
          );
          continue;
        }
        const decl: PluginServiceDecl = { label };
        if (isObject(s)) {
          if (typeof s.name === 'string') decl.name = s.name;
          if (typeof s.plist === 'string') decl.plist = s.plist;
        }
        services.push(decl);
      }
    }
  }

  let permissions = EMPTY_PERMISSIONS;
  if (raw.permissions === undefined) {
    errors.push(
      '"permissions" is required. Say what the plugin needs, or write { } to say it needs nothing.'
    );
  } else if (!isObject(raw.permissions)) {
    errors.push('"permissions" must be an object.');
  } else {
    const read = readPermissions(raw.permissions);
    permissions = read.permissions;
    // A legacy module may carry a slip in its permissions; a plugin may not, because
    // what is declared is what the person approves.
    errors.push(...read.warnings);
    for (const h of permissions.net) {
      if (/[/\s]/.test(h) || h.includes('://')) {
        errors.push(
          `permissions.net lists hosts, not addresses: write "api.example.com", not "${h}".`
        );
      }
    }
    const labels = new Set(services.map((s) => s.label));
    for (const l of permissions.services) {
      if (!labels.has(l)) {
        warnings.push(
          `permissions.services lists "${l}", which is not under "services", so it cannot be started or stopped.`
        );
      }
    }
    for (const l of labels) {
      if (!permissions.services.includes(l)) {
        warnings.push(
          `"services" lists "${l}", which permissions.services does not: with enforcement on it cannot be started or stopped.`
        );
      }
    }
  }

  if (raw.extensions !== undefined && !isObject(raw.extensions)) {
    errors.push('"extensions" must be an object.');
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key) && !INFORMATIONAL.has(key)) {
      warnings.push(`"${key}" is not a field of manifest version 1 and is ignored.`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    manifest: {
      manifestVersion: 1,
      id: raw.id as string,
      name: (raw.name as string).trim(),
      version: raw.version as string,
      description: (raw.description as string).trim(),
      engines: { api },
      entry,
      ...(skills ? { skills } : {}),
      config,
      services,
      permissions,
      ...(isObject(raw.extensions) ? { extensions: raw.extensions } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Permissions in words

export type PermissionKey =
  | 'exec'
  | 'fs.read'
  | 'fs.write'
  | 'net'
  | 'secrets'
  | 'services'
  | 'llm'
  | 'api'
  | 'memory.read'
  | 'memory.write';

export interface PermissionLine {
  key: PermissionKey;
  /** A short heading: "Run programs". */
  label: string;
  /** A sentence that says what the plugin may do. */
  summary: string;
  /** The declared values: commands, folders, hosts, names. Empty for `llm`. */
  items: string[];
}

/** Every permission a plugin declares, in plain words; nothing for what it leaves out. */
export function describePermissions(p: PluginPermissions): PermissionLine[] {
  const lines: PermissionLine[] = [];
  const add = (key: PermissionKey, label: string, summary: string, items: string[]) => {
    if (items.length > 0 || key === 'llm') lines.push({ key, label, summary, items });
  };
  add('exec', 'Run programs', 'Run these programs on this computer, as you.', p.exec);
  add('fs.read', 'Read files', 'Read the files inside these folders.', p.fs.read);
  add('fs.write', 'Change files', 'Create and change the files inside these folders.', p.fs.write);
  add('net', 'Use the network', 'Connect to these hosts.', p.net);
  add('secrets', 'Use secrets', 'Read and change these secrets in your vault.', p.secrets);
  add(
    'services',
    'Control background services',
    'Start and stop these background services.',
    p.services
  );
  if (p.llm) add('llm', 'Use AI models', 'Call AI models, which can cost money.', []);
  add('api', 'Call OpenClerq', 'Call these parts of the OpenClerq API.', p.api);
  add('memory.read', 'Read memory', 'Read these kinds of memory notes.', p.memory.read);
  add(
    'memory.write',
    'Write memory',
    'Add and change these kinds of memory notes.',
    p.memory.write
  );
  return lines;
}

/** Whether a plugin declares no permission at all. */
export function declaresNothing(p: PluginPermissions): boolean {
  return describePermissions(p).length === 0;
}

export interface PermissionChange {
  change: 'added' | 'removed';
  key: PermissionKey;
  /** The value that came or went; empty for `llm`. */
  item: string;
  /** "Can now: Connect to api.example.com", "Can no longer: …". */
  text: string;
}

/** The order permissions are listed and compared in. */
const PERMISSION_ORDER: readonly PermissionKey[] = [
  'exec',
  'fs.read',
  'fs.write',
  'net',
  'secrets',
  'services',
  'llm',
  'api',
  'memory.read',
  'memory.write',
];

const VERB: Record<PermissionKey, string> = {
  exec: 'run',
  'fs.read': 'read files in',
  'fs.write': 'change files in',
  net: 'connect to',
  secrets: 'use the secret',
  services: 'control the service',
  llm: 'use AI models',
  api: 'call',
  'memory.read': 'read memory notes of type',
  'memory.write': 'write memory notes of type',
};

/** What a plugin's declared permissions gained and lost between two versions of its manifest. */
export function diffPermissions(
  before: PluginPermissions,
  after: PluginPermissions
): PermissionChange[] {
  const out: PermissionChange[] = [];
  const a = describePermissions(canonicalPermissions(before));
  const b = describePermissions(canonicalPermissions(after));
  for (const key of PERMISSION_ORDER) {
    const was = a.find((l) => l.key === key)?.items ?? [];
    const now = b.find((l) => l.key === key)?.items ?? [];
    const one = (change: 'added' | 'removed', item: string) =>
      out.push({
        change,
        key,
        item,
        text: `${change === 'added' ? 'Can now' : 'Can no longer'} ${VERB[key]}${item ? ` ${item}` : ''}`,
      });
    if (key === 'llm') {
      if (!a.some((l) => l.key === 'llm') && b.some((l) => l.key === 'llm')) one('added', '');
      if (a.some((l) => l.key === 'llm') && !b.some((l) => l.key === 'llm')) one('removed', '');
      continue;
    }
    for (const item of now) if (!was.includes(item)) one('added', item);
    for (const item of was) if (!now.includes(item)) one('removed', item);
  }
  return out;
}
