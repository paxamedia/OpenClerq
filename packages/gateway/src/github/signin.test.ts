/**
 * Signing a person in: the device flow, the stored tokens, renewal, sign-out
 * and the repositories they reach, against a fake GitHub. The waits between
 * polls are the test's to release one at a time, so nothing here sleeps and
 * the intervals the gateway asked for can be read back.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CLIENT_SECRET_SECRET, USER_TOKENS_SECRET } from './names.js';
import {
  clearAppConfig,
  readAppConfig,
  settingsUrl,
  writeAppConfig,
  type GithubAppConfig,
} from './config.js';
import type { Vault } from './connect.js';
import { FakeGithub } from './fake-github.js';
import {
  FINISHED_KEPT_MS,
  GithubSignIn,
  MAX_FLOWS,
  MAX_REPOSITORIES,
  SignInError,
  type FlowStart,
} from './signin.js';
import { closeStore, initStore } from '../store.js';

let fake: FakeGithub;
const saved = { api: process.env.CLERQ_GITHUB_API, web: process.env.CLERQ_GITHUB_WEB };

/** A vault in memory. */
function memoryVault() {
  const entries = new Map<string, string>();
  const vault: Vault & { entries: Map<string, string>; failOn: string | undefined } = {
    entries,
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
    available: () => true,
  };
  return vault;
}

let vault: ReturnType<typeof memoryVault>;
let clock: number;
let sleeps: number[];
/** The polls waiting for their interval to pass, oldest first. */
let waiting: Array<() => void>;
let signin: GithubSignIn;

const config = (over: Partial<GithubAppConfig> = {}): GithubAppConfig => ({
  appId: fake.app.id,
  slug: fake.app.slug,
  name: fake.app.name,
  clientId: fake.app.clientId,
  owner: fake.app.owner,
  htmlUrl: `${process.env.CLERQ_GITHUB_WEB}/apps/${fake.app.slug}`,
  source: 'import',
  createdAt: new Date(0).toISOString(),
  ...over,
});

function makeSignIn(options: { timeoutMs?: number } = {}): GithubSignIn {
  return new GithubSignIn({
    vault,
    now: () => clock,
    timeoutMs: options.timeoutMs,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        if (signal.aborted) return resolve();
        const go = () => {
          clock += ms;
          resolve();
        };
        waiting.push(go);
        signal.addEventListener(
          'abort',
          () => {
            waiting = waiting.filter((w) => w !== go);
            resolve();
          },
          { once: true }
        );
      }),
  });
}

