/**
 * A fake GitHub API server for tests. Nothing here reaches the network: it
 * listens on 127.0.0.1 and the gateway is pointed at it with `CLERQ_GITHUB_API`.
 *
 * It checks what GitHub checks that matters to the gateway:
 *   - an app's JWT is RS256, signed by the app's key, `iss` is the app id,
 *     `iat` is not in the future and `exp` is at most 10 minutes after it;
 *   - an installation token is real, unexpired and not revoked, and has the
 *     permission and repository an endpoint needs;
 *   - `POST /app/installations/{id}/access_tokens` takes `repositories` and
 *     `permissions` together and refuses ones the installation does not have;
 *   - `DELETE /installation/token` revokes the token that authenticates it;
 *   - a manifest's code converts once;
 *   - the manifest form (`POST /settings/apps/new`) answers with the redirect a
 *     browser would follow, so a test can play the person's browser;
 *   - the device flow (`/login/device/code`, `/login/oauth/access_token`): a
 *     test plays the person with `approve()`, `deny()` and `expire()`, and can
 *     script the next answers (`deviceScript`); user tokens expire, are
 *     refreshed once each with the client secret, and a grant can be revoked;
 *   - `GET /user`, `/user/installations`, `/user/installations/{id}/repositories`
 *     and `DELETE /applications/{client_id}/grant` for a user token.
 *
 * The website's endpoints (`/login/...`, the manifest form) are served by the
 * same server as the API: a test points both `CLERQ_GITHUB_API` and
 * `CLERQ_GITHUB_WEB` at it.
 *
 * Used only by tests; nothing that ships imports it.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { githubWebBase } from './config.js';
import type { AddressInfo } from 'node:net';

export interface FakeInstallation {
  id: number;
  account: { login: string; type: 'User' | 'Organization' };
  selection: 'all' | 'selected';
  /** `owner/name`, lower case. With `all`, any repository of the account is in. */
  repos: string[];
  permissions: Record<string, string>;
  suspended?: boolean;
}

export interface FakeToken {
  token: string;
  installationId: number;
  repos: string[];
  permissions: Record<string, string>;
  expiresAt: number;
  revoked: boolean;
  /** The request body that made it. */
  asked: { repositories?: unknown; permissions?: unknown };
}

export interface Seen {
  method: string;
  path: string;
  /** How the call proved itself: an app's JWT, an installation token, a personal token, or not at all. */
  auth: 'jwt' | 'token' | 'pat' | 'user' | 'none';
  /** The token used, when `auth` is `token`, `pat` or `user`. */
  token?: string;
  body?: unknown;
  /** The JWT's claims, when `auth` is `jwt`. */
  claims?: { iat: number; exp: number; iss: string };
  status: number;
}

export interface FakePullRequest {
  repo: string;
  token: string;
  /** Who GitHub would show as the author: the app's bot for an installation token. */
  author: string;
  body: Record<string, unknown>;
  number: number;
}

export interface FakeApp {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  owner: { login: string; type: 'User' | 'Organization' };
}

/** A person at the other end of the device flow. */
export interface FakeUser {
  login: string;
  id: number;
  name: string | null;
}

/** A user access token, as an app with expiring tokens gets it. */
export interface FakeUserToken {
  token: string;
  login: string;
  /** Absent: the app does not expire user tokens. */
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  /** The refresh token was used (each works once). */
  refreshUsed: boolean;
  revoked: boolean;
  /** The person's authorization was revoked (a deleted grant): the refresh token is dead too. */
  grantRevoked: boolean;
}

/** One `POST /login/device/code`. */
export interface FakeDevice {
  deviceCode: string;
  userCode: string;
  clientId: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  approvedBy?: FakeUser;
  /** The seconds the server asked to wait. */
  interval: number;
}

/** What the next device-flow poll answers, ahead of the real state. */
export type DeviceScript = 'pending' | 'slow_down' | 'denied' | 'expired' | 'disabled';

