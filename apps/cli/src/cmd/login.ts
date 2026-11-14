/** `clerq login` and `clerq logout`. */

import fs from 'node:fs';
import path from 'node:path';
import {
  GatewayError,
  gateway,
  setGatewayBaseUrl,
  setGatewayTenant,
  setGatewayToken,
  API_VERSION,
} from '@clerq/gateway-client';
import { flag, str, type Call } from '../args.js';
import {
  DEFAULT_PROFILE,
  PROFILE_NAME,
  deleteConfigIfEmpty,
  loadConfig,
  localTokenPath,
  saveConfig,
  tildePath,
} from '../config.js';
import {
  assertTransport,
  checkToken,
  expandTilde,
  isLoopbackHost,
  normalizeUrl,
} from '../connection.js';
import { unusable } from '../connect.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { readSecret, readStdin } from '../prompt.js';

type TokenSource = 'stdin' | 'prompt' | 'file' | 'local-file';

/** Check the token is accepted: one call that needs it. */
async function checkAccepted(url: string): Promise<void> {
  try {
    await gateway.approvals();
  } catch (e) {
    if (e instanceof GatewayError && e.status === 401) {
      throw new CliError(`The gateway at ${url} refused that token. Nothing was saved.`);
    }
    if (e instanceof GatewayError && e.status === 403) {
      throw new CliError(
        `The gateway at ${url} knows that token but does not let it list approvals. ` +
          "The command line needs the gateway's own token (not a phone's or a module's). Nothing was saved."
      );
    }
    throw e;
  }
}