/** Wait for `fn` to answer something. */
async function until<T>(fn: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Let one poll of `flow` go, and wait until it has been answered: the flow is
 * waiting again, or it has finished.
 */
async function step(flow: FlowStart): Promise<void> {
  const before = sleeps.length;
  await until(() => waiting.length > 0);
  (waiting.shift() as () => void)();
  await until(() => sleeps.length > before || signin.status(flow.flowId)?.status !== 'pending');
}

/** Sign a person in: start, approve on the fake, let one poll through. */
async function signedIn(login = 'octocat'): Promise<FlowStart> {
  const flow = await signin.start();
  fake.approve(flow.userCode, { login });
  await step(flow);
  expect(signin.status(flow.flowId)?.status).toBe('approved');
  return flow;
}

const stored = () => JSON.parse(vault.get(USER_TOKENS_SECRET) as string);
/** The stored token's whole expiry is hours away: move the clock past it. */
const pastExpiry = () => {
  clock += fake.userTokenLifetimeMs + 1;
  fake.clock = () => clock;
};

beforeAll(async () => {
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  // GitHub's website and its API are one server here.
  process.env.CLERQ_GITHUB_WEB = fake.url;
  await initStore(':memory:');
});

afterAll(async () => {
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
  clock = Date.UTC(2026, 10, 14, 9, 0, 0);
  fake.clock = () => clock;
  sleeps = [];
  waiting = [];
  vault = memoryVault();
  vault.set(APP_CLIENT_SECRET_SECRET, fake.clientSecret);
  writeAppConfig(config());
  signin = makeSignIn();
});

afterEach(() => {
  signin.close();
  clearAppConfig();
  fake.clock = Date.now;
});

describe('the device flow', () => {
  it('goes pending, pending, slow_down (the interval grows by five), then signs in', async () => {
    fake.deviceScript = ['pending', 'pending', 'slow_down'];
    const flow = await signin.start();
    expect(flow.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(flow.verificationUri).toBe(`${fake.url}/login/device`);
    expect(flow.interval).toBe(5);
    expect(Date.parse(flow.expiresAt) - clock).toBe(900_000);
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'pending', interval: 5 });

    fake.approve(flow.userCode, { login: 'octocat' });
    await step(flow); // pending
    await step(flow); // pending
    await step(flow); // slow_down
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'pending', interval: 10 });
    await step(flow); // approved

    // The first look is after one interval, as GitHub asks; each later one after the interval then in force.
    expect(sleeps).toEqual([5000, 5000, 5000, 10_000]);
    expect(fake.polls()).toHaveLength(4);
    const done = signin.status(flow.flowId);
    expect(done).toMatchObject({
      status: 'approved',
      user: { login: 'octocat', id: 583231, name: 'The Octocat' },
    });
    // The poll asked as the device flow must.
    expect(fake.polls()[0].body).toMatchObject({
      client_id: fake.app.clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  });

  it('never looks faster than once a second, whatever GitHub says', async () => {
    fake.deviceInterval = 0;
    const flow = await signin.start();
    expect(flow.interval).toBe(1);
    fake.approve(flow.userCode);
    await step(flow);
    expect(sleeps[0]).toBe(1000);
  });

  it('keeps the tokens only in the vault, in one entry, and in no answer', async () => {
    const flow = await signin.start();
    const deviceCode = [...fake.devices.values()][0].deviceCode;
    fake.approve(flow.userCode);
    await step(flow);
    const held = stored();
    const real = [...fake.userTokens.values()][0];
    expect(held).toMatchObject({
      v: 1,
      clientId: fake.app.clientId,
      accessToken: real.token,
      refreshToken: real.refreshToken,
    });
    expect(held.accessExpiresAt).toBe(clock + fake.userTokenLifetimeMs);
    expect(held.refreshExpiresAt).toBe(clock + fake.refreshTokenLifetimeMs);

    // No answer the gateway gives carries a token or the device code.
    const answers = JSON.stringify([
      flow,
      signin.status(flow.flowId),
      await signin.user(),
      await signin.repositories(),
    ]);
    for (const secret of [real.token, real.refreshToken, deviceCode]) {
      expect(secret).toBeTruthy();
      expect(answers).not.toContain(secret);
    }
    // And it is the only place: the other vault entries are the ones the test put there.
    expect([...vault.entries.keys()].sort()).toEqual([
      APP_CLIENT_SECRET_SECRET,
      USER_TOKENS_SECRET,
    ]);
  });

  it('ends at access_denied', async () => {
    const flow = await signin.start();
    fake.deny(flow.userCode);
    await step(flow);
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'denied' });
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
    // And the poll stopped.
    expect(waiting).toHaveLength(0);
  });

  it('ends at expired_token', async () => {
    const flow = await signin.start();
    fake.expire(flow.userCode);
    await step(flow);
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'expired' });
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('ends as expired when the code runs out before GitHub is asked again', async () => {
    fake.deviceExpiresIn = 60;
    const flow = await signin.start();
    clock += 120_000;
    await step(flow);
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'expired' });
    expect(fake.polls()).toHaveLength(0);
  });

  it('says what to switch on when device flow is off (at the first poll), and links the app’s settings', async () => {
    const flow = await signin.start();
    fake.deviceFlowEnabled = false;
    await step(flow);
    const view = signin.status(flow.flowId);
    expect(view).toMatchObject({ status: 'disabled', settingsUrl: settingsUrl(config()) });
    expect(view?.message).toContain('Enable Device Flow');
    expect(view?.message).toContain('Identifying and authorizing users');
    expect(view?.message).toContain(settingsUrl(config()));
  });

  it('says the same when it is off at the start, whatever status GitHub answers with', async () => {
    for (const status of [200, 400]) {
      fake.deviceFlowEnabled = false;
      fake.loginErrorStatus = status;
      const e = (await signin.start().catch((x: unknown) => x)) as SignInError;
      expect(e).toBeInstanceOf(SignInError);
      expect(e).toMatchObject({ status: 409, code: 'device_flow_disabled' });
      expect(e.message).toContain('Enable Device Flow');
      expect(e.extra).toEqual({ settingsUrl: settingsUrl(config()) });
    }
  });

  it('refuses a wrong client id at the start, in plain words', async () => {
    writeAppConfig(config({ clientId: 'Iv23liWRONGCLIENT' }));
    for (const status of [200, 400, 404]) {
      fake.loginErrorStatus = status;
      const e = (await signin.start().catch((x: unknown) => x)) as SignInError;
      expect(e).toMatchObject({ status: 422, code: 'github_rejected' });
      expect(e.message).toContain("did not recognise this app's client ID");
    }
    expect(fake.devices.size).toBe(0);
  });

  it('ends with a wrong client id found while polling', async () => {
    const flow = await signin.start();
    fake.app.clientId = 'Iv23liSOMETHINGELSE';
    try {
      await step(flow);
    } finally {
      fake.app.clientId = config().clientId;
    }
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'error' });
    expect(signin.status(flow.flowId)?.message).toContain("did not recognise this app's client ID");
  });

  it('refuses a sign-in address that is not on GitHub’s website', async () => {
    for (const uri of ['https://evil.example/login/device', 'javascript:alert(1)', 'http://x']) {
      fake.deviceVerificationUri = uri;
      const e = (await signin.start().catch((x: unknown) => x)) as SignInError;
      expect(e).toMatchObject({ status: 502, code: 'invalid_verification_uri' });
    }
    expect(waiting).toHaveLength(0);
  });

  it('says there is no app, rather than guessing', async () => {
    clearAppConfig();
    const e = (await signin.start().catch((x: unknown) => x)) as SignInError;
    expect(e).toMatchObject({ status: 409, code: 'app_not_connected' });
    expect(e.message).toContain('No GitHub App is connected');
    expect(fake.seen).toHaveLength(0);
  });

  it('gives up after three polls in a row that GitHub does not answer', async () => {
    signin.close();
    signin = makeSignIn({ timeoutMs: 40 });
    const flow = await signin.start();
    fake.hang = '/login/oauth/access_token';
    await step(flow);
    await step(flow);
    expect(signin.status(flow.flowId)?.status).toBe('pending');
    await step(flow);
    expect(signin.status(flow.flowId)).toMatchObject({
      status: 'error',
      message: 'GitHub could not be reached. Start again.',
    });
    expect(waiting).toHaveLength(0);
  });

  it('forgets a cancelled flow, and what GitHub says after that is not kept', async () => {
    const flow = await signin.start();
    fake.approve(flow.userCode);
    expect(signin.cancel(flow.flowId)).toBe(true);
    expect(signin.status(flow.flowId)).toBeNull();
    expect(signin.cancel(flow.flowId)).toBe(false);
    // The waiting poll is gone with it: nothing asks GitHub, nothing is stored.
    expect(waiting).toHaveLength(0);
    expect(fake.polls()).toHaveLength(0);
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('runs two flows at once, each with its own answer', async () => {
    const a = await signin.start();
    const b = await signin.start();
    expect(a.flowId).not.toBe(b.flowId);
    expect(a.userCode).not.toBe(b.userCode);
    fake.deny(a.userCode);
    fake.approve(b.userCode, { login: 'hubot' });
    // Both are waiting; let each go once.
    await until(() => waiting.length === 2);
    waiting.splice(0).forEach((go) => go());
    await until(
      () =>
        signin.status(a.flowId)?.status !== 'pending' &&
        signin.status(b.flowId)?.status !== 'pending'
    );
    expect(signin.status(a.flowId)).toMatchObject({ status: 'denied' });
    expect(signin.status(b.flowId)).toMatchObject({ status: 'approved', user: { login: 'hubot' } });
    expect((await signin.user()).user?.login).toBe('hubot');
  });

  it('holds a few flows, and cancels the oldest to make room', async () => {
    const first = await signin.start();
    for (let i = 1; i < MAX_FLOWS; i++) await signin.start();
    expect(signin.status(first.flowId)?.status).toBe('pending');
    const sixth = await signin.start();
    expect(signin.status(first.flowId)).toBeNull();
    expect(signin.status(sixth.flowId)?.status).toBe('pending');
  });

  it('forgets a finished flow after ten minutes', async () => {
    const flow = await signin.start();
    fake.deny(flow.userCode);
    await step(flow);
    expect(signin.status(flow.flowId)?.status).toBe('denied');
    clock += FINISHED_KEPT_MS + 1;
    await signin.start(); // making room is when the old ones go
    expect(signin.status(flow.flowId)).toBeNull();
  });

  it('keeps the sign-in but says so when GitHub will not say who it is', async () => {
    const flow = await signin.start();
    fake.approve(flow.userCode);
    fake.failNext.set('/user', { status: 500, message: 'Server Error' });
    await step(flow);
    const view = signin.status(flow.flowId);
    expect(view?.status).toBe('approved');
    expect(view?.user).toBeNull();
    expect(view?.message).toContain('did not say who you are');
    expect(vault.get(USER_TOKENS_SECRET)).toBeDefined();
  });

  it('reports a vault that refuses the tokens, and keeps nothing', async () => {
    vault.failOn = USER_TOKENS_SECRET;
    const flow = await signin.start();
    fake.approve(flow.userCode);
    await step(flow);
    expect(signin.status(flow.flowId)).toMatchObject({ status: 'error' });
    expect(signin.status(flow.flowId)?.message).toContain('vault refused');
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('cuts every code and token it has seen out of what GitHub says', async () => {
    const flow = await signin.start();
    const device = [...fake.devices.values()][0];
    expect(
      signin.scrub(`code ${device.deviceCode} and ghu_${'a'.repeat(30)} and ghr_${'b'.repeat(30)}`)
    ).toBe('code «redacted» and «redacted» and «redacted»');
    expect(flow.flowId).not.toContain('«');
  });
});

describe('who is signed in', () => {
  it('says nobody, then who, with the address checks', async () => {
    expect(await signin.user()).toEqual({ signedIn: false, refreshable: false });
    await signedIn();
    const view = await signin.user();
    expect(view).toMatchObject({
      signedIn: true,
      refreshable: true,
      user: {
        login: 'octocat',
        id: 583231,
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
        htmlUrl: `${fake.url}/octocat`,
      },
      expiresAt: new Date(clock + fake.userTokenLifetimeMs).toISOString(),
    });
  });

  it('leaves out an avatar that is not https and a profile that is not on GitHub’s website', async () => {
    await signedIn();
    for (const [avatar, html] of [
      ['http://avatars.example/a.png', 'https://evil.example/octocat'],
      ['javascript:alert(1)', 'javascript:alert(1)'],
      ['https://user:pw@avatars.example/a.png', `${fake.url.replace('http:', 'https:')}/octocat`],
    ]) {
      fake.userAvatarUrl = avatar;
      fake.userHtmlUrl = html;
      clock += 61_000; // past the cache
      fake.clock = () => clock;
      const { user } = await signin.user();
      expect(user?.avatarUrl).toBeNull();
      expect(user?.htmlUrl).toBeNull();
    }
    // https for the avatar is enough, wherever it is; the profile must be GitHub's.
    fake.userAvatarUrl = 'https://avatars.githubusercontent.com/u/1';
    fake.userHtmlUrl = `${fake.url}/octocat`;
    clock += 61_000;
    expect((await signin.user()).user).toMatchObject({
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      htmlUrl: `${fake.url}/octocat`,
    });
  });

  it('asks GitHub once for a burst of questions', async () => {
    await signedIn();
    const before = fake.calls('GET', '/user').filter((c) => c.path === '/user').length;
    await Promise.all([signin.user(), signin.user(), signin.user()]);
    await signin.user();
    const after = fake.calls('GET', '/user').filter((c) => c.path === '/user').length;
    // The sign-in itself asked once; this burst at most once more.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('does not put the token in what it says when GitHub fails and echoes it', async () => {
    await signedIn();
    const held = stored();
    clock += 61_000;
    fake.failNext.set('/user', { status: 500, message: 'boom {token}' });
    const view = await signin.user();
    expect(view.signedIn).toBe(true);
    expect(view.message).toContain('could not say who you are');
    expect(view.message).toContain('«redacted»');
    expect(JSON.stringify(view)).not.toContain(held.accessToken);
  });

  it('is signed out when the stored tokens belong to another app', async () => {
    await signedIn();
    writeAppConfig(config({ clientId: 'Iv23liANOTHERAPP0001' }));
    expect(await signin.user()).toEqual({ signedIn: false, refreshable: false });
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('is signed out, with the reason, when GitHub revoked the authorization', async () => {
    await signedIn();
    for (const t of fake.userTokens.values()) {
      t.revoked = true;
      t.grantRevoked = true;
    }
    clock += 61_000;
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: false, refreshable: false });
    expect(view.message).toContain('no longer accepts');
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('treats a damaged vault entry as nobody being signed in', async () => {
    vault.set(USER_TOKENS_SECRET, '{not json');
    expect(await signin.user()).toEqual({ signedIn: false, refreshable: false });
  });
});

describe('renewing', () => {
  it('renews an expired token with the client secret, once, and stores the new pair', async () => {
    await signedIn();
    const first = stored();
    pastExpiry();
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: true, refreshable: true, user: { login: 'octocat' } });
    expect(fake.refreshes()).toHaveLength(1);
    expect(fake.refreshes()[0].body).toMatchObject({
      client_id: fake.app.clientId,
      client_secret: fake.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
    });
    const next = stored();
    expect(next.accessToken).not.toBe(first.accessToken);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(next.accessExpiresAt).toBe(clock + fake.userTokenLifetimeMs);
    // The new token is the one that works; the old refresh token is spent.
    expect(fake.userTokens.get(next.accessToken)?.revoked).toBe(false);
    expect(fake.userTokens.get(first.accessToken)?.refreshUsed).toBe(true);
    // Later questions use it without asking again.
    await signin.user();
    expect(fake.refreshes()).toHaveLength(1);
  });

  it('renews a little before the token ends, not at the last second', async () => {
    await signedIn();
    clock += fake.userTokenLifetimeMs - 30_000; // 30 s left
    await signin.user();
    expect(fake.refreshes()).toHaveLength(1);
  });

  it('spends one refresh token for any number of callers at once', async () => {
    await signedIn();
    pastExpiry();
    // GitHub answers slowly, so the others arrive while the first is in flight, and some after.
    fake.delays.set('POST /login/oauth/access_token', 60);
    const first = [signin.user(), signin.user(), signin.user()];
    await new Promise((r) => setTimeout(r, 20));
    const late = [signin.user(), signin.repositories().catch((e: unknown) => e)];
    const views = await Promise.all(first);
    await Promise.all(late);
    expect(views.every((v) => v.signedIn && v.user?.login === 'octocat')).toBe(true);
    expect(fake.refreshes()).toHaveLength(1);
  });

  it('does not spend the refresh token again for a caller that looked just before the renewal ended', async () => {
    await signedIn();
    pastExpiry();
    fake.delays.set('POST /login/oauth/access_token', 30);
    const a = signin.user();
    const b = signin.user();
    await Promise.all([a, b]);
    // A third arrives after the renewal has finished and sees a good token.
    await signin.user();
    expect(fake.refreshes()).toHaveLength(1);
  });

  it('is signed out at expiry, with the reason and what to do, when the app has no client secret', async () => {
    await signedIn();
    vault.delete(APP_CLIENT_SECRET_SECRET);
    expect((await signin.user()).refreshable).toBe(false);
    pastExpiry();
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: false, refreshable: false });
    expect(view.message).toContain('no client secret');
    expect(view.message).toContain('Sign in again');
    expect(fake.refreshes()).toHaveLength(0);
    // Nothing dead is kept.
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('is signed out when GitHub no longer takes the refresh token', async () => {
    await signedIn();
    pastExpiry();
    for (const t of fake.userTokens.values()) t.refreshUsed = true;
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: false, refreshable: false });
    expect(view.message).toContain('no longer accepts the saved sign-in');
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('is signed out when the refresh token has itself run out', async () => {
    await signedIn();
    clock += fake.refreshTokenLifetimeMs + 1;
    fake.clock = () => clock;
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: false, refreshable: false });
    expect(fake.refreshes()).toHaveLength(0);
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('keeps the sign-in and tries again when GitHub cannot be reached for the renewal', async () => {
    await signedIn();
    pastExpiry();
    fake.failNext.set('/login/oauth/access_token', { status: 503, message: 'down' });
    const down = await signin.user();
    expect(down).toMatchObject({ signedIn: false, refreshable: true });
    expect(down.message).toContain('It will be tried again');
    expect(vault.get(USER_TOKENS_SECRET)).toBeDefined();
    // The next question renews it.
    const up = await signin.user();
    expect(up).toMatchObject({ signedIn: true, user: { login: 'octocat' } });
  });

  it('keeps the sign-in and says so when the client secret is wrong', async () => {
    await signedIn();
    pastExpiry();
    vault.set(APP_CLIENT_SECRET_SECRET, 'a-secret-that-is-wrong');
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: false, refreshable: true });
    expect(view.message).toContain('client secret');
    expect(vault.get(USER_TOKENS_SECRET)).toBeDefined();
    // Put the right one back and it works, with no new sign-in.
    vault.set(APP_CLIENT_SECRET_SECRET, fake.clientSecret);
    expect((await signin.user()).signedIn).toBe(true);
  });

  it('never expires a token the app does not expire', async () => {
    fake.expiringUserTokens = false;
    await signedIn();
    expect(stored().accessExpiresAt).toBeUndefined();
    expect(stored().refreshToken).toBeUndefined();
    clock += 400 * 86_400_000;
    fake.clock = () => clock;
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: true, refreshable: false });
    expect(view.expiresAt).toBeUndefined();
    expect(fake.refreshes()).toHaveLength(0);
  });

  it('drops the sign-in when the renewed pair cannot be stored (GitHub has spent the old one)', async () => {
    await signedIn();
    pastExpiry();
    vault.failOn = USER_TOKENS_SECRET;
    const view = await signin.user();
    expect(view).toMatchObject({ signedIn: false });
    expect(view.message).toContain('could not be stored');
  });
});

