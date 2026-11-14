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
 *   - a manifest's code converts once.
 *
 * Used only by tests; nothing that ships imports it.
 */

import crypto from 'node:crypto';
import http from 'node:http';
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
  auth: 'jwt' | 'token' | 'pat' | 'none';
  /** The installation token used, when `auth` is `token`. */
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
  /** Page size for `GET /app/installations`. */
  pageSize = 100;
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
    this.counter = 0;
    this.purposes.clear();
    this.pats.clear();
    this.predictable = false;
    this.tokenLifetimeMs = 3_600_000;
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
      html_url: `https://github.com/apps/${this.app.slug}`,
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
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const entry: Seen = { method, path: path + url.search, auth: 'none', body, status: 0 };
    this.seen.push(entry);
    const reply = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      entry.status = status;
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (this.hang && path.includes(this.hang)) return; // never answered
    for (const [needle, ms] of this.delays) {
      if (`${method} ${path}`.includes(needle)) await new Promise((r) => setTimeout(r, ms));
    }
    for (const [needle, failure] of this.failNext) {
      if (path.includes(needle)) {
        this.failNext.delete(needle);
        // `{token}` becomes the credential that was sent: an error that echoes it.
        return reply(failure.status, {
          message: failure.message.replace('{token}', bearer ?? ''),
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

    // Who is calling.
    let jwtOk = false;
    let token: FakeToken | undefined;
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
        html_url: `https://github.com/apps/${this.app.slug}`,
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
      return reply(201, { html_url: `https://github.com/${full}/pull/${number}`, number });
    }

    reply(404, { message: 'Not Found' });
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
      html_url: `https://github.com/settings/installations/${i.id}`,
    };
  }
}
