/**
 * Signing a person in to GitHub through the app's device flow, and what the
 * gateway keeps of it.
 *
 * WHAT THE USER TOKEN IS FOR, AND NOT FOR. The token this signs in with is the
 * person's own (a "user access token" of the connected GitHub App). It is used
 * for two things only: to say who is signed in ("signed in as @login": `GET
 * /user`) and to list the repositories that person can reach through the
 * app's installations (`GET /user/installations`, `.../repositories`). It is
 * NOT used to clone, fetch, push or open a pull request: a run does those with
 * the app's installation tokens (`app.ts`), one repository and one purpose at a
 * time, and never with the person's token. Nothing a run, an agent or a spec
 * can name ever reaches it (see `RESERVED_SECRETS`).
 *
 * One GitHub user is signed in per gateway: the gateway has one operator.
 *
 * The flow: `POST <web>/login/device/code` gives a code the person types on
 * GitHub; this polls `POST <web>/login/oauth/access_token` in the background
 * (at GitHub's `interval`, five seconds slower after every `slow_down`) until
 * the person approves, denies, or the code runs out. The tokens go in the vault
 * in one entry (`USER_TOKENS_SECRET`); the device code and the tokens are held
 * in memory only as long as they are needed, are in no answer and no log line,
 * and are cut out of every message from GitHub before it is passed on.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { GithubApiError, githubRequest, nextPage } from './api.js';
import {
  APP_CLIENT_SECRET_SECRET,
  githubUrl,
  githubWebBase,
  readAppConfig,
  settingsUrl,
  splitProject,
  USER_TOKENS_SECRET,
  type GithubAppConfig,
} from './config.js';
import type { Vault } from './connect.js';

/** GitHub's own words are cut to this many characters. */
const MESSAGE_MAX = 300;
/** Never poll faster than this, whatever GitHub says (a 0 would be a busy loop). */
export const MIN_POLL_MS = 1_000;
/** GitHub's default, used when it names none. */
const DEFAULT_INTERVAL_S = 5;
/** What `slow_down` adds, as GitHub documents it. */
export const SLOW_DOWN_S = 5;
/** Flows held at once; the oldest is cancelled to make room. */
export const MAX_FLOWS = 5;
/** How long a finished flow can still be asked about. */
export const FINISHED_KEPT_MS = 10 * 60_000;
/** The user token is renewed this long before it ends. */
export const EXPIRY_MARGIN_MS = 60_000;
/** How long who is signed in is believed. */
export const USER_CACHE_MS = 60_000;
/** Repositories listed, at most. */
export const MAX_REPOSITORIES = 1_000;
const PAGE_SIZE = 100;
const MAX_INSTALLATION_PAGES = 10;
const MAX_REPOSITORY_PAGES = 12;
/** Polls in a row that may fail to reach GitHub before a flow gives up. */
const MAX_POLL_FAILURES = 3;
const SECRETS_KEPT = 64;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export type FlowStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'disabled' | 'error';

/** An answer with a status and a code for a client to read. */
export class SignInError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

/** Who is signed in, as a client sees it. Addresses are checked: https, and the profile on GitHub's website. */
export interface PublicUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
}

export interface FlowStart {
  flowId: string;
  /** What the person types on GitHub. */
  userCode: string;
  /** Where they type it: on GitHub's website. */
  verificationUri: string;
  expiresAt: string;
  /** Seconds between looks, as GitHub asked. */
  interval: number;
}

export interface FlowView {
  status: FlowStatus;
  message?: string;
  /** For `disabled`: the app's settings page, where device flow is switched on. */
  settingsUrl?: string;
  user?: PublicUser | null;
  /** Of a pending flow: when the code stops working. */
  expiresAt?: string;
  /** Of a pending flow: seconds between looks now. */
  interval?: number;
}

export interface UserView {
  signedIn: boolean;
  user?: PublicUser;
  /** When the user token stops working, if it does (GitHub's `expires_in`). */
  expiresAt?: string;
  /** A renewal is possible: a refresh token and the app's client secret are both there. */
  refreshable: boolean;
  message?: string;
}

export interface SignOutView {
  signedOut: true;
  /** GitHub was asked to revoke the authorization, and did. */
  revoked: boolean;
  message: string;
  /** GitHub's page where a person revokes an app's access themselves. */
  authorizationsUrl: string;
}

export interface UserRepository {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string | null;
  installationId: number;
  /** Whose installation reaches it. */
  account: string | null;
}