export async function run(ctx: Context, call: Call): Promise<number> {
  const { out, home } = ctx;
  const named = str(call, 'profile');
  const profileName = named ?? DEFAULT_PROFILE;
  if (!PROFILE_NAME.test(profileName)) {
    throw new UsageError(
      `"${profileName}" is not a profile name. Use letters, digits, dots, dashes and underscores.`
    );
  }
  if (call.args[0] && str(call, 'gateway')) {
    throw new UsageError('Give the address once: either `clerq login <url>` or --gateway.');
  }
  const tokenStdin = flag(call, 'token-stdin');
  const tokenFileArg = str(call, 'token-file');
  if (tokenStdin && tokenFileArg) {
    throw new UsageError('Use --token-stdin or --token-file, not both.');
  }

  const { config } = loadConfig(home);
  const known = Object.hasOwn(config.profiles, profileName)
    ? config.profiles[profileName]
    : undefined;
  const localFile = localTokenPath(home);
  const asked = call.args[0] ?? str(call, 'gateway');

  // Which gateway: the one named, else the profile's own, else the one on this computer.
  let url: string;
  let verifyOnly = false;
  if (asked) {
    url = normalizeUrl(asked);
  } else if (named !== undefined && known) {
    url = normalizeUrl(known.url);
  } else if (!tokenStdin && !tokenFileArg && fs.existsSync(localFile)) {
    url = ctx.localUrl;
    verifyOnly = true;
  } else if (known) {
    url = normalizeUrl(known.url);
  } else {
    throw new UsageError(
      'Say which gateway: `clerq login <url>`, e.g. clerq login https://clerq.example.com. ' +
        `(There is no token file at ${tildePath(localFile, home)}, so there is no gateway on this computer to use as it is.)`
    );
  }
  ctx.url = url;
  assertTransport(url, flag(call, 'insecure'));

  setGatewayBaseUrl(url);
  setGatewayTenant(null);
  setGatewayToken(null);
  out.note(`Checking ${url} ...`);
  const compat = await gateway.checkCompatibility();
  if (!compat.ok) throw unusable(compat, url);

  // The token, and where it came from.
  let token: string;
  let source: TokenSource;
  let tokenFile: string | undefined;
  if (verifyOnly) {
    token = checkToken(
      fs.readFileSync(localFile, 'utf8').split(/\r?\n/)[0] ?? '',
      `The token file ${tildePath(localFile, home)}`
    );
    source = 'local-file';
  } else if (tokenFileArg) {
    tokenFile = path.resolve(ctx.cwd, expandTilde(tokenFileArg, home));
    let text: string;
    try {
      text = fs.readFileSync(tokenFile, 'utf8');
    } catch (e) {
      throw new CliError(`Could not read the token file ${tokenFile}: ${(e as Error).message}`);
    }
    token = checkToken(text.split(/\r?\n/)[0] ?? '', `The token file ${tokenFile}`);
    source = 'file';
  } else if (tokenStdin) {
    token = checkToken(
      (await readStdin(ctx.io.stdin)).split(/\r?\n/)[0] ?? '',
      'The token on standard input'
    );
    source = 'stdin';
  } else {
    token = checkToken(
      await readSecret(ctx.io, `Token for ${url} (not shown): `),
      'The token you typed'
    );
    source = 'prompt';
  }
  out.hide(token);
  setGatewayToken(token);
  await checkAccepted(url);

  const facts = { gateway: compat.gateway, api: compat.api };
  if (verifyOnly) {
    const defaultProfile = Object.hasOwn(config.profiles, DEFAULT_PROFILE)
      ? config.profiles[DEFAULT_PROFILE]
      : undefined;
    out.data({
      ok: true,
      url,
      profile: null,
      saved: false,
      verifiedOnly: true,
      tokenSource: source,
      ...facts,
    });
    out.say(
      `The gateway on this computer at ${url} accepted the token in ${tildePath(localFile, home)}` +
        `${compat.gateway ? ` (OpenClerq ${compat.gateway}, API ${API_VERSION})` : ''}.`
    );
    out.say('Nothing was saved: clerq reads that file on its own for this address.');
    if (defaultProfile) {
      out.warn(
        `Profile "${DEFAULT_PROFILE}" in ${tildePath(path.join(home, '.clerq', 'cli.json'), home)} points at ` +
          `${normalizeUrl(defaultProfile.url)} and is used first. Run \`clerq logout\` to go back to this computer's gateway, or pass --gateway ${url}.`
      );
    }
    return EXIT.ok;
  }

  config.profiles[profileName] = tokenFile ? { url, tokenFile } : { url, token };
  const file = saveConfig(home, config);
  out.data({
    ok: true,
    url,
    profile: profileName,
    saved: true,
    verifiedOnly: false,
    tokenSource: source,
    ...facts,
  });
  out.say(
    `Signed in to ${url}${compat.gateway ? ` (OpenClerq ${compat.gateway}, API ${API_VERSION})` : ''}.`
  );
  out.say(
    tokenFile
      ? `Saved profile "${profileName}" in ${tildePath(file, home)} with the path of the token file ${tokenFile}, not the token.`
      : `Saved profile "${profileName}" in ${tildePath(file, home)} (readable by you only).`
  );
  if (profileName !== DEFAULT_PROFILE) out.say(`Use it with --profile ${profileName}.`);
  if (url.startsWith('http:') && !isLoopbackHost(new URL(url).hostname)) {
    out.warn(
      'This address is plain http: the token crosses the network readable. Use https where you can.'
    );
  }
  return EXIT.ok;
}

export async function runLogout(ctx: Context, call: Call): Promise<number> {
  const { out, home } = ctx;
  const name = str(call, 'profile') ?? DEFAULT_PROFILE;
  const { config, file } = loadConfig(home);
  const shown = tildePath(file, home);
  const fromEnv = (ctx.env.CLERQ_GATEWAY_TOKEN ?? '').trim() !== '';
  if (!Object.hasOwn(config.profiles, name)) {
    out.data({ ok: true, removed: false, profile: name });
    out.say(`Nothing is stored for profile "${name}" in ${shown}.`);
    if (fromEnv) out.warn('CLERQ_GATEWAY_TOKEN is still set in your environment.');
    return EXIT.ok;
  }
  const { url, tokenFile } = config.profiles[name];
  delete config.profiles[name];
  saveConfig(home, config);
  deleteConfigIfEmpty(home, config);
  out.data({ ok: true, removed: true, profile: name, url });
  out.say(
    `Removed profile "${name}" (${url}) and its stored token from ${shown}.` +
      (tokenFile ? ` The token file ${tokenFile} was left where it is.` : '')
  );
  out.say('The gateway still accepts that token until it is replaced there.');
  if (fromEnv) out.warn('CLERQ_GATEWAY_TOKEN is still set in your environment.');
  return EXIT.ok;
}
