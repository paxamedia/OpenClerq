/**
 * The credential a run uses with its forge: to clone and fetch the repository,
 * to push its branch, and to open the pull request.
 *
 * The lookup is a function of the forge, the project and the purpose, so that
 * where the credential comes from can change without the runner changing:
 *
 *   - `vaultCredentials`: the secret the spec names (`publish.token_secret`), a
 *     personal access token in the vault.
 *   - `githubAppCredentials` (github/credentials.ts), the gateway's default:
 *     a short-lived installation token of the user's own GitHub App, for one
 *     repository and one purpose, when the app is installed on it; else the
 *     vault secret, as before. `publish.auth` can force one or the other.
 *
 * The token reaches git only as an HTTP header in the environment of the git
 * command that needs it (`forgeAuthEnv`), and the forge's API only in the
 * request that opens the pull request. The agent and the gates never see it,
 * and it is taken out of everything the run stores.
 */

import type { Forge } from '@clerq/workspaces';
import { logger } from '../logger.js';
import { isReservedSecret } from '../github/config.js';

export type CredentialPurpose = 'fetch' | 'push' | 'pull_request';

/**
 * Where a spec says its credential comes from: `auto` (the GitHub App when it
 * is installed on the repository, else the vault secret), `app` (only the
 * app: a run without it fails before any work) or `token` (only the vault
 * secret, never the app).
 */
export type PublishAuth = 'auto' | 'app' | 'token';

export interface CredentialRequest {
  forge: Forge;
  /** "owner/name" or "group/name". */
  project: string;
  purpose: CredentialPurpose;
  /** The vault secret the spec names (`publish.token_secret`). */
  secretName: string;
  /** The spec's `publish.auth`. Absent means `auto`. */
  auth?: PublishAuth;
  automationId: string;
  runId: string;
  /**
   * The caller only wants to know whether there is a credential and where it
   * comes from (the spec preview). Nothing is made, and the `token` of the
   * answer is empty.
   */
  dryRun?: boolean;
}

export interface ForgeCredential {
  token: string;
  /**
   * Where it came from, for the run's record: `vault:GITHUB_TOKEN`, or
   * `github-app:<slug>/installation/<id>`. Never the token.
   */
  source: string;
  /** Who the forge sees acting with it, when that is not the user: `my-app[bot]`. */
  actor?: string;
  /** When it stops working, in milliseconds since the epoch, if it does. */
  expiresAt?: number;
  /**
   * End it: revoke an installation token. Called by whoever asked, when done
   * (a run calls it in `finally`). Safe to call twice; it never throws.
   */
  release?(): Promise<void>;
}

/** Finds the credential for one forge operation, or undefined when there is none. */
export type ForgeCredentials = (
  request: CredentialRequest
) => Promise<ForgeCredential | undefined> | ForgeCredential | undefined;

/**
 * The vault lookup: the secret the spec names, whatever the purpose. The
 * GitHub App's own secrets are never handed out as a token.
 */
export function vaultCredentials(
  getSecret: (name: string) => string | undefined
): ForgeCredentials {
  return (request) => {
    if (isReservedSecret(request.secretName)) return undefined;
    const token = getSecret(request.secretName);
    if (!token) return undefined;
    return { token: request.dryRun ? '' : token, source: `vault:${request.secretName}` };
  };
}

/** The credential's source in words, for a person: "the vault secret X" or "the GitHub App Y". */
export function describeSource(source: string): string {
  const app = /^github-app:([^/]+)\/installation\/(\d+)$/.exec(source);
  if (app) return `the GitHub App ${app[1]} (installation ${app[2]})`;
  return source.startsWith('vault:') ? `the vault secret ${source.slice('vault:'.length)}` : source;
}

/**
 * The credentials one run has been given, kept to end them and to take them
 * out of what the run stores. `secrets` is the run's redaction set: the token
 * and the Basic form git would send it in, for each.
 */
export class HeldCredentials {
  private readonly held = new Map<string, ForgeCredential>();

  /** `secrets` is the run's redaction set; this adds every credential's values to it. */
  constructor(readonly secrets: Record<string, string>) {}

  /** Keep `credential` (if any) and return it. A token held twice is held once. */
  add(credential: ForgeCredential | undefined): ForgeCredential | undefined {
    if (!credential?.token) return credential;
    if (!this.held.has(credential.token)) {
      const n = this.held.size;
      this.held.set(credential.token, credential);
      this.secrets[`FORGE_TOKEN_${n}`] = credential.token;
      for (const user of ['x-access-token', 'oauth2']) {
        this.secrets[`FORGE_BASIC_${n}_${user}`] = Buffer.from(
          `${user}:${credential.token}`
        ).toString('base64');
      }
    }
    return credential;
  }

  /** Take every value in the redaction set out of an error's message. The error itself is kept. */
  scrub(e: unknown): void {
    if (!(e instanceof Error)) return;
    let message = e.message;
    for (const value of Object.values(this.secrets)) {
      if (value && value.length >= 6) message = message.split(value).join('«redacted»');
    }
    if (message !== e.message) e.message = message;
  }

  /** End every credential that can be ended. A failure is logged and ignored. */
  async releaseAll(): Promise<void> {
    await Promise.all(
      [...this.held.values()].map(async (credential) => {
        try {
          await credential.release?.();
        } catch {
          logger.warn('Could not end a forge credential; it expires by itself', {
            source: credential.source,
          });
        }
      })
    );
  }
}
