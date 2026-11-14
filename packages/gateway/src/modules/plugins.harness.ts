/**
 * Test harness for the plugin lifecycle: scratch plugin folders, a gateway over
 * them, and the calls a test makes. Not part of the gateway.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway, type Gateway } from '../gateway.js';
import type { GatewayConfig } from '../types.js';
import { getStore } from '../store.js';

export const TOKEN = 'plugins-test-token-0123456789';

const VARS = [
  'HOME',
  'USERPROFILE',
  'CLERQ_KEYCHAIN',
  'CLERQ_VAULT_KEY',
  'CLERQ_MODULES_DIR',
  'CLERQ_LAUNCHCTL',
];

export interface Scratch {
  home: string;
  modules: string;
  db: string;
  cleanup(): void;
}

/** A scratch HOME (so the vault, module config and tokens never touch the real ones) and a modules folder. */
export function scratch(): Scratch {
  const saved: Record<string, string | undefined> = {};
  for (const v of VARS) saved[v] = process.env[v];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-plugins-'));
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  delete process.env.CLERQ_VAULT_KEY;
  delete process.env.CLERQ_MODULES_DIR;
  process.env.CLERQ_KEYCHAIN = 'off';
  const modules = path.join(home, 'modules');
  fs.mkdirSync(modules, { recursive: true });
  // Never the real launchctl: this one knows no agents and records its calls.
  const fake = path.join(home, 'launchctl');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${home}/launchctl.log"\nexit 113\n`, {
    mode: 0o755,
  });
  process.env.CLERQ_LAUNCHCTL = fake;
  (globalThis as Record<string, unknown>).__plugins = {};
  return {
    home,
    modules,
    db: path.join(home, 'clerq.db'),
    cleanup() {
      for (const v of VARS) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v];
      }
      fs.rmSync(home, { recursive: true, force: true });
      delete (globalThis as Record<string, unknown>).__plugins;
    },
  };
}

/** What the plugins under test did, by plugin id, in order. */
export function events(id: string): string[] {
  const all = (globalThis as { __plugins?: Record<string, string[]> }).__plugins ?? {};
  return (all[id] ??= []);
}

export interface PluginSpec {
  id: string;
  version?: string;
  /** Merged over the manifest. */
  manifest?: Record<string, unknown>;
  /** The permissions object. */
  permissions?: Record<string, unknown>;
  /** The body of the default export: hooks and anything above them. */
  hooks?: string;
  /** Code above the export. */
  top?: string;
  /** More files, by path. */
  files?: Record<string, string>;
  /** Write no server entry. */
  noServer?: boolean;
}

/**
 * Write a plugin folder. The default server entry records what the host did in
 * `globalThis.__plugins[id]` (`import`, `register`, `start`, `stop`, `upgrade:<from>`) and
 * serves `GET /hi`.
 */
export function writePlugin(root: string, spec: PluginSpec): string {
  const dir = path.join(root, spec.id);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const manifest = {
    manifestVersion: 1,
    id: spec.id,
    name: `Plugin ${spec.id}`,
    version: spec.version ?? '1.0.0',
    description: 'A plugin made for a test.',
    engines: { api: 1 },
    ...(spec.noServer ? {} : { entry: { server: 'dist/server.js' } }),
    permissions: spec.permissions ?? {},
    ...spec.manifest,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (!spec.noServer) {
    fs.writeFileSync(
      path.join(dir, 'dist', 'server.js'),
      `const log = ((globalThis.__plugins ??= {})[${JSON.stringify(spec.id)}] ??= []);
log.push('import');
${spec.top ?? ''}
export default {
  ${
    spec.hooks ??
    `register(ctx) {
    log.push('register');
    ctx.routes.get('/hi', (_req, res) => res.json({ ok: true, id: ctx.id, version: ctx.version }));
  },
  start() { log.push('start'); },
  stop() { log.push('stop'); },
  upgrade(_ctx, { from }) { log.push('upgrade:' + from); },`
  }
};
`
    );
  }
  for (const [rel, text] of Object.entries(spec.files ?? {})) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

export interface Running {
  gw: Gateway;
  base: string;
  /** A call with the gateway token (or `token`, or none with `null`). */
  api(p: string, init?: RequestInit, token?: string | null): Promise<Response>;
  json<T = Record<string, unknown>>(p: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

/** A gateway over `modulesDir`, with its database in a file so a second start remembers the first. */
export async function startGateway(
  s: Scratch,
  config: Partial<GatewayConfig> = {}
): Promise<Running> {
  const gw = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: s.db,
    skillsDir: path.join(s.home, 'skills'),
    modulesDir: s.modules,
    ...config,
  });
  await gw.ready;
  const addr = gw.server.address();
  const base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
  const api = (p: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  return {
    gw,
    base,
    api,
    async json<T>(p: string, init?: RequestInit) {
      return (await (await api(p, init)).json()) as T;
    },
    close: () => gw.close({ graceMs: 500 }),
  };
}

/** Turn enforcement on in the database before any plugin is loaded. */
export async function seedEnforce(s: Scratch, on = true): Promise<void> {
  const quiet = fs.mkdtempSync(path.join(s.home, 'empty-'));
  const gw = await startGateway(s, { modulesDir: quiet });
  await gw.api('/plugins/settings', { method: 'PUT', body: JSON.stringify({ enforce: on }) });
  await gw.close();
}

export interface PluginRowJson {
  id: string;
  state: string;
  reason: string | null;
  kind: string;
  permissionsHash: string | null;
  checksum: string | null;
  switchedOff: boolean;
  warnings: string[];
  needsRestart: boolean;
  approval: {
    status: string;
    approvedBy: string | null;
    approvedVersion: string | null;
    changes: { code: boolean; permissions: boolean; version: boolean };
    permissionChanges: Array<{ text: string }>;
  };
  permissions: Record<string, unknown>;
}

export async function listPlugins(r: Running): Promise<Record<string, PluginRowJson>> {
  const { plugins } = await r.json<{ plugins: PluginRowJson[] }>('/plugins');
  return Object.fromEntries(plugins.map((p) => [p.id, p]));
}

/** The audit rows whose action starts with `prefix`, oldest first. */
export function auditRows(prefix: string): Array<{
  action: string;
  actor: string;
  subject: string | null;
  detail: Record<string, unknown>;
}> {
  return getStore()
    .prepare(
      'SELECT action, actor, subject, detail FROM audit_log WHERE action LIKE ? ORDER BY rowid'
    )
    .all(`${prefix}%`)
    .map((r) => ({
      action: String(r.action),
      actor: String(r.actor),
      subject: r.subject === null ? null : String(r.subject),
      detail: r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : {},
    }));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