describe('signing out', () => {
  it('forgets the tokens and revokes the grant with the app’s client id and secret', async () => {
    await signedIn();
    const held = stored();
    const out = await signin.signOut();
    expect(out).toMatchObject({ signedOut: true, revoked: true });
    expect(out?.message).toContain('revoked');
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
    expect(fake.grantsRevoked).toEqual(['octocat']);
    expect(fake.userTokens.get(held.accessToken)?.revoked).toBe(true);
    // The request carried the token in the body and basic credentials, and nothing else of ours.
    const call = fake.calls('DELETE', `/applications/${fake.app.clientId}/grant`)[0];
    expect(call.body).toEqual({ access_token: held.accessToken });
    expect(call.status).toBe(204);
    expect(await signin.user()).toEqual({ signedIn: false, refreshable: false });
  });

  it('says where to revoke on GitHub when there is no client secret, and asks GitHub nothing', async () => {
    await signedIn();
    vault.delete(APP_CLIENT_SECRET_SECRET);
    const out = await signin.signOut();
    expect(out).toMatchObject({ signedOut: true, revoked: false });
    expect(out?.authorizationsUrl).toBe(`${fake.url}/settings/apps/authorizations`);
    expect(out?.message).toContain('no client secret');
    expect(out?.message).toContain(`${fake.url}/settings/apps/authorizations`);
    expect(fake.calls('DELETE', '/applications')).toHaveLength(0);
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('is signed out all the same when GitHub cannot be asked, and says where to revoke', async () => {
    await signedIn();
    fake.failNext.set('/grant', { status: 500, message: 'Server Error' });
    const out = await signin.signOut();
    expect(out).toMatchObject({ signedOut: true, revoked: false });
    expect(out?.message).toContain('not revoked');
    expect(out?.message).toContain('/settings/apps/authorizations');
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('says so when the saved token had run out and could not be revoked by it', async () => {
    await signedIn();
    pastExpiry();
    // Expired: GitHub will not revoke by a token that no longer works.
    const out = await signin.signOut();
    expect(out).toMatchObject({ signedOut: true, revoked: false });
    expect(out?.message).toContain('had expired');
  });

  it('answers null when nobody is signed in', async () => {
    expect(await signin.signOut()).toBeNull();
  });

  it('does not put the token in a message from GitHub that echoes it', async () => {
    await signedIn();
    const held = stored();
    // GitHub's own words, with the token in them.
    fake.failNext.set('/grant', { status: 500, message: 'oops {token}' });
    const out = await signin.signOut();
    expect(out?.message).toContain('«redacted»');
    expect(JSON.stringify(out)).not.toContain(held.accessToken);
  });
});

describe('the repositories a person reaches', () => {
  const many = (account: string, n: number, prefix = 'r') =>
    Array.from({ length: n }, (_, i) => `${account}/${prefix}${i}`);

  it('lists every repository of every installation, paging through both lists', async () => {
    fake.userPageSize = 2;
    fake.userRepoPageSize = 3;
    fake.install({
      id: 11,
      account: { login: 'acme', type: 'Organization' },
      repos: many('acme', 7),
    });
    fake.install({ id: 12, account: { login: 'octocat', type: 'User' }, repos: ['octocat/hello'] });
    fake.install({ id: 13, account: { login: 'zed', type: 'User' }, repos: ['zed/z'] });
    await signedIn();
    const list = await signin.repositories();
    expect(list.repositories).toHaveLength(9);
    expect(list.truncated).toBe(false);
    expect(list.warnings).toEqual([]);
    expect(list.repositories[0]).toMatchObject({
      fullName: 'acme/r0',
      owner: 'acme',
      name: 'r0',
      private: true,
      installationId: 11,
      account: 'acme',
      htmlUrl: `${fake.url}/acme/r0`,
    });
    expect(list.repositories.find((r) => r.fullName === 'octocat/hello')).toMatchObject({
      installationId: 12,
    });
    // It asked the user's endpoints, as the user, never as the app.
    const asked = fake.seen.filter((s) => s.path.startsWith('/user/installations'));
    expect(asked.length).toBeGreaterThan(4);
    expect(asked.every((s) => s.auth === 'user')).toBe(true);
  });

  it('stops at the limit and says so', async () => {
    fake.install({ id: 21, repos: many('acme', MAX_REPOSITORIES + 200) });
    await signedIn();
    const list = await signin.repositories();
    expect(list.repositories).toHaveLength(MAX_REPOSITORIES);
    expect(list.truncated).toBe(true);
    expect(list.limit).toBe(MAX_REPOSITORIES);
  });

  it('is not truncated at exactly the limit', async () => {
    fake.install({ id: 22, repos: many('acme', MAX_REPOSITORIES) });
    await signedIn();
    const list = await signin.repositories();
    expect(list.repositories).toHaveLength(MAX_REPOSITORIES);
    expect(list.truncated).toBe(false);
  });

  it('skips a suspended installation, an installation the person cannot see, and a name it cannot use', async () => {
    fake.install({
      id: 31,
      account: { login: 'acme', type: 'Organization' },
      repos: ['acme/ok', 'acme/..'],
    });
    fake.install({
      id: 32,
      account: { login: 'old', type: 'User' },
      repos: ['old/x'],
      suspended: true,
    });
    fake.install({ id: 33, account: { login: 'other', type: 'User' }, repos: ['other/y'] });
    fake.userInstallationIds = [31, 32];
    await signedIn();
    const list = await signin.repositories();
    expect(list.repositories.map((r) => r.fullName)).toEqual(['acme/ok']);
    expect(list.warnings).toEqual([
      'The installation on old is suspended, so its repositories are not listed.',
      '1 repository has a name OpenClerq cannot use, and was left out.',
    ]);
  });

  it('keeps the case GitHub spells a repository with', async () => {
    fake.install({ id: 41, repos: ['acme/widgets'] });
    fake.repoCase.set('acme/widgets', 'Acme/Widgets');
    await signedIn();
    expect((await signin.repositories()).repositories[0]).toMatchObject({
      fullName: 'Acme/Widgets',
      owner: 'Acme',
      name: 'Widgets',
    });
  });

  it('says nobody is signed in, and does not ask GitHub', async () => {
    const e = (await signin.repositories().catch((x: unknown) => x)) as SignInError;
    expect(e).toMatchObject({ status: 409, code: 'not_signed_in' });
    expect(fake.calls('GET', '/user/installations')).toHaveLength(0);
  });

  it('signs out when GitHub says the sign-in was revoked', async () => {
    fake.install({ id: 51, repos: ['acme/a'] });
    await signedIn();
    for (const t of fake.userTokens.values()) {
      t.revoked = true;
      t.grantRevoked = true;
    }
    const e = (await signin.repositories().catch((x: unknown) => x)) as SignInError;
    expect(e).toMatchObject({ status: 409, code: 'not_signed_in' });
    expect(vault.get(USER_TOKENS_SECRET)).toBeUndefined();
  });

  it('does not reveal the token in an error from GitHub', async () => {
    fake.install({ id: 61, repos: ['acme/a'] });
    await signedIn();
    const held = stored();
    fake.failNext.set('/user/installations', { status: 500, message: 'oops {token}' });
    const e = (await signin.repositories().catch((x: unknown) => x)) as SignInError;
    expect(e).toMatchObject({ status: 502, code: 'github_unreachable' });
    expect(e.message).not.toContain(held.accessToken);
    expect(e.message).toContain('«redacted»');
  });
});

describe('the connected app', () => {
  it('is read from the stored connection', () => {
    expect(readAppConfig()?.clientId).toBe(fake.app.clientId);
  });
});
