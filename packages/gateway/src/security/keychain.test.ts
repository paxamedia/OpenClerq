import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectBackend,
  describeBackend,
  getPassword,
  setPassword,
  deletePassword,
  KeychainError,
} from './keychain.js';

const isMac = process.platform === 'darwin';
const SERVICE = 'OpenClerq-test';
const ACCOUNT = 'keychain-test';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    CLERQ_KEYCHAIN: process.env.CLERQ_KEYCHAIN,
    CLERQ_KEYCHAIN_PATH: process.env.CLERQ_KEYCHAIN_PATH,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('backend detection', () => {
  it('can be switched off, for headless hosts and for tests', () => {
    process.env.CLERQ_KEYCHAIN = 'off';
    expect(detectBackend()).toBe('none');
    expect(describeBackend()).toBe('none');
  });

  it('finds the platform tool where there is one', () => {
    delete process.env.CLERQ_KEYCHAIN;
    if (isMac) expect(detectBackend()).toBe('macos');
  });

  it('refuses to store when nothing can hold the value', () => {
    process.env.CLERQ_KEYCHAIN = 'off';
    expect(() => setPassword(SERVICE, ACCOUNT, 'abc123')).toThrow(/No keychain is available/);
    expect(getPassword(SERVICE, ACCOUNT)).toBeNull();
    expect(deletePassword(SERVICE, ACCOUNT)).toBe(false);
  });
});

describe.skipIf(!isMac)('macOS keychain', () => {
  let dir: string;
  let keychain: string;

  beforeAll(() => {
    // A throwaway keychain: tests must never write to the developer's login one.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-kc-'));
    keychain = path.join(dir, 'test.keychain');
    execFileSync('security', ['create-keychain', '-p', 'test-pass', keychain]);
    execFileSync('security', ['unlock-keychain', '-p', 'test-pass', keychain]);
  });

  afterAll(() => {
    try {
      execFileSync('security', ['delete-keychain', keychain]);
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.CLERQ_KEYCHAIN_PATH = keychain;
    delete process.env.CLERQ_KEYCHAIN;
  });

  it('returns null for an item that was never stored', () => {
    expect(getPassword(SERVICE, 'absent')).toBeNull();
  });

  it('round-trips a value', () => {
    const value = 'a'.repeat(64);
    setPassword(SERVICE, ACCOUNT, value);
    expect(getPassword(SERVICE, ACCOUNT)).toBe(value);
  });

  it('replaces an existing value rather than failing on the duplicate', () => {
    setPassword(SERVICE, ACCOUNT, 'b'.repeat(64));
    setPassword(SERVICE, ACCOUNT, 'c'.repeat(64));
    expect(getPassword(SERVICE, ACCOUNT)).toBe('c'.repeat(64));
  });

  it('deletes, and says so when there was nothing to delete', () => {
    setPassword(SERVICE, ACCOUNT, 'd'.repeat(64));
    expect(deletePassword(SERVICE, ACCOUNT)).toBe(true);
    expect(getPassword(SERVICE, ACCOUNT)).toBeNull();
    expect(deletePassword(SERVICE, ACCOUNT)).toBe(false);
  });

  it('refuses a value that would need quoting', () => {
    // Everything stored here is hex; refusing the rest removes a class of
    // quoting bugs across three different command-line tools.
    for (const bad of ['has space', 'quote"inside', "single'quote", 'newline\nhere', '']) {
      expect(() => setPassword(SERVICE, ACCOUNT, bad)).toThrow(KeychainError);
    }
  });
});
