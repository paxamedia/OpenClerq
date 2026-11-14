/**
 * The client a bundled plugin's UI is given.
 *
 * A plugin that says which core endpoints it calls (`PluginUI.api`) is declared at the
 * gateway: `GET /plugins` lists it with the manifest it shipped, and `plugins.enforce` says
 * whether what plugins declare is held to.
 *
 *  - Enforcement off: the plugin is given the app's own client, as every screen is. A
 *    plugin the person switched off in Settings → Plugins, or that the gateway failed to
 *    start, says so instead of drawing.
 *  - Enforcement on: the plugin is given a client of its own over a module UI token
 *    (`POST /modules/<id>/token`): a token that reaches only the endpoints its manifest
 *    declares, is issued only for a plugin that is enabled, is revoked when it stops, and
 *    is renewed here before it expires. A plugin the gateway will not issue one for (not
 *    installed, off, waiting for approval) makes no call.
 *
 * A plugin that declares nothing (`api` absent) gets the app's client in both modes.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { createGatewayClient, type GatewayClientOptions } from '@clerq/gateway-client';
import type { PluginInfo } from '@clerq/gateway-client';
import type { PluginUI } from '@clerq/plugin-sdk/ui';
import { useEnvironment, type GatewayClient } from './client';
import { errorMessage } from './format';
import { useResource } from './live';

/** What makes a client from an address and a token: `createGatewayClient`, unless a host brings its own. */
export type ScopedClientFactory = (options: GatewayClientOptions) => GatewayClient;

export const defaultScopedClient: ScopedClientFactory = (options) => createGatewayClient(options);

/** How long a plugin's UI token lives. The gateway's own default, and the one most plugins' frames use. */
export const PLUGIN_TOKEN_TTL_S = 15 * 60;

/** A token is renewed when this much of its life has passed. */
const RENEW_AT = 0.7;
/** Never sooner than this after the last one arrived, so a very short life does not loop. */
const MIN_WAIT_MS = 500;
/** After a failed renewal, try again after this. The token in hand keeps working until it expires. */
const RETRY_MS = 10_000;

export interface MintedToken {
  token: string;
  expiresAt: string;
}

/**
 * A module UI token that is renewed before it expires, for as long as it is wanted.
 * `token` is read at every request (the client is given the getter), so a renewal needs
 * no new client. A request already in flight, a stream included, keeps the token it began with.
 */
export class ScopedToken {
  private held: MintedToken | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private problem: unknown = null;

  constructor(
    private readonly mint: () => Promise<MintedToken>,
    private readonly changed: () => void = () => undefined,
    private readonly ttlMs = PLUGIN_TOKEN_TTL_S * 1000
  ) {}

  /** The token to send now; null until the first one arrives. */
  get token(): string | null {
    return this.held?.token ?? null;
  }

  get ready(): boolean {
    return this.held !== null;
  }

  /** Why the last attempt failed, while there is no token to send. */
  get error(): unknown {
    return this.held ? null : this.problem;
  }

