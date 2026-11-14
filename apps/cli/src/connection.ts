/**
 * Which gateway to talk to, and with which token.
 *
 * Address, first match wins:
 *   1. `--gateway <url>`, else the profile named by `--profile`
 *   2. `CLERQ_GATEWAY_URL`
 *   3. the profile named `default` in `~/.clerq/cli.json`
 *   4. `http://127.0.0.1:18790`, the gateway on this computer
 *
 * Token, first match wins:
 *   1. the profile named by `--profile`
 *   2. `CLERQ_GATEWAY_TOKEN`
 *   3. the profile named `default`
 *   4. `~/.clerq/gateway-token`, only for an address on this computer
 *
 * A token kept in a profile is sent only to that profile's own address, and the
 * local token file only to a loopback address: `--gateway https://elsewhere` never
 * carries a token that was saved for somewhere else.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROFILE,
  loadConfig,
  localTokenPath,
  tildePath,
  type CliConfig,
  type Profile,
} from './config.js';
import { CliError, UsageError } from './errors.js';
import type { Env } from './output.js';

export const DEFAULT_URL = 'http://127.0.0.1:18790';

export interface ConnectionFlags {
  gateway?: string;
  profile?: string;
  insecure?: boolean;
}

export type UrlSource = 'flag' | 'profile' | 'env' | 'default-profile' | 'local-default';
export type TokenSource = 'profile' | 'env' | 'default-profile' | 'local-file' | 'none';

export interface Resolved {
  url: string;
  token: string | null;
  urlSource: UrlSource;
  tokenSource: TokenSource;
  /** The profile the address or the token came from. */
  profile: string | null;
  /** The file the token was read from (a profile's token file, or the local one). */
  tokenFile: string | null;
  /** The configuration read, for a caller that saves it back. */
  config: CliConfig;
  configFile: string;
  configExists: boolean;
}

/** `localhost`, `127.x.x.x`, `::1`: an address that never leaves this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  return mapped ? mapped[1].startsWith('127.') : false;
}

/**
 * The gateway's address in the one form used everywhere: http or https, no
 * user name or password, no query or fragment, no trailing slash. Throws a
 * usage error in words when it is none of that.
 */
