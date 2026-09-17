/**
 * The OS keychain, reached through the tool each platform already ships.
 *
 * A master key in an environment variable is readable by every process that can
 * see the environment, and it lands in shell history, `.env` files and CI logs.
 * The keychain is where the operating system keeps this kind of thing, guarded
 * by the user's login.
 *
 * No native addon is involved: `bun build --compile` cannot embed one, and a
 * native dependency for three platforms is a build problem on all of them.
 * These are the platform tools:
 *
 *   macOS    security(1), the login keychain
 *   Linux    secret-tool(1) from libsecret, when a secret service is running
 *   Windows  DPAPI via PowerShell, protecting a file only this user can read
 *
 * Values are restricted to printable, quote-free text. Everything stored here
 * is hex, and refusing anything else removes a whole class of quoting bugs
 * across three different command-line tools.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';

export type KeychainBackend = 'macos' | 'libsecret' | 'dpapi' | 'none';

const SAFE_VALUE = /^[A-Za-z0-9+/=._:-]{1,4096}$/;

export class KeychainError extends Error {
  readonly code = 'keychain_error';
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

function onPath(command: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const names = process.platform === 'win32' ? [`${command}.exe`, command] : [command];
  return dirs.some((dir) =>
    names.some((name) => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  );
}

/** Which backend this host can use, if any. */
export function detectBackend(): KeychainBackend {
  if (process.env.CLERQ_KEYCHAIN === 'off') return 'none';
  if (process.platform === 'darwin') return onPath('security') ? 'macos' : 'none';
  if (process.platform === 'win32') return onPath('powershell') ? 'dpapi' : 'none';
  // A secret service needs a session bus; without one secret-tool hangs or fails.
  if (onPath('secret-tool') && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY)) {
    return 'libsecret';
  }
  return 'none';
}

function assertSafe(value: string): void {
  if (!SAFE_VALUE.test(value)) {
    throw new KeychainError(
      'Keychain values must be printable text without quotes or spaces (hex or base64).'
    );
  }
}

/** macOS only: a specific keychain file, which tests use instead of the login one. */
function macKeychainArgs(): string[] {
  const explicit = process.env.CLERQ_KEYCHAIN_PATH?.trim();
  return explicit ? [explicit] : [];
}

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    input,
    // Never inherit stdio: a prompt would hang a headless gateway forever.
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function dpapiFile(): string {
  return path.join(os.homedir(), '.clerq', 'vault.key.dpapi');
}

/**
 * Windows has no credential CLI that can read a password back, so DPAPI is used
 * directly: the value is encrypted to the current user account and the blob is
 * kept in a file. Another account cannot decrypt it even with the file.
 *
 * Untested on Windows in CI — see SECURITY.md. Every failure falls back rather
 * than throwing, so a broken path degrades to the file key instead of breaking
 * the vault.
 */
function dpapiSet(value: string): void {
  const res = run(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$plain = [Console]::In.ReadToEnd().Trim(); ' +
        'ConvertTo-SecureString -String $plain -AsPlainText -Force | ConvertFrom-SecureString',
    ],
    `${value}\n`
  );
  if (res.status !== 0 || !res.stdout?.trim()) {
    throw new KeychainError(`DPAPI protect failed: ${res.stderr?.trim() || 'no output'}`);
  }
  const file = dpapiFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.stdout.trim(), { mode: 0o600 });
}

function dpapiGet(): string | null {
  const file = dpapiFile();
  if (!fs.existsSync(file)) return null;
  const res = run(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // The blob travels by environment variable, not on the command line.
      '$sec = ConvertTo-SecureString -String $env:CLERQ_DPAPI_BLOB; ' +
        '[Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
        '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))',
    ],
    undefined
  );
  if (res.status !== 0) return null;
  return res.stdout?.trim() || null;
}

/** Read a stored value, or null when there is none. */
export function getPassword(service: string, account: string): string | null {
  const backend = detectBackend();
  try {
    if (backend === 'macos') {
      const res = run('security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
        ...macKeychainArgs(),
      ]);
      // 44 is "item not found", which is an answer rather than a failure.
      if (res.status !== 0) return null;
      return res.stdout?.trim() || null;
    }
    if (backend === 'libsecret') {
      const res = run('secret-tool', ['lookup', 'service', service, 'account', account]);
      if (res.status !== 0) return null;
      return res.stdout?.trim() || null;
    }
    if (backend === 'dpapi') {
      const file = dpapiFile();
      if (!fs.existsSync(file)) return null;
      const blob = fs.readFileSync(file, 'utf8').trim();
      const previous = process.env.CLERQ_DPAPI_BLOB;
      process.env.CLERQ_DPAPI_BLOB = blob;
      try {
        return dpapiGet();
      } finally {
        if (previous === undefined) delete process.env.CLERQ_DPAPI_BLOB;
        else process.env.CLERQ_DPAPI_BLOB = previous;
      }
    }
  } catch (e) {
    logger.warn('Keychain read failed', {
      backend,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

/** Store a value, replacing any existing one. Throws when the backend refuses. */
export function setPassword(service: string, account: string, value: string): void {
  assertSafe(value);
  const backend = detectBackend();
  if (backend === 'none') throw new KeychainError('No keychain is available on this host.');

  if (backend === 'macos') {
    // -U replaces an existing item instead of failing on a duplicate.
    const res = run('security', [
      'add-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w',
      value,
      '-U',
      ...macKeychainArgs(),
    ]);
    if (res.status !== 0) {
      throw new KeychainError(`security(1) failed: ${res.stderr?.trim() || res.status}`);
    }
    return;
  }

  if (backend === 'libsecret') {
    const res = run(
      'secret-tool',
      ['store', '--label', `${service} ${account}`, 'service', service, 'account', account],
      `${value}\n`
    );
    if (res.status !== 0) {
      throw new KeychainError(`secret-tool failed: ${res.stderr?.trim() || res.status}`);
    }
    return;
  }

  dpapiSet(value);
}

/** Remove a stored value. Returns false when there was nothing to remove. */
export function deletePassword(service: string, account: string): boolean {
  const backend = detectBackend();
  try {
    if (backend === 'macos') {
      const res = run('security', [
        'delete-generic-password',
        '-s',
        service,
        '-a',
        account,
        ...macKeychainArgs(),
      ]);
      return res.status === 0;
    }
    if (backend === 'libsecret') {
      return run('secret-tool', ['clear', 'service', service, 'account', account]).status === 0;
    }
    if (backend === 'dpapi') {
      const file = dpapiFile();
      if (!fs.existsSync(file)) return false;
      fs.rmSync(file);
      return true;
    }
  } catch {
    /* treated as "not removed" */
  }
  return false;
}

export function describeBackend(backend: KeychainBackend = detectBackend()): string {
  switch (backend) {
    case 'macos':
      return 'macOS keychain';
    case 'libsecret':
      return 'libsecret (GNOME Keyring / KWallet)';
    case 'dpapi':
      return 'Windows DPAPI';
    default:
      return 'none';
  }
}
