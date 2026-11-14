/**
 * Connecting the app: the manifest flow (state, callback, conversion), import,
 * status and disconnect, against a fake GitHub, with an in-memory vault and a
 * clock the test moves. Who may call what is in gateway.integration.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { GithubApp } from './app.js';
import {
  APP_CLIENT_SECRET_SECRET,
  APP_PRIVATE_KEY_SECRET,
  clearAppConfig,
  readAppConfig,
  writeAppConfig,
} from './config.js';
import type { Vault } from './connect.js';
import { FakeGithub } from './fake-github.js';
import { ManifestFlows, STATE_TTL_MS } from './manifest.js';
import { mountGithubRoutes } from './routes.js';
import { closeStore, getStore, initStore } from '../store.js';

const WEB = 'http://github.test';
let fake: FakeGithub;
let server: http.Server;
let base: string;
let clock: number;
let flows: ManifestFlows;
let github: GithubApp;
const saved = { api: process.env.CLERQ_GITHUB_API, web: process.env.CLERQ_GITHUB_WEB };

/** A vault in memory that can be made to fail. */
function memoryVault() {
  const entries = new Map<string, string>();
  const vault: Vault & { entries: Map<string, string>; down: boolean; failOn: string | undefined } =
    {
      entries,
      down: false,
      failOn: undefined,
      get: (name) => entries.get(name),
      set(name, value) {
        if (vault.failOn === name) return { ok: false, error: 'The vault refused that.' };
        entries.set(name, value);
        return { ok: true };
      },
      delete(name) {
        entries.delete(name);
        return { ok: true };
      },
      available: () => !vault.down,
    };
  return vault;
}
let vault: ReturnType<typeof memoryVault>;

