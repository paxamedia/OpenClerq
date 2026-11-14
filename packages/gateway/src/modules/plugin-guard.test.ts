import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PluginPermissionError } from '@clerq/plugin-sdk';
import { EMPTY_PERMISSIONS } from '@clerq/plugin-sdk/manifest';
import { closeStore, getStore, initStore } from '../store.js';
import { AUDIT_REPEAT_MS, PluginGuard, containedIn, expandHome } from './plugin-guard.js';

let tmp = '';
let enforcing = true;
let clock = 1_000_000;

const guard = (declared: Partial<typeof EMPTY_PERMISSIONS> = {}) =>
  new PluginGuard({
    id: 'g',
    dir: path.join(tmp, 'plugin'),
    declared: () => ({ ...EMPTY_PERMISSIONS, ...declared }),
    enforcing: () => enforcing,
    now: () => clock,
  });

const rows = () =>
  getStore()
    .prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'plugin.permission.%'")
    .all();

beforeAll(async () => {
  await initStore(':memory:');
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-guard-')));
  fs.mkdirSync(path.join(tmp, 'plugin', 'data'), { recursive: true });
});

afterAll(() => {
  closeStore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  enforcing = true;
  clock = 1_000_000;
  getStore().prepare('DELETE FROM audit_log').run();
});

describe('the audit trail of a check', () => {
  it('writes one row, and counts the repeats in the next', () => {
    const g = guard();
    for (let i = 0; i < 5; i++) expect(() => g.secret('x', 'read')).toThrow(PluginPermissionError);
    expect(rows()).toHaveLength(1);
    clock += AUDIT_REPEAT_MS;
    expect(() => g.secret('x', 'read')).toThrow();
    const all = rows();
    expect(all).toHaveLength(2);
    expect(JSON.parse(String(all[1].detail)).repeatedBefore).toBe(4);
  });

  it('keeps a row for each different thing, and for denied apart from undeclared', () => {
    const g = guard();
    expect(() => g.secret('a', 'read')).toThrow();
    expect(() => g.secret('b', 'read')).toThrow();
    expect(() => g.command('/bin/ls')).toThrow();
    enforcing = false;
    g.secret('a', 'read');
    expect(rows().map((r) => r.action)).toEqual([
      'plugin.permission.denied',
      'plugin.permission.denied',
      'plugin.permission.denied',
      'plugin.permission.undeclared',
    ]);
  });

  it('does not grow without bound for a plugin that tries a new name every time', () => {
    const g = guard();
    for (let i = 0; i < 700; i++) {
      clock += AUDIT_REPEAT_MS;
      expect(() => g.secret(`name${i}`, 'write')).toThrow();
    }
    expect(rows().length).toBe(700);
  });

  it('says what was refused, and how to find the cause', () => {
    try {
      guard().secret('other', 'read');
      expect.unreachable();
    } catch (e) {
      const err = e as PluginPermissionError;
      expect(err.code).toBe('plugin_permission_denied');
      expect(err.permission).toBe('secrets');
      expect(err.subject).toBe('other');
      expect(err.message).toBe(
        'The plugin "g" may not read the secret "other": it is not in permissions.secrets. Plugin permission enforcement is on.'
      );
    }
  });

  it('is asked about enforcement every time, so turning it on reaches a running plugin', () => {
    const g = guard();
    enforcing = false;
    expect(() => g.command('/bin/ls')).not.toThrow();
    enforcing = true;
    expect(() => g.command('/bin/ls')).toThrow();
  });
});

describe('hosts', () => {
  const url = (u: string) => new URL(u);

  it('matches a host exactly, a subdomain by wildcard, and a port when the declaration has one', () => {
    const g = guard({ net: ['api.example.com', '*.cdn.example.org', 'ports.example.com:8443'] });
    for (const ok of [
      'https://api.example.com/x',
      'http://API.EXAMPLE.COM/x',
      'https://api.example.com:9999/x',
      'https://a.cdn.example.org/x',
      'https://a.b.cdn.example.org/x',
      'https://ports.example.com:8443/x',
    ]) {
      expect(() => g.host(url(ok)), ok).not.toThrow();
    }
    for (const bad of [
      'https://example.com/x',
      'https://api.example.com.evil.net/x',
      'https://xapi.example.com/x',
      'https://cdn.example.org/x',
      'https://evilcdn.example.org/x',
      'https://ports.example.com/x',
      'https://ports.example.com:8444/x',
    ]) {
      expect(() => g.host(url(bad)), bad).toThrow(PluginPermissionError);
    }
  });

  it('refuses everything when nothing is declared, and survives a malformed entry', () => {
    expect(() => guard().host(url('https://a.example.com/'))).toThrow();
    const g = guard({ net: ['ok.example.com:notaport', 'fine.example.com'] });
    expect(() => g.host(url('https://fine.example.com/'))).not.toThrow();
    expect(() => g.host(url('https://ok.example.com/'))).toThrow();
  });
});