export class FakeGithub {
  readonly app: FakeApp;
  readonly privateKeyPem: string;
  /** The keys the app currently has: a JWT signed with any of them is accepted. */
  private readonly publicKeys: crypto.KeyObject[] = [];
  readonly installations: FakeInstallation[] = [];
  readonly tokens = new Map<string, FakeToken>();
  readonly seen: Seen[] = [];
  readonly pulls: FakePullRequest[] = [];
  /** Codes `POST /app-manifests/{code}/conversions` will accept, once each. */
  readonly conversions = new Map<string, Record<string, unknown>>();
  /** What the server thinks the time is (tests move it). */
  clock: () => number = Date.now;
  /** How long a token lives. GitHub's is an hour. */
  tokenLifetimeMs = 3_600_000;
  /** The tokens to hand out next, in order, before making them up. */
  nextTokens: string[] = [];
  /**
   * Personal access tokens the pull request endpoint takes, with the login each
   * acts as (the author GitHub shows). An installation token acts as `<slug>[bot]`.
   */
  readonly pats = new Map<string, string>();
  /** Make tokens as `ghs_predictable_<purpose>_<n>`, so a test can plant one where it should not be. */
  predictable = false;
  /** A status to answer with for the next call to a path that includes the text, once. */
  failNext = new Map<string, { status: number; message: string }>();
  /** The permissions to report in a token, instead of what was asked (to test a wider token). */
  grantInstead: Record<string, string> | undefined;
  /** The repositories to report in a token, instead of what was asked. */
  reportRepos: string[] | undefined;
  /** Never answer a call whose path includes this text (to test a timeout). */
  hang: string | undefined;
  /** Answer a call late: `METHOD /path` includes the key, wait this many milliseconds first. */
  readonly delays = new Map<string, number>();
  /** `html_url` to report for the app (from `GET /app`) and for installations, instead of GitHub's own. */
  appHtmlUrl: string | undefined;
  installationHtmlUrl: string | undefined;
  /** `html_url` to report for a pull request. */
  prHtmlUrl: string | undefined;
  /** Page size for `GET /app/installations`. */
  pageSize = 100;
  /** Page sizes for the user's installations and an installation's repositories. */
  userPageSize = 100;
  userRepoPageSize = 100;

  // ---- the person: device flow, user tokens ----
  /** The client secret the app was given (what a conversion returns). */
  clientSecret = 'client-secret-from-the-fake-conversion';
  /** Whether the app has device flow switched on (the checkbox on its settings page). */
  deviceFlowEnabled = true;
  /** Whether the app expires user tokens (8 hours, with a refresh token). */
  expiringUserTokens = true;
  userTokenLifetimeMs = 8 * 3_600_000;
  refreshTokenLifetimeMs = 182 * 86_400_000;
  deviceInterval = 5;
  deviceExpiresIn = 900;
  /** The address to send the person to, instead of GitHub's `/login/device`. */
  deviceVerificationUri: string | undefined;
  /** The status the login endpoints answer errors with: GitHub puts them in a 200's body. */
  loginErrorStatus = 200;
  readonly devices = new Map<string, FakeDevice>();
  /** The people who approved a code, by login. */
  private readonly people = new Map<string, FakeUser>();
  /** The answers the next polls give, in order, before the real state. */
  deviceScript: DeviceScript[] = [];
  readonly userTokens = new Map<string, FakeUserToken>();
  /** Logins whose grant was revoked with `DELETE /applications/{client_id}/grant`. */
  readonly grantsRevoked: string[] = [];
  /** The ids of the installations a user can see; undefined, all of them. */
  userInstallationIds: number[] | undefined;
  /** `owner/name` in lower case to the name as GitHub spells it. */
  readonly repoCase = new Map<string, string>();
  /** What `GET /user` says. */
  userAvatarUrl: string | undefined;
  userHtmlUrl: string | undefined;
  /** What the browser posted to the manifest form. */
  readonly manifestPosts: Array<{ path: string; state: string; manifest: Record<string, any> }> =
    [];
  private counter = 0;
  private server: http.Server | undefined;
  url = '';

  constructor(options: Partial<FakeApp> & { privateKeyPem?: string } = {}) {
    const pair = options.privateKeyPem
      ? undefined
      : crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
    this.privateKeyPem = options.privateKeyPem ?? (pair?.privateKey as string);
    this.publicKeys.push(crypto.createPublicKey(crypto.createPrivateKey(this.privateKeyPem)));
    this.app = {
      id: options.id ?? 424242,
      slug: options.slug ?? 'openclerq-test',
      name: options.name ?? 'OpenClerq-test',
      clientId: options.clientId ?? 'Iv23liTESTCLIENT0001',
      owner: options.owner ?? { login: 'acme', type: 'User' },
    };
  }

