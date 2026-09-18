/**
 * Private local state.
 *
 * Everything OpenClerq keeps under ~/.clerq — conversations, run prompts,
 * memory, the encrypted vault, API keys — is for this account alone. Every
 * writer creates the directory (0700) and its files (0600) through here, so
 * which one runs first cannot decide the mode. Permissions are left alone on
 * Windows, where POSIX modes do not apply and the profile directory is
 * already private to its owner.
 *
 * CLERQ_KEEP_PERMISSIONS=1 stops the gateway tightening paths that already
 * exist, for an operator who has deliberately shared them. Files the gateway
 * itself creates or rewrites are still made private.
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function posix(): boolean {
  return process.platform !== 'win32';
}

function keepExisting(): boolean {
  const v = process.env.CLERQ_KEEP_PERMISSIONS;
  return v === '1' || v === 'true';
}

/** ~/.clerq, resolved from HOME so tests and containers can relocate it. */
export function clerqHome(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq');
}

/**
 * Create `dir` readable only by this account, and tighten it if it already
 * exists with wider permissions. Returns true when it changed an existing mode.
 */
export function ensurePrivateDir(dir: string): boolean {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // mkdir's mode is filtered by the umask; set it explicitly.
    if (posix()) fs.chmodSync(dir, DIR_MODE);
    return false;
  }
  if (!posix() || keepExisting()) return false;
  const mode = fs.statSync(dir).mode & 0o777;
  if ((mode & 0o077) === 0) return false;
  fs.chmodSync(dir, DIR_MODE);
  return true;
}

/**
 * Make an existing file readable only by this account. Returns true when it
 * changed the mode; false when there was nothing to do or no file.
 *
 * `force` is for a file this call has just created or replaced: that one is
 * ours, so CLERQ_KEEP_PERMISSIONS does not apply to it.
 */
export function restrictFile(file: string, force = false): boolean {
  if (!posix() || !fs.existsSync(file)) return false;
  if (!force && keepExisting()) return false;
  const mode = fs.statSync(file).mode & 0o777;
  if ((mode & 0o077) === 0) return false;
  fs.chmodSync(file, FILE_MODE);
  return true;
}

/** Write a file readable only by this account, creating its directory privately. */
export function writePrivateFile(file: string, data: string | Uint8Array): void {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: FILE_MODE });
  // writeFileSync's mode applies only when the file is created, and this call
  // replaced the contents either way, so the file is ours to tighten.
  restrictFile(file, true);
}

/** Append to a file readable only by this account. */
export function appendPrivateFile(file: string, data: string): void {
  const created = !fs.existsSync(file);
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, data, { mode: FILE_MODE });
  restrictFile(file, created);
}

/**
 * Tighten ~/.clerq and the files in it that hold secrets or personal data.
 * Run once at startup, so installs made before this fix are repaired too.
 * Returns the paths it changed, for the startup log.
 */
export function secureClerqHome(): string[] {
  const home = clerqHome();
  if (!fs.existsSync(home)) return [];
  const changed: string[] = [];
  if (ensurePrivateDir(home)) changed.push(home);
  if (keepExisting()) return changed;
  for (const name of [
    '.env',
    'gateway-token',
    'clerq.db',
    'clerq.db-wal',
    'clerq.db-shm',
    'secrets.vault',
    'secrets.audit.log',
    'vault.key',
    'config.json',
  ]) {
    const file = path.join(home, name);
    if (restrictFile(file)) changed.push(file);
  }
  return changed;
}
