/**
 * The connected GitHub App, as the gateway uses it: ask GitHub where the app
 * is installed, make installation tokens, revoke them.
 *
 * Everything here is in memory. Nothing is written to disk or to the store:
 * the app's key is read from the vault when a request needs it, an
 * installation token lives only in `tokens`, and a lookup's answer is kept for
 * minutes, not for ever.
 *
 * A token is for one repository and one purpose (see `PERMISSIONS`), valid for
 * at most an hour, and is given to one holder, the run that asked for it, so
 * that revoking it when that run ends cannot take it from another run.
 */

import type { CredentialPurpose } from '../automations/credentials.js';
import { logger } from '../logger.js';
import { API_TIMEOUT_MS, GithubApiError, githubRequest, nextPage, type ApiOptions } from './api.js';
import {
  APP_PRIVATE_KEY_SECRET,
  readAppConfig,
  splitProject,
  type GithubAppConfig,
} from './config.js';
import { InvalidKeyError, parsePrivateKey, signAppJwt } from './jwt.js';

/** What a token for each purpose may do: the least that purpose needs. Metadata read comes with every token. */
export const PERMISSIONS: Record<CredentialPurpose, Record<string, 'read' | 'write'>> = {
  fetch: { contents: 'read' },
  push: { contents: 'write' },
  pull_request: { pull_requests: 'write', contents: 'read' },
};

/** A token is made again when this close to expiring. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
/** How long an installation lookup is believed. */
export const INSTALLED_TTL_MS = 5 * 60_000;
/** A repository that is not installed is asked again sooner, so installing the app shows quickly. */
export const MISSING_TTL_MS = 30_000;
/** How long the list of installations is believed. */
export const LIST_TTL_MS = 60_000;
/** A revoke is not worth a run's end waiting for: the token expires by itself. */
export const REVOKE_TIMEOUT_MS = 8_000;
const MAX_LOOKUPS = 500;
const MAX_PAGES = 3;

/**
 * The app cannot be used right now: no key, GitHub refused or did not answer,
 * the installation is suspended or lacks a permission. The message is plain
 * words for the person who reads the run.
 */
export class AppUnavailable extends Error {
  readonly code = 'github_app_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'AppUnavailable';
  }
}

export interface Installation {
  id: number;
  account: string | null;
  accountType: string | null;
  repositorySelection: 'all' | 'selected' | null;
  suspended: boolean;
  permissions: Record<string, string>;
  htmlUrl: string | null;
}

export type InstallationLookup =
  | { installed: true; installation: Installation }
  | { installed: false };

/** An installation token and the one way to end it. */
export interface MintedToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  permissions: Record<string, string>;
  /** Revoke it at GitHub and forget it. Safe to call twice; a failure is logged and ignored. */
  release(): Promise<void>;
}

/** What the Repos page says about a repository: no token is made to find out. */
export type AppAccess =
  | { state: 'off' }
  | { state: 'installed'; slug: string; installationId: number }
  | { state: 'not_installed'; slug: string }
  | { state: 'unknown'; slug: string; reason: string };

export interface GithubAppOptions {
  /** The vault (the key is read when needed and not kept). */
  getSecret(name: string): string | null | undefined;
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  installedTtlMs?: number;
  missingTtlMs?: number;
  listTtlMs?: number;
}

/** What GitHub says about an app: from `GET /app`, or from a manifest's conversion. */
export interface AppInfo {
  appId: number;
  slug: string;
  name: string;
  clientId: string | null;
  owner: { login: string; type: string } | null;
  htmlUrl: string | null;
  permissions: Record<string, string>;
}

/** What a manifest's conversion hands over once: the app, and its secrets. */
export interface ConvertedApp extends AppInfo {
  privateKey: string;
  clientSecret: string | null;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string'
    )
  );
}

export function readAppInfo(body: unknown): AppInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'number' || typeof b.slug !== 'string' || !/^[A-Za-z0-9-]+$/.test(b.slug)) {
    return null;
  }
  const owner = b.owner as { login?: unknown; type?: unknown } | null | undefined;
  return {
    appId: b.id,
    slug: b.slug,
    name: typeof b.name === 'string' ? b.name : b.slug,
    clientId: typeof b.client_id === 'string' ? b.client_id : null,
    owner:
      typeof owner?.login === 'string'
        ? { login: owner.login, type: typeof owner.type === 'string' ? owner.type : 'User' }
        : null,
    htmlUrl: typeof b.html_url === 'string' ? b.html_url : null,
    permissions: stringMap(b.permissions),
  };
}

function rank(level: string | undefined): number {
  return level === 'write' || level === 'admin' ? 2 : level === 'read' ? 1 : 0;
}