describe('paths', () => {
  it('reads ~ as the home folder, and a relative root against the plugin folder', () => {
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~other/x')).toBe('~other/x');
    const g = guard({ fs: { read: ['data'], write: [] } });
    const file = path.join(tmp, 'plugin', 'data', 'f.txt');
    fs.writeFileSync(file, 'x');
    expect(g.path(file, 'read')).toBe(file);
    expect(() => g.path(path.join(tmp, 'plugin', 'other.txt'), 'read')).toThrow();
  });

  it('answers with the real path, so what was checked is what is opened', () => {
    const real = path.join(tmp, 'plugin', 'data');
    const alias = path.join(tmp, 'alias-of-data');
    fs.symlinkSync(real, alias);
    const g = guard({ fs: { read: [alias], write: [] } });
    fs.writeFileSync(path.join(real, 'g.txt'), 'x');
    expect(g.path(path.join(alias, 'g.txt'), 'read')).toBe(path.join(real, 'g.txt'));
  });

  it('allows the folder itself and refuses its sibling that shares a prefix', () => {
    const root = path.join(tmp, 'plugin', 'data');
    fs.mkdirSync(path.join(tmp, 'plugin', 'data-secrets'), { recursive: true });
    expect(containedIn(root, root)).toBe(root);
    expect(containedIn(root, path.join(tmp, 'plugin', 'data-secrets', 'x'))).toBeNull();
    expect(containedIn(root, path.join(root, '..', 'data-secrets', 'x'))).toBeNull();
  });

  it('refuses a path with a NUL, an empty one and a relative one in either mode', () => {
    enforcing = false;
    const g = guard({ fs: { read: [tmp], write: [] } });
    for (const bad of ['', 'a\0b', 'relative/x']) {
      expect(() => g.path(bad, 'read')).toThrow(Error);
    }
  });
});

describe('SQL through the context', () => {
  const db = () => getStore();

  it('refuses a statement that names a core table, and any table that is not the plugin’s own', () => {
    const g = guard();
    for (const sql of [
      'SELECT * FROM settings',
      "UPDATE 'settings' SET value = 'x'",
      'DELETE FROM "audit_log"',
      'SELECT * FROM sqlite_master',
      'SELECT * FROM main.runs',
    ]) {
      expect(() => g.sql(sql), sql).toThrow(PluginPermissionError);
    }
    // Another module's table is not this plugin's.
    db().exec('CREATE TABLE mod_other__things (id INTEGER)');
    expect(() => g.sql('SELECT * FROM mod_other__things')).toThrow(PluginPermissionError);
  });

  it('lets a plugin name its own tables, and does not mind words that are not tables', () => {
    db().exec('CREATE TABLE mod_g__things (id INTEGER, name TEXT, tenant_id TEXT)');
    const g = guard();
    expect(() =>
      g.sql('SELECT id, name FROM mod_g__things WHERE tenant_id = ? ORDER BY id')
    ).not.toThrow();
    expect(() =>
      g.sql("INSERT INTO mod_g__things (name, tenant_id) VALUES ('a', 'default')")
    ).not.toThrow();
    expect(rows()).toEqual([]);
  });

  it('notices a table created after the guard last looked', () => {
    const g = guard();
    expect(() => g.sql('SELECT * FROM mod_late__t')).not.toThrow();
    db().exec('CREATE TABLE mod_late__t (id INTEGER)');
    expect(() => g.sql('SELECT * FROM mod_late__t')).toThrow(PluginPermissionError);
  });

  it('refuses ATTACH, DETACH, PRAGMA and VACUUM', () => {
    for (const sql of ["ATTACH 'x' AS y", 'DETACH y', 'PRAGMA user_version', 'VACUUM']) {
      expect(() => guard().sql(sql), sql).toThrow(/may not run/);
    }
  });

  it('with enforcement off, audits a write to a core table and not a read, and goes ahead', () => {
    enforcing = false;
    const g = guard();
    expect(() => g.sql('SELECT * FROM settings')).not.toThrow();
    expect(rows()).toEqual([]);
    expect(() => g.sql("UPDATE settings SET value = 'x'")).not.toThrow();
    expect(rows().map((r) => r.action)).toEqual(['plugin.permission.undeclared']);
    expect(() => g.sql('PRAGMA user_version')).not.toThrow();
    expect(rows()).toHaveLength(2);
  });
});

describe('what a command may be given', () => {
  it('refuses variables that choose the program or library, in any case', () => {
    for (const key of [
      'PATH',
      'path',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'NODE_OPTIONS',
      'GIT_EXEC_PATH',
      'GIT_CONFIG_COUNT',
      'BASH_ENV',
      'ENV',
    ]) {
      expect(() => guard().env([key]), key).toThrow(PluginPermissionError);
    }
    expect(() => guard().env(['HOME_LIKE', 'GREETING', 'LANG'])).not.toThrow();
  });

  it('only audits them when enforcement is off', () => {
    enforcing = false;
    expect(() => guard().env(['PATH'])).not.toThrow();
    expect(rows().map((r) => JSON.parse(String(r.detail)).subject)).toEqual(['env:PATH']);
  });
});