  start(): void {
    void this.renew();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Ask for a new token now, as after the gateway refused the one in hand. */
  refresh(): Promise<void> {
    clearTimeout(this.timer);
    return this.renew();
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    try {
      const minted = await this.mint();
      if (this.stopped) return;
      this.held = minted;
      this.problem = null;
      const life = Date.parse(minted.expiresAt) - Date.now();
      const wait = Math.max(
        MIN_WAIT_MS,
        Math.min(this.ttlMs, life > 0 ? life : this.ttlMs) * RENEW_AT
      );
      this.timer = setTimeout(() => void this.renew(), wait);
    } catch (e) {
      if (this.stopped) return;
      this.problem = e;
      this.timer = setTimeout(() => void this.renew(), RETRY_MS);
    }
    this.changed();
  }
}

export type PluginAccess =
  /** Draw the plugin with `client`. `scoped` says it is limited to what the plugin declared. */
  | { status: 'ready'; client: GatewayClient; scoped: boolean }
  | { status: 'loading' }
  /** Draw `reason` instead, and make no call for the plugin. */
  | { status: 'unavailable'; reason: string };

/** Why a plugin the gateway lists is not running, in words for the person. */
export function whyNotRunning(name: string, info: PluginInfo): string {
  if (info.state === 'disabled')
    return `${name} is switched off. Turn it on in Settings → Plugins.`;
  if (info.state === 'awaiting_approval')
    return `${name} is waiting for your approval: plugin checks are on, and it is new or has changed since you approved it. Review it in Settings → Plugins.`;
  return info.reason
    ? `${name} is not running. ${info.reason}`
    : `${name} is not running. Settings → Plugins says why.`;
}

/**
 * What a plugin's page gets, given what the gateway lists and the token held for it.
 * `source` is the plugin's client and token, which exist only while plugin checks are on and
 * the plugin is enabled.
 */
export function decideAccess(input: {
  plugin: Pick<PluginUI, 'id' | 'name' | 'api'>;
  /** The app's own client. */
  app: GatewayClient;
  listing: { data?: { plugins: PluginInfo[]; enforce: boolean }; error?: unknown };
  source?: { client: GatewayClient; token: Pick<ScopedToken, 'ready' | 'error'> };
}): PluginAccess {
  const { plugin, app, listing, source } = input;
  const own: PluginAccess = { status: 'ready', client: app, scoped: false };
  if (plugin.api === undefined) return own;
  if (!listing.data) {
    return listing.error
      ? {
          status: 'unavailable',
          reason: `Couldn’t ask the gateway which plugins run. ${errorMessage(listing.error)}`,
        }
      : { status: 'loading' };
  }
  const { plugins: listed, enforce } = listing.data;
  const info = listed.find((i) => i.id === plugin.id);
  if (!info) {
    return enforce
      ? {
          status: 'unavailable',
          reason: `${plugin.name} is not installed on this gateway, and plugin checks are on, so there is nothing that says what it may call.`,
        }
      : own;
  }
  if (info.state !== 'enabled') {
    return { status: 'unavailable', reason: whyNotRunning(plugin.name, info) };
  }
  if (!enforce) return own;
  if (!source || !source.token.ready) {
    return source?.token.error
      ? {
          status: 'unavailable',
          reason: `Couldn’t get ${plugin.name} a token. ${errorMessage(source.token.error)}`,
        }
      : { status: 'loading' };
  }
  return { status: 'ready', client: source.client, scoped: true };
}

interface Source {
  token: ScopedToken;
  client: GatewayClient;
}

/**
 * A function that says, for each plugin the shell draws, what client it gets or why it
 * cannot run. Reads `GET /plugins` (the same resource Settings shows) and keeps one token
 * per plugin that is given a scoped client.
 */
export function usePluginAccess(plugins: PluginUI[]): (plugin: PluginUI) => PluginAccess {
  const env = useEnvironment();
  const { client } = env;
  const factory = env.scopedClient ?? defaultScopedClient;
  const ttlSeconds = env.pluginTokenSeconds ?? PLUGIN_TOKEN_TTL_S;
  const listing = useResource('plugins', () => client.plugins(), { on: ['modules'] });
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const sources = useRef(new Map<string, Source>());

  // The plugins that need a token of their own: declared, listed, enabled, and enforcement is on.
  const wanted = useMemo(() => {
    const data = listing.data;
    if (!data?.enforce) return [];
    return plugins
      .filter(
        (p) =>
          p.api !== undefined && data.plugins.some((i) => i.id === p.id && i.state === 'enabled')
      )
      .map((p) => p.id)
      .sort();
  }, [plugins, listing.data]);
  const wantedKey = wanted.join('\n');

  useEffect(() => {
    const made = new Map<string, Source>();
    for (const id of wantedKey ? wantedKey.split('\n') : []) {
      const token = new ScopedToken(
        () => client.moduleToken(id, ttlSeconds),
        bump,
        ttlSeconds * 1000
      );
      made.set(id, {
        token,
        client: factory({ baseUrl: client.getUrl(), token: () => token.token }),
      });
    }
    sources.current = made;
    made.forEach((s) => s.token.start());
    bump();
    return () => {
      made.forEach((s) => s.token.stop());
      if (sources.current === made) sources.current = new Map();
    };
  }, [wantedKey, client, factory, ttlSeconds]);

  return useCallback(
    (plugin: PluginUI): PluginAccess =>
      decideAccess({
        plugin,
        app: client,
        listing: { data: listing.data, error: listing.error },
        source: sources.current.get(plugin.id),
      }),
    // `version` changes when a token arrives or fails, which is when `sources` has something new to say.
    [client, listing.data, listing.error, version]
  );
}