/** A request with the Host header the test chooses. */
function call(
  method: string,
  path: string,
  options: { body?: unknown; host?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(options.host ? { host: options.host } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Start a manifest the way a client does, and give the code GitHub would send back. */
async function startFlow(body: Record<string, unknown> = {}) {
  const res = await call('POST', '/github/app/manifest', {
    body: { baseUrl: base, ...body },
  });
  expect(res.status).toBe(200);
  const offer = res.json() as { state: string; url: string; manifest: Record<string, any> };
  const code = `code${crypto.randomBytes(8).toString('hex')}`;
  return { ...offer, code };
}

const callback = (state: string, code: string, host?: string) =>
  call('GET', `/github/app/callback?code=${code}&state=${state}`, { host });

beforeAll(async () => {
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  process.env.CLERQ_GITHUB_WEB = WEB;
  await initStore(':memory:');
  const app = express();
  app.use(express.json());
  clock = Date.UTC(2026, 10, 13, 12, 0, 0);
  flows = new ManifestFlows(
    () => clock,
    () => WEB
  );
  vault = memoryVault();
  github = new GithubApp({ getSecret: (n) => vault.get(n), now: () => clock });
  mountGithubRoutes(app, { app: github, flows, vault, now: () => clock });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeStore();
  await fake.close();
  for (const [key, value] of [
    ['CLERQ_GITHUB_API', saved.api],
    ['CLERQ_GITHUB_WEB', saved.web],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  fake.reset();
  fake.installations.length = 0;
  fake.conversions.clear();
  fake.clock = () => clock;
  clock = Date.UTC(2026, 10, 13, 12, 0, 0);
  flows.clear();
  vault.entries.clear();
  vault.down = false;
  vault.failOn = undefined;
  clearAppConfig();
  getStore().prepare('DELETE FROM audit_log').run();
  github.invalidate();
});

afterEach(() => {
  process.env.CLERQ_GITHUB_API = fake.url;
});

const audited = () =>
  getStore()
    .prepare(
      "SELECT action, subject, detail FROM audit_log WHERE action LIKE 'github.%' ORDER BY id"
    )
    .all()
    .map((r) => String(r.action));

describe('asking for a manifest', () => {
  it('returns the page to post it to, the manifest and a state', async () => {
    const offer = await startFlow();
    expect(offer.url).toBe(`${WEB}/settings/apps/new?state=${offer.state}`);
    expect(offer.state).toMatch(/^[0-9a-f]{64}$/);
    expect(offer.manifest).toMatchObject({
      public: false,
      request_oauth_on_install: false,
      default_events: [],
      hook_attributes: { active: false },
      redirect_url: `${base}/v1/github/app/callback`,
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    // Nothing broader than what runs need.
    expect(Object.keys(offer.manifest.default_permissions).sort()).toEqual([
      'contents',
      'metadata',
      'pull_requests',
    ]);
    expect(offer.manifest.name).toMatch(/^OpenClerq-[0-9a-f]{6}$/);
    expect(offer.manifest.name.length).toBeLessThanOrEqual(34);
  });

  it('can be for an organisation, with a name of the person’s choosing', async () => {
    const offer = await startFlow({ owner: 'acme-org', name: 'Acme Clerq' });
    expect(offer.url).toBe(`${WEB}/organizations/acme-org/settings/apps/new?state=${offer.state}`);
    expect(offer.manifest.name).toBe('Acme Clerq');
  });

  it('refuses what it cannot use, in words', async () => {
    for (const [body, code] of [
      [{}, 'invalid_base_url'],
      [{ baseUrl: 'not a url' }, 'invalid_base_url'],
      [{ baseUrl: 'ftp://127.0.0.1' }, 'invalid_base_url'],
      [{ baseUrl: 'http://clerq.example.com' }, 'invalid_base_url'],
      [{ baseUrl: 'https://user:pw@clerq.example.com' }, 'invalid_base_url'],
      [{ baseUrl: 'https://clerq.example.com/?x=1' }, 'invalid_base_url'],
      [{ baseUrl: base, owner: 'not an org!' }, 'invalid_owner'],
      [{ baseUrl: base, name: 'x'.repeat(40) }, 'invalid_name'],
      [{ baseUrl: base, name: '<script>' }, 'invalid_name'],
    ] as const) {
      const res = await call('POST', '/github/app/manifest', { body });
      expect([res.status, res.json().error]).toEqual([400, code]);
    }
  });

  it('takes https for another computer, and a path prefix a proxy may add', async () => {
    const res = await call('POST', '/github/app/manifest', {
      body: { baseUrl: 'https://clerq.example.com/openclerq/' },
    });
    expect(res.json().redirectUrl).toBe(
      'https://clerq.example.com/openclerq/v1/github/app/callback'
    );
  });

  it('is refused while an app is connected', async () => {
    writeAppConfig({
      appId: 1,
      slug: 'x',
      name: 'x',
      clientId: 'Iv1.x',
      owner: null,
      htmlUrl: 'https://github.com/apps/x',
      source: 'import',
      createdAt: 'now',
    });
    const res = await call('POST', '/github/app/manifest', { body: { baseUrl: base } });
    expect(res.status).toBe(409);
  });

  it('keeps at most twenty waiting, and the newest work', async () => {
    const first = await startFlow();
    for (let i = 0; i < 21; i++) await startFlow();
    expect(flows.waiting).toBe(20);
    // The oldest was dropped to make room.
    const dropped = await callback(first.state, 'abcdefgh');
    expect(dropped.status).toBe(400);
  });
});

describe('the callback', () => {
  it('trades the code for the app, stores the key and the secret in the vault only, and says what next', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    const res = await callback(state, code);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Connected. Now install the app on the repositories it may use:');
    expect(res.text).toContain(`${WEB}/apps/${fake.app.slug}/installations/new`);
    // Nothing in the page is the key or the secret.
    expect(res.text).not.toContain('BEGIN');
    expect(res.text).not.toContain('client-secret-from-the-fake-conversion');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");

    expect(readAppConfig()).toMatchObject({
      appId: fake.app.id,
      slug: fake.app.slug,
      name: fake.app.name,
      clientId: fake.app.clientId,
      owner: { login: 'acme', type: 'User' },
      source: 'manifest',
    });
    // The secrets are in the vault, and only there.
    expect(vault.get(APP_PRIVATE_KEY_SECRET)).toBe(fake.privateKeyPem);
    expect(vault.get(APP_CLIENT_SECRET_SECRET)).toBe('client-secret-from-the-fake-conversion');
    const row = String(
      getStore().prepare("SELECT value FROM settings WHERE key = 'github.app'").get()?.value
    );
    expect(row).not.toContain('BEGIN');
    expect(row).not.toContain('client-secret');
    expect(row).not.toContain('webhook-secret');
    expect(vault.get('GITHUB_APP_WEBHOOK_SECRET')).toBeUndefined();
    expect(audited()).toEqual(['github.app.connected']);

    // The conversion needed no credential.
    const [conv] = fake.calls('POST', '/app-manifests/');
    expect(conv.auth).toBe('none');
  });

  it('works once: the same state again is refused and changes nothing', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    expect((await callback(state, code)).status).toBe(200);
    const config = readAppConfig();
    fake.conversions.set(code, fake.conversion({ slug: 'someone-elses' }));
    const again = await callback(state, code);
    expect(again.status).toBe(400);
    expect(again.text).toContain('Nothing was connected');
    expect(readAppConfig()).toEqual(config);
    expect(fake.calls('POST', '/app-manifests/')).toHaveLength(1);
  });

  it('refuses a state it never made, a malformed one and none, without asking GitHub', async () => {
    const { code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    for (const state of ['f'.repeat(64), 'short', '../../etc', '']) {
      const res = await callback(state, code);
      expect(res.status).toBe(400);
    }
    expect((await call('GET', `/github/app/callback?code=${code}`)).status).toBe(400);
    expect((await call('GET', '/github/app/callback')).status).toBe(400);
    expect(fake.seen).toHaveLength(0);
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
  });

  it('refuses a state after ten minutes', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    clock += STATE_TTL_MS;
    const res = await callback(state, code);
    expect(res.status).toBe(400);
    expect(res.text).toContain('expired');
    expect(fake.seen).toHaveLength(0);
    expect(readAppConfig()).toBeNull();
  });

  it('accepts it just inside ten minutes', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    clock += STATE_TTL_MS - 1;
    expect((await callback(state, code)).status).toBe(200);
  });

  it('wants the address the app was created for, and spends the state when it is not', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    const wrong = await callback(state, code, 'evil.example');
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain('different address');
    // The right address cannot use it afterwards.
    expect((await callback(state, code)).status).toBe(400);
    expect(fake.seen).toHaveLength(0);
    expect(readAppConfig()).toBeNull();
  });

  it('refuses a code that is not a code, before asking GitHub', async () => {
    const { state } = await startFlow();
    const res = await callback(state, '../../app');
    expect(res.status).toBe(400);
    expect(fake.seen).toHaveLength(0);
  });

  it('says so when GitHub does not know the code, and stores nothing', async () => {
    const { state, code } = await startFlow();
    const res = await callback(state, code);
    expect(res.status).toBe(502);
    expect(res.text).toContain('GitHub answered 404');
    expect(readAppConfig()).toBeNull();
  });

  it('refuses an app created under another organisation than the one asked for', async () => {
    const { state, code } = await startFlow({ owner: 'acme-org' });
    fake.conversions.set(code, fake.conversion({ owner: { login: 'someone-else', type: 'User' } }));
    const res = await callback(state, code);
    expect(res.status).toBe(400);
    expect(res.text).toContain('asked for under acme-org');
    expect(res.text).toContain(`${WEB}/settings/apps/${fake.app.slug}`);
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
  });

  it('accepts the organisation it was asked for, whatever the case', async () => {
    const { state, code } = await startFlow({ owner: 'Acme-Org' });
    fake.conversions.set(
      code,
      fake.conversion({ owner: { login: 'acme-org', type: 'Organization' } })
    );
    expect((await callback(state, code)).status).toBe(200);
    expect(readAppConfig()?.owner).toEqual({ login: 'acme-org', type: 'Organization' });
  });

  it('refuses an app with a permission the manifest did not ask for', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(
      code,
      fake.conversion({
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          metadata: 'read',
          administration: 'write',
        },
      })
    );
    const res = await callback(state, code);
    expect(res.status).toBe(400);
    expect(res.text).toContain('administration: write');
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
  });

  it('refuses a key it cannot read', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion({ pem: 'not a key' }));
    const res = await callback(state, code);
    expect(res.status).toBe(400);
    expect(readAppConfig()).toBeNull();
  });

  it('does not spend the code when the vault is not there to keep the key', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    vault.down = true;
    const res = await callback(state, code);
    expect(res.status).toBe(503);
    expect(fake.conversions.has(code)).toBe(true);
    expect(fake.seen).toHaveLength(0);
  });

  it('puts back what it had when the vault refuses part way', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    vault.failOn = APP_CLIENT_SECRET_SECRET;
    const res = await callback(state, code);
    expect(res.status).toBe(400);
    expect(res.text).toContain('could not be stored');
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
    expect(audited()).toEqual([]);
  });

  it('is refused when an app was connected meanwhile', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion());
    writeAppConfig({
      appId: 9,
      slug: 'other',
      name: 'other',
      clientId: 'Iv1.o',
      owner: null,
      htmlUrl: 'https://github.com/apps/other',
      source: 'import',
      createdAt: 'now',
    });
    const res = await callback(state, code);
    expect(res.status).toBe(409);
    expect(fake.conversions.has(code)).toBe(true);
    expect(readAppConfig()?.slug).toBe('other');
  });

  it('lets one of two callbacks that began together connect; the late one says where to delete its app', async () => {
    const a = await startFlow();
    const b = await startFlow();
    fake.conversions.set(a.code, fake.conversion({ id: 11, slug: 'app-a' }));
    const keyB = fake.addKey();
    fake.conversions.set(b.code, fake.conversion({ id: 22, slug: 'app-b', pem: keyB }));
    // A is slow at GitHub; B goes through while it waits.
    fake.delays.set(a.code, 400);
    const late = callback(a.state, a.code);
    while (fake.calls('POST', a.code).length === 0) await new Promise((r) => setTimeout(r, 10));
    const winner = await callback(b.state, b.code);
    expect(winner.status).toBe(200);
    expect(winner.text).toContain('Connected. Now install the app');

    const loser = await late;
    expect(loser.status).toBe(409);
    expect(loser.text).toContain(
      'Another app, app-b, was connected while this one was being created'
    );
    expect(loser.text).toContain('Nothing was connected');
    // Where to delete the one that was not kept.
    expect(loser.text).toContain(`${WEB}/settings/apps/app-a`);
    expect(loser.text).not.toContain('Connected. Now install');

    // The first to finish is the connection, with its own key, and the other left no trace.
    expect(readAppConfig()).toMatchObject({ appId: 22, slug: 'app-b' });
    expect(vault.get(APP_PRIVATE_KEY_SECRET)).toBe(keyB);
    expect(audited()).toEqual(['github.app.connected']);
  });

  it('does not let an import that waited for GitHub replace an app connected meanwhile', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion({ id: 33, slug: 'app-c' }));
    fake.delays.set('GET /app', 400);
    const importing = call('POST', '/github/app/import', {
      body: { appId: fake.app.id, clientId: fake.app.clientId, privateKey: fake.privateKeyPem },
    });
    while (fake.calls('GET', '/app').length === 0) await new Promise((r) => setTimeout(r, 10));
    expect((await callback(state, code)).status).toBe(200);

    const res = await importing;
    expect(res.status).toBe(409);
    expect(res.json().error).toBe('app_changed');
    expect(readAppConfig()).toMatchObject({ appId: 33, slug: 'app-c' });
    expect(audited()).toEqual(['github.app.connected']);
  });

  it('writes the words of GitHub into the page as text, not as markup', async () => {
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion({ name: '<script>alert(1)</script> "app"' }));
    const res = await callback(state, code);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
  });
});