export function normalizeUrl(text: string): string {
  const raw = text.trim();
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    throw new UsageError(
      `"${text}" is not a gateway address. Write it like http://127.0.0.1:18790 or https://clerq.example.com.`
    );
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UsageError(
      `The gateway's address must start with http:// or https:// (it is "${text}").`
    );
  }
  if (u.username || u.password) {
    throw new UsageError(
      'Leave the user name and password out of the address; the token is sent as a header.'
    );
  }
  const pathname = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${pathname}`;
}

/** Refuse a token over plain http to another computer, unless `--insecure` says it is accepted. */
export function assertTransport(url: string, insecure: boolean): void {
  const u = new URL(url);
  if (u.protocol === 'https:' || isLoopbackHost(u.hostname) || insecure) return;
  throw new CliError(
    `Refusing to talk to ${url}: it is plain http to another computer, so the token and everything ` +
      'else would cross the network readable by anyone on the way. Use an https:// address (a reverse ' +
      'proxy with TLS, see docs/SERVER.md), or pass --insecure if you accept that for this command.'
  );
}

/** A token as typed or read: visible characters only, no spaces. */
export function checkToken(token: string, where: string): string {
  const t = token.trim();
  if (!t) throw new CliError(`${where} is empty.`);
  if (t.length > 4096 || !/^[\x21-\x7e]+$/.test(t)) {
    throw new CliError(
      `${where} does not look like a token: it must be one line of visible characters, without spaces.`
    );
  }
  return t;
}

function readTokenFile(file: string, home: string): string {
  const shown = tildePath(file, home);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const why =
      (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : (e as Error).message;
    throw new CliError(`The token file ${shown} ${why}.`);
  }
  return checkToken(text.split(/\r?\n/)[0] ?? '', `The token file ${shown}`);
}

/** `~` in a path from the configuration or a flag, as the shell would have it. */
export function expandTilde(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(1)) : p;
}

function profileToken(
  name: string,
  p: Profile,
  home: string
): { token: string; file: string | null } | null {
  if (p.token)
    return { token: checkToken(p.token, `The token stored in profile "${name}"`), file: null };
  if (p.tokenFile) {
    const file = expandTilde(p.tokenFile, home);
    return { token: readTokenFile(file, home), file };
  }
  return null;
}

export function resolveConnection(input: {
  flags: ConnectionFlags;
  env: Env;
  home: string;
  /** The gateway on this computer. */
  localUrl?: string;
}): Resolved {
  const { flags, env, home } = input;
  const { config, file: configFile, exists: configExists } = loadConfig(home);
  const has = (name: string) => Object.hasOwn(config.profiles, name);

  if (flags.profile !== undefined && !has(flags.profile)) {
    const known = Object.keys(config.profiles);
    throw new CliError(
      `There is no profile "${flags.profile}" in ${tildePath(configFile, home)}` +
        (known.length ? ` (it has: ${known.join(', ')}).` : '.') +
        ` Make it with: clerq login <url> --profile ${flags.profile}`
    );
  }
  const chosen = flags.profile !== undefined ? config.profiles[flags.profile] : undefined;
  const defaultProfile = has(DEFAULT_PROFILE) ? config.profiles[DEFAULT_PROFILE] : undefined;
  const envUrl = (env.CLERQ_GATEWAY_URL ?? '').trim();

  let url: string;
  let urlSource: UrlSource;
  let profile: string | null = null;
  if (flags.gateway) {
    url = normalizeUrl(flags.gateway);
    urlSource = 'flag';
  } else if (chosen) {
    url = normalizeUrl(chosen.url);
    urlSource = 'profile';
    profile = flags.profile as string;
  } else if (envUrl) {
    url = normalizeUrl(envUrl);
    urlSource = 'env';
  } else if (defaultProfile) {
    url = normalizeUrl(defaultProfile.url);
    urlSource = 'default-profile';
    profile = DEFAULT_PROFILE;
  } else {
    url = input.localUrl ?? DEFAULT_URL;
    urlSource = 'local-default';
  }

  const base = { url, urlSource, config, configFile, configExists };
  const same = (p: Profile) => normalizeUrl(p.url) === url;

  // 1. The profile named on the command line.
  if (chosen && same(chosen)) {
    const t = profileToken(flags.profile as string, chosen, home);
    if (t) {
      return {
        ...base,
        token: t.token,
        tokenSource: 'profile',
        profile: flags.profile as string,
        tokenFile: t.file,
      };
    }
  }
  // 2. The environment.
  const envToken = (env.CLERQ_GATEWAY_TOKEN ?? '').trim();
  if (envToken) {
    return {
      ...base,
      token: checkToken(envToken, 'CLERQ_GATEWAY_TOKEN'),
      tokenSource: 'env',
      profile,
      tokenFile: null,
    };
  }
  // 3. The default profile, for its own address.
  if (defaultProfile && same(defaultProfile)) {
    const t = profileToken(DEFAULT_PROFILE, defaultProfile, home);
    if (t) {
      return {
        ...base,
        token: t.token,
        tokenSource: 'default-profile',
        profile: DEFAULT_PROFILE,
        tokenFile: t.file,
      };
    }
  }
  // 4. The gateway on this computer keeps its token in a file.
  if (isLoopbackHost(new URL(url).hostname)) {
    const file = localTokenPath(home);
    if (fs.existsSync(file)) {
      return {
        ...base,
        token: readTokenFile(file, home),
        tokenSource: 'local-file',
        profile,
        tokenFile: file,
      };
    }
  }
  return { ...base, token: null, tokenSource: 'none', profile, tokenFile: null };
}

/** Where the address came from, in words that follow "the address is". */
export function urlWords(r: Resolved, home: string): string {
  switch (r.urlSource) {
    case 'flag':
      return 'from --gateway';
    case 'profile':
      return `from --profile ${r.profile}`;
    case 'env':
      return 'from CLERQ_GATEWAY_URL';
    case 'default-profile':
      return `from the profile "${DEFAULT_PROFILE}" in ${tildePath(r.configFile, home)}`;
    default:
      return 'the gateway on this computer, the default';
  }
}

/** Where the token came from, in words; never the token. */
export function tokenWords(r: Resolved, home: string): string {
  switch (r.tokenSource) {
    case 'env':
      return 'from CLERQ_GATEWAY_TOKEN';
    case 'profile':
    case 'default-profile':
      return r.tokenFile
        ? `profile "${r.profile}": in the file ${tildePath(r.tokenFile, home)}`
        : `profile "${r.profile}": stored in ${tildePath(r.configFile, home)}`;
    case 'local-file':
      return `in ${tildePath(r.tokenFile as string, home)}`;
    default:
      return 'none';
  }
}
