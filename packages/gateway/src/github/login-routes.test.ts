/**
 * The sign-in routes over HTTP: what they answer, in what shape and with which
 * status, against a fake GitHub (its website and its API are one server here),
 * an in-memory vault and a real, in-memory store for the repositories the
 * person already added. Who may call them is in gateway.integration.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureRemoteRepo } from '../automations/store.js';
import { GithubApp } from './app.js';
import {
  APP_CLIENT_SECRET_SECRET,
  APP_PRIVATE_KEY_SECRET,
  USER_TOKENS_SECRET,
  clearAppConfig,
  settingsUrl,
  writeAppConfig,
  type GithubAppConfig,
} from './config.js';
import type { Vault } from './connect.js';
import { FakeGithub } from './fake-github.js';
import { mountGithubRoutes } from './routes.js';
import { GithubSignIn } from './signin.js';
import { closeStore, getStore, initStore } from '../store.js';

let fake: FakeGithub;
let server: http.Server;
let base: string;
let signin: GithubSignIn;
let vault: Vault & { entries: Map<string, string> };
const saved = { api: process.env.CLERQ_GITHUB_API, web: process.env.CLERQ_GITHUB_WEB };

function memoryVault() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (name: string) => entries.get(name),
    set(name: string, value: string) {
      entries.set(name, value);
      return { ok: true };
    },
    delete(name: string) {
      entries.delete(name);
      return { ok: true };
    },
    available: () => true,
  };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as any };
}

const config = (): GithubAppConfig => ({
  appId: fake.app.id,
  slug: fake.app.slug,
  name: fake.app.name,
  clientId: fake.app.clientId,
  owner: fake.app.owner,
  htmlUrl: `${fake.url}/apps/${fake.app.slug}`,
  source: 'import',
  createdAt: new Date(0).toISOString(),
});

/** Wait for `fn` to answer something. */
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Connect the app and sign a person in, over the routes. */
async function signIn(login = 'octocat'): Promise<void> {
  const started = (await call('POST', '/github/login')).json();
  fake.approve(started.userCode, { login });
  await until(async () => {
    const view = (await call('GET', `/github/login/${started.flowId}`)).json();
    return view.status === 'approved' ? view : undefined;
  });
}

beforeAll(async () => {
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  process.env.CLERQ_GITHUB_WEB = fake.url;
  await initStore(':memory:');
  const app = express();
  app.use(express.json());
  vault = memoryVault();
  signin = new GithubSignIn({
    vault,
    // The interval GitHub asks for is not waited out here: a few milliseconds will do.
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      }),
  });
  mountGithubRoutes(app, {
    app: new GithubApp({ getSecret: (n) => vault.get(n) }),
    vault,
    signin,
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  signin.close();
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
  vault.entries.clear();
  vault.set(APP_PRIVATE_KEY_SECRET, fake.privateKeyPem);
  vault.set(APP_CLIENT_SECRET_SECRET, fake.clientSecret);
  writeAppConfig(config());
  getStore().prepare('DELETE FROM audit_log').run();
  getStore().prepare('DELETE FROM repos').run();
});

afterEach(() => {
  clearAppConfig();
});

describe('with no app connected', () => {
  beforeEach(() => clearAppConfig());

  it('says so plainly when asked to sign in, and asks GitHub nothing', async () => {
    const res = await call('POST', '/github/login');
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ error: 'app_not_connected' });
    expect(res.json().message).toContain('No GitHub App is connected');
    expect(fake.seen).toHaveLength(0);
  });

  it('says nobody is signed in', async () => {
    expect((await call('GET', '/github/user')).json()).toEqual({
      signedIn: false,
      refreshable: false,
    });
    const out = await call('DELETE', '/github/user');
    expect(out.status).toBe(404);
    expect(out.json().error).toBe('not_signed_in');
    const repos = await call('GET', '/github/user/repositories');
    expect(repos.status).toBe(409);
    expect(repos.json().error).toBe('not_signed_in');
  });
});