export interface RepositoryList {
  repositories: UserRepository[];
  /** The list was cut at `limit`: there are more than it shows. */
  truncated: boolean;
  limit: number;
  warnings: string[];
}

export interface SignInOptions {
  vault: Vault;
  now?: () => number;
  fetch?: typeof fetch;
  /** One request's limit. Default 15 s. */
  timeoutMs?: number;
  /** Waits; resolves early when the signal aborts. Tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The connected app. Default: the stored connection. */
  app?: () => GithubAppConfig | null;
  maxFlows?: number;
  userCacheMs?: number;
}

interface StoredTokens {
  v: 1;
  /** The app these belong to: tokens of another app are not used. */
  clientId: string;
  accessToken: string;
  accessExpiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  savedAt: number;
}

interface Flow {
  id: string;
  clientId: string;
  /** The secret half: whoever has it can poll. Cleared when the flow ends. */
  deviceCode: string;
  userCode: string;
  startedAt: number;
  expiresAt: number;
  /** Seconds. */
  interval: number;
  status: FlowStatus;
  message?: string;
  settingsUrl?: string;
  user?: PublicUser | null;
  finishedAt?: number;
  abort: AbortController;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // A flow waiting for a person is not a reason to keep the process alive.
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export class GithubSignIn {
  private readonly vault: Vault;
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly appOf: () => GithubAppConfig | null;
  private readonly maxFlows: number;
  private readonly userCacheMs: number;
  private readonly flows = new Map<string, Flow>();
  /** Every secret seen, newest last: cut out of any text that came from GitHub. */
  private readonly known: string[] = [];
  /** The one renewal in progress, so two callers never both spend a refresh token. */
  private renewing: Promise<RenewResult> | null = null;
  private cache: { token: string; until: number; user: PublicUser } | null = null;
  private closed = false;

  constructor(options: SignInOptions) {
    this.vault = options.vault;
    this.now = options.now ?? Date.now;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? realSleep;
    this.appOf = options.app ?? readAppConfig;
    this.maxFlows = options.maxFlows ?? MAX_FLOWS;
    this.userCacheMs = options.userCacheMs ?? USER_CACHE_MS;
  }

  // ---- words from GitHub, with every secret cut out ---------------------------------

  private learn(...secrets: Array<string | undefined>): void {
    for (const s of secrets) {
      if (!s || s.length < 6 || this.known.includes(s)) continue;
      this.known.push(s);
      if (this.known.length > SECRETS_KEPT) this.known.shift();
    }
  }

  /** `value` with no token, code or secret in it, and not long. */
  scrub(value: string): string {
    let out = value;
    for (const secret of this.known) out = out.split(secret).join('«redacted»');
    // Whatever else looks like a GitHub token, in case one was not seen first.
    out = out.replace(/\b(gh[opsur]_[A-Za-z0-9]{8,})/g, '«redacted»');
    return out.length > MESSAGE_MAX ? `${out.slice(0, MESSAGE_MAX - 1)}…` : out;
  }

  // ---- the vault ----------------------------------------------------------------

  private readStored(): StoredTokens | null {
    const raw = this.vault.get(USER_TOKENS_SECRET);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (
        v.v !== 1 ||
        typeof v.clientId !== 'string' ||
        typeof v.accessToken !== 'string' ||
        !v.accessToken
      ) {
        return null;
      }
      const stored: StoredTokens = {
        v: 1,
        clientId: v.clientId,
        accessToken: v.accessToken,
        accessExpiresAt: num(v.accessExpiresAt),
        refreshToken: text(v.refreshToken),
        refreshExpiresAt: num(v.refreshExpiresAt),
        savedAt: num(v.savedAt) ?? 0,
      };
      this.learn(stored.accessToken, stored.refreshToken);
      return stored;
    } catch {
      return null;
    }
  }

  private writeStored(tokens: StoredTokens): void {
    const result = this.vault.set(USER_TOKENS_SECRET, JSON.stringify(tokens));
    if (!result.ok) {
      throw new SignInError(
        500,
        'vault_failed',
        'The sign-in could not be stored: the vault refused it.'
      );
    }
    this.learn(tokens.accessToken, tokens.refreshToken);
  }

  private forget(): void {
    this.cache = null;
    this.vault.delete(USER_TOKENS_SECRET);
  }

  private clientSecret(): string | null {
    return this.vault.get(APP_CLIENT_SECRET_SECRET) ?? null;
  }

  // ---- requests to GitHub's website (the login endpoints) -----------------------------