describe('importing an app that exists', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    appId: fake.app.id,
    clientId: fake.app.clientId,
    privateKey: fake.privateKeyPem,
    clientSecret: 'imported-client-secret',
    ...extra,
  });

  it('proves the key to GitHub, then stores the app and its secrets', async () => {
    const res = await call('POST', '/github/app/import', { body: body() });
    expect(res.status).toBe(201);
    expect(res.json()).toMatchObject({
      connected: true,
      replacedKey: false,
      app: {
        appId: fake.app.id,
        slug: fake.app.slug,
        clientId: fake.app.clientId,
        source: 'import',
        installUrl: `${WEB}/apps/${fake.app.slug}/installations/new`,
        settingsUrl: `${WEB}/settings/apps/${fake.app.slug}`,
      },
    });
    // The key was used once to ask GitHub who the app is.
    const [check] = fake.calls('GET', '/app');
    expect(check.auth).toBe('jwt');
    expect(check.claims?.iss).toBe(String(fake.app.id));
    // Stored as it is without the blank line at its end.
    expect(vault.get(APP_PRIVATE_KEY_SECRET)).toBe(fake.privateKeyPem.trim());
    expect(vault.get(APP_CLIENT_SECRET_SECRET)).toBe('imported-client-secret');
    // No answer holds a secret.
    expect(res.text).not.toContain('BEGIN');
    expect(res.text).not.toContain('imported-client-secret');
    expect(audited()).toEqual(['github.app.imported']);
  });

  it('takes the app id as text, the client secret as optional, and a PEM from an .env file', async () => {
    const oneLine = fake.privateKeyPem.trim().replace(/\n/g, '\\n');
    const res = await call('POST', '/github/app/import', {
      body: { appId: String(fake.app.id), clientId: fake.app.clientId, privateKey: oneLine },
    });
    expect(res.status).toBe(201);
    expect(vault.get(APP_PRIVATE_KEY_SECRET)).toBe(fake.privateKeyPem.trim());
    expect(vault.get(APP_CLIENT_SECRET_SECRET)).toBeUndefined();
  });

  it('answers 422 with what is wrong with a key that is no key, asking nobody', async () => {
    const res = await call('POST', '/github/app/import', { body: body({ privateKey: 'hunter2' }) });
    expect(res.status).toBe(422);
    expect(res.json().error).toBe('invalid_private_key');
    expect(res.text).not.toContain('hunter2');
    expect(fake.seen).toHaveLength(0);
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
  });

  it('answers 422 with GitHub’s own message for a key that is not this app’s', async () => {
    const stranger = new FakeGithub();
    const res = await call('POST', '/github/app/import', {
      body: body({ privateKey: stranger.privateKeyPem }),
    });
    expect(res.status).toBe(422);
    expect(res.json()).toEqual({
      error: 'github_rejected',
      message: 'A JSON web token could not be decoded',
    });
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
  });

  it('answers 422 clock_skew, not "bad key", when this computer’s clock is the problem', async () => {
    // GitHub's clock is five minutes behind ours: our JWT is dated in its future.
    fake.clock = () => clock - 5 * 60_000;
    const res = await call('POST', '/github/app/import', { body: body() });
    expect(res.status).toBe(422);
    expect(res.json().error).toBe('clock_skew');
    expect(res.json().message).toContain("about 5 minutes ahead of GitHub's");
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
  });

  it('answers 422 for an app id GitHub does not accept the key for', async () => {
    const res = await call('POST', '/github/app/import', { body: body({ appId: 999 }) });
    expect(res.status).toBe(422);
    expect(res.json().message).toBe('Issuer is not this app');
  });

  it('answers 422 when the client id is another app’s', async () => {
    const res = await call('POST', '/github/app/import', {
      body: body({ clientId: 'Iv23liOTHER' }),
    });
    expect(res.status).toBe(422);
    expect(res.json().error).toBe('client_id_mismatch');
    expect(readAppConfig()).toBeNull();
  });

  it('answers 502 when GitHub cannot be reached, and 400 for what is missing', async () => {
    process.env.CLERQ_GITHUB_API = 'http://127.0.0.1:1';
    expect((await call('POST', '/github/app/import', { body: body() })).status).toBe(502);
    for (const bad of [
      { appId: 'abc' },
      { appId: -4 },
      { clientId: '' },
      { clientId: 'has space' },
      { privateKey: '' },
      { privateKey: 5 },
      { clientSecret: 5 },
    ]) {
      expect((await call('POST', '/github/app/import', { body: body(bad) })).status).toBe(400);
    }
  });

  it('answers 503 when the vault has no key to keep it', async () => {
    vault.down = true;
    expect((await call('POST', '/github/app/import', { body: body() })).status).toBe(503);
    expect(fake.seen).toHaveLength(0);
  });

  it('is rotation when it is the same app: a new key replaces the old, the secret stays', async () => {
    await call('POST', '/github/app/import', { body: body() });
    const first = readAppConfig();
    fake.install({ repos: ['acme/app'] });

    // The new key is made on GitHub, the old one deleted there.
    const rotated = fake.addKey();
    fake.removeOriginalKey();
    const stale = await github.installationFor('acme/app').catch((e: Error) => e);
    expect(stale).toBeInstanceOf(Error);

    const res = await call('POST', '/github/app/import', {
      body: { appId: fake.app.id, clientId: fake.app.clientId, privateKey: rotated },
    });
    expect(res.status).toBe(200);
    expect(res.json().replacedKey).toBe(true);
    expect(vault.get(APP_PRIVATE_KEY_SECRET)).toBe(rotated.trim());
    // Not given again: kept.
    expect(vault.get(APP_CLIENT_SECRET_SECRET)).toBe('imported-client-secret');
    const now = readAppConfig();
    expect(now?.createdAt).toBe(first?.createdAt);
    expect(now?.keyUpdatedAt).toBeDefined();
    expect(audited()).toEqual(['github.app.imported', 'github.app.key_replaced']);

    // The app works again with the new key, no restart.
    expect(await github.installationFor('acme/app')).toMatchObject({ installed: true });
  });

  it('refuses another app while one is connected', async () => {
    await call('POST', '/github/app/import', { body: body() });
    const res = await call('POST', '/github/app/import', { body: body({ appId: 7 }) });
    expect(res.status).toBe(409);
    expect(res.json().error).toBe('app_already_connected');
  });

  it('keeps the old connection when a replacement is refused', async () => {
    await call('POST', '/github/app/import', { body: body() });
    const before = readAppConfig();
    const res = await call('POST', '/github/app/import', {
      body: body({ privateKey: new FakeGithub().privateKeyPem }),
    });
    expect(res.status).toBe(422);
    expect(readAppConfig()).toEqual(before);
    expect(vault.get(APP_PRIVATE_KEY_SECRET)).toBe(fake.privateKeyPem.trim());
  });
});