describe('a sign-in', () => {
  it('answers the code, the address, when it ends and how often to look', async () => {
    const res = await call('POST', '/github/login');
    expect(res.status).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      'expiresAt',
      'flowId',
      'interval',
      'userCode',
      'verificationUri',
    ]);
    expect(body.flowId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.verificationUri).toBe(`${fake.url}/login/device`);
    expect(body.interval).toBe(5);
    // The device code is the secret half: it is in nothing that was answered.
    const device = [...fake.devices.values()][0];
    expect(res.text).not.toContain(device.deviceCode);
    const view = await call('GET', `/github/login/${body.flowId}`);
    expect(view.status).toBe(200);
    expect(view.json()).toMatchObject({ status: 'pending', interval: 5 });
  });

  it('is approved with who signed in, and then there is a user', async () => {
    await signIn('hubot');
    const user = (await call('GET', '/github/user')).json();
    expect(user).toMatchObject({
      signedIn: true,
      refreshable: true,
      user: { login: 'hubot', id: 583231, name: 'The Octocat' },
    });
    expect(typeof user.expiresAt).toBe('string');
    // The tokens are in the vault, and in no answer.
    const held = JSON.parse(vault.entries.get(USER_TOKENS_SECRET) as string);
    expect(JSON.stringify(user)).not.toContain(held.accessToken);
    expect(JSON.stringify(user)).not.toContain(held.refreshToken);
  });

  it('can be cancelled, and then is gone', async () => {
    const started = (await call('POST', '/github/login')).json();
    expect((await call('DELETE', `/github/login/${started.flowId}`)).json()).toEqual({
      cancelled: true,
    });
    expect((await call('GET', `/github/login/${started.flowId}`)).status).toBe(404);
    expect((await call('DELETE', `/github/login/${started.flowId}`)).status).toBe(404);
    // Approving later changes nothing.
    fake.approve(started.userCode);
    await new Promise((r) => setTimeout(r, 40));
    expect((await call('GET', '/github/user')).json().signedIn).toBe(false);
  });

  it('says there is no such flow for an id it never gave', async () => {
    const res = await call('GET', '/github/login/nope');
    expect(res.status).toBe(404);
    expect(res.json().error).toBe('flow_not_found');
  });

  it('says what to switch on, and where, when device flow is off', async () => {
    fake.deviceFlowEnabled = false;
    const res = await call('POST', '/github/login');
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'device_flow_disabled',
      settingsUrl: settingsUrl(config()),
    });
    expect(res.json().message).toContain('Enable Device Flow');
  });

  it('reports a refusal on GitHub as denied', async () => {
    const started = (await call('POST', '/github/login')).json();
    fake.deny(started.userCode);
    const view = await until(async () => {
      const v = (await call('GET', `/github/login/${started.flowId}`)).json();
      return v.status !== 'pending' ? v : undefined;
    });
    expect(view).toMatchObject({ status: 'denied' });
  });

  it('reports disabled, with the app’s settings address, when GitHub says so while polling', async () => {
    const started = (await call('POST', '/github/login')).json();
    fake.deviceFlowEnabled = false;
    const view = await until(async () => {
      const v = (await call('GET', `/github/login/${started.flowId}`)).json();
      return v.status !== 'pending' ? v : undefined;
    });
    expect(view).toMatchObject({ status: 'disabled', settingsUrl: settingsUrl(config()) });
    expect(view.message).toContain('Enable Device Flow');
  });
});

describe('signing out', () => {
  it('forgets the tokens, revokes the grant and records that it was done', async () => {
    await signIn();
    const out = await call('DELETE', '/github/user');
    expect(out.status).toBe(200);
    expect(out.json()).toMatchObject({ signedOut: true, revoked: true });
    expect(out.json().authorizationsUrl).toBe(`${fake.url}/settings/apps/authorizations`);
    expect(vault.entries.has(USER_TOKENS_SECRET)).toBe(false);
    expect((await call('GET', '/github/user')).json().signedIn).toBe(false);
    const rows = getStore()
      .prepare("SELECT action, detail FROM audit_log WHERE action = 'github.user.signed_out'")
      .all();
    expect(rows).toHaveLength(1);
    // The audit row says what happened, never a token.
    expect(JSON.stringify(rows)).not.toContain('ghu_');
  });

  it('is done with the app: disconnecting signs out first, and revokes while the secret is still there', async () => {
    await signIn();
    const out = await call('DELETE', '/github/app');
    expect(out.status).toBe(200);
    expect(out.json().user).toMatchObject({ signedOut: true, revoked: true });
    expect(out.json().message).toContain('revoked');
    expect(fake.grantsRevoked).toEqual(['octocat']);
    // Both ends of it are in the audit log, without a token.
    const rows = getStore()
      .prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'github.user.%' ORDER BY id")
      .all()
      .map((r) => `${r.action} ${r.detail}`);
    expect(rows).toEqual([
      'github.user.signed_in {"login":"octocat"}',
      'github.user.signed_out {"revoked":true}',
    ]);
    expect(vault.entries.has(USER_TOKENS_SECRET)).toBe(false);
    expect(vault.entries.has(APP_CLIENT_SECRET_SECRET)).toBe(false);
    expect(vault.entries.has(APP_PRIVATE_KEY_SECRET)).toBe(false);
  });

  it('leaves the disconnect answer as it was when nobody was signed in', async () => {
    const out = await call('DELETE', '/github/app');
    expect(out.status).toBe(200);
    expect(out.json().user).toBeUndefined();
  });
});

