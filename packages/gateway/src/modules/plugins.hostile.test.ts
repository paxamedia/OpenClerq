/**
 * Hostile plugins going around the context: raw SQL on the gateway's own tables, and a command steered
 * to the plugin's own script. They run with enforcement on where that is the point.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStore } from '../store.js';
import {
  auditRows,
  listPlugins,
  scratch,
  seedEnforce,
  startGateway,
  writePlugin,
  type Running,
  type Scratch,
} from './plugins.harness.js';

let s: Scratch;
let running: Running | undefined;

beforeEach(() => {
  s = scratch();
});

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  s.cleanup();
});

const start = async (config = {}) => (running = await startGateway(s, config));

async function approve(gw: Running, id: string) {
  const p = (await listPlugins(gw))[id];
  const res = await gw.api(`/plugins/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
  });
  expect(res.status).toBe(200);
}

describe('SQL through ctx.store', () => {
  const SQL = `
  register(ctx) {
    const run = (name, fn) => ctx.routes.get('/' + name, async (req, res) => {
      try { res.json({ ok: true, value: await fn(req.query) }); }
      catch (e) { res.json({ ok: false, name: e.name, code: e.code, permission: e.permission, subject: e.subject, message: String(e.message) }); }
    });
    run('exec', (q) => { ctx.store.exec(q.sql); return true; });
    run('all', (q) => ctx.store.prepare(q.sql).all());
    run('own', () => { ctx.store.exec("INSERT INTO mod_sql__notes (note, tenant_id) VALUES ('hi', 'default')"); return ctx.store.prepare('SELECT note FROM mod_sql__notes WHERE note LIKE ?').all('h%').length; });
  },`;

  const install = () =>
    writePlugin(s.modules, {
      id: 'sql',
      hooks: SQL,
      files: {
        'migrations/0001_notes.sql':
          'CREATE TABLE mod_sql__notes (id INTEGER PRIMARY KEY, note TEXT);',
      },
    });
  const victim = () => writePlugin(s.modules, { id: 'victim' });

  type Out = {
    ok: boolean;
    permission?: string;
    subject?: string;
    code?: string;
    message?: string;
  };
  const call = async (gw: Running, route: string, sql?: string) =>
    (await gw.json<Out>(
      `/api/modules/sql/${route}${sql ? `?sql=${encodeURIComponent(sql)}` : ''}`
    )) as Out;
  const setting = () =>
    getStore().prepare("SELECT value FROM settings WHERE key = 'plugins.enforce'").get()?.value;

  const NAMING = [
    ["UPDATE settings SET value='false' WHERE key='plugins.enforce'", 'settings'],
    ['UPDATE "settings" SET value=\'false\'', 'settings'],
    ["UPDATE [settings] SET value='false'", 'settings'],
    ["UPDATE `settings` SET value='false'", 'settings'],
    ["UPDATE 'settings' SET value='false'", 'settings'],
    ["UPDATE main.settings SET value='false'", 'settings'],
    ["UPDATE SeTtInGs SET value='false'", 'settings'],
    ["UPDATE /* hidden */ settings SET value='false'", 'settings'],
    ['UPDATE "Settings" SET value=\'false\'', 'settings'],
    [
      "UPDATE plugin_state SET approved_checksum='x', approved_permissions_hash='y' WHERE id='victim'",
      'plugin_state',
    ],
    ['SELECT * FROM plugin_state', 'plugin_state'],
    ['SELECT * FROM sqlite_master', 'sqlite_master'],
    ['SELECT note FROM mod_sql__notes WHERE id IN (SELECT id FROM runs)', 'runs'],
    ['DELETE FROM audit_log', 'audit_log'],
  ] as const;

  it.each(NAMING)('refuses `%s` when enforcement is on, and audits it', async (sql, table) => {
    install();
    victim();
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'sql');
    const exec = await call(gw, /^select/i.test(sql) ? 'all' : 'exec', sql);
    expect(exec).toMatchObject({
      ok: false,
      code: 'plugin_permission_denied',
      permission: 'store',
      subject: table,
    });
    expect(exec.message).toContain('may name only its own tables (mod_sql__*)');
    expect(setting()).toBe('true');
    expect(
      auditRows('plugin.permission.denied').filter((r) => r.detail.permission === 'store').length
    ).toBeGreaterThanOrEqual(1);
    // The setting and the approvals are untouched.
    expect(await gw.json('/plugins/settings')).toEqual({ enforce: true });
    expect((await listPlugins(gw)).victim.approval.status).toBe('not_approved');
  });

  it('refuses ATTACH, DETACH, PRAGMA and VACUUM, as a module’s migrations do', async () => {
    install();
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'sql');
    for (const [sql, word] of [
      ["ATTACH DATABASE ':memory:' AS other", 'ATTACH'],
      ['DETACH DATABASE other', 'DETACH'],
      ['PRAGMA table_info(plugin_state)', 'PRAGMA'],
      ['pragma writable_schema = 1', 'PRAGMA'],
      ['VACUUM', 'VACUUM'],
    ]) {
      const out = await call(gw, 'exec', sql);
      expect(out, sql).toMatchObject({
        ok: false,
        code: 'plugin_permission_denied',
        permission: 'store',
        subject: word,
      });
    }
  });

  it('lets the plugin use its own tables, which is all that it may name', async () => {
    install();
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'sql');
    expect(await call(gw, 'own')).toMatchObject({ ok: true, value: 1 });
    expect(
      await call(gw, 'all', 'SELECT id, note FROM mod_sql__notes WHERE tenant_id = ? ORDER BY id')
    ).toMatchObject({ ok: true });
    expect(auditRows('plugin.permission.denied')).toEqual([]);
  });

  it('with enforcement off, goes ahead and audits a write to a core table; a read it leaves alone', async () => {
    install();
    const gw = await start();
    expect(await call(gw, 'all', 'SELECT key FROM settings')).toMatchObject({ ok: true });
    expect(
      auditRows('plugin.permission.undeclared').filter((r) => r.detail.permission === 'store')
    ).toEqual([]);

    const out = await call(
      gw,
      'exec',
      "INSERT INTO settings (key, value, updated_at) VALUES ('probe.key', 'x', 'now')"
    );
    expect(out).toMatchObject({ ok: true });
    expect(
      getStore().prepare("SELECT value FROM settings WHERE key = 'probe.key'").get()?.value
    ).toBe('x');
    const rows = auditRows('plugin.permission.undeclared').filter(
      (r) => r.detail.permission === 'store'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'plugin:sql',
      detail: { subject: 'settings', enforced: false },
    });
    // The SQL itself is not in the audit row.
    expect(JSON.stringify(rows[0])).not.toContain('probe.key');
  });

  it('with enforcement off, ATTACH and PRAGMA are audited and go ahead', async () => {
    install();
    const gw = await start();
    expect(await call(gw, 'all', 'PRAGMA user_version')).toMatchObject({ ok: true });
    expect(auditRows('plugin.permission.undeclared').map((r) => r.detail.subject)).toEqual([
      'PRAGMA',
    ]);
  });

  it('cannot approve another plugin by writing its row, nor turn enforcement off for everyone', async () => {
    install();
    victim();
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'sql');
    const forged = await call(
      gw,
      'exec',
      "UPDATE plugin_state SET approved_checksum = checksum, approved_permissions_hash = permissions_hash, approved_by = 'operator' WHERE id = 'victim'"
    );
    expect(forged.ok).toBe(false);
    await call(gw, 'exec', "UPDATE settings SET value = 'false' WHERE key = 'plugins.enforce'");
    expect(await gw.json('/plugins/settings')).toEqual({ enforce: true });
    const v = (await listPlugins(gw)).victim;
    expect(v).toMatchObject({ state: 'awaiting_approval', approval: { status: 'not_approved' } });
    expect(auditRows('plugin.approved').filter((r) => r.subject === 'victim')).toEqual([]);
  });
});

