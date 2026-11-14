/**
 * `clerq github` against a real gateway, in this process, and a fake GitHub (its
 * website and its API are one server). Real HTTP, a real store and vault under a
 * temporary HOME. The browser is the test's own: it reads the page the command
 * wrote, posts the form to the fake the way a browser would, and follows the
 * redirect back to the gateway. Nothing opens a real browser or reaches GitHub.
 *
 * Needs the gateway built (`pnpm build`); without it the tests are skipped
 * locally and fail under CI.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FakeGithub } from '../../../packages/gateway/dist/github/fake-github.js';
import { FakeStdin, capture, cli, type CliResult } from './test-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', '..', '..', 'packages', 'gateway', 'dist');
const runnable = fs.existsSync(path.join(DIST, 'index.js')) || Boolean(process.env.CI);

const TOKEN = 'cli-github-e2e-gateway-token-0123456789';
const posix = process.platform !== 'win32';

let root: string;
let gatewayUrl: string;
let fake: FakeGithub;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
const saved: Record<string, string | undefined> = {};
const ENV = ['HOME', 'USERPROFILE', 'CLERQ_KEYCHAIN', 'CLERQ_GITHUB_API', 'CLERQ_GITHUB_WEB'];

let homes = 0;
const newHome = () => {
  const dir = path.join(root, `cli-home-${homes++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** A home that is signed in to the gateway, the way a person would be. */
async function signedIn(): Promise<string> {
  const home = newHome();
  const r = await cli(['login', gatewayUrl, '--token-stdin'], { home, stdin: `${TOKEN}\n` });
  expect(r.code, r.stderr).toBe(0);
  return home;
}

/** Wait for `fn` to answer something. */
async function until<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const decode = (text: string) =>
  text.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/**
 * What a person's browser does with the page: read the form, post it to GitHub (the
 * fake), and follow GitHub's redirect back to the gateway. Resolves with what the
 * gateway's page answered.
 */
async function browser(file: string): Promise<{ status: number; text: string }> {
  const page = fs.readFileSync(file, 'utf8');
  const action = decode(/<form[^>]* action="([^"]+)"/.exec(page)?.[1] as string);
  const manifest = decode(/name="manifest" value="([^"]*)"/.exec(page)?.[1] as string);
  const posted = await fetch(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ manifest }),
    redirect: 'manual',
  });
  expect(posted.status).toBe(302);
  const back = await fetch(posted.headers.get('location') as string, { redirect: 'manual' });
  return { status: back.status, text: await back.text() };
}

/** An opener that plays the browser in the background, and keeps what it did. */
function browserOpener() {
  const opened: string[] = [];
  const done: Array<Promise<{ status: number; text: string }>> = [];
  return {
    opened,
    done,
    openUrl: async (target: string) => {
      opened.push(target);
      if (target.endsWith('.html')) done.push(browser(target));
      return true;
    },
  };
}

/** The key as GitHub gives it (a file), the way it is kept. */
const pemFile = (home: string, text: string, mode = 0o600) => {
  const file = path.join(home, 'my-app.private-key.pem');
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
};

const json = <T = Record<string, any>>(r: CliResult): T => JSON.parse(r.stdout) as T;

/** Everything a command printed. */
const said = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

/** No secret of the connection is in what was printed. */
function expectNoSecrets(...results: CliResult[]) {
  for (const r of results) {
    const all = said(r);
    expect(all).not.toContain('BEGIN RSA');
    expect(all).not.toContain('PRIVATE KEY');
    expect(all).not.toContain(fake.clientSecret);
    expect(all).not.toMatch(/ghu_fake|ghr_fake|device_[0-9a-f]{8}/);
    expect(all).not.toContain(TOKEN);
  }
}

