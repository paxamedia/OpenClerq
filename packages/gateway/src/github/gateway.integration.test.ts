/**
 * The GitHub App routes through a whole gateway: who may call them (the
 * gateway's own token, and nobody else but GitHub's browser on the callback),
 * the real vault, and nothing secret in any answer or log line.
 *
 * HOME is a temporary directory, so the vault and its key are this file's own.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway.js';
import { MOBILE_SCOPES } from '../remote/devices.js';
import { getSecret } from '../secrets-vault.js';
import { issueToken } from '../security/scoped-tokens.js';
import { getStore } from '../store.js';
import { APP_CLIENT_SECRET_SECRET, APP_PRIVATE_KEY_SECRET, readAppConfig } from './config.js';
import { FakeGithub } from './fake-github.js';

const TOKEN = 'github-gateway-test-token-0123456789';
const WEB = 'http://github.test';

let home: string;
let fake: FakeGithub;
let baseUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
const saved: Record<string, string | undefined> = {};
const ENV = ['HOME', 'USERPROFILE', 'CLERQ_KEYCHAIN', 'CLERQ_GITHUB_API', 'CLERQ_GITHUB_WEB'];

const api = (p: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

beforeAll(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-github-gw-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLERQ_KEYCHAIN = 'off';
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  process.env.CLERQ_GITHUB_WEB = WEB;

  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 50; i++) {
    if ((await api('/automations')).status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  fake.reset();
  fake.installations.length = 0;
  fake.conversions.clear();
  if ((await api('/github/app')).status === 200) await api('/github/app', { method: 'DELETE' });
});

describe('who may reach /github', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/github/app'],
    ['DELETE', '/github/app'],
    ['POST', '/github/app/manifest', { baseUrl: 'http://127.0.0.1:1' }],
    ['POST', '/github/app/import', {}],
    ['POST', '/github/login'],
    ['GET', '/github/login/0123456789abcdef0123456789abcdef'],
    ['DELETE', '/github/login/0123456789abcdef0123456789abcdef'],
    ['GET', '/github/user'],
    ['DELETE', '/github/user'],
    ['GET', '/github/user/repositories'],
  ];

  it('needs the gateway token, with and without /v1', async () => {
    for (const prefix of ['', '/v1']) {
      for (const [method, p, body] of routes) {
        const res = await api(
          `${prefix}${p}`,
          { method, body: body ? JSON.stringify(body) : undefined },
          null
        );
        expect([method, prefix + p, res.status]).toEqual([method, prefix + p, 401]);
      }
    }
  });

  it('is for the gateway token only: a phone, a module and another tenant get 403', async () => {
    const phone = issueToken({
      kind: 'device',
      subject: 'dev_1',
      scopes: MOBILE_SCOPES,
      ttlMs: 60_000,
    });
    // A module that was given every scope there is: /github is out of reach whatever it says.
    const module = issueToken({ kind: 'module', subject: 'mod', scopes: ['* /*'], ttlMs: 60_000 });
    const tenant = issueToken({
      kind: 'module',
      subject: 'mod',
      scopes: ['* /*'],
      ttlMs: 60_000,
      tenantId: 'acme',
    });
    for (const { token } of [phone, module, tenant]) {
      for (const prefix of ['', '/v1']) {
        for (const [method, p, body] of routes) {
          const res = await api(
            `${prefix}${p}`,
            { method, body: body ? JSON.stringify(body) : undefined },
            token
          );
          expect([method, prefix + p, res.status]).toEqual([method, prefix + p, 403]);
        }
      }
    }
    // The same module token is fine where its scopes reach.
    expect((await api('/automations', {}, module.token)).status).toBe(200);
  });

  it('exempts only GET of the callback, in both forms, and that needs the state', async () => {
    for (const p of ['/github/app/callback', '/v1/github/app/callback']) {
      const res = await api(`${p}?code=abcdef12&state=${'0'.repeat(64)}`, {}, null);
      // Reached the handler: refused for the state, not for the missing token.
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('expired or was already used');
    }
    // Nothing near it is open.
    for (const [method, p] of [
      ['POST', '/github/app/callback'],
      ['POST', '/v1/github/app/callback'],
      ['PUT', '/github/app/callback'],
      ['DELETE', '/github/app/callback'],
      ['GET', '/github/app/callback/'],
      ['GET', '/github/app/callback/extra'],
      ['GET', '/github/app/callbackx'],
      ['GET', '/GITHUB/app/callback'],
      ['GET', '/github/app/manifest'],
      ['GET', '/github/app'],
    ] as const) {
      const res = await api(p, { method }, null);
      expect([method, p, res.status]).toEqual([method, p, 401]);
    }
  });

  it('does not let a scoped token through the callback’s exemption to anything else', async () => {
    const module = issueToken({ kind: 'module', subject: 'mod', scopes: ['* /*'], ttlMs: 60_000 });
    expect((await api('/github/app', {}, module.token)).status).toBe(403);
    // The callback itself ignores the token: it is the state that counts.
    expect((await api('/github/app/callback', {}, module.token)).status).toBe(400);
  });
});

describe('connecting through a whole gateway', () => {
  it('goes from a manifest to a connected app, with the key only in the vault', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      })
    );
    try {
      const offer = await (
        await api('/v1/github/app/manifest', {
          method: 'POST',
          body: JSON.stringify({ baseUrl: baseUrl }),
        })
      ).json();
      expect(offer.manifest.redirect_url).toBe(`${baseUrl}/v1/github/app/callback`);

      // What GitHub does: the browser comes back with the code and the state, with no token.
      fake.conversions.set('abcdef123456', fake.conversion());
      const page = await fetch(
        `${baseUrl}/v1/github/app/callback?code=abcdef123456&state=${offer.state}`
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Connected. Now install the app on the repositories it may use:');

      // The app is stored and the secrets are in the vault.
      expect(readAppConfig()).toMatchObject({ slug: fake.app.slug, source: 'manifest' });
      expect(getSecret(APP_PRIVATE_KEY_SECRET)).toBe(fake.privateKeyPem);
      expect(getSecret(APP_CLIENT_SECRET_SECRET)).toBe('client-secret-from-the-fake-conversion');
      expect(fs.readFileSync(path.join(home, '.clerq', 'secrets.vault'), 'utf8')).not.toContain(
        'BEGIN RSA'
      );

      // No route returns them.
      const answers = [
        html,
        await (await api('/github/app')).text(),
        await (await api('/secrets')).text(),
        JSON.stringify(getStore().prepare("SELECT * FROM settings WHERE key = 'github.app'").all()),
        JSON.stringify(getStore().prepare('SELECT * FROM audit_log').all()),
      ];
      for (const text of answers) {
        expect(text).not.toContain('BEGIN RSA');
        expect(text).not.toContain('client-secret-from-the-fake-conversion');
        expect(text).not.toContain('webhook-secret');
      }
      // The names are listed, as every secret's name is.
      expect(JSON.parse(answers[2]).secrets).toEqual(
        expect.arrayContaining([APP_PRIVATE_KEY_SECRET, APP_CLIENT_SECRET_SECRET])
      );

      // Nothing was logged of them.
      const logged = logs.join('\n');
      expect(logged).not.toContain('MIIE');
      expect(logged).not.toContain('client-secret-from-the-fake-conversion');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('keeps the app’s secrets out of reach of /secrets, which manages the others', async () => {
    const set = await api('/secrets', {
      method: 'POST',
      body: JSON.stringify({ name: APP_PRIVATE_KEY_SECRET, value: 'x' }),
    });
    expect(set.status).toBe(400);
    expect((await set.json()).error).toContain('POST /github/app/import');
    const del = await api(`/secrets/${APP_PRIVATE_KEY_SECRET}`, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect((await del.json()).error).toContain('DELETE /github/app');
    // An ordinary secret is as before.
    expect(
      (
        await api('/secrets', {
          method: 'POST',
          body: JSON.stringify({ name: 'GITHUB_TOKEN', value: 'ghp_x' }),
        })
      ).status
    ).toBe(200);
    expect((await api('/secrets/GITHUB_TOKEN', { method: 'DELETE' })).status).toBe(200);
  });

  it('forgets the app and its key', async () => {
    await api('/github/app/import', {
      method: 'POST',
      body: JSON.stringify({
        appId: fake.app.id,
        clientId: fake.app.clientId,
        privateKey: fake.privateKeyPem,
        clientSecret: 'a-client-secret',
      }),
    });
    expect(getSecret(APP_PRIVATE_KEY_SECRET)).toBeTruthy();
    const res = await api('/v1/github/app', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(getSecret(APP_PRIVATE_KEY_SECRET)).toBeNull();
    expect(getSecret(APP_CLIENT_SECRET_SECRET)).toBeNull();
    expect(readAppConfig()).toBeNull();
  });
});