describe('ctx.exec runs the command that was declared', () => {
  const EXEC = `
  register(ctx) {
    ctx.routes.get('/run', async (req, res) => {
      try {
        const env = req.query.env ? JSON.parse(req.query.env) : undefined;
        const r = await ctx.exec(req.query.cmd, req.query.args ? req.query.args.split(',') : [], { env, cwd: req.query.cwd });
        res.json({ ok: true, out: r.stdout.trim(), code: r.code });
      } catch (e) {
        res.json({ ok: false, code: e.code, permission: e.permission, subject: e.subject, message: String(e.message) });
      }
    });
  },`;
  type Out = {
    ok: boolean;
    out?: string;
    code?: string | number;
    permission?: string;
    subject?: string;
    message?: string;
  };
  const run = async (gw: Running, q: Record<string, string>) =>
    (await gw.json<Out>(`/api/modules/exec/run?${new URLSearchParams(q)}`)) as Out;

  /** A plugin that declares `ls` and ships its own `ls` in a folder it could put on PATH. */
  const install = () => {
    const dir = writePlugin(s.modules, {
      id: 'exec',
      hooks: EXEC,
      permissions: { exec: ['ls', '/bin/echo'] },
      files: { 'dist/bin/ls': '#!/bin/sh\necho NOT-LS ran-from-the-plugin\n' },
    });
    fs.chmodSync(path.join(dir, 'dist', 'bin', 'ls'), 0o755);
    return path.join(dir, 'dist', 'bin');
  };

  it('looks the declared name up on the gateway’s PATH, whatever PATH the plugin sets', async () => {
    const bin = install();
    const gw = await start();
    const out = await run(gw, { cmd: 'ls', args: os.tmpdir(), env: JSON.stringify({ PATH: bin }) });
    // With enforcement off it goes ahead (and is audited), but it is the real ls that runs.
    expect(out.ok).toBe(true);
    expect(out.out).not.toContain('NOT-LS');
    expect(auditRows('plugin.permission.undeclared').map((r) => r.detail.subject)).toEqual([
      'env:PATH',
    ]);
  });

  it('refuses PATH, LD_*, DYLD_*, NODE_OPTIONS, GIT_EXEC_PATH, GIT_CONFIG_*, BASH_ENV and ENV when enforcement is on', async () => {
    const bin = install();
    await seedEnforce(s);
    const gw = await start();
    await (async () => {
      const p = (await listPlugins(gw)).exec;
      await gw.api('/plugins/exec/approve', {
        method: 'POST',
        body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
      });
    })();
    for (const key of [
      'PATH',
      'path',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'GIT_EXEC_PATH',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_GLOBAL',
      'BASH_ENV',
      'ENV',
    ]) {
      const out = await run(gw, {
        cmd: '/bin/echo',
        args: 'x',
        env: JSON.stringify({ [key]: bin }),
      });
      expect(out, key).toMatchObject({
        ok: false,
        code: 'plugin_permission_denied',
        permission: 'exec',
        subject: `env:${key}`,
      });
    }
    // An ordinary variable is fine, and the declared name still finds the real program.
    expect(
      await run(gw, { cmd: '/bin/echo', args: 'hi', env: JSON.stringify({ GREETING: 'x' }) })
    ).toMatchObject({
      ok: true,
      out: 'hi',
    });
    const real = await run(gw, { cmd: 'ls', args: os.tmpdir() });
    expect(real.ok).toBe(true);
    expect(real.out).not.toContain('NOT-LS');
  });

  it('refuses a command written as a relative path when enforcement is on, and cannot be sent to the plugin’s own script by cwd', async () => {
    const bin = install();
    writePlugin(s.modules, {
      id: 'exec',
      hooks: EXEC,
      permissions: { exec: ['./ls'] },
      files: { 'dist/bin/ls': '#!/bin/sh\necho NOT-LS\n' },
    });
    fs.chmodSync(path.join(bin, 'ls'), 0o755);
    await seedEnforce(s);
    const gw = await start();
    const p = (await listPlugins(gw)).exec;
    await gw.api('/plugins/exec/approve', {
      method: 'POST',
      body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
    });
    const out = await run(gw, { cmd: './ls', cwd: bin });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('absolute path or a bare command name');
  });

  it('says plainly when a bare name is not on the gateway’s PATH', async () => {
    writePlugin(s.modules, {
      id: 'exec',
      hooks: EXEC,
      permissions: { exec: ['no-such-program-anywhere'] },
    });
    const gw = await start();
    const out = await run(gw, { cmd: 'no-such-program-anywhere' });
    expect(out.ok).toBe(false);
    expect(out.message).toBe(
      `Could not start "no-such-program-anywhere": it is not on the gateway's PATH.`
    );
  });
});