  /** Generate another private key for the app (a rotation), accepted from now on. Returns its PEM. */
  addKey(): string {
    const pair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    this.publicKeys.push(crypto.createPublicKey(pair.publicKey));
    return pair.privateKey;
  }

  /** Delete the app's first key on GitHub: a JWT signed with it is refused from now on. */
  removeOriginalKey(): void {
    this.publicKeys.shift();
  }

  async listen(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Forget what was seen and made (keeps the installations), and go back to the app's first key. */
  reset(): void {
    this.publicKeys.length = 0;
    this.publicKeys.push(crypto.createPublicKey(crypto.createPrivateKey(this.privateKeyPem)));
    this.seen.length = 0;
    this.pulls.length = 0;
    this.tokens.clear();
    this.nextTokens.length = 0;
    this.failNext.clear();
    this.grantInstead = undefined;
    this.reportRepos = undefined;
    this.hang = undefined;
    this.delays.clear();
    this.appHtmlUrl = undefined;
    this.installationHtmlUrl = undefined;
    this.prHtmlUrl = undefined;
    this.counter = 0;
    this.purposes.clear();
    this.pats.clear();
    this.predictable = false;
    this.tokenLifetimeMs = 3_600_000;
    this.clientSecret = 'client-secret-from-the-fake-conversion';
    this.deviceFlowEnabled = true;
    this.expiringUserTokens = true;
    this.userTokenLifetimeMs = 8 * 3_600_000;
    this.refreshTokenLifetimeMs = 182 * 86_400_000;
    this.deviceInterval = 5;
    this.deviceExpiresIn = 900;
    this.deviceVerificationUri = undefined;
    this.loginErrorStatus = 200;
    this.devices.clear();
    this.people.clear();
    this.deviceScript = [];
    this.userTokens.clear();
    this.grantsRevoked.length = 0;
    this.userInstallationIds = undefined;
    this.repoCase.clear();
    this.userAvatarUrl = undefined;
    this.userHtmlUrl = undefined;
    this.manifestPosts.length = 0;
    this.userPageSize = 100;
    this.userRepoPageSize = 100;
  }

  /** The person approves the code on GitHub's page. */
  approve(userCode: string, user: Partial<FakeUser> = {}): void {
    const device = [...this.devices.values()].find((d) => d.userCode === userCode);
    if (!device) throw new Error(`No device with the code ${userCode}`);
    device.state = 'approved';
    device.approvedBy = { login: 'octocat', id: 583231, name: 'The Octocat', ...user };
    this.people.set(device.approvedBy.login, device.approvedBy);
  }

  deny(userCode: string): void {
    const device = [...this.devices.values()].find((d) => d.userCode === userCode);
    if (!device) throw new Error(`No device with the code ${userCode}`);
    device.state = 'denied';
  }

  expire(userCode: string): void {
    const device = [...this.devices.values()].find((d) => d.userCode === userCode);
    if (!device) throw new Error(`No device with the code ${userCode}`);
    device.state = 'expired';
  }

  /** Every device-flow poll made so far, as it was seen. */
  polls(): Seen[] {
    return this.seen.filter(
      (s) =>
        s.method === 'POST' &&
        s.path === '/login/oauth/access_token' &&
        (s.body as { grant_type?: string } | undefined)?.grant_type?.includes('device_code')
    );
  }

  /** Every refresh made so far. */
  refreshes(): Seen[] {
    return this.seen.filter(
      (s) =>
        s.method === 'POST' &&
        s.path === '/login/oauth/access_token' &&
        (s.body as { grant_type?: string } | undefined)?.grant_type === 'refresh_token'
    );
  }

  /** Make a user token for `login`, as GitHub does after a device flow or a refresh. */
  issueUserToken(login: string): FakeUserToken {
    const id = crypto.randomBytes(12).toString('hex');
    const expiring = this.expiringUserTokens;
    const made: FakeUserToken = {
      token: `ghu_fake${id}`,
      login,
      expiresAt: expiring ? this.clock() + this.userTokenLifetimeMs : undefined,
      refreshToken: expiring ? `ghr_fake${id}` : undefined,
      refreshExpiresAt: expiring ? this.clock() + this.refreshTokenLifetimeMs : undefined,
      refreshUsed: false,
      revoked: false,
      grantRevoked: false,
    };
    this.userTokens.set(made.token, made);
    return made;
  }

  private tokenAnswer(t: FakeUserToken): Record<string, unknown> {
    return {
      access_token: t.token,
      token_type: 'bearer',
      scope: '',
      ...(t.expiresAt !== undefined
        ? {
            expires_in: Math.round((t.expiresAt - this.clock()) / 1000),
            refresh_token: t.refreshToken,
            refresh_token_expires_in: Math.round(
              ((t.refreshExpiresAt ?? this.clock()) - this.clock()) / 1000
            ),
          }
        : {}),
    };
  }

  private userOf(login: string): FakeUser {
    return this.people.get(login) ?? { login, id: 583231, name: 'The Octocat' };
  }

  install(installation: Partial<FakeInstallation> & { repos: string[] }): FakeInstallation {
    const found: FakeInstallation = {
      id: installation.id ?? 1000 + this.installations.length + 1,
      account: installation.account ?? { login: 'acme', type: 'Organization' },
      selection: installation.selection ?? 'selected',
      repos: installation.repos.map((r) => r.toLowerCase()),
      permissions: installation.permissions ?? {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
      },
      suspended: installation.suspended,
    };
    this.installations.push(found);
    return found;
  }

  /** Tokens made and not revoked. */
  live(): FakeToken[] {
    return [...this.tokens.values()].filter((t) => !t.revoked);
  }

  /** The calls made to a path (a substring), with their method. */
  calls(method: string, path: string): Seen[] {
    return this.seen.filter((s) => s.method === method && s.path.includes(path));
  }

  /** A converted app, as `POST /app-manifests/{code}/conversions` returns it. */
  conversion(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.app.id,
      slug: this.app.slug,
      node_id: 'A_kgDOTEST',
      owner: { login: this.app.owner.login, type: this.app.owner.type },
      name: this.app.name,
      client_id: this.app.clientId,
      client_secret: 'client-secret-from-the-fake-conversion',
      webhook_secret: 'webhook-secret-from-the-fake-conversion',
      pem: this.privateKeyPem,
      html_url: `${githubWebBase()}/apps/${this.app.slug}`,
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      events: [],
      ...extra,
    };
  }

