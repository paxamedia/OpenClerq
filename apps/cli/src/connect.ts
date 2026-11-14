/**
 * Getting from "which gateway" to "a gateway this CLI can use": resolve the
 * address and token, refuse an unsafe address, point the client at it, and ask
 * whether it speaks this CLI's API version before anything else is sent.
 */

import {
  GatewayError,
  gateway,
  setGatewayBaseUrl,
  setGatewayTenant,
  setGatewayToken,
} from '@clerq/gateway-client';
import { flag, str } from './args.js';
import { localTokenPath, modeWarning, tildePath } from './config.js';
import type { Context } from './context.js';
import { CliError, EXIT } from './errors.js';
import { assertTransport, isLocalGateway, resolveConnection, type Resolved } from './connection.js';

/** The connection flags of this call. */
export const flagsOf = (ctx: Context) => ({
  gateway: str(ctx.call, 'gateway'),
  profile: str(ctx.call, 'profile'),
  insecure: flag(ctx.call, 'insecure'),
});

/** Resolve the connection and check its address is acceptable. Sends nothing. */
export function resolve(ctx: Context): Resolved {
  const resolved = resolveConnection({
    flags: flagsOf(ctx),
    env: ctx.env,
    home: ctx.home,
    localUrl: ctx.localUrl,
  });
  ctx.url = resolved.url;
  ctx.out.hide(resolved.token);
  const warning = modeWarning(resolved.configFile, resolved.config, ctx.home);
  if (warning) ctx.out.warn(warning);
  assertTransport(resolved.url, flag(ctx.call, 'insecure'));
  return resolved;
}

/** Aim the client at `resolved`. */
export function aim(resolved: Resolved): void {
  setGatewayBaseUrl(resolved.url);
  setGatewayToken(resolved.token);
  setGatewayTenant(null);
}

/** The plain-words refusal for a gateway this CLI cannot use. */
export function unusable(
  compat: Awaited<ReturnType<typeof gateway.checkCompatibility>>,
  url: string
): CliError {
  if (compat.kind === 'unreachable') {
    return new CliError(
      `Cannot reach the gateway at ${url}. Is OpenClerq running? ` +
        'Point the CLI at another with --gateway, CLERQ_GATEWAY_URL or `clerq login <url>`.',
      EXIT.gateway
    );
  }
  return new CliError(compat.reason ?? `The gateway at ${url} cannot be used.`, EXIT.gateway);
}

export type TokenState = 'accepted' | 'refused' | 'not-allowed';

/**
 * Whether the gateway takes the token set for this client, as its own: one call
 * only the gateway's own token may make (`GET /routing`). A paired phone's token
 * and a module's are valid, and are refused here: they reach a few routes each,
 * not the ones this client needs. (`GET /approvals`, which a first version asked,
 * is one a phone may read, so a phone's token passed.)
 */
export async function probeToken(): Promise<TokenState> {
  try {
    await gateway.routing();
    return 'accepted';
  } catch (e) {
    if (e instanceof GatewayError && e.status === 401) return 'refused';
    if (e instanceof GatewayError && e.status === 403) return 'not-allowed';
    throw e;
  }
}

/**
 * Everything a command that talks to the gateway does first: resolve, refuse an
 * unsafe address, and check the version. With `needToken`, also stop when there
 * is no token to send.
 */
export async function connect(ctx: Context, needToken = true): Promise<Resolved> {
  const resolved = resolve(ctx);
  aim(resolved);
  const compat = await gateway.checkCompatibility();
  if (!compat.ok) throw unusable(compat, resolved.url);
  if (needToken && !resolved.token) {
    const local = isLocalGateway(resolved.url, ctx.localUrl);
    throw new CliError(
      `There is no token for ${resolved.url}. ` +
        (local
          ? `The gateway on this computer writes one to ${tildePath(localTokenPath(ctx.home), ctx.home)} the first time it runs: start OpenClerq, or run \`clerq login ${resolved.url}\`. `
          : `Run \`clerq login ${resolved.url}\` ` +
            `(for a gateway of yours on this computer, \`--token-file ${tildePath(localTokenPath(ctx.home), ctx.home)}\` keeps where its token is). `) +
        'CLERQ_GATEWAY_TOKEN works too.'
    );
  }
  return resolved;
}