describe('disconnecting while a sign-in is waiting', () => {
  it('cancels it: approving afterwards stores nothing, and the same app again is signed out', async () => {
    const started = (await call('POST', '/github/login')).json();
    const out = await call('DELETE', '/github/app');
    expect(out.status).toBe(200);
    // The window that is watching it is told, not left waiting.
    const view = (await call('GET', `/github/login/${started.flowId}`)).json();
    expect(view.status).toBe('error');
    expect(view.message).toContain('disconnected');
    // The flow polls every few milliseconds, so on a loaded machine a poll can have been made
    // before the disconnect got through: let one that was already on its way land, then count.
    await new Promise((r) => setTimeout(r, 30));
    const before = fake.polls().length;
    fake.approve(started.userCode);
    await new Promise((r) => setTimeout(r, 60));
    // No poll after the disconnect, so nothing was told the approval.
    expect(fake.polls()).toHaveLength(before);
    expect(vault.entries.has(USER_TOKENS_SECRET)).toBe(false);
    // Connect the same app again: nobody is signed in.
    vault.set(APP_PRIVATE_KEY_SECRET, fake.privateKeyPem);
    vault.set(APP_CLIENT_SECRET_SECRET, fake.clientSecret);
    writeAppConfig(config());
    expect((await call('GET', '/github/user')).json()).toEqual({
      signedIn: false,
      refreshable: false,
    });
  });
});

describe('the repositories', () => {
  it('lists what the person reaches, marking the ones OpenClerq already has', async () => {
    fake.install({
      id: 71,
      account: { login: 'acme', type: 'Organization' },
      repos: ['acme/app', 'acme/web', 'acme/new'],
    });
    fake.repoCase.set('acme/app', 'Acme/App');
    // A row made by an automation or by hand, spelled differently from how GitHub spells it.
    const row = ensureRemoteRepo(
      { kind: 'github', project: 'acme/app', url: 'https://github.com/acme/app.git' },
      'GITHUB_TOKEN'
    );
    await signIn();
    const res = await call('GET', '/github/user/repositories');
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(false);
    expect(body.limit).toBe(1000);
    expect(body.repositories.map((r: any) => [r.fullName, r.added])).toEqual([
      ['Acme/App', true],
      ['acme/web', false],
      ['acme/new', false],
    ]);
    expect(body.repositories[0]).toMatchObject({
      repoId: row.id,
      installationId: 71,
      account: 'acme',
      private: true,
    });
    expect(body.repositories[1].repoId).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  it('says so when the limit cut the list', async () => {
    fake.install({
      id: 72,
      repos: Array.from({ length: 1010 }, (_, i) => `acme/r${i}`),
    });
    await signIn();
    const body = (await call('GET', '/github/user/repositories')).json();
    expect(body.repositories).toHaveLength(1000);
    expect(body.truncated).toBe(true);
    expect(body.message).toContain('first 1000');
    expect(body.message).toContain('clerq repo add github:owner/name');
  });

  it('says to sign in, with a 409, and does not ask GitHub, when nobody is', async () => {
    const res = await call('GET', '/github/user/repositories');
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_signed_in' });
    expect(fake.calls('GET', '/user')).toHaveLength(0);
  });
});
