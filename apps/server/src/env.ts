/**
 * The server's configuration comes from the process environment and from one
 * file, `~/.clerq/.env` (what the desktop app writes API keys to). Unlike the
 * developer entry point (`packages/gateway/src/cli.ts`) it never reads a `.env`
 * from the working directory or the repository: a daemon's configuration must
 * not depend on where it was started from.
 *
 * A variable that is already set wins over the file, so `Environment=` in a
 * unit, `-e` in a container and the shell all override it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_PORT = 18790;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * The account's home, made explicit. The gateway keeps its data in
 * `$HOME/.clerq` (`HOME` or, on Windows, `USERPROFILE`) and resolves that
 * from the environment in several places; a missing or relative one would put
 * it in whatever the working directory is. So when neither is set, the
 * account's own home is put in `HOME` here, and one that is not an absolute
 * path is refused.
 */
export function ensureHome(env: Env, homedir: () => string = os.homedir): string {
  let home = env.HOME || env.USERPROFILE || '';
  if (!home) {
    try {
      home = homedir();
    } catch {
      home = '';
    }
    if (!home) {
      throw new ConfigError(
        'HOME is not set and this account has no home directory. The server keeps its data in ' +
          '$HOME/.clerq: set HOME to a directory it may write to.'
      );
    }
    env.HOME = home;
  }
  if (!path.isAbsolute(home)) {
    throw new ConfigError(`HOME must be an absolute path (it is "${home}").`);
  }
  return home;
}

/** `~/.clerq/.env`, the only file the server reads configuration from. */
export function envFilePath(home: string): string {
  return path.join(home, '.clerq', '.env');
}

/**
 * Put what `~/.clerq/.env` sets into `env`, leaving every variable already
 * set alone. Returns the file read, or null when there is none (or it cannot
 * be read, which is reported through `warn`).
 */
export function loadEnvFile(
  env: Env,
  home: string,
  warn: (message: string) => void = () => undefined
): string | null {
  const file = envFilePath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
  for (const [name, value] of Object.entries(dotenv.parse(text))) {
    if (env[name] === undefined) env[name] = value;
  }
  return file;
}

export interface ServerConfig {
  host: string;
  port: number;
}

/** `CLERQ_HOST` and `CLERQ_PORT`, checked. */
export function readServerConfig(env: Env): ServerConfig {
  const host = (env.CLERQ_HOST ?? '').trim() || DEFAULT_HOST;
  const rawPort = (env.CLERQ_PORT ?? '').trim();
  let port = DEFAULT_PORT;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
      throw new ConfigError(
        `CLERQ_PORT must be a port number from 1 to 65535 (it is "${rawPort}").`
      );
    }
    port = Number(rawPort);
  }
  return { host, port };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
