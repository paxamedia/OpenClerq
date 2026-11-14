/**
 * `~/.clerq/cli.json`: the profiles `clerq login` saves.
 *
 * A profile holds a gateway's address and either its token or the path of a
 * file that holds the token. The file is written 0600 (the directory 0700 when
 * this makes it), through a temporary file in the same directory that is
 * renamed over it, so a reader never sees a half-written file and a looser
 * mode on an old file does not carry over. A token is never put anywhere else.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';

export interface Profile {
  /** The gateway's address, without a trailing slash. */
  url: string;
  token?: string;
  /** Path of a file holding the token, read each time. */
  tokenFile?: string;
}

export interface CliConfig {
  version: 1;
  profiles: Record<string, Profile>;
}

/** What a profile may be called: it is a key in a file and a word on a command line. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The profile used when none is named. */
export const DEFAULT_PROFILE = 'default';

export const clerqDir = (home: string) => path.join(home, '.clerq');
export const configPath = (home: string) => path.join(clerqDir(home), 'cli.json');
/** Where the gateway on this computer keeps its token. */
export const localTokenPath = (home: string) => path.join(clerqDir(home), 'gateway-token');

/** `~/.clerq/cli.json` for a message: the home directory written as `~`. */
export function tildePath(file: string, home: string): string {
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

export const emptyConfig = (): CliConfig => ({ version: 1, profiles: {} });

function invalid(file: string, why: string): CliError {
  return new CliError(`${file} ${why} Fix it, or delete it and run \`clerq login\` again.`);
}

/** Read and check the file. A missing file is an empty configuration. */
export function loadConfig(home: string): { config: CliConfig; file: string; exists: boolean } {
  const file = configPath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: emptyConfig(), file, exists: false };
    }
    throw new CliError(`Could not read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw invalid(file, `is not valid JSON (${(e as Error).message}).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(file, 'does not hold a JSON object.');
  }
  const raw = parsed as { version?: unknown; profiles?: unknown };
  if (raw.version !== 1) {
    throw new CliError(
      `${file} is version ${String(raw.version)}; this clerq reads version 1. Update clerq, or delete the file.`
    );
  }
  if (!raw.profiles || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
    throw invalid(file, 'has no "profiles" object.');
  }
  const profiles: Record<string, Profile> = Object.create(null);
  for (const [name, value] of Object.entries(raw.profiles as Record<string, unknown>)) {
    const p = value as Partial<Profile> | null;
    if (!PROFILE_NAME.test(name))
      throw invalid(file, `has a profile named "${name}", which is not a plain name.`);
    if (!p || typeof p !== 'object' || typeof p.url !== 'string' || !p.url) {
      throw invalid(file, `has a profile "${name}" without a url.`);
    }
    if (p.token !== undefined && typeof p.token !== 'string') {
      throw invalid(file, `has a profile "${name}" whose token is not text.`);
    }
    if (p.tokenFile !== undefined && typeof p.tokenFile !== 'string') {
      throw invalid(file, `has a profile "${name}" whose tokenFile is not text.`);
    }
    profiles[name] = {
      url: p.url,
      ...(p.token ? { token: p.token } : {}),
      ...(p.tokenFile ? { tokenFile: p.tokenFile } : {}),
    };
  }
  return { config: { version: 1, profiles }, file, exists: true };
}

/** A warning when a file that holds a token can be read by other users; null when it is fine. */
export function modeWarning(file: string, config: CliConfig, home: string): string | null {
  if (process.platform === 'win32') return null;
  if (!Object.values(config.profiles).some((p) => p.token)) return null;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) === 0) return null;
    const shown = tildePath(file, home);
    return `${shown} holds a token and can be read by other users (mode ${mode.toString(8)}). Run: chmod 600 ${shown}`;
  } catch {
    return null;
  }
}

/** Write the file: 0600, in a 0700 directory when it has to be made, replaced in one step. */
export function saveConfig(home: string, config: CliConfig): string {
  const dir = clerqDir(home);
  const file = configPath(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.cli.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
    // The mode given at creation is narrowed by the umask only; this makes it exact.
    fs.chmodSync(file, 0o600);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new CliError(`Could not write ${file}: ${(e as Error).message}`);
  }
  return file;
}

/** Remove the file when no profile is left. */
export function deleteConfigIfEmpty(home: string, config: CliConfig): void {
  if (Object.keys(config.profiles).length === 0) fs.rmSync(configPath(home), { force: true });
}