describe('looking at the connection', () => {
  it('says there is none', async () => {
    const res = await call('GET', '/github/app');
    expect(res.json()).toEqual({ connected: false });
  });

  it('lists the app, what is stored and where it is installed, with no secret', async () => {
    await call('POST', '/github/app/import', {
      body: {
        appId: fake.app.id,
        clientId: fake.app.clientId,
        privateKey: fake.privateKeyPem,
        clientSecret: 'status-client-secret',
      },
    });
    fake.install({
      id: 61,
      repos: ['acme/app', 'acme/lib'],
      account: { login: 'acme', type: 'Organization' },
    });
    fake.install({ id: 62, selection: 'all', repos: [], account: { login: 'me', type: 'User' } });

    const res = await call('GET', '/github/app');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      connected: true,
      app: { slug: fake.app.slug, clientId: fake.app.clientId },
      secrets: { privateKey: true, clientSecret: true },
      installations: [
        {
          id: 61,
          account: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          suspended: false,
        },
        { id: 62, account: 'me', accountType: 'User', repositorySelection: 'all' },
      ],
    });
    expect(res.text).not.toContain('BEGIN');
    expect(res.text).not.toContain('status-client-secret');

    // Cached for a minute; ?refresh=1 asks again.
    await call('GET', '/github/app');
    expect(fake.calls('GET', '/app/installations')).toHaveLength(1);
    await call('GET', '/github/app?refresh=1');
    expect(fake.calls('GET', '/app/installations')).toHaveLength(2);
  });

  it('still answers when GitHub cannot be reached, and says why the list is missing', async () => {
    await call('POST', '/github/app/import', {
      body: { appId: fake.app.id, clientId: fake.app.clientId, privateKey: fake.privateKeyPem },
    });
    fake.failNext.set('/app/installations', { status: 500, message: 'Server Error' });
    const res = await call('GET', '/github/app?refresh=1');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      connected: true,
      installations: null,
      installationsError: expect.stringContaining('Could not list the installations'),
      secrets: { privateKey: true, clientSecret: false },
    });
  });

  it('points an organisation’s app at its organisation’s settings', async () => {
    const org = new FakeGithub({ owner: { login: 'acme-org', type: 'Organization' } });
    writeAppConfig({
      appId: org.app.id,
      slug: org.app.slug,
      name: org.app.name,
      clientId: org.app.clientId,
      owner: org.app.owner,
      htmlUrl: 'https://github.com/apps/x',
      source: 'manifest',
      createdAt: 'now',
    });
    const res = await call('GET', '/github/app');
    expect(res.json().app.settingsUrl).toBe(
      `${WEB}/organizations/acme-org/settings/apps/${org.app.slug}`
    );
  });
});