  /**
   * One POST to `<web>/login/...`, answering with JSON whatever the status
   * (GitHub puts errors in a 200's body). Throws only when nothing answered.
   */
  private async webPost(
    path: string,
    body: Record<string, string>,
    signal?: AbortSignal
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const limit = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${githubWebBase()}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'OpenClerq',
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, limit]) : limit,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new GithubApiError(0, 'Could not reach GitHub.');
    }
    if (res.status >= 300 && res.status < 400) {
      throw new GithubApiError(0, `GitHub answered with a redirect (${res.status}); not followed.`);
    }
    const raw = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      const j: unknown = raw ? JSON.parse(raw) : {};
      if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    } catch {
      /* not JSON: an empty answer */
    }
    return { status: res.status, body: parsed };
  }

  // ---- the device flow ---------------------------------------------------------------

  private mustHaveApp(): GithubAppConfig {
    const app = this.appOf();
    if (!app) {
      throw new SignInError(
        409,
        'app_not_connected',
        'No GitHub App is connected, so there is nothing to sign in to. Connect one first (clerq github connect, or Settings, GitHub).'
      );
    }
    return app;
  }

  /** What to tell a person whose app does not have device flow switched on. */
  private disabledWords(app: GithubAppConfig): string {
    return (
      'Device flow is not switched on for this GitHub App. Open the app\'s settings page, scroll to "Identifying and authorizing users", ' +
      'tick "Enable Device Flow", save, and try again. Settings page: ' +
      settingsUrl(app)
    );
  }

  /** Begin a sign-in: ask GitHub for a code, and poll for the answer in the background. */
  async start(): Promise<FlowStart> {
    const app = this.mustHaveApp();
    if (this.closed) throw new SignInError(503, 'closing', 'The gateway is stopping.');
    // The tokens have to go somewhere: better to say so now than after the person has approved.
    if (!this.vault.available()) {
      throw new SignInError(
        503,
        'vault_unavailable',
        'The vault has no master key on this computer, so a sign-in could not be kept. Nothing was started.'
      );
    }
    let answer;
    try {
      answer = await this.webPost('/login/device/code', { client_id: app.clientId });
    } catch (e) {
      throw new SignInError(
        502,
        'github_unreachable',
        e instanceof GithubApiError ? e.message : 'Could not reach GitHub.'
      );
    }
    const b = answer.body;
    const error = text(b.error);
    if (error === 'device_flow_disabled') {
      throw new SignInError(409, 'device_flow_disabled', this.disabledWords(app), {
        settingsUrl: settingsUrl(app),
      });
    }
    if (error === 'incorrect_client_credentials' || (error && answer.status === 404)) {
      throw new SignInError(
        422,
        'github_rejected',
        "GitHub did not recognise this app's client ID. Check it on the app's settings page and import the app again."
      );
    }
    const deviceCode = text(b.device_code);
    const userCode = text(b.user_code);
    const uri = githubUrl(b.verification_uri);
    if (error || !deviceCode || !userCode || answer.status >= 400) {
      throw new SignInError(
        502,
        'github_rejected',
        this.scrub(
          text(b.error_description) ?? `GitHub answered ${answer.status} to the sign-in request.`
        )
      );
    }
    if (!/^[A-Za-z0-9-]{4,24}$/.test(userCode)) {
      throw new SignInError(502, 'github_rejected', "GitHub's answer was not understood.");
    }
    if (!uri) {
      throw new SignInError(
        502,
        'invalid_verification_uri',
        'GitHub gave a sign-in address that is not on its website, so it was not used. Nothing was started.'
      );
    }
    this.learn(deviceCode);
    const expiresIn = Math.min(1800, Math.max(60, num(b.expires_in) ?? 900));
    const interval = Math.min(60, Math.max(1, num(b.interval) ?? DEFAULT_INTERVAL_S));
    const startedAt = this.now();
    const flow: Flow = {
      id: crypto.randomBytes(16).toString('hex'),
      clientId: app.clientId,
      deviceCode,
      userCode,
      startedAt,
      expiresAt: startedAt + expiresIn * 1000,
      interval,
      status: 'pending',
      abort: new AbortController(),
    };
    this.room();
    this.flows.set(flow.id, flow);
    void this.poll(flow, app);
    return {
      flowId: flow.id,
      userCode,
      verificationUri: uri,
      expiresAt: new Date(flow.expiresAt).toISOString(),
      interval,
    };
  }

  /** Make room for one more flow: forget the finished ones that are old, then the oldest. */
  private room(): void {
    const now = this.now();
    for (const [id, f] of this.flows) {
      if (f.finishedAt !== undefined && now - f.finishedAt > FINISHED_KEPT_MS)
        this.flows.delete(id);
    }
    while (this.flows.size >= this.maxFlows) {
      const oldest = [...this.flows.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      this.end(oldest, 'error', 'Another sign-in was started, and this one was dropped.');
      this.flows.delete(oldest.id);
    }
  }

  /** A flow's end: its device code is forgotten and its poll stops. */
  private end(
    flow: Flow,
    status: FlowStatus,
    message?: string,
    extra: { settingsUrl?: string; user?: PublicUser | null } = {}
  ): void {
    if (flow.finishedAt !== undefined) return;
    flow.status = status;
    flow.message = message ? this.scrub(message) : undefined;
    flow.settingsUrl = extra.settingsUrl;
    if (extra.user !== undefined) flow.user = extra.user;
    flow.finishedAt = this.now();
    flow.deviceCode = '';
    flow.abort.abort();
  }

  private async poll(flow: Flow, app: GithubAppConfig): Promise<void> {
    const code = flow.deviceCode;
    let failures = 0;
    try {
      for (;;) {
        await this.sleep(Math.max(MIN_POLL_MS, flow.interval * 1000), flow.abort.signal);
        if (flow.finishedAt !== undefined || this.closed) return;
        if (this.now() >= flow.expiresAt) {
          return this.end(flow, 'expired', 'The code ran out before it was approved. Start again.');
        }
        let answer;
        try {
          answer = await this.webPost(
            '/login/oauth/access_token',
            { client_id: flow.clientId, device_code: code, grant_type: DEVICE_GRANT },
            flow.abort.signal
          );
        } catch {
          if (flow.finishedAt !== undefined) return;
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            return this.end(flow, 'error', 'GitHub could not be reached. Start again.');
          }
          continue;
        }
        failures = 0;
        // Cancelled while GitHub was answering: cancelled means nothing is kept.
        if (flow.finishedAt !== undefined) return;
        const b = answer.body;
        const token = text(b.access_token);
        if (token) {
          await this.approve(flow, app, b);
          return;
        }
        switch (text(b.error)) {
          case 'authorization_pending':
            break;
          case 'slow_down': {
            const said = num(b.interval);
            flow.interval =
              said !== undefined && said > flow.interval ? said : flow.interval + SLOW_DOWN_S;
            break;
          }
          case 'access_denied':
            return this.end(flow, 'denied', 'The sign-in was refused on GitHub.');
          case 'expired_token':
            return this.end(
              flow,
              'expired',
              'The code ran out before it was approved. Start again.'
            );
          case 'device_flow_disabled':
            return this.end(flow, 'disabled', this.disabledWords(app), {
              settingsUrl: settingsUrl(app),
            });
          case 'incorrect_client_credentials':
            return this.end(
              flow,
              'error',
              "GitHub did not recognise this app's client ID. Check it on the app's settings page and import the app again."
            );
          default:
            return this.end(
              flow,
              'error',
              text(b.error_description) ?? `GitHub answered ${answer.status}. Start again.`
            );
        }
      }
    } catch (e) {
      // Never an uncaught rejection from a background loop.
      logger.error('GitHub sign-in stopped unexpectedly', {
        reason: e instanceof Error ? e.name : 'unknown',
      });
      this.end(flow, 'error', 'The sign-in stopped unexpectedly. Start again.');
    }
  }

  /** Keep the tokens GitHub gave, then find out who it is. */
  private async approve(
    flow: Flow,
    app: GithubAppConfig,
    b: Record<string, unknown>
  ): Promise<void> {
    const now = this.now();
    const expiresIn = num(b.expires_in);
    const refreshIn = num(b.refresh_token_expires_in);
    const tokens: StoredTokens = {
      v: 1,
      clientId: app.clientId,
      accessToken: b.access_token as string,
      accessExpiresAt: expiresIn === undefined ? undefined : now + expiresIn * 1000,
      refreshToken: text(b.refresh_token),
      refreshExpiresAt:
        text(b.refresh_token) && refreshIn !== undefined ? now + refreshIn * 1000 : undefined,
      savedAt: now,
    };
    this.learn(tokens.accessToken, tokens.refreshToken);
    try {
      this.writeStored(tokens);
    } catch (e) {
      return this.end(
        flow,
        'error',
        e instanceof SignInError ? e.message : 'The sign-in could not be stored.'
      );
    }
    this.cache = null;
    let user: PublicUser | null = null;
    let message: string | undefined;
    try {
      user = await this.identify(tokens.accessToken);
    } catch (e) {
      message = `Signed in, but GitHub did not say who you are: ${
        e instanceof Error ? this.scrub(e.message) : 'unknown error'
      }`;
    }
    this.end(flow, 'approved', message, { user });
  }

  /** A flow's state, or null when there is no such flow (never started, or forgotten). */
  status(id: string): FlowView | null {
    const flow = this.flows.get(id);
    if (!flow) return null;
    const view: FlowView = { status: flow.status };
    if (flow.message) view.message = flow.message;
    if (flow.settingsUrl) view.settingsUrl = flow.settingsUrl;
    if (flow.user !== undefined) view.user = flow.user;
    if (flow.status === 'pending') {
      view.expiresAt = new Date(flow.expiresAt).toISOString();
      view.interval = flow.interval;
    }
    return view;
  }

  /** Stop a flow. True when there was one to stop (finished or not). */
  cancel(id: string): boolean {
    const flow = this.flows.get(id);
    if (!flow) return false;
    if (flow.finishedAt === undefined) {
      this.end(flow, 'error', 'The sign-in was cancelled.');
    }
    this.flows.delete(id);
    return true;
  }

  /** Stop every flow (the gateway is closing). */
  close(): void {
    this.closed = true;
    for (const flow of this.flows.values()) {
      if (flow.finishedAt === undefined) this.end(flow, 'error', 'The gateway stopped.');
    }
    this.flows.clear();
  }

  // ---- who is signed in ----------------------------------------------------------------

  private async identify(token: string): Promise<PublicUser> {
    const cached = this.cache;
    if (cached && cached.token === token && cached.until > this.now()) return cached.user;
    const res = await githubRequest(
      { method: 'GET', path: '/user', bearer: token },
      { fetch: this.doFetch, timeoutMs: this.timeoutMs }
    );
    const b = (res.body ?? {}) as Record<string, unknown>;
    const login = text(b.login);
    const id = num(b.id);
    if (!login || id === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
      throw new GithubApiError(502, "GitHub's answer about the user was not understood.");
    }
    const user: PublicUser = {
      login,
      id,
      name: text(b.name)?.slice(0, 200) ?? null,
      // An address from GitHub is passed on only if it is https; the profile only on GitHub's website.
      avatarUrl: httpsUrl(b.avatar_url),
      htmlUrl: githubUrl(b.html_url),
    };
    this.cache = { token, until: this.now() + this.userCacheMs, user };
    return user;
  }

  /** The user token as stored, whether it is still good or not. Null when nobody is signed in. */
  private heldFor(app: GithubAppConfig | null): StoredTokens | null {
    const stored = this.readStored();
    if (!stored || !app) return null;
    // Tokens of another app are no use to this one.
    if (stored.clientId !== app.clientId) {
      this.forget();
      return null;
    }
    return stored;
  }

  private expired(t: StoredTokens): boolean {
    return t.accessExpiresAt !== undefined && this.now() >= t.accessExpiresAt - EXPIRY_MARGIN_MS;
  }

  private canRefresh(t: StoredTokens): boolean {
    return (
      Boolean(t.refreshToken) &&
      Boolean(this.clientSecret()) &&
      (t.refreshExpiresAt === undefined || this.now() < t.refreshExpiresAt)
    );
  }

  /**
   * A user token that works now: the stored one, or a renewed one. `signedOut`
   * means nothing is held any more (said in `message`); `unusable` that tokens
   * are held but cannot be used right now (GitHub did not answer, or the app's
   * client secret is wrong).
   */
  private async usable(
    app: GithubAppConfig | null
  ): Promise<
    | { token: string; tokens: StoredTokens }
    | { signedOut: true; message?: string }
    | { unusable: true; message: string; tokens: StoredTokens }
  > {
    const stored = this.heldFor(app);
    if (!stored || !app) return { signedOut: true };
    if (!this.expired(stored)) return { token: stored.accessToken, tokens: stored };
    if (!this.canRefresh(stored)) {
      this.forget();
      return {
        signedOut: true,
        message: this.clientSecret()
          ? 'Your GitHub sign-in ran out and could not be renewed. Sign in again.'
          : 'Your GitHub sign-in ran out, and this app has no client secret stored, so it cannot be renewed. Sign in again. ' +
            'To stay signed in, import the app again with its client secret (a "Generate a new client secret" button on its settings page).',
      };
    }
    const renewed = await this.renew(app, stored);
    if (renewed.ok) return { token: renewed.tokens.accessToken, tokens: renewed.tokens };
    if (renewed.signedOut) return { signedOut: true, message: renewed.message };
    return {
      unusable: true,
      message: renewed.message ?? 'Could not renew the sign-in.',
      tokens: stored,
    };
  }

  /**
   * Renew the user token, once for everyone who asks at the same time: GitHub
   * accepts a refresh token once, so a second request with it would sign the
   * person out. Whoever comes after the first has finished finds the new token
   * already stored (`seen` is what they saw) and does not ask GitHub again.
   */
  private renew(app: GithubAppConfig, seen: StoredTokens): Promise<RenewResult> {
    this.renewing ??= this.renewOnce(app, seen).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async renewOnce(app: GithubAppConfig, seen: StoredTokens): Promise<RenewResult> {
    // Someone renewed between this caller's look and now.
    const current = this.readStored();
    if (!current) return { ok: false, signedOut: true, message: undefined };
    if (current.accessToken !== seen.accessToken && !this.expired(current)) {
      return { ok: true, tokens: current };
    }
    const secret = this.clientSecret();
    if (!current.refreshToken || !secret) {
      this.forget();
      return { ok: false, signedOut: true, message: 'Sign in again.' };
    }
    let answer;
    try {
      answer = await this.webPost('/login/oauth/access_token', {
        client_id: app.clientId,
        client_secret: secret,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
    } catch (e) {
      return {
        ok: false,
        signedOut: false,
        message: `Could not renew your GitHub sign-in: ${e instanceof GithubApiError ? e.message : 'GitHub could not be reached.'} It will be tried again.`,
      };
    }
    const b = answer.body;
    const token = text(b.access_token);
    if (!token) {
      const error = text(b.error);
      if (error === 'incorrect_client_credentials') {
        return {
          ok: false,
          signedOut: false,
          message:
            "GitHub did not accept the app's client secret, so your sign-in could not be renewed. Import the app again with a valid client secret. The sign-in itself is kept.",
        };
      }
      if (error === 'bad_refresh_token' || error === 'unauthorized' || answer.status === 401) {
        this.forget();
        return {
          ok: false,
          signedOut: true,
          message:
            'GitHub no longer accepts the saved sign-in (it expired or was revoked). Sign in again.',
        };
      }
      if (answer.status >= 500 || answer.status === 0) {
        return {
          ok: false,
          signedOut: false,
          message: `GitHub could not renew your sign-in right now (${answer.status}). It will be tried again.`,
        };
      }
      this.forget();
      return {
        ok: false,
        signedOut: true,
        message: this.scrub(
          `GitHub refused to renew your sign-in${text(b.error_description) ? `: ${text(b.error_description)}` : ''}. Sign in again.`
        ),
      };
    }
    const now = this.now();
    const expiresIn = num(b.expires_in);
    const refreshIn = num(b.refresh_token_expires_in);
    const next: StoredTokens = {
      v: 1,
      clientId: app.clientId,
      accessToken: token,
      accessExpiresAt: expiresIn === undefined ? undefined : now + expiresIn * 1000,
      refreshToken: text(b.refresh_token) ?? current.refreshToken,
      refreshExpiresAt:
        text(b.refresh_token) && refreshIn !== undefined
          ? now + refreshIn * 1000
          : text(b.refresh_token)
            ? undefined
            : current.refreshExpiresAt,
      savedAt: now,
    };
    this.learn(token, next.refreshToken);
    try {
      this.writeStored(next);
    } catch {
      // GitHub has spent the old refresh token; the new one could not be kept.
      this.forget();
      return {
        ok: false,
        signedOut: true,
        message:
          'Your sign-in was renewed but could not be stored, so it was dropped. Sign in again.',
      };
    }
    return { ok: true, tokens: next };
  }

  /** `GET /github/user`: who is signed in, if anyone, and whether the sign-in can be renewed. */
  async user(): Promise<UserView> {
    const app = this.appOf();
    const got = await this.usable(app);
    if ('signedOut' in got) {
      return {
        signedIn: false,
        refreshable: false,
        ...(got.message ? { message: got.message } : {}),
      };
    }
    if ('unusable' in got) {
      return { signedIn: false, refreshable: this.canRefresh(got.tokens), message: got.message };
    }
    const view = (tokens: StoredTokens, user?: PublicUser, message?: string): UserView => ({
      signedIn: true,
      ...(user ? { user } : {}),
      ...(tokens.accessExpiresAt !== undefined
        ? { expiresAt: new Date(tokens.accessExpiresAt).toISOString() }
        : {}),
      refreshable: this.canRefresh(tokens),
      ...(message ? { message } : {}),
    });
    const signedOut = (message?: string): UserView => ({
      signedIn: false,
      refreshable: false,
      message:
        message ??
        'GitHub no longer accepts your sign-in (it was revoked or has expired). Sign in again.',
    });
    try {
      return view(got.tokens, await this.identify(got.token));
    } catch (e) {
      if (!(e instanceof GithubApiError && e.status === 401)) {
        return view(
          got.tokens,
          undefined,
          `GitHub could not say who you are: ${this.scrub(e instanceof Error ? e.message : 'unknown error')}`
        );
      }
      // The token was revoked on GitHub (or is no good): one renewal if that is possible, else it is over.
      const again = await this.afterRefusal(app, got.tokens);
      if (!('tokens' in again)) return signedOut(again.message);
      try {
        return view(again.tokens, await this.identify(again.tokens.accessToken));
      } catch {
        this.forget();
        return signedOut();
      }
    }
  }

  /** GitHub refused the token: renew it if that is possible, else forget it. */
  private async afterRefusal(
    app: GithubAppConfig | null,
    tokens: StoredTokens
  ): Promise<{ tokens: StoredTokens } | { message?: string }> {
    if (!app || !this.canRefresh(tokens)) {
      this.forget();
      return {};
    }
    const renewed = await this.renew(app, tokens);
    if (renewed.ok && renewed.tokens.accessToken !== tokens.accessToken) {
      return { tokens: renewed.tokens };
    }
    if (renewed.ok) this.forget();
    return renewed.ok ? {} : { message: renewed.message };
  }

  // ---- signing out -----------------------------------------------------------------------

  /** `DELETE /github/user`: forget the tokens, and revoke the authorization when that is possible. Null when nobody was signed in. */
  async signOut(): Promise<SignOutView | null> {
    const app = this.appOf();
    const stored = this.readStored();
    if (!stored) return null;
    // Forgotten first: whatever happens at GitHub, this gateway is signed out.
    this.forget();
    const authorizationsUrl = `${githubWebBase()}/settings/apps/authorizations`;
    const where = `To revoke it yourself, open ${authorizationsUrl} and revoke ${app?.name ?? 'the app'}.`;
    const secret = this.clientSecret();
    if (!app || !secret || stored.clientId !== app.clientId) {
      return {
        signedOut: true,
        revoked: false,
        authorizationsUrl,
        message: `Signed out of OpenClerq. ${
          secret
            ? 'The saved sign-in belonged to another app, so GitHub was not asked to revoke it.'
            : 'This app has no client secret stored, so OpenClerq cannot ask GitHub to revoke the sign-in.'
        } ${where}`,
      };
    }
    try {
      await githubRequest(
        {
          method: 'DELETE',
          path: `/applications/${encodeURIComponent(app.clientId)}/grant`,
          basic: { user: app.clientId, password: secret },
          body: { access_token: stored.accessToken },
        },
        { fetch: this.doFetch, timeoutMs: this.timeoutMs }
      );
    } catch (e) {
      const why =
        e instanceof GithubApiError
          ? e.status === 404 || e.status === 422
            ? 'GitHub did not know the saved token any more (it had expired), so it could not be revoked by it'
            : `GitHub answered ${e.status || 'nothing'}: ${this.scrub(e.message)}`
          : 'GitHub could not be asked';
      return {
        signedOut: true,
        revoked: false,
        authorizationsUrl,
        message: `Signed out of OpenClerq, but the authorization on GitHub was not revoked (${why}). ${where}`,
      };
    }
    return {
      signedOut: true,
      revoked: true,
      authorizationsUrl,
      message: "Signed out, and GitHub revoked the app's access to your account.",
    };
  }

  // ---- repositories the person can reach through the app --------------------------------

  /**
   * The repositories the signed-in person reaches through the app's installations:
   * `GET /user/installations`, then each one's repositories, at most `MAX_REPOSITORIES`.
   * Throws `SignInError` 409 when nobody is signed in (or the sign-in cannot be used now).
   */
  async repositories(): Promise<RepositoryList> {
    const app = this.appOf();
    const got = await this.usable(app);
    if ('signedOut' in got) {
      throw new SignInError(
        409,
        'not_signed_in',
        got.message ??
          'Not signed in to GitHub. Sign in first (clerq github login, or Settings, GitHub).'
      );
    }
    if ('unusable' in got) throw new SignInError(409, 'sign_in_unusable', got.message);
    const api = { fetch: this.doFetch, timeoutMs: this.timeoutMs };
    const out: UserRepository[] = [];
    const warnings: string[] = [];
    let truncated = false;
    let dropped = 0;
    const token = got.token;
    const fail = (e: unknown, what: string): SignInError => {
      if (e instanceof GithubApiError) {
        if (e.status === 401) {
          this.forget();
          return new SignInError(
            409,
            'not_signed_in',
            'GitHub no longer accepts your sign-in (it was revoked or has expired). Sign in again.'
          );
        }
        return new SignInError(
          e.status === 0 || e.status >= 500 ? 502 : 422,
          e.status === 0 || e.status >= 500 ? 'github_unreachable' : 'github_rejected',
          `${what}: ${this.scrub(e.message)}`
        );
      }
      return new SignInError(500, 'github_failed', `${what}.`);
    };

    // The installations this person can see.
    const installations: Array<{ id: number; account: string | null; suspended: boolean }> = [];
    let path: string | null = `/user/installations?per_page=${PAGE_SIZE}`;
    try {
      for (let page = 0; path; page++) {
        if (page >= MAX_INSTALLATION_PAGES) {
          truncated = true;
          break;
        }
        const res = await githubRequest({ method: 'GET', path, bearer: token }, api);
        const list = (res.body as { installations?: unknown } | undefined)?.installations;
        if (Array.isArray(list)) {
          for (const item of list) {
            const i = item as Record<string, unknown>;
            const account = (i.account ?? null) as { login?: unknown } | null;
            if (num(i.id) === undefined) continue;
            installations.push({
              id: i.id as number,
              account: typeof account?.login === 'string' ? account.login : null,
              suspended: Boolean(i.suspended_at),
            });
          }
        }
        path = nextPage(res.headers.get('link'));
      }
    } catch (e) {
      throw fail(e, 'Could not list where the app is installed for you');
    }

    outer: for (const inst of installations) {
      const label = inst.account ?? `installation ${inst.id}`;
      if (inst.suspended) {
        warnings.push(
          `The installation on ${label} is suspended, so its repositories are not listed.`
        );
        continue;
      }
      let next: string | null = `/user/installations/${inst.id}/repositories?per_page=${PAGE_SIZE}`;
      try {
        for (let page = 0; next; page++) {
          if (page >= MAX_REPOSITORY_PAGES) {
            truncated = true;
            break outer;
          }
          const res = await githubRequest({ method: 'GET', path: next, bearer: token }, api);
          const list = (res.body as { repositories?: unknown } | undefined)?.repositories;
          if (Array.isArray(list)) {
            for (const item of list) {
              const r = item as Record<string, unknown>;
              const fullName = text(r.full_name);
              const parts = fullName ? splitProject(fullName) : null;
              if (!fullName || !parts) {
                dropped += 1;
                continue;
              }
              if (out.length >= MAX_REPOSITORIES) {
                truncated = true;
                break outer;
              }
              out.push({
                fullName,
                owner: parts.owner,
                name: parts.name,
                private: r.private === true,
                htmlUrl: githubUrl(r.html_url),
                installationId: inst.id,
                account: inst.account,
              });
            }
          }
          next = nextPage(res.headers.get('link'));
        }
      } catch (e) {
        if (e instanceof GithubApiError && e.status !== 401 && e.status !== 0 && e.status < 500) {
          // One installation that will not list (no access for this person): the rest still show.
          warnings.push(`Could not list the repositories of ${label}: ${this.scrub(e.message)}`);
          continue;
        }
        throw fail(e, `Could not list the repositories of ${label}`);
      }
    }
    if (dropped > 0) {
      warnings.push(
        `${dropped} ${dropped === 1 ? 'repository has a name' : 'repositories have names'} OpenClerq cannot use, and ${dropped === 1 ? 'was' : 'were'} left out.`
      );
    }
    return { repositories: out, truncated, limit: MAX_REPOSITORIES, warnings };
  }
}

type RenewResult =
  | { ok: true; tokens: StoredTokens }
  /** `signedOut`: GitHub refused for good and the tokens were forgotten; else they are kept and it is tried again. */
  | { ok: false; signedOut: boolean; message: string | undefined };