function readInstallation(body: unknown): Installation | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'number') return null;
  const account = b.account as { login?: unknown; type?: unknown } | null | undefined;
  const selection = b.repository_selection;
  return {
    id: b.id,
    account: typeof account?.login === 'string' ? account.login : null,
    accountType: typeof account?.type === 'string' ? account.type : null,
    repositorySelection: selection === 'all' || selection === 'selected' ? selection : null,
    suspended: Boolean(b.suspended_at),
    permissions:
      b.permissions && typeof b.permissions === 'object'
        ? Object.fromEntries(
            Object.entries(b.permissions as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string'
            )
          )
        : {},
    htmlUrl: typeof b.html_url === 'string' ? b.html_url : null,
  };
}

/** Why an API call failed, in words for a run's failure message. */
function explain(e: GithubApiError, what: string): string {
  if (e.status === 0) return `${what}: ${e.message}`;
  if (e.status === 401) {
    return (
      `${what}: GitHub did not accept the app's key (${e.message}). ` +
      'It may have been deleted in the app settings: generate a new private key there and import it again.'
    );
  }
  return `${what}: GitHub answered ${e.status} (${e.message}).`;
}

export class GithubApp {
  private readonly now: () => number;
  private readonly api: ApiOptions;
  private readonly installedTtl: number;
  private readonly missingTtl: number;
  private readonly listTtl: number;
  private lookups = new Map<string, { until: number; value: InstallationLookup }>();
  private lookupsInFlight = new Map<string, Promise<InstallationLookup>>();
  private tokens = new Map<string, MintedToken>();
  private mintsInFlight = new Map<string, Promise<MintedToken>>();
  private list: { until: number; value: Installation[] } | undefined;

  constructor(private readonly options: GithubAppOptions) {
    this.now = options.now ?? Date.now;
    this.api = { fetch: options.fetch, timeoutMs: options.timeoutMs };
    this.installedTtl = options.installedTtlMs ?? INSTALLED_TTL_MS;
    this.missingTtl = options.missingTtlMs ?? MISSING_TTL_MS;
    this.listTtl = options.listTtlMs ?? LIST_TTL_MS;
  }

  /** The stored connection, or null. */
  config(): GithubAppConfig | null {
    return readAppConfig();
  }

  connected(): boolean {
    return this.config() !== null;
  }

  /** Forget every cached answer (the connection changed, or the person asked). Tokens in use stay valid until released. */
  invalidate(): void {
    this.lookups.clear();
    this.list = undefined;
  }

  /** The app's JWT, signed now. Throws `AppUnavailable` when the key is missing. */
  jwt(config: GithubAppConfig): string {
    const pem = this.options.getSecret(APP_PRIVATE_KEY_SECRET);
    if (!pem) {
      throw new AppUnavailable(
        `The GitHub App ${config.slug} is connected, but its private key is not in the vault. Import the key again.`
      );
    }
    try {
      return signAppJwt({ issuer: config.appId, privateKey: pem, now: this.now() });
    } catch (e) {
      if (e instanceof InvalidKeyError) {
        throw new AppUnavailable(
          `The private key stored for the GitHub App ${config.slug} cannot be used: ${e.message}`
        );
      }
      throw e;
    }
  }

  /**
   * `GET /app` as the app with this id and key, which is how a key is proved
   * to work. Throws `InvalidKeyError` for a key that is no key, and
   * `GithubApiError` for GitHub's refusal (its `message` is GitHub's own).
   */
  async describeApp(appId: number, privateKey: string): Promise<AppInfo> {
    const bearer = signAppJwt({
      issuer: appId,
      privateKey: parsePrivateKey(privateKey),
      now: this.now(),
    });
    const res = await githubRequest({ method: 'GET', path: '/app', bearer }, this.api);
    const info = readAppInfo(res.body);
    if (!info) throw new GithubApiError(502, "GitHub's answer about the app was not understood.");
    return info;
  }

  /**
   * Exchange the code GitHub sent back after the manifest was accepted:
   * `POST /app-manifests/{code}/conversions`. It needs no credential and works
   * once; the answer holds the app's private key and client secret.
   */
  async convertManifest(code: string): Promise<ConvertedApp> {
    const res = await githubRequest(
      { method: 'POST', path: `/app-manifests/${encodeURIComponent(code)}/conversions` },
      this.api
    );
    const info = readAppInfo(res.body);
    const b = (res.body ?? {}) as Record<string, unknown>;
    if (!info || typeof b.pem !== 'string' || !b.pem || typeof b.client_id !== 'string') {
      throw new GithubApiError(502, "GitHub's answer to the manifest was not understood.");
    }
    return {
      ...info,
      privateKey: b.pem,
      clientSecret: typeof b.client_secret === 'string' && b.client_secret ? b.client_secret : null,
    };
  }

