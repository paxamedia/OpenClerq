/**
 * Manifest permissions: what a module says it needs. Parsed, stored, shown to
 * the operator and part of what they approve. They are checked against what the
 * module does through its context only when the operator has turned plugin
 * enforcement on (docs/PLUGINS.md); module code runs with the gateway's access
 * whatever it declares.
 *
 *   "permissions": {
 *     "exec": ["/usr/bin/git"],                       exact commands it runs
 *     "fs": { "read": ["~/Documents"], "write": [] },  paths
 *     "net": ["api.example.com"],                      hosts
 *     "secrets": ["api-key"],                          its vault names
 *     "services": ["org.example.worker"],              launchd labels
 *     "llm": true,                                     model calls
 *     "api": ["GET /runs/:id"],                        core endpoints
 *     "memory": { "read": ["fact"], "write": [] }      memory types
 *   }
 *
 * `GET /modules` keeps showing the first six, as it always has; `GET /plugins`
 * shows all of them.
 */

import { audit } from '@clerq/store';
import { readPermissions } from '@clerq/plugin-sdk/manifest';
import type { PluginPermissions } from '@clerq/plugin-sdk';
import { getStore } from '../store.js';
import { declarableScope } from '../security/scoped-tokens.js';

/** The permissions a module had before `api` and `memory`. */
export interface ModulePermissions {
  exec: string[];
  fs: { read: string[]; write: string[] };
  net: string[];
  secrets: string[];
  services: string[];
  llm: boolean;
}

export const NO_PERMISSIONS: ModulePermissions = {
  exec: [],
  fs: { read: [], write: [] },
  net: [],
  secrets: [],
  services: [],
  llm: false,
};

/** The first six permissions of a full set. */
export function legacyView(p: PluginPermissions): ModulePermissions {
  return {
    exec: p.exec,
    fs: { read: p.fs.read, write: p.fs.write },
    net: p.net,
    secrets: p.secrets,
    services: p.services,
    llm: p.llm,
  };
}

/** Read `manifest.permissions`, keeping what is well-formed and saying what is not. */
export function parsePermissions(manifest: Record<string, unknown>): {
  permissions: ModulePermissions;
  warnings: string[];
} {
  const { permissions, warnings } = readPermissions(manifest.permissions);
  return { permissions: legacyView(permissions), warnings };
}

/** The manifest's `coreEndpoints` that are well-formed scopes. */
export function coreEndpointsOf(manifest: Record<string, unknown>): string[] {
  const raw = manifest.coreEndpoints;
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === 'string' && declarableScope(s))
    : [];
}

/**
 * Everything a manifest declares, in full: the `permissions` object, with `api`
 * read together with the older `coreEndpoints`. This is what a person approves,
 * what `ctx.permissions` holds and what the checks use.
 */
export function declaredPermissions(manifest: Record<string, unknown>): {
  permissions: PluginPermissions;
  warnings: string[];
} {
  const { permissions, warnings } = readPermissions(manifest.permissions);
  const api = [...new Set([...permissions.api, ...coreEndpointsOf(manifest)])];
  return { permissions: { ...permissions, api }, warnings };
}

/**
 * Record a module as loaded (or failed) with what it declares. A change in
 * declared permissions since the last start goes in the audit log.
 */
export function recordModule(input: {
  id: string;
  name: string;
  version: string;
  dir: string;
  status: 'loaded' | 'failed';
  error?: string;
  permissions: ModulePermissions;
}): void {
  const db = getStore();
  const now = new Date().toISOString();
  const json = JSON.stringify(input.permissions);
  const before = db.prepare('SELECT permissions FROM modules WHERE id = ?').get(input.id);
  db.prepare(
    `INSERT INTO modules (id, name, version, dir, permissions, status, error, first_seen_at, loaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version,
       dir = excluded.dir, permissions = excluded.permissions, status = excluded.status,
       error = excluded.error, loaded_at = excluded.loaded_at`
  ).run(
    input.id,
    input.name,
    input.version,
    input.dir,
    json,
    input.status,
    input.error ?? null,
    now,
    now
  );
  if (!before || String(before.permissions) !== json) {
    audit(db, {
      actor: 'gateway',
      action: before ? 'module.permissions.changed' : 'module.installed',
      subject: input.id,
      detail: { version: input.version, permissions: input.permissions },
    });
  }
}
