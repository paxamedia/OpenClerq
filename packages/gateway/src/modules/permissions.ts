/**
 * Manifest permissions: what a module says it needs. Parsed, stored and shown
 * to the operator; not enforced yet. Module code runs with the gateway's
 * access whatever it declares.
 *
 *   "permissions": {
 *     "exec": ["/usr/bin/git"],                       exact commands it runs
 *     "fs": { "read": ["~/Documents"], "write": [] },  paths
 *     "net": ["api.example.com"],                      hosts
 *     "secrets": ["api-key"],                          its vault names
 *     "services": ["org.example.worker"],              launchd labels
 *     "llm": true                                      model calls
 *   }
 */

import { audit } from '@clerq/store';
import { getStore } from '../store.js';

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

const KNOWN = new Set(['exec', 'fs', 'net', 'secrets', 'services', 'llm']);

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

/** Read `manifest.permissions`, keeping what is well-formed and saying what is not. */
export function parsePermissions(manifest: Record<string, unknown>): {
  permissions: ModulePermissions;
  warnings: string[];
} {
  const raw = manifest.permissions;
  const warnings: string[] = [];
  if (raw === undefined) return { permissions: NO_PERMISSIONS, warnings };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { permissions: NO_PERMISSIONS, warnings: ['permissions should be an object.'] };
  }
  const p = raw as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!KNOWN.has(key)) warnings.push(`permissions.${key} is not a known permission.`);
  }
  const fs = (p.fs ?? {}) as Record<string, unknown>;
  if (p.fs !== undefined && (typeof p.fs !== 'object' || Array.isArray(p.fs))) {
    warnings.push('permissions.fs should be { "read": [...], "write": [...] }.');
  }
  if (p.llm !== undefined && typeof p.llm !== 'boolean')
    warnings.push('permissions.llm should be true or false.');
  return {
    permissions: {
      exec: strings(p.exec, 'exec', warnings),
      fs: {
        read: strings(typeof p.fs === 'object' ? fs.read : undefined, 'fs.read', warnings),
        write: strings(typeof p.fs === 'object' ? fs.write : undefined, 'fs.write', warnings),
      },
      net: strings(p.net, 'net', warnings),
      secrets: strings(p.secrets, 'secrets', warnings),
      services: strings(p.services, 'services', warnings),
      llm: p.llm === true,
    },
    warnings,
  };
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