  private requireConfig(): GithubAppConfig {
    const config = this.config();
    if (!config) throw new AppUnavailable('No GitHub App is connected.');
    return config;
  }

  /**
   * Whether the app is installed on `owner/name`: `GET /repos/{owner}/{repo}/installation`,
   * asked as the app. Kept for a few minutes (a "not installed" for 30 s).
   * Throws `AppUnavailable` when GitHub cannot say.
   */
  async installationFor(project: string): Promise<InstallationLookup> {
    const config = this.requireConfig();
    const parts = splitProject(project);
    if (!parts) return { installed: false };
    const key = `${config.appId}:${project.toLowerCase()}`;
    const hit = this.lookups.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const running = this.lookupsInFlight.get(key);
    if (running) return running;
    const work = this.lookup(config, parts, project)
      .then((value) => {
        if (this.lookups.size >= MAX_LOOKUPS) this.prune();
        this.lookups.set(key, {
          until: this.now() + (value.installed ? this.installedTtl : this.missingTtl),
          value,
        });
        return value;
      })
      .finally(() => this.lookupsInFlight.delete(key));
    this.lookupsInFlight.set(key, work);
    return work;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.lookups) if (v.until <= now) this.lookups.delete(k);
    if (this.lookups.size >= MAX_LOOKUPS) this.lookups.clear();
  }

  private async lookup(
    config: GithubAppConfig,
    parts: { owner: string; name: string },
    project: string
  ): Promise<InstallationLookup> {
    const bearer = this.jwt(config);
    try {
      const res = await githubRequest(
        {
          method: 'GET',
          path: `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}/installation`,
          bearer,
          accept: [404],
        },
        this.api
      );
      if (res.status === 404) return { installed: false };
      const found = readInstallation(res.body);
      if (!found) {
        throw new AppUnavailable(
          `GitHub's answer about the installation on ${project} was not understood.`
        );
      }
      const appId = (res.body as { app_id?: unknown }).app_id;
      if (typeof appId === 'number' && appId !== config.appId) {
        throw new AppUnavailable(`GitHub says another app (${appId}) is installed on ${project}.`);
      }
      return { installed: true, installation: found };
    } catch (e) {
      if (e instanceof GithubApiError) {
        throw new AppUnavailable(
          explain(e, `Could not ask GitHub whether the app is installed on ${project}`)
        );
      }
      throw e;
    }
  }

  /** What the Repos page shows for one repository. Never makes a token. */
  async access(project: string): Promise<AppAccess> {
    const config = this.config();
    if (!config) return { state: 'off' };
    try {
      const found = await this.installationFor(project);
      if (!found.installed) return { state: 'not_installed', slug: config.slug };
      if (found.installation.suspended) {
        return { state: 'unknown', slug: config.slug, reason: 'The installation is suspended.' };
      }
      return { state: 'installed', slug: config.slug, installationId: found.installation.id };
    } catch (e) {
      return {
        state: 'unknown',
        slug: config.slug,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Every installation of the app: `GET /app/installations`. Cached for a minute. */
  async installations(options: { refresh?: boolean } = {}): Promise<Installation[]> {
    const config = this.requireConfig();
    if (!options.refresh && this.list && this.list.until > this.now()) return this.list.value;
    const bearer = this.jwt(config);
    const out: Installation[] = [];
    let path: string | null = '/app/installations?per_page=100';
    try {
      for (let page = 0; path && page < MAX_PAGES; page++) {
        const res = await githubRequest({ method: 'GET', path, bearer }, this.api);
        if (Array.isArray(res.body)) {
          for (const item of res.body) {
            const one = readInstallation(item);
            if (one) out.push(one);
          }
        }
        path = nextPage(res.headers.get('link'));
      }
    } catch (e) {
      if (e instanceof GithubApiError) {
        throw new AppUnavailable(explain(e, 'Could not list the installations of the app'));
      }
      throw e;
    }
    this.list = { until: this.now() + this.listTtl, value: out };
    return out;
  }

  /**
   * An installation token for `project` and `purpose`.
   *
   * `holder` is the run it is for. A holder's token is reused while it has
   * more than five minutes left, and dropped when released; with no holder
   * (`''`) nothing is kept: the token is made, used once and released.
   * Throws `AppUnavailable`.
   */
  async mint(
    project: string,
    installation: Installation,
    purpose: CredentialPurpose,
    holder: string
  ): Promise<MintedToken> {
    const config = this.requireConfig();
    const parts = splitProject(project);
    if (!parts) throw new AppUnavailable(`${project} is not a GitHub repository name.`);
    const key = `${config.appId}:${installation.id}:${project.toLowerCase()}:${purpose}:${holder}`;
    if (holder) {
      const kept = this.tokens.get(key);
      if (kept && kept.expiresAt - this.now() > REFRESH_BEFORE_EXPIRY_MS) return kept;
      const running = this.mintsInFlight.get(key);
      if (running) return running;
    }
    const work = this.mintFresh(config, parts, project, installation, purpose, holder, key).finally(
      () => this.mintsInFlight.delete(key)
    );
    if (holder) this.mintsInFlight.set(key, work);
    return work;
  }

  private async mintFresh(
    config: GithubAppConfig,
    parts: { owner: string; name: string },
    project: string,
    installation: Installation,
    purpose: CredentialPurpose,
    holder: string,
    key: string
  ): Promise<MintedToken> {
    const wanted = PERMISSIONS[purpose];
    let body: unknown;
    try {
      const res = await githubRequest(
        {
          method: 'POST',
          path: `/app/installations/${installation.id}/access_tokens`,
          bearer: this.jwt(config),
          body: { repositories: [parts.name], permissions: wanted },
        },
        this.api
      );
      body = res.body;
    } catch (e) {
      if (e instanceof GithubApiError) {
        const tail =
          e.status === 422 || e.status === 403
            ? ' If the app was given new permissions, accept them on its installation page.'
            : '';
        throw new AppUnavailable(
          explain(e, `Could not get a ${purpose.replace('_', ' ')} token for ${project}`) + tail
        );
      }
      throw e;
    }

    const b = (body ?? {}) as Record<string, unknown>;
    const token = typeof b.token === 'string' ? b.token : '';
    const expiresAt = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : Number.NaN;
    if (!token || !Number.isFinite(expiresAt)) {
      throw new AppUnavailable(
        `GitHub's answer to the token request for ${project} was not understood.`
      );
    }
    const permissions = Object.fromEntries(
      Object.entries((b.permissions ?? {}) as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string'
      )
    );
    const made: MintedToken = {
      token,
      expiresAt,
      permissions,
      release: async () => undefined,
    };
    let released = false;
    made.release = async () => {
      if (released) return;
      released = true;
      if (this.tokens.get(key) === made) this.tokens.delete(key);
      await this.revoke(token, { project, purpose, installation: installation.id });
    };

    // A token wider than asked for is not used: ended at once.
    const tooWide = this.tooWide(b, wanted, permissions, parts, project);
    if (tooWide) {
      await made.release();
      throw new AppUnavailable(tooWide);
    }
    if (holder) this.tokens.set(key, made);
    return made;
  }

  /** What is wrong with a token's scope, or null when it is no wider than asked. */
  private tooWide(
    body: Record<string, unknown>,
    wanted: Record<string, 'read' | 'write'>,
    granted: Record<string, string>,
    parts: { owner: string; name: string },
    project: string
  ): string | null {
    for (const [name, level] of Object.entries(granted)) {
      const asked = name === 'metadata' ? 'read' : wanted[name];
      if (rank(level) > rank(asked)) {
        return `GitHub gave a token with more access than was asked for (${name}: ${level}) on ${project}; it was revoked and not used.`;
      }
    }
    if (body.repository_selection !== undefined && body.repository_selection !== 'selected') {
      return `GitHub gave a token for more than the one repository ${project}; it was revoked and not used.`;
    }
    if (Array.isArray(body.repositories)) {
      const names = body.repositories.map((r) =>
        r && typeof r === 'object' ? String((r as { name?: unknown }).name ?? '') : ''
      );
      if (names.length !== 1 || names[0].toLowerCase() !== parts.name.toLowerCase()) {
        return `GitHub gave a token for repositories other than ${project}; it was revoked and not used.`;
      }
    }
    return null;
  }

  /**
   * End a token at GitHub: `DELETE /installation/token`, authenticated with
   * the token itself. A failure is logged without the token and ignored: the
   * token expires within the hour anyway.
   */
  private async revoke(
    token: string,
    about: { project: string; purpose: CredentialPurpose; installation: number }
  ): Promise<void> {
    try {
      await githubRequest(
        { method: 'DELETE', path: '/installation/token', bearer: token },
        this.api
      );
    } catch (e) {
      logger.warn('Could not revoke a GitHub installation token; it expires by itself', {
        repository: about.project,
        purpose: about.purpose,
        installation: about.installation,
        status: e instanceof GithubApiError ? e.status : undefined,
        reason: e instanceof GithubApiError ? e.message : 'unexpected error',
      });
    }
  }
}