describe('forgetting it', () => {
  it('removes the settings and both secrets, and says the app is still on GitHub', async () => {
    await call('POST', '/github/app/import', {
      body: {
        appId: fake.app.id,
        clientId: fake.app.clientId,
        privateKey: fake.privateKeyPem,
        clientSecret: 'bye-secret',
      },
    });
    const res = await call('DELETE', '/github/app');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      disconnected: true,
      appDeletedOnGitHub: false,
      slug: fake.app.slug,
      settingsUrl: `${WEB}/settings/apps/${fake.app.slug}`,
    });
    expect(res.json().message).toContain('still exists on GitHub');
    expect(res.json().message).toContain(`${WEB}/settings/apps/${fake.app.slug}`);
    expect(readAppConfig()).toBeNull();
    expect(vault.entries.size).toBe(0);
    expect(audited()).toEqual(['github.app.imported', 'github.app.disconnected']);
    expect((await call('GET', '/github/app')).json()).toEqual({ connected: false });
    // Nothing was asked of GitHub to forget it.
    expect(fake.calls('DELETE', '')).toHaveLength(0);
  });

  it('says there was nothing to forget', async () => {
    const res = await call('DELETE', '/github/app');
    expect(res.status).toBe(404);
    expect(res.json().error).toBe('app_not_connected');
  });

  it('can be followed by connecting another app', async () => {
    await call('POST', '/github/app/import', {
      body: {
        appId: fake.app.id,
        clientId: fake.app.clientId,
        privateKey: fake.privateKeyPem,
        clientSecret: 'a',
      },
    });
    await call('DELETE', '/github/app');
    const { state, code } = await startFlow();
    fake.conversions.set(code, fake.conversion({ client_secret: undefined }));
    expect((await callback(state, code)).status).toBe(200);
    // A secret of the app before it is not kept for the one after.
    expect(vault.get(APP_CLIENT_SECRET_SECRET)).toBeUndefined();
  });
});
