/**
 * Keeping and forgetting the app connection: the settings row and the two
 * vault secrets, written together or not at all.
 */

import { audit } from '@clerq/store';
import { getStore } from '../store.js';
import { getSecret, setSecret, deleteSecret, listSecrets } from '../secrets-vault.js';
import {
  APP_CLIENT_SECRET_SECRET,
  APP_PRIVATE_KEY_SECRET,
  clearAppConfig,
  readAppConfig,
  writeAppConfig,
  type GithubAppConfig,
} from './config.js';

/** The vault, as far as this module needs it. */
export interface Vault {
  get(name: string): string | null | undefined;
  set(name: string, value: string): { ok: boolean; error?: string };
  delete(name: string): { ok: boolean; error?: string };
  /** False when the vault has no master key on this host. */
  available(): boolean;
}

export const realVault: Vault = {
  get: getSecret,
  set: setSecret,
  delete: deleteSecret,
  available: () => Array.isArray(listSecrets()),
};

export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectError';
  }
}

/**
 * Another app was connected (or this one forgotten) after the request began,
 * while it waited for GitHub. `connected` is the app that is there now.
 */
export class ConnectConflict extends Error {
  constructor(readonly connected: GithubAppConfig | null) {
    super(
      connected
        ? `The GitHub App ${connected.slug} was connected while this was being set up.`
        : 'The connected GitHub App was forgotten while this was being set up.'
    );
    this.name = 'ConnectConflict';
  }
}

function must(result: { ok: boolean; error?: string }): void {
  if (!result.ok) throw new ConnectError(result.error ?? 'The vault refused the secret.');
}

/**
 * Store the connection. The private key goes in the vault first, then the
 * client secret, then the settings row; if any step fails the earlier ones
 * are put back as they were.
 *
 * `clientSecret` null keeps the one stored for the same app and drops one
 * stored for another.
 *
 * `expected` is which app was connected when the request began (its id, or
 * null for none). A request that waited for GitHub in between checks it again
 * here, with no await before the writes, so two requests that began together
 * cannot both connect: the later one gets a `ConnectConflict` and stores nothing.
 */
export function saveConnection(
  vault: Vault,
  input: {
    config: GithubAppConfig;
    privateKey: string;
    clientSecret: string | null;
    expected: number | null;
    actor: string;
    action: 'github.app.connected' | 'github.app.imported' | 'github.app.key_replaced';
  }
): void {
  const before = {
    config: readAppConfig(),
    key: vault.get(APP_PRIVATE_KEY_SECRET) ?? null,
    secret: vault.get(APP_CLIENT_SECRET_SECRET) ?? null,
  };
  if ((before.config?.appId ?? null) !== input.expected) throw new ConnectConflict(before.config);
  const sameApp = before.config?.appId === input.config.appId;
  try {
    must(vault.set(APP_PRIVATE_KEY_SECRET, input.privateKey));
    if (input.clientSecret) must(vault.set(APP_CLIENT_SECRET_SECRET, input.clientSecret));
    else if (!sameApp && before.secret) must(vault.delete(APP_CLIENT_SECRET_SECRET));
    writeAppConfig(input.config);
  } catch (e) {
    // Back as it was: a half-stored connection would be worse than none.
    for (const [name, value] of [
      [APP_PRIVATE_KEY_SECRET, before.key],
      [APP_CLIENT_SECRET_SECRET, before.secret],
    ] as const) {
      if (value) vault.set(name, value);
      else vault.delete(name);
    }
    if (before.config) writeAppConfig(before.config);
    else clearAppConfig();
    throw e instanceof ConnectError ? e : new ConnectError('The connection could not be stored.');
  }
  audit(getStore(), {
    actor: input.actor,
    action: input.action,
    subject: String(input.config.appId),
    detail: { slug: input.config.slug, owner: input.config.owner?.login ?? null },
  });
}

/** Forget the connection: the settings row and both secrets. The app itself stays on GitHub. */
export function forgetConnection(vault: Vault, actor: string): GithubAppConfig | null {
  const config = readAppConfig();
  if (!config) return null;
  must(vault.delete(APP_PRIVATE_KEY_SECRET));
  must(vault.delete(APP_CLIENT_SECRET_SECRET));
  clearAppConfig();
  audit(getStore(), {
    actor,
    action: 'github.app.disconnected',
    subject: String(config.appId),
    detail: { slug: config.slug },
  });
  return config;
}
