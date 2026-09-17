import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSecrets,
  setSecret,
  getSecret,
  deleteSecret,
  vaultKeyStatus,
} from './secrets-vault.js';

const VARS = ['HOME', 'USERPROFILE', 'CLERQ_VAULT_KEY', 'CLERQ_KEYCHAIN', 'CLERQ_KEYCHAIN_PATH'];
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  // Tests get their own home, and never touch the developer's keychain.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-vault-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLERQ_KEYCHAIN = 'off';
  delete process.env.CLERQ_VAULT_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const keyFile = () => path.join(home, '.clerq', 'vault.key');

describe('master key', () => {
  it('generates one on first use instead of staying disabled', () => {
    // Before 0.5 the vault did nothing at all until the user found the right
    // environment variable.
    expect(vaultKeyStatus()).toMatchObject({ source: 'file' });
    expect(fs.existsSync(keyFile())).toBe(true);
    expect(fs.readFileSync(keyFile(), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the key file readable only by this account', () => {
    vaultKeyStatus();
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
  });

  it('reuses the stored key, so secrets survive a restart', () => {
    setSecret('token', 'value-one');
    const first = fs.readFileSync(keyFile(), 'utf8');

    // A fresh home would be a fresh key; the same home must decrypt as before.
    process.env.CLERQ_KEYCHAIN_PATH = 'cache-buster';
    expect(getSecret('token')).toBe('value-one');
    expect(fs.readFileSync(keyFile(), 'utf8')).toBe(first);
  });

  it('honours CLERQ_VAULT_KEY when it is set, and says where the key came from', () => {
    process.env.CLERQ_VAULT_KEY = 'ab'.repeat(32);
    expect(vaultKeyStatus().source).toBe('env');
    setSecret('from-env', 'kept');
    // The file key is not created while the environment supplies one.
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(getSecret('from-env')).toBe('kept');
  });

  it('ignores a malformed CLERQ_VAULT_KEY rather than failing the vault', () => {
    process.env.CLERQ_VAULT_KEY = 'not-hex';
    expect(vaultKeyStatus().source).toBe('file');
  });
});

describe('secrets', () => {
  it('round-trips a value and lists it by name only', () => {
    expect(setSecret('api_key', 'super-secret-value')).toEqual({ ok: true });
    expect(listSecrets()).toEqual(['api_key']);
    expect(getSecret('api_key')).toBe('super-secret-value');

    // The value is never in the listing, and never in the file in clear text.
    const raw = fs.readFileSync(path.join(home, '.clerq', 'secrets.vault'), 'utf8');
    expect(raw).not.toContain('super-secret-value');
  });

  it('refuses a name that is not a plain identifier', () => {
    expect(setSecret('../escape', 'x').ok).toBe(false);
    expect(setSecret('has space', 'x').ok).toBe(false);
  });

  it('returns null for a secret that does not exist', () => {
    expect(getSecret('absent')).toBeNull();
  });

  it('deletes, and treats deleting nothing as success', () => {
    setSecret('gone', 'value');
    expect(deleteSecret('gone')).toEqual({ ok: true });
    expect(getSecret('gone')).toBeNull();
    expect(deleteSecret('gone')).toEqual({ ok: true });
  });

  it('appends every write to the audit log', () => {
    setSecret('audited', 'value');
    deleteSecret('audited');
    const log = fs.readFileSync(path.join(home, '.clerq', 'secrets.audit.log'), 'utf8');
    expect(log).toMatch(/\tset\taudited\n/);
    expect(log).toMatch(/\tdelete\taudited\n/);
    expect(log).not.toContain('value');
  });

  it('does not return a secret encrypted under a different key', () => {
    setSecret('rotated', 'original');
    process.env.CLERQ_VAULT_KEY = 'cd'.repeat(32);
    // Wrong key: authentication fails, and nothing is returned.
    expect(getSecret('rotated')).toBeNull();
  });
});
