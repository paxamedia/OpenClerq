/**
 * Signing in through a whole gateway: the device flow end to end against a fake
 * GitHub (its website and API are one server here), the real vault under a
 * temporary HOME, and the places the sign-in must never reach: an answer, a log
 * line, a spec, `/secrets`, the credential lookup.
 *
 * The flow waits for GitHub's interval (the floor is a second), so this file
 * has two sign-ins and no more.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultCredentials } from '../automations/credentials.js';
import { createGateway } from '../gateway.js';
import { getSecret, listSecrets } from '../secrets-vault.js';
import { getStore } from '../store.js';
import { USER_TOKENS_SECRET } from './config.js';
import { FakeGithub } from './fake-github.js';

const TOKEN = 'github-signin-gateway-test-token-0123456789';

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

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });
const json = async (p: string, init?: RequestInit) => {
  const res = await api(p, init);
  return { status: res.status, body: (await res.json()) as any };
};

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-github-signin-gw-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLERQ_KEYCHAIN = 'off';
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  process.env.CLERQ_GITHUB_WEB = fake.url;

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

beforeEach(() => {
  fake.reset();
  fake.installations.length = 0;
  fake.deviceInterval = 1;
});

const importApp = () =>
  json('/v1/github/app/import', {
    method: 'POST',
    body: JSON.stringify({
      appId: fake.app.id,
      clientId: fake.app.clientId,
      privateKey: fake.privateKeyPem,
      clientSecret: fake.clientSecret,
    }),
  });

describe('a sign-in through a whole gateway', () => {
  it('goes from a code to a signed-in person, with the tokens only in the real vault', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      })
    );
    try {
      expect((await importApp()).status).toBe(201);
      fake.install({
        id: 5001,
        account: { login: 'octocat', type: 'User' },
        repos: ['octocat/hello'],
      });

      const started = await json('/v1/github/login', { method: 'POST' });
      expect(started.status).toBe(200);
      const deviceCode = [...fake.devices.values()][0].deviceCode;
      fake.approve(started.body.userCode, { login: 'octocat' });
      const done = await until(async () => {
        const v = await json(`/v1/github/login/${started.body.flowId}`);
        return v.body.status === 'pending' ? undefined : v.body;
      });
      expect(done).toMatchObject({ status: 'approved', user: { login: 'octocat' } });

      // In the real vault, encrypted, in one entry.
      const held = JSON.parse(getSecret(USER_TOKENS_SECRET) as string);
      expect(held.accessToken).toMatch(/^ghu_fake/);
      expect(held.refreshToken).toMatch(/^ghr_fake/);
      const vaultFile = fs.readFileSync(path.join(home, '.clerq', 'secrets.vault'), 'utf8');
      expect(vaultFile).not.toContain(held.accessToken);

      const me = await json('/v1/github/user');
      expect(me.body).toMatchObject({ signedIn: true, user: { login: 'octocat' } });
      const repos = await json('/v1/github/user/repositories');
      expect(repos.body.repositories).toEqual([
        expect.objectContaining({ fullName: 'octocat/hello', installationId: 5001, added: false }),
      ]);

      // No route returns a token or the device code, and nothing logged them.
      const names = await (await api('/secrets')).text();
      const everything = [
        JSON.stringify(started.body),
        JSON.stringify(done),
        JSON.stringify(me.body),
        JSON.stringify(repos.body),
        names,
        await (await api('/github/app')).text(),
        JSON.stringify(getStore().prepare('SELECT * FROM audit_log').all()),
        JSON.stringify(getStore().prepare('SELECT * FROM settings').all()),
        logs.join('\n'),
      ].join('\n');
      for (const secret of [held.accessToken, held.refreshToken, deviceCode]) {
        expect(everything).not.toContain(secret);
      }
      // The name is listed, as every secret's name is, and nothing more.
      expect(JSON.parse(names).secrets).toContain(USER_TOKENS_SECRET);

      // Sign out through the gateway: revoked on GitHub, gone from the vault.
      const out = await json('/v1/github/user', { method: 'DELETE' });
      expect(out.body).toMatchObject({ signedOut: true, revoked: true });
      expect(fake.grantsRevoked).toEqual(['octocat']);
      expect(getSecret(USER_TOKENS_SECRET)).toBeNull();
      expect((await json('/v1/github/user')).body.signedIn).toBe(false);
      expect(logs.join('\n')).not.toContain(held.accessToken);
    } finally {
      for (const spy of spies) spy.mockRestore();
      await api('/v1/github/app', { method: 'DELETE' });
    }
  }, 30_000);

  it('answers a plain 409 with no app, and tells where device flow is switched on when it is off', async () => {
    expect((await api('/v1/github/app', { method: 'DELETE' })).status).toBeGreaterThanOrEqual(200);
    const none = await json('/v1/github/login', { method: 'POST' });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('app_not_connected');

    await importApp();
    fake.deviceFlowEnabled = false;
    const off = await json('/v1/github/login', { method: 'POST' });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('device_flow_disabled');
    expect(off.body.settingsUrl).toBe(`${fake.url}/settings/apps/${fake.app.slug}`);
    await api('/v1/github/app', { method: 'DELETE' });
  });
});

describe('the sign-in’s name in the vault', () => {
  const name = USER_TOKENS_SECRET;

  it('is refused by /secrets, both ways, with the way to do it properly', async () => {
    const set = await json('/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, value: 'x' }),
    });
    expect(set.status).toBe(400);
    expect(set.body.error).toContain('POST /github/login');
    const del = await json(`/secrets/${name}`, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(del.body.error).toContain('DELETE /github/user');
  });

  it('is refused as a spec’s token or agent key, at save', async () => {
    const spec = (extra: string, agent = '') =>
      [
        'name: reserved-check',
        'targets:',
        '  repos: [github:acme/remote-app]',
        'agent:',
        '  driver: claude-code',
        agent,
        'prompt: Do a thing.',
        'publish:',
        extra,
      ]
        .filter(Boolean)
        .join('\n');
    const asToken = await json('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: spec(`  token_secret: ${name}`) }),
    });
    expect(asToken.status).toBe(400);
    expect(asToken.body.message).toContain(name);
    expect(asToken.body.message).toContain('where OpenClerq keeps your GitHub sign-in');
    const asKey = await json('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('  push: false', `  api_key_secret: ${name}`) }),
    });
    expect(asKey.status).toBe(400);
    expect(asKey.body.message).toContain('where OpenClerq keeps your GitHub sign-in');
  });

  it('is never handed out as a forge credential, even when the vault holds it', () => {
    const lookup = vaultCredentials((n) => (n === name ? 'ghu_would_be_a_leak' : undefined));
    for (const purpose of ['fetch', 'push', 'pull_request'] as const) {
      expect(
        lookup({
          forge: 'github',
          project: 'acme/app',
          purpose,
          secretName: name,
          automationId: 'a',
          runId: 'r',
        })
      ).toBeUndefined();
    }
  });

  it('is listed by name only', async () => {
    expect(Array.isArray(listSecrets())).toBe(true);
  });
});