beforeAll(async () => {
  if (!runnable) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-github-e2e-')));
  for (const name of ENV) saved[name] = process.env[name];
  const gatewayHome = path.join(root, 'gateway-home');
  fs.mkdirSync(gatewayHome);
  process.env.HOME = gatewayHome;
  process.env.USERPROFILE = gatewayHome;
  process.env.CLERQ_KEYCHAIN = 'off';

  const mod = (await import(pathToFileURL(path.join(DIST, 'github', 'fake-github.js')).href)) as {
    FakeGithub: new () => FakeGithub;
  };
  fake = await new mod.FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  process.env.CLERQ_GITHUB_WEB = fake.url;

  const { createGateway } = await import('@clerq/gateway');
  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await until(() => undefined, 0).catch(() => undefined);
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${gatewayUrl}/v1/automations`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}, 30_000);

afterAll(async () => {
  if (!runnable) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Disconnect whatever a test left connected, so the next starts clean. */
beforeEach(async () => {
  if (!runnable) return;
  // Whatever the last test left connected goes first, while the fake still remembers its tokens.
  const home = await signedIn();
  await cli(['github', 'disconnect', '--yes'], { home });
  fake.reset();
  fake.installations.length = 0;
  fake.conversions.clear();
  fake.deviceInterval = 1;
});

describe.skipIf(!runnable)('connect', () => {
  it('writes a page that posts the manifest, opens it, waits, connects, and deletes the page', async () => {
    const home = await signedIn();
    const b = browserOpener();
    const r = await cli(['github', 'connect', '--name', 'Acme Clerq'], {
      home,
      openUrl: b.openUrl,
      githubPollMs: 20,
    });
    expect(r.code, r.stderr).toBe(0);
    // The page was opened once, and is gone.
    expect(b.opened).toHaveLength(1);
    expect(b.opened[0]).toMatch(/create-github-app\.html$/);
    expect(fs.existsSync(b.opened[0])).toBe(false);
    expect(fs.existsSync(path.dirname(b.opened[0]))).toBe(false);
    // GitHub got the manifest, asking for what the gateway made it ask for.
    expect(fake.manifestPosts).toHaveLength(1);
    expect(fake.manifestPosts[0].path).toBe('/settings/apps/new');
    expect(fake.manifestPosts[0].manifest).toMatchObject({
      name: 'Acme Clerq',
      public: false,
      redirect_url: `${gatewayUrl}/v1/github/app/callback`,
    });
    expect((await b.done[0]).status).toBe(200);
    expect(r.stdout).toContain('Connected the GitHub App');
    // The links: install, and the one click device flow needs.
    expect(r.stdout).toContain(`${fake.url}/apps/${fake.app.slug}/installations/new`);
    expect(r.stdout).toContain('Enable Device Flow');
    expect(r.stdout).toContain(`${fake.url}/settings/apps/${fake.app.slug}`);
    expect(r.stdout).toContain(
      `GitHub sends the browser back to ${gatewayUrl}/v1/github/app/callback`
    );
    expectNoSecrets(r);

    // It is connected for the next command too.
    const s = await cli(['github', 'status'], { home });
    expect(s.stdout).toContain(fake.app.slug);
    expect(s.stdout).toMatch(/client secret yes/);
  });

  it('under an organisation, with --json: data on stdout, words on stderr', async () => {
    const home = await signedIn();
    const b = browserOpener();
    const r = await cli(['github', 'connect', '--org', 'acme-org', '--json'], {
      home,
      openUrl: b.openUrl,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(fake.manifestPosts[0].path).toBe('/organizations/acme-org/settings/apps/new');
    const out = json(r);
    expect(out).toMatchObject({ connected: true, app: { slug: fake.app.slug } });
    expect(out.installUrl).toContain('/installations/new');
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('Waiting for the app to be created');
    expectNoSecrets(r);
  });

  it('with --no-browser prints the page’s path, opens nothing, and waits for a browser that is elsewhere', async () => {
    const home = await signedIn();
    const c = capture(new FakeStdin());
    let opened = 0;
    const run = cli(['github', 'connect', '--no-browser'], {
      home,
      io: c.io,
      openUrl: async () => {
        opened += 1;
        return true;
      },
    });
    const file = await until(() => /(\/\S*create-github-app\.html)/.exec(c.stdout())?.[1]);
    expect(fs.existsSync(file)).toBe(true);
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Someone opens that page on a computer with a browser.
    const result = await browser(file);
    expect(result.status).toBe(200);
    expect(result.text).toContain('Connected');
    const r = await run;
    expect(r.code).toBe(0);
    expect(opened).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('says where the page is when no browser can be opened', async () => {
    const home = await signedIn();
    const c = capture(new FakeStdin());
    const run = cli(['github', 'connect'], { home, io: c.io, openUrl: async () => false });
    const file = await until(() => /(\/\S*create-github-app\.html)/.exec(c.stdout())?.[1]);
    expect(c.stdout()).toContain('Could not open a browser');
    await browser(file);
    expect((await run).code).toBe(0);
  });

  it('gives up after the wait, deletes the page and says to start again', async () => {
    const home = await signedIn();
    const pages: string[] = [];
    const r = await cli(['github', 'connect'], {
      home,
      githubWaitMs: 120,
      githubPollMs: 20,
      openUrl: async (t) => {
        pages.push(t);
        return true;
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Nothing was connected within');
    expect(r.stderr).toContain('clerq github connect');
    expect(fs.existsSync(pages[0])).toBe(false);
    expect((await cli(['github', 'status', '--json'], { home })).stdout).toContain(
      '"connected":false'
    );
  });

  it('stops on Ctrl-C with 130, and deletes the page', async () => {
    const home = await signedIn();
    const abort = new AbortController();
    const pages: string[] = [];
    const r = await cli(['github', 'connect'], {
      home,
      signal: abort.signal,
      githubPollMs: 20,
      openUrl: async (t) => {
        pages.push(t);
        setTimeout(() => abort.abort(), 80);
        return true;
      },
    });
    expect(r.code).toBe(130);
    expect(fs.existsSync(pages[0])).toBe(false);
  });

  it('refuses when an app is connected already', async () => {
    const home = await signedIn();
    const first = browserOpener();
    expect((await cli(['github', 'connect'], { home, openUrl: first.openUrl })).code).toBe(0);
    const again = browserOpener();
    const r = await cli(['github', 'connect'], { home, openUrl: again.openUrl });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is connected already');
    expect(again.opened).toHaveLength(0);
  });

  it('is exit 3 when no gateway answers, and nothing is written', async () => {
    const home = newHome();
    const r = await cli(['github', 'connect', '--gateway', 'http://127.0.0.1:1'], { home });
    expect(r.code).toBe(3);
  });
});

describe.skipIf(!runnable)('import', () => {
  it('reads the key from a file, connects, and prints neither the key nor the secret', async () => {
    const home = await signedIn();
    const key = pemFile(home, fake.privateKeyPem);
    const secret = path.join(home, 'secret.txt');
    fs.writeFileSync(secret, `${fake.clientSecret}\n`, { mode: 0o600 });
    const r = await cli(
      [
        'github',
        'import',
        '--app-id',
        String(fake.app.id),
        '--client-id',
        fake.app.clientId,
        '--private-key-file',
        key,
        '--client-secret-file',
        secret,
      ],
      { home }
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Connected the GitHub App`);
    expect(r.stdout).toContain('Enable Device Flow');
    expect(r.stdout).not.toContain('No client secret was given');
    expectNoSecrets(r);
  });

  it('says what a missing client secret means', async () => {
    const home = await signedIn();
    const r = await cli(
      [
        'github',
        'import',
        '--app-id',
        String(fake.app.id),
        '--client-id',
        fake.app.clientId,
        '--private-key-file',
        pemFile(home, fake.privateKeyPem),
      ],
      { home }
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('No client secret was given');
    expect(r.stdout).toContain('cannot be renewed');
  });

  it.skipIf(!posix)('refuses a key file anybody can read, and asks GitHub nothing', async () => {
    const home = await signedIn();
    const r = await cli(
      [
        'github',
        'import',
        '--app-id',
        String(fake.app.id),
        '--client-id',
        fake.app.clientId,
        '--private-key-file',
        pemFile(home, fake.privateKeyPem, 0o644),
      ],
      { home }
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('chmod 600');
    expect(fake.seen).toHaveLength(0);
    expectNoSecrets(r);
  });

  it('reports a key GitHub does not accept in GitHub’s words, and a key that is no key', async () => {
    const home = await signedIn();
    const other = (await import('node:crypto')).generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const args = (file: string) => [
      'github',
      'import',
      '--app-id',
      String(fake.app.id),
      '--client-id',
      fake.app.clientId,
      '--private-key-file',
      file,
    ];
    const wrong = await cli(args(pemFile(home, other.privateKey)), { home });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('JSON web token');
    expectNoSecrets(wrong);
    const junk = await cli(args(pemFile(home, 'this is not a key')), { home });
    expect(junk.code).toBe(1);
    expect(junk.stderr.length).toBeGreaterThan(10);
  });

  it('replaces the key of the same app, and says so', async () => {
    const home = await signedIn();
    const args = (file: string) => [
      'github',
      'import',
      '--app-id',
      String(fake.app.id),
      '--client-id',
      fake.app.clientId,
      '--private-key-file',
      file,
    ];
    expect((await cli(args(pemFile(home, fake.privateKeyPem)), { home })).code).toBe(0);
    const second = fake.addKey();
    const r = await cli(args(pemFile(home, second)), { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Replaced the key');
  });
});

describe.skipIf(!runnable)('status and disconnect', () => {
  const connectApp = async (home: string) => {
    const r = await cli(
      [
        'github',
        'import',
        '--app-id',
        String(fake.app.id),
        '--client-id',
        fake.app.clientId,
        '--private-key-file',
        pemFile(home, fake.privateKeyPem),
        '--client-secret-file',
        (() => {
          const f = path.join(home, 'secret.txt');
          fs.writeFileSync(f, fake.clientSecret, { mode: 0o600 });
          return f;
        })(),
      ],
      { home }
    );
    expect(r.code, r.stderr).toBe(0);
  };

  it('says nothing is connected, as data too', async () => {
    const home = await signedIn();
    const r = await cli(['github', 'status'], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No GitHub App is connected');
    expect(json(await cli(['github', 'status', '--json'], { home }))).toMatchObject({
      connected: false,
    });
  });

  it('shows the app, where it is installed, and that nobody is signed in', async () => {
    const home = await signedIn();
    await connectApp(home);
    let r = await cli(['github', 'status'], { home });
    expect(r.stdout).toContain('nowhere yet');
    expect(r.stdout).toContain(`${fake.url}/apps/${fake.app.slug}/installations/new`);
    expect(r.stdout).toMatch(/Signed in\s+no/);
    fake.install({ account: { login: 'acme', type: 'Organization' }, repos: ['acme/app'] });
    fake.install({
      account: { login: 'octocat', type: 'User' },
      selection: 'all',
      repos: [],
      suspended: true,
    });
    // The list is kept for a minute: --refresh asks again.
    r = await cli(['github', 'status', '--refresh'], { home });
    expect(r.stdout).toContain('acme (selected repositories)');
    expect(r.stdout).toContain('octocat (all repositories), SUSPENDED');
    const data = json(await cli(['github', 'status', '--refresh', '--json'], { home }));
    expect(data.installations).toHaveLength(2);
    expect(data.user).toMatchObject({ signedIn: false });
    expectNoSecrets(r);
  });

  it('says when GitHub refuses the key, and what to do about it', async () => {
    const home = await signedIn();
    await connectApp(home);
    fake.removeOriginalKey();
    const r = await cli(['github', 'status', '--refresh'], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('could not ask GitHub');
    expect(r.stderr).toContain('generate a new private key');
    expect(r.stderr).toContain('clerq github import');
  });

  it('asks before it disconnects, and does nothing on no, or without a terminal', async () => {
    const home = await signedIn();
    await connectApp(home);
    // No terminal and no --yes: it will not guess.
    const noTty = await cli(['github', 'disconnect'], { home });
    expect(noTty.code).toBe(64);
    expect(noTty.stderr).toContain('Pass --yes');
    // A terminal, and the answer is no (Enter alone).
    const no = new FakeStdin('', true);
    const c = capture(no, true);
    const run = cli(['github', 'disconnect'], { home, io: c.io });
    await until(() => c.stderr().includes('[y/N]'));
    no.type('\n');
    const answered = await run;
    expect(answered.code).toBe(1);
    expect(c.stderr()).toContain('Nothing was changed');
    expect(json(await cli(['github', 'status', '--json'], { home })).connected).toBe(true);
  });

  it('disconnects on a yes, and says the app is still on GitHub, with its settings page', async () => {
    const home = await signedIn();
    await connectApp(home);
    const yes = new FakeStdin('', true);
    const c = capture(yes, true);
    const run = cli(['github', 'disconnect'], { home, io: c.io });
    await until(() => c.stderr().includes('[y/N]'));
    yes.type('y\n');
    const r = await run;
    expect(r.code, c.stderr()).toBe(0);
    expect(c.stdout()).toContain('still exists on GitHub');
    expect(c.stdout()).toContain(`${fake.url}/settings/apps/${fake.app.slug}`);
    expect(json(await cli(['github', 'status', '--json'], { home })).connected).toBe(false);
  });

  it('disconnects with --yes, as data with --json, and a second time says nothing is connected', async () => {
    const home = await signedIn();
    await connectApp(home);
    const r = await cli(['github', 'disconnect', '--yes', '--json'], { home });
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({
      disconnected: true,
      appDeletedOnGitHub: false,
      slug: fake.app.slug,
    });
    const again = await cli(['github', 'disconnect', '--yes'], { home });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('No GitHub App is connected');
  });
});

describe.skipIf(!runnable)('login, logout and repos', () => {
  const connectApp = async (home: string) => {
    const secret = path.join(home, 'secret.txt');
    fs.writeFileSync(secret, fake.clientSecret, { mode: 0o600 });
    const r = await cli(
      [
        'github',
        'import',
        '--app-id',
        String(fake.app.id),
        '--client-id',
        fake.app.clientId,
        '--private-key-file',
        pemFile(home, fake.privateKeyPem),
        '--client-secret-file',
        secret,
      ],
      { home }
    );
    expect(r.code, r.stderr).toBe(0);
  };

  /** Run `clerq github login`, and play the person: read the code it printed, then answer on GitHub. */
  async function login(
    home: string,
    answer: (code: string) => void,
    extra: string[] = [],
    openUrl?: (t: string) => Promise<boolean>,
    githubWaitMs?: number
  ) {
    const c = capture(new FakeStdin());
    const run = cli(['github', 'login', ...extra], {
      home,
      io: c.io,
      openUrl: openUrl ?? (async () => true),
      githubWaitMs,
    });
    const code = await until(() => /([0-9A-F]{4}-[0-9A-F]{4})/.exec(c.stdout() + c.stderr())?.[1]);
    answer(code);
    const result = await run;
    // The streams were the test's own, so the result's are empty: what was printed is here.
    const printed: CliResult = { code: result.code, stdout: c.stdout(), stderr: c.stderr() };
    return { result: printed, text: () => `${c.stdout()}\n${c.stderr()}` };
  }

  it('prints the code and the address, opens the browser at it, waits, and signs in', async () => {
    const home = await signedIn();
    await connectApp(home);
    const opened: string[] = [];
    const { result, text } = await login(
      home,
      (code) => fake.approve(code, { login: 'hubot', name: 'Hubot' }),
      [],
      async (t) => (opened.push(t), true)
    );
    expect(result.code, result.stderr).toBe(0);
    expect(opened).toEqual([`${fake.url}/login/device`]);
    expect(text()).toContain(`${fake.url}/login/device`);
    expect(result.stdout).toContain('Signed in to GitHub as @hubot (Hubot).');
    expectNoSecrets(result);

    // Status now says who, and when the token ends and that it is renewed.
    const s = await cli(['github', 'status'], { home });
    expect(s.stdout).toMatch(/Signed in\s+@hubot \(Hubot\); the token ends .* and is renewed/);
    expect(json(await cli(['github', 'status', '--json'], { home })).user).toMatchObject({
      signedIn: true,
      refreshable: true,
      user: { login: 'hubot' },
    });
  });

  it('waits as long as the code lasts, not as long as connect does', async () => {
    const home = await signedIn();
    await connectApp(home);
    // connect's wait would be over before the gateway looks at GitHub even once (it never goes faster than every second).
    const { result } = await login(home, (code) => fake.approve(code), [], undefined, 50);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Signed in to GitHub as @octocat');
    expect(result.stderr).not.toContain('Gave up waiting');
  });

  it('with --no-browser opens nothing; with --json, the code is on stderr and the result on stdout', async () => {
    const home = await signedIn();
    await connectApp(home);
    const opened: string[] = [];
    const { result, text } = await login(
      home,
      (code) => fake.approve(code),
      ['--no-browser', '--json'],
      async (t) => (opened.push(t), true)
    );
    expect(result.code, result.stderr).toBe(0);
    expect(opened).toEqual([]);
    expect(result.stderr).toMatch(/[0-9A-F]{4}-[0-9A-F]{4}/);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(json(result)).toMatchObject({ status: 'approved', user: { login: 'octocat' } });
    expect(text()).not.toContain('ghu_');
  });

  it('is 1 when it is refused on GitHub, and 1 when the code runs out', async () => {
    const home = await signedIn();
    await connectApp(home);
    const denied = await login(home, (code) => fake.deny(code));
    expect(denied.result.code).toBe(1);
    expect(denied.result.stderr).toContain('refused on GitHub');
    const expired = await login(home, (code) => fake.expire(code));
    expect(expired.result.code).toBe(1);
    expect(expired.result.stderr).toContain('ran out');
    expect(json(await cli(['github', 'status', '--json'], { home })).user.signedIn).toBe(false);
  });

  it('tells how to switch device flow on, when it is off at the start', async () => {
    const home = await signedIn();
    await connectApp(home);
    fake.deviceFlowEnabled = false;
    const r = await cli(['github', 'login'], { home, openUrl: async () => true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Enable Device Flow');
    expect(r.stdout).toContain('Identifying and authorizing users');
    expect(r.stdout).toContain(`${fake.url}/settings/apps/${fake.app.slug}`);
    const asData = json(await cli(['github', 'login', '--json'], { home }));
    expect(asData).toMatchObject({
      status: 'disabled',
      settingsUrl: `${fake.url}/settings/apps/${fake.app.slug}`,
    });
  });

  it('tells the same when GitHub says so while it waits', async () => {
    const home = await signedIn();
    await connectApp(home);
    fake.deviceScript = ['disabled'];
    const r = await cli(['github', 'login'], { home, openUrl: async () => true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Enable Device Flow');
    expect(r.stdout).toContain(`${fake.url}/settings/apps/${fake.app.slug}`);
  });

  it('says there is no app to sign in to, in plain words', async () => {
    const home = await signedIn();
    const r = await cli(['github', 'login'], { home, openUrl: async () => true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No GitHub App is connected');
  });

  it('stops on Ctrl-C with 130 and cancels the flow', async () => {
    const home = await signedIn();
    await connectApp(home);
    const abort = new AbortController();
    const r = await cli(['github', 'login'], {
      home,
      signal: abort.signal,
      openUrl: async () => {
        setTimeout(() => abort.abort(), 60);
        return true;
      },
    });
    expect(r.code).toBe(130);
    expect(r.stderr).toContain('Nothing was signed in');
    // The flow is gone on the gateway: approving later changes nothing.
    for (const d of fake.devices.values()) fake.approve(d.userCode);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(json(await cli(['github', 'status', '--json'], { home })).user.signedIn).toBe(false);
  });

  it('is 3 when the gateway cannot be used', async () => {
    const home = newHome();
    const r = await cli(['github', 'login', '--gateway', 'http://127.0.0.1:1'], { home });
    expect(r.code).toBe(3);
  });

  it('lists the repositories reached, marks the added, adds one, and signs out', async () => {
    const home = await signedIn();
    await connectApp(home);
    fake.install({
      account: { login: 'acme', type: 'Organization' },
      repos: ['acme/app', 'acme/web'],
    });
    fake.repoCase.set('acme/app', 'Acme/App');

    // Not signed in yet.
    const early = await cli(['github', 'repos'], { home });
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('Not signed in to GitHub');

    const { result } = await login(home, (code) => fake.approve(code));
    expect(result.code).toBe(0);

    let r = await cli(['github', 'repos'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Acme\/App\s+acme\s+private\s+no/);
    expect(r.stdout).toMatch(/acme\/web\s+acme\s+private\s+no/);
    expect(r.stdout).toContain('clerq github repos --add owner/name');

    const added = await cli(['github', 'repos', '--add', 'acme/web'], { home });
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain('Added acme/web');
    const again = await cli(['github', 'repos', '--add', 'github:acme/web', '--json'], { home });
    expect(json(again)).toMatchObject({ ok: true, created: false, kind: 'github' });

    r = await cli(['github', 'repos', '--json'], { home });
    const list = json(r);
    expect(list.repositories.map((x: any) => [x.fullName, x.added])).toEqual([
      ['Acme/App', false],
      ['acme/web', true],
    ]);
    expect(list.truncated).toBe(false);
    expectNoSecrets(r);

    const bad = await cli(['github', 'repos', '--add', 'not a repo'], { home });
    expect(bad.code).toBe(64);

    // Sign out: revoked on GitHub, and a second time there is nobody.
    const out = await cli(['github', 'logout'], { home });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain('revoked');
    expect(fake.grantsRevoked).toEqual(['octocat']);
    const second = await cli(['github', 'logout', '--json'], { home });
    expect(second.code).toBe(0);
    expect(json(second)).toMatchObject({ signedOut: false, signedIn: false });
    expectNoSecrets(out, second);
  });

  it('signing out without a client secret says where to revoke', async () => {
    const home = await signedIn();
    await cli(
      [
        'github',
        'import',
        '--app-id',
        String(fake.app.id),
        '--client-id',
        fake.app.clientId,
        '--private-key-file',
        pemFile(home, fake.privateKeyPem),
      ],
      { home }
    );
    const { result } = await login(home, (code) => fake.approve(code));
    expect(result.code).toBe(0);
    const out = await cli(['github', 'logout'], { home });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('no client secret');
    expect(out.stdout).toContain(`${fake.url}/settings/apps/authorizations`);
    expect(out.stderr).toContain('still lists the app as authorized');
    expect(fake.grantsRevoked).toEqual([]);
  });

  it('disconnecting the app signs out first, and says so', async () => {
    const home = await signedIn();
    await connectApp(home);
    const { result } = await login(home, (code) => fake.approve(code));
    expect(result.code).toBe(0);
    const r = await cli(['github', 'disconnect', '--yes'], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('revoked');
    expect(fake.grantsRevoked).toEqual(['octocat']);
  });
});
