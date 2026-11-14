/**
 * The connected app against a fake GitHub: installation lookups, installation
 * tokens (what each purpose asks for, caching, refresh, revoking) and the
 * failures a run has to explain. No request leaves the machine.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppUnavailable,
  GithubApp,
  INSTALLED_TTL_MS,
  LIST_TTL_MS,
  MISSING_TTL_MS,
  PERMISSIONS,
  REFRESH_BEFORE_EXPIRY_MS,
} from './app.js';
import { APP_PRIVATE_KEY_SECRET, writeAppConfig } from './config.js';
import { FakeGithub } from './fake-github.js';
import { logger } from '../logger.js';
import { closeStore, initStore } from '../store.js';

let fake: FakeGithub;
let clock: number;
let app: GithubApp;
const saved = process.env.CLERQ_GITHUB_API;

const make = (extra: Partial<ConstructorParameters<typeof GithubApp>[0]> = {}) =>
  new GithubApp({
    getSecret: (name) => (name === APP_PRIVATE_KEY_SECRET ? fake.privateKeyPem : undefined),
    now: () => clock,
    ...extra,
  });

beforeAll(async () => {
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  await initStore(':memory:');
  writeAppConfig({
    appId: fake.app.id,
    slug: fake.app.slug,
    name: fake.app.name,
    clientId: fake.app.clientId,
    owner: fake.app.owner,
    htmlUrl: `https://github.com/apps/${fake.app.slug}`,
    source: 'import',
    createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  closeStore();
  await fake.close();
  if (saved === undefined) delete process.env.CLERQ_GITHUB_API;
  else process.env.CLERQ_GITHUB_API = saved;
});

beforeEach(() => {
  fake.reset();
  fake.installations.length = 0;
  fake.clock = () => clock;
  fake.tokenLifetimeMs = 3_600_000;
  clock = Date.UTC(2026, 10, 13, 12, 0, 0);
  app = make();
});

afterEach(() => vi.restoreAllMocks());

describe('which repositories the app is installed on', () => {
  it('asks GitHub as the app, once, and remembers a few minutes', async () => {
    fake.install({ id: 77, repos: ['acme/app'] });
    const first = await app.installationFor('acme/app');
    expect(first).toMatchObject({ installed: true, installation: { id: 77, account: 'acme' } });

    const calls = fake.calls('GET', '/repos/acme/app/installation');
    expect(calls).toHaveLength(1);
    // Signed as the app, with the app's id as issuer and a short life.
    expect(calls[0].auth).toBe('jwt');
    expect(calls[0].claims).toMatchObject({ iss: String(fake.app.id) });
    expect((calls[0].claims?.exp ?? 0) - (calls[0].claims?.iat ?? 0)).toBe(600);

    await app.installationFor('acme/app');
    await app.installationFor('ACME/App');
    expect(fake.calls('GET', '/installation')).toHaveLength(1);

    clock += INSTALLED_TTL_MS + 1;
    await app.installationFor('acme/app');
    expect(fake.calls('GET', '/installation')).toHaveLength(2);
  });

  it('says not installed on a 404, and asks again sooner so a new install shows up', async () => {
    expect(await app.installationFor('acme/app')).toEqual({ installed: false });
    await app.installationFor('acme/app');
    expect(fake.calls('GET', '/installation')).toHaveLength(1);

    fake.install({ repos: ['acme/app'] });
    clock += MISSING_TTL_MS - 1;
    expect(await app.installationFor('acme/app')).toEqual({ installed: false });
    clock += 2;
    expect(await app.installationFor('acme/app')).toMatchObject({ installed: true });
    expect(MISSING_TTL_MS).toBeLessThan(INSTALLED_TTL_MS);
  });

  it('asks once for a burst of the same question', async () => {
    fake.install({ repos: ['acme/app'] });
    await Promise.all(Array.from({ length: 6 }, () => app.installationFor('acme/app')));
    expect(fake.calls('GET', '/installation')).toHaveLength(1);
  });

  it('does not ask about a name that is no repository', async () => {
    expect(await app.installationFor('not-a-repo')).toEqual({ installed: false });
    expect(await app.installationFor('a/b/c')).toEqual({ installed: false });
    expect(await app.installationFor('../etc/passwd')).toEqual({ installed: false });
    expect(fake.seen).toHaveLength(0);
  });

  it('is for the repositories of an installation on "all", and not for another account', async () => {
    fake.install({ selection: 'all', repos: [], account: { login: 'acme', type: 'Organization' } });
    expect(await app.installationFor('acme/anything')).toMatchObject({ installed: true });
    expect(await app.installationFor('other/anything')).toEqual({ installed: false });
  });

  it('forgets everything when the connection changes', async () => {
    fake.install({ repos: ['acme/app'] });
    await app.installationFor('acme/app');
    app.invalidate();
    await app.installationFor('acme/app');
    expect(fake.calls('GET', '/installation')).toHaveLength(2);
  });

  it('turns every way GitHub can fail into one plain error', async () => {
    fake.failNext.set('/repos/acme/app/installation', { status: 500, message: 'Server Error' });
    await expect(app.installationFor('acme/app')).rejects.toThrow(AppUnavailable);

    // A refused key says what to do about it.
    fake.failNext.set('/repos/acme/app/installation', { status: 401, message: 'Bad key' });
    await expect(app.installationFor('acme/app')).rejects.toThrow(/generate a new private key/);

    // A failure is not remembered: the next question goes to GitHub again.
    fake.install({ repos: ['acme/app'] });
    expect(await app.installationFor('acme/app')).toMatchObject({ installed: true });
  });

  it('turns a timeout into an error instead of waiting for ever', async () => {
    fake.hang = '/installation';
    const quick = make({ timeoutMs: 150 });
    await expect(quick.installationFor('acme/app')).rejects.toThrow(/did not answer in time/);
  });

  it('turns a refused connection into an error', async () => {
    process.env.CLERQ_GITHUB_API = 'http://127.0.0.1:1';
    try {
      await expect(make().installationFor('acme/app')).rejects.toThrow(/Could not reach GitHub/);
    } finally {
      process.env.CLERQ_GITHUB_API = fake.url;
    }
  });

  it('does not follow a redirect, which a renamed repository gets', async () => {
    // A redirect would carry the app's JWT somewhere GitHub did not say.
    const { createServer } = await import('node:http');
    const redirector = createServer((_req, res) => {
      res.writeHead(301, { Location: `${fake.url}/app` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const port = (redirector.address() as { port: number }).port;
    process.env.CLERQ_GITHUB_API = `http://127.0.0.1:${port}`;
    try {
      await expect(make().installationFor('acme/app')).rejects.toThrow(/redirect/);
      expect(fake.seen).toHaveLength(0);
    } finally {
      process.env.CLERQ_GITHUB_API = fake.url;
      redirector.close();
    }
  });

  it('refuses to run without the key in the vault, saying so', async () => {
    const keyless = make({ getSecret: () => undefined });
    await expect(keyless.installationFor('acme/app')).rejects.toThrow(
      /private key is not in the vault/
    );
    const broken = make({ getSecret: () => 'not a key' });
    await expect(broken.installationFor('acme/app')).rejects.toThrow(/cannot be used/);
  });
});

describe('what an installation token is for', () => {
  it('asks for one repository and the least each purpose needs, in one call', async () => {
    fake.install({ id: 5, repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    for (const purpose of ['fetch', 'push', 'pull_request'] as const) {
      fake.seen.length = 0;
      const minted = await app.mint('acme/app', found.installation, purpose, `run_${purpose}`);
      const [call] = fake.calls('POST', '/app/installations/5/access_tokens');
      expect(call.auth).toBe('jwt');
      expect(call.body).toEqual({ repositories: ['app'], permissions: PERMISSIONS[purpose] });
      expect(fake.tokens.get(minted.token)?.permissions).toEqual(PERMISSIONS[purpose]);
    }
    expect(PERMISSIONS).toEqual({
      fetch: { contents: 'read' },
      push: { contents: 'write' },
      pull_request: { pull_requests: 'write', contents: 'read' },
    });
  });

  it('is valid for an hour at most and says when it ends', async () => {
    fake.install({ repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    const t = await app.mint('acme/app', found.installation, 'push', 'run_a');
    expect(t.token).toMatch(/^ghs_/);
    expect(t.expiresAt).toBe(clock + 3_600_000);
  });

  it('is kept for the run that asked, until five minutes before it ends', async () => {
    fake.install({ repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    const { installation } = found;

    const a = await app.mint('acme/app', installation, 'push', 'run_a');
    expect((await app.mint('acme/app', installation, 'push', 'run_a')).token).toBe(a.token);
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(1);

    // Another purpose, another run: another token.
    expect((await app.mint('acme/app', installation, 'fetch', 'run_a')).token).not.toBe(a.token);
    expect((await app.mint('acme/app', installation, 'push', 'run_b')).token).not.toBe(a.token);
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(3);

    // Still good with six minutes to go; made again with four.
    clock = a.expiresAt - REFRESH_BEFORE_EXPIRY_MS - 60_000;
    expect((await app.mint('acme/app', installation, 'push', 'run_a')).token).toBe(a.token);
    clock = a.expiresAt - REFRESH_BEFORE_EXPIRY_MS + 60_000;
    const fresh = await app.mint('acme/app', installation, 'push', 'run_a');
    expect(fresh.token).not.toBe(a.token);
    expect(fresh.expiresAt).toBeGreaterThan(a.expiresAt);
    // The first one was not revoked by being replaced: whoever holds it ends it.
    expect(fake.tokens.get(a.token)?.revoked).toBe(false);
    await a.release();
    expect(fake.tokens.get(a.token)?.revoked).toBe(true);
    expect(fake.tokens.get(fresh.token)?.revoked).toBe(false);
    // …and the replacement is still what the run is given.
    expect((await app.mint('acme/app', installation, 'push', 'run_a')).token).toBe(fresh.token);
  });

  it('is never shared when nobody holds it: made, used once, ended', async () => {
    fake.install({ repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    const a = await app.mint('acme/app', found.installation, 'fetch', '');
    const b = await app.mint('acme/app', found.installation, 'fetch', '');
    expect(a.token).not.toBe(b.token);
    await a.release();
    expect(fake.tokens.get(a.token)?.revoked).toBe(true);
    expect(fake.tokens.get(b.token)?.revoked).toBe(false);
  });

  it('ends at GitHub when released, with the token as the credential, once', async () => {
    fake.install({ repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    const t = await app.mint('acme/app', found.installation, 'push', 'run_a');
    await t.release();
    await t.release();
    const revokes = fake.calls('DELETE', '/installation/token');
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toMatchObject({ auth: 'token', token: t.token, status: 204 });
    expect(fake.live()).toHaveLength(0);

    // A released token is not handed out again.
    const next = await app.mint('acme/app', found.installation, 'push', 'run_a');
    expect(next.token).not.toBe(t.token);
  });

  it('logs a failed revoke without the token, and goes on', async () => {
    fake.install({ repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    const t = await app.mint('acme/app', found.installation, 'push', 'run_a');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    fake.failNext.set('/installation/token', { status: 500, message: 'down' });
    await expect(t.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(t.token);
    expect(JSON.stringify(warn.mock.calls)).toContain('acme/app');
  });

  it('does not wait for ever for a revoke that GitHub does not answer', async () => {
    fake.install({ repos: ['acme/app'] });
    const quick = make({ timeoutMs: 150 });
    const found = await quick.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    const t = await quick.mint('acme/app', found.installation, 'push', 'run_a');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    fake.hang = '/installation/token';
    const began = Date.now();
    await t.release();
    expect(Date.now() - began).toBeLessThan(3_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(t.token);
  });

  it('refuses, and ends, a token wider than asked for', async () => {
    fake.install({ repos: ['acme/app'] });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');

    fake.grantInstead = { contents: 'write', metadata: 'read' };
    await expect(app.mint('acme/app', found.installation, 'fetch', 'run_a')).rejects.toThrow(
      /more access than was asked for \(contents: write\)/
    );
    expect(fake.live()).toHaveLength(0);

    fake.grantInstead = undefined;
    fake.reportRepos = ['acme/app', 'acme/secrets'];
    await expect(app.mint('acme/app', found.installation, 'fetch', 'run_a')).rejects.toThrow(
      /repositories other than acme\/app/
    );
    expect(fake.live()).toHaveLength(0);
  });

  it('says what to do when the installation lacks a permission', async () => {
    fake.install({ repos: ['acme/app'], permissions: { contents: 'read', metadata: 'read' } });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    await expect(app.mint('acme/app', found.installation, 'push', 'run_a')).rejects.toThrow(
      /permissions requested are not granted.*accept them on its installation page/
    );
  });

  it('does not make a token for a suspended installation', async () => {
    fake.install({ repos: ['acme/app'], suspended: true });
    const found = await app.installationFor('acme/app');
    if (!found.installed) throw new Error('installed');
    expect(found.installation.suspended).toBe(true);
    await expect(app.mint('acme/app', found.installation, 'push', 'run_a')).rejects.toThrow(
      AppUnavailable
    );
  });
});

describe('installations and the Repos page', () => {
  it('lists every installation, following the pages, and keeps the answer a minute', async () => {
    for (let i = 0; i < 5; i++) fake.install({ id: 100 + i, repos: [`acme/r${i}`] });
    fake.pageSize = 2;
    const all = await app.installations();
    expect(all.map((i) => i.id)).toEqual([100, 101, 102, 103, 104]);
    expect(fake.calls('GET', '/app/installations')).toHaveLength(3);

    await app.installations();
    expect(fake.calls('GET', '/app/installations')).toHaveLength(3);
    await app.installations({ refresh: true });
    expect(fake.calls('GET', '/app/installations')).toHaveLength(6);
    clock += LIST_TTL_MS + 1;
    await app.installations();
    expect(fake.calls('GET', '/app/installations')).toHaveLength(9);
  });

  it('says where the app is, without ever making a token', async () => {
    fake.install({ id: 9, repos: ['acme/app'] });
    expect(await app.access('acme/app')).toEqual({
      state: 'installed',
      slug: fake.app.slug,
      installationId: 9,
    });
    expect(await app.access('acme/other')).toEqual({ state: 'not_installed', slug: fake.app.slug });
    fake.failNext.set('/repos/acme/third/installation', { status: 500, message: 'Server Error' });
    expect(await app.access('acme/third')).toMatchObject({ state: 'unknown' });
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(0);
  });
});