  private purposes = new Map<string, number>();

  private nextToken(permissions: Record<string, string>): string {
    const queued = this.nextTokens.shift();
    if (queued) return queued;
    if (this.predictable) {
      const purpose = permissions.pull_requests
        ? 'pr'
        : permissions.contents === 'write'
          ? 'push'
          : 'fetch';
      const n = (this.purposes.get(purpose) ?? 0) + 1;
      this.purposes.set(purpose, n);
      return `ghs_predictable_${purpose}_${n}`;
    }
    this.counter += 1;
    return `ghs_fake${String(this.counter).padStart(4, '0')}${crypto.randomBytes(12).toString('hex')}`;
  }

  private verifyJwt(jwt: string): { iat: number; exp: number; iss: string } | string {
    const parts = jwt.split('.');
    if (parts.length !== 3) return 'A JSON web token could not be decoded';
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string };
      if (header.alg !== 'RS256') return 'Unsupported algorithm';
      const ok = this.publicKeys.some((key) =>
        crypto
          .createVerify('RSA-SHA256')
          .update(`${parts[0]}.${parts[1]}`)
          .verify(key, Buffer.from(parts[2], 'base64url'))
      );
      if (!ok) return 'A JSON web token could not be decoded';
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
        iat: number;
        exp: number;
        iss: string | number;
      };
      const now = Math.floor(this.clock() / 1000);
      if (String(claims.iss) !== String(this.app.id)) return 'Issuer is not this app';
      if (claims.iat > now)
        return "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued";
      if (claims.exp <= now) return "'Expiration time' claim ('exp') is too far in the past";
      if (claims.exp - claims.iat > 600 + 60) {
        return "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires";
      }
      return { iat: claims.iat, exp: claims.exp, iss: String(claims.iss) };
    } catch {
      return 'A JSON web token could not be decoded';
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    // A browser's form post (the manifest) is urlencoded.
    if (String(req.headers['content-type'] ?? '').includes('x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const entry: Seen = { method, path: path + url.search, auth: 'none', body, status: 0 };
    this.seen.push(entry);
    const reply = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      entry.status = status;
      // GitHub's clock, which a client can compare with its own.
      res.writeHead(status, {
        'Content-Type': 'application/json',
        Date: new Date(this.clock()).toUTCString(),
        ...headers,
      });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (this.hang && path.includes(this.hang)) return; // never answered
    for (const [needle, ms] of this.delays) {
      if (`${method} ${path}`.includes(needle)) await new Promise((r) => setTimeout(r, ms));
    }
    for (const [needle, failure] of this.failNext) {
      if (path.includes(needle)) {
        this.failNext.delete(needle);
        // `{token}` becomes the credential that was sent (a bearer, a device code or a refresh token): an error that echoes it.
        const sent = (body ?? {}) as {
          device_code?: string;
          refresh_token?: string;
          access_token?: string;
        };
        const echoed = bearer ?? sent.device_code ?? sent.refresh_token ?? sent.access_token ?? '';
        return reply(failure.status, {
          message: failure.message.replace('{token}', echoed),
        });
      }
    }

    // The manifest's code is the credential: no header.
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (method === 'POST' && conversion) {
      const found = this.conversions.get(decodeURIComponent(conversion[1]));
      if (!found) return reply(404, { message: 'Not Found' });
      this.conversions.delete(decodeURIComponent(conversion[1]));
      return reply(201, found);
    }

    if (this.handleWeb(method, path, url, body, reply, entry, res)) return;

    // An app's authorization of one person, revoked with the app's own client id and secret.
    const grant = /^\/applications\/([^/]+)\/grant$/.exec(path);
    if (method === 'DELETE' && grant) {
      const basic = /^Basic (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':') : [];
      if (
        decodeURIComponent(grant[1]) !== this.app.clientId ||
        id !== this.app.clientId ||
        secret !== this.clientSecret
      ) {
        return reply(401, { message: 'Bad credentials' });
      }
      const given = String((body as { access_token?: unknown } | undefined)?.access_token ?? '');
      const held = this.userTokens.get(given);
      if (!held) return reply(404, { message: 'Not Found' });
      if (held.revoked || (held.expiresAt !== undefined && held.expiresAt <= this.clock())) {
        return reply(422, { message: 'Validation Failed' });
      }
      for (const t of this.userTokens.values()) {
        if (t.login === held.login) {
          t.revoked = true;
          t.grantRevoked = true;
        }
      }
      this.grantsRevoked.push(held.login);
      return reply(204);
    }

    // Who is calling.
    let jwtOk = false;
    let token: FakeToken | undefined;
    let userToken: FakeUserToken | undefined;
    if (bearer) {
      if (bearer.split('.').length === 3) {
        const verdict = this.verifyJwt(bearer);
        if (typeof verdict === 'string') return reply(401, { message: verdict });
        entry.auth = 'jwt';
        entry.claims = verdict;
        jwtOk = true;
      } else if (this.pats.has(bearer)) {
        entry.auth = 'pat';
        entry.token = bearer;
      } else if (this.userTokens.has(bearer)) {
        userToken = this.userTokens.get(bearer);
        entry.auth = 'user';
        entry.token = bearer;
        if (
          !userToken ||
          userToken.revoked ||
          (userToken.expiresAt !== undefined && userToken.expiresAt <= this.clock())
        ) {
          return reply(401, { message: 'Bad credentials' });
        }
      } else {
        token = this.tokens.get(bearer);
        entry.auth = 'token';
        entry.token = bearer;
        if (!token || token.revoked || token.expiresAt <= this.clock()) {
          return reply(401, { message: 'Bad credentials' });
        }
      }
    }
    const needJwt = () => {
      if (jwtOk) return true;
      reply(401, {
        message: bearer ? 'A JSON web token is required' : 'Missing or invalid authorization',
      });
      return false;
    };

    if (method === 'GET' && path === '/app') {
      if (!needJwt()) return;
      return reply(200, {
        id: this.app.id,
        slug: this.app.slug,
        name: this.app.name,
        client_id: this.app.clientId,
        owner: this.app.owner,
        html_url: this.appHtmlUrl ?? `${githubWebBase()}/apps/${this.app.slug}`,
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      });
    }

    if (method === 'GET' && path === '/app/installations') {
      if (!needJwt()) return;
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Math.min(this.pageSize, Number(url.searchParams.get('per_page') ?? 100));
      const slice = this.installations.slice((page - 1) * size, page * size);
      const more = page * size < this.installations.length;
      return reply(
        200,
        slice.map((i) => this.publicInstallation(i)),
        more
          ? {
              Link: `<${this.url}/app/installations?per_page=${size}&page=${page + 1}>; rel="next"`,
            }
          : {}
      );
    }

    const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (method === 'GET' && lookup) {
      if (!needJwt()) return;
      const full =
        `${decodeURIComponent(lookup[1])}/${decodeURIComponent(lookup[2])}`.toLowerCase();
      const found = this.installations.find(
        (i) =>
          i.repos.includes(full) ||
          (i.selection === 'all' && full.startsWith(`${i.account.login.toLowerCase()}/`))
      );
      if (!found) return reply(404, { message: 'Not Found' });
      return reply(200, this.publicInstallation(found));
    }

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === 'POST' && mint) {
      if (!needJwt()) return;
      const installation = this.installations.find((i) => i.id === Number(mint[1]));
      if (!installation) return reply(404, { message: 'Not Found' });
      if (installation.suspended) {
        return reply(403, { message: 'This installation has been suspended' });
      }
      const asked = (body ?? {}) as { repositories?: unknown; permissions?: unknown };
      const repoNames = Array.isArray(asked.repositories) ? (asked.repositories as string[]) : [];
      const repos = repoNames.map(
        (n) => `${installation.account.login.toLowerCase()}/${n.toLowerCase()}`
      );
      for (const r of repos) {
        const inside = installation.selection === 'all' ? true : installation.repos.includes(r);
        if (!inside) {
          return reply(422, {
            message:
              'There is at least one repository that does not exist or is not accessible to the parent installation.',
          });
        }
      }
      const perms = (asked.permissions ?? installation.permissions) as Record<string, string>;
      const level = (l: string | undefined) => (l === 'write' ? 2 : l === 'read' ? 1 : 0);
      for (const [name, l] of Object.entries(perms)) {
        if (level(l) > level(installation.permissions[name])) {
          return reply(422, {
            message: 'The permissions requested are not granted to this installation.',
          });
        }
      }
      const made: FakeToken = {
        token: this.nextToken(perms),
        installationId: installation.id,
        repos,
        permissions: { ...perms },
        expiresAt: this.clock() + this.tokenLifetimeMs,
        revoked: false,
        asked,
      };
      this.tokens.set(made.token, made);
      const granted = this.grantInstead ?? { ...perms, metadata: 'read' };
      const reported = this.reportRepos ?? repos;
      return reply(201, {
        token: made.token,
        expires_at: new Date(made.expiresAt).toISOString(),
        permissions: granted,
        repository_selection: repos.length > 0 ? 'selected' : installation.selection,
        repositories: reported.map((r, i) => ({
          id: 500 + i,
          name: r.split('/')[1],
          full_name: r,
        })),
      });
    }

    if (method === 'DELETE' && path === '/installation/token') {
      if (!token) return reply(401, { message: 'Bad credentials' });
      token.revoked = true;
      return reply(204);
    }

    const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path);
    if (method === 'POST' && pull) {
      const full = `${pull[1]}/${pull[2]}`.toLowerCase();
      let author: string;
      if (entry.auth === 'pat') {
        author = this.pats.get(entry.token as string) as string;
      } else if (token) {
        if (!token.repos.includes(full) || token.permissions.pull_requests !== 'write') {
          return reply(403, { message: 'Resource not accessible by integration' });
        }
        author = `${this.app.slug}[bot]`;
      } else {
        return reply(401, { message: 'Bad credentials' });
      }
      const number = this.pulls.length + 1;
      this.pulls.push({
        repo: full,
        token: entry.token as string,
        author,
        body: (body ?? {}) as Record<string, unknown>,
        number,
      });
      return reply(201, {
        html_url: this.prHtmlUrl ?? `${githubWebBase()}/${full}/pull/${number}`,
        number,
      });
    }

    if (userToken) {
      if (method === 'GET' && path === '/user') {
        const person = this.userOf(userToken.login);
        return reply(200, {
          login: person.login,
          id: person.id,
          name: person.name,
          avatar_url:
            this.userAvatarUrl ?? `https://avatars.githubusercontent.com/u/${person.id}?v=4`,
          html_url: this.userHtmlUrl ?? `${githubWebBase()}/${person.login}`,
        });
      }
      if (method === 'GET' && path === '/user/installations') {
        const visible = this.installations.filter(
          (i) => !this.userInstallationIds || this.userInstallationIds.includes(i.id)
        );
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = Math.min(this.userPageSize, Number(url.searchParams.get('per_page') ?? 100));
        const slice = visible.slice((page - 1) * size, page * size);
        return reply(
          200,
          {
            total_count: visible.length,
            installations: slice.map((i) => this.publicInstallation(i)),
          },
          page * size < visible.length
            ? {
                Link: `<${this.url}/user/installations?per_page=${size}&page=${page + 1}>; rel="next"`,
              }
            : {}
        );
      }
      const listed = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      if (method === 'GET' && listed) {
        const found = this.installations.find((i) => i.id === Number(listed[1]));
        if (!found || (this.userInstallationIds && !this.userInstallationIds.includes(found.id))) {
          return reply(404, { message: 'Not Found' });
        }
        if (found.suspended) return reply(403, { message: 'This installation has been suspended' });
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = Math.min(
          this.userRepoPageSize,
          Number(url.searchParams.get('per_page') ?? 100)
        );
        const slice = found.repos.slice((page - 1) * size, page * size);
        return reply(
          200,
          {
            total_count: found.repos.length,
            repository_selection: found.selection,
            repositories: slice.map((full, i) => {
              const shown = this.repoCase.get(full) ?? full;
              return {
                id: 9000 + (page - 1) * size + i,
                name: shown.split('/')[1],
                full_name: shown,
                private: !full.endsWith('-public'),
                html_url: `${githubWebBase()}/${shown}`,
                owner: { login: shown.split('/')[0] },
              };
            }),
          },
          page * size < found.repos.length
            ? {
                Link: `<${this.url}/user/installations/${found.id}/repositories?per_page=${size}&page=${page + 1}>; rel="next"`,
              }
            : {}
        );
      }
    }

    reply(404, { message: 'Not Found' });
  }

  /**
   * GitHub's website: the device flow and the manifest form. True when it
   * answered; the API's routes follow it.
   */
  private handleWeb(
    method: string,
    path: string,
    url: URL,
    body: unknown,
    reply: (status: number, payload?: unknown, headers?: Record<string, string>) => void,
    entry: Seen,
    res: http.ServerResponse
  ): boolean {
    const b = (body ?? {}) as Record<string, unknown>;
    const failed = (error: string, description: string, extra: Record<string, unknown> = {}) =>
      reply(this.loginErrorStatus, { error, error_description: description, ...extra });

    if (method === 'POST' && path === '/login/device/code') {
      if (b.client_id !== this.app.clientId) {
        failed(
          'incorrect_client_credentials',
          'The client_id and/or client_secret passed are incorrect.'
        );
        return true;
      }
      if (!this.deviceFlowEnabled) {
        failed('device_flow_disabled', 'Device Flow must be explicitly enabled for this App');
        return true;
      }
      const id = crypto.randomBytes(8).toString('hex');
      const userCode = `${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase();
      const device: FakeDevice = {
        deviceCode: `device_${id}${crypto.randomBytes(12).toString('hex')}`,
        userCode,
        clientId: b.client_id,
        state: 'pending',
        interval: this.deviceInterval,
      };
      this.devices.set(device.deviceCode, device);
      reply(200, {
        device_code: device.deviceCode,
        user_code: userCode,
        verification_uri: this.deviceVerificationUri ?? `${githubWebBase()}/login/device`,
        expires_in: this.deviceExpiresIn,
        interval: this.deviceInterval,
      });
      return true;
    }

    if (method === 'POST' && path === '/login/oauth/access_token') {
      if (b.grant_type === 'refresh_token') {
        if (b.client_id !== this.app.clientId || b.client_secret !== this.clientSecret) {
          failed(
            'incorrect_client_credentials',
            'The client_id and/or client_secret passed are incorrect.'
          );
          return true;
        }
        const old = [...this.userTokens.values()].find((t) => t.refreshToken === b.refresh_token);
        if (
          !old ||
          old.refreshUsed ||
          old.grantRevoked ||
          (old.refreshExpiresAt !== undefined && old.refreshExpiresAt <= this.clock())
        ) {
          failed('bad_refresh_token', 'The refresh token passed is incorrect or expired.');
          return true;
        }
        old.refreshUsed = true;
        old.revoked = true;
        reply(200, this.tokenAnswer(this.issueUserToken(old.login)));
        return true;
      }

      const scripted = this.deviceScript.shift();
      if (scripted) {
        const device = this.devices.get(String(b.device_code));
        switch (scripted) {
          case 'pending':
            failed('authorization_pending', 'The authorization request is still pending.');
            break;
          case 'slow_down':
            if (device) device.interval += 5;
            failed('slow_down', 'Too many requests have been made in the same timeframe.', {
              interval: (device?.interval ?? this.deviceInterval) + 0,
            });
            break;
          case 'denied':
            failed('access_denied', 'The user has denied the request.');
            break;
          case 'expired':
            failed('expired_token', 'The device_code has expired.');
            break;
          case 'disabled':
            failed('device_flow_disabled', 'Device Flow must be explicitly enabled for this App');
            break;
        }
        return true;
      }
      if (b.client_id !== this.app.clientId) {
        failed(
          'incorrect_client_credentials',
          'The client_id and/or client_secret passed are incorrect.'
        );
        return true;
      }
      if (!this.deviceFlowEnabled) {
        failed('device_flow_disabled', 'Device Flow must be explicitly enabled for this App');
        return true;
      }
      const device = this.devices.get(String(b.device_code));
      if (!device) {
        failed('incorrect_device_code', 'The device_code provided is not valid.');
        return true;
      }
      switch (device.state) {
        case 'pending':
          failed('authorization_pending', 'The authorization request is still pending.');
          return true;
        case 'denied':
          failed('access_denied', 'The user has denied the request.');
          return true;
        case 'expired':
          failed('expired_token', 'The device_code has expired.');
          return true;
        case 'approved':
          this.devices.delete(device.deviceCode);
          reply(200, this.tokenAnswer(this.issueUserToken((device.approvedBy as FakeUser).login)));
          return true;
      }
    }

    // The manifest form a browser posts: GitHub asks the person to confirm, then redirects back.
    const form =
      method === 'POST' ? /^\/(?:organizations\/([^/]+)\/)?settings\/apps\/new$/.exec(path) : null;
    if (form) {
      const state = url.searchParams.get('state') ?? '';
      let manifest: Record<string, any>;
      try {
        manifest = JSON.parse(String(b.manifest ?? ''));
      } catch {
        reply(422, { message: 'The manifest could not be read.' });
        return true;
      }
      this.manifestPosts.push({ path, state, manifest });
      const org = form[1] ? decodeURIComponent(form[1]) : undefined;
      const code = `code${crypto.randomBytes(8).toString('hex')}`;
      this.conversions.set(
        code,
        this.conversion(org ? { owner: { login: org, type: 'Organization' } } : {})
      );
      entry.status = 302;
      res.writeHead(302, {
        Location: `${String(manifest.redirect_url)}?code=${code}&state=${encodeURIComponent(state)}`,
      });
      res.end();
      return true;
    }
    return false;
  }

  private publicInstallation(i: FakeInstallation) {
    return {
      id: i.id,
      app_id: this.app.id,
      app_slug: this.app.slug,
      account: { login: i.account.login, type: i.account.type },
      repository_selection: i.selection,
      permissions: i.permissions,
      suspended_at: i.suspended ? '2026-01-01T00:00:00Z' : null,
      html_url: this.installationHtmlUrl ?? `${githubWebBase()}/settings/installations/${i.id}`,
    };
  }
}
