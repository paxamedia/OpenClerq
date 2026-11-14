/**
 * The command line against a real gateway, in this process: real HTTP, a real
 * store, real git, a temporary HOME. The agents are scripted (nothing here runs
 * a model or a vendor's CLI) and the forge is a bare repository on disk.
 *
 * Needs the gateway built (`pnpm build`); without it the tests are skipped
 * locally and fail under CI.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, DriverAvailability, DriverEvent, DriverRunInput } from '@clerq/drivers';
import { runCli } from './cli.js';
import { FakeStdin, capture, cli, type CliResult } from './test-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIST = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'gateway',
  'dist',
  'index.js'
);
const runnable = fs.existsSync(GATEWAY_DIST) || Boolean(process.env.CI);

const TOKEN = 'cli-e2e-gateway-token-0123456789abcdef';
const posix = process.platform !== 'win32';

type Mode = 'edit' | 'fail';
let mode: Mode = 'edit';
let agentModels: Array<string | undefined> = [];

/** A scripted agent: writes CHANGED.md, or fails. */
function scripted(id: string): Driver {
  return {
    id,
    async detect(): Promise<DriverAvailability> {
      return { id, available: true, version: 'test', path: `/fake/${id}` };
    },
    run: (input) => runScripted(id, input),
  };
}

async function* runScripted(id: string, input: DriverRunInput): AsyncIterable<DriverEvent> {
  agentModels.push(input.model);
  input.onSpawn?.({ pid: process.pid, pgid: process.pid, command: `/fake/${id}` });
  yield { type: 'started', model: 'fake-model' };
  yield { type: 'text', text: 'Updating the changelog.' };
  if (mode === 'edit') {
    yield { type: 'tool_call', id: 't1', name: 'Write', input: { file_path: 'CHANGED.md' } };
    fs.writeFileSync(path.join(input.cwd, 'CHANGED.md'), `changed ${Date.now()}\n`);
    yield { type: 'tool_result', id: 't1', output: 'written', isError: false };
  }
  yield {
    type: 'finished',
    result: {
      ok: mode === 'edit',
      summary: mode === 'edit' ? 'Added CHANGED.md' : 'The agent gave up.',
      costUsd: 0.25,
      tokensIn: 1000,
      tokensOut: 200,
      durationMs: 5,
      exitCode: mode === 'edit' ? 0 : 1,
      timedOut: false,
      cancelled: false,
      permissionDenials: [],
      warnings: [],
    },
  };
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

let root: string;
let gatewayHome: string;
let repo: string;
let bare: string;
let gatewayUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
const saved: Record<string, string | undefined> = {};

/** A fresh home directory for the command line, as its own account would have. */
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

const spec = (name: string, extra = '', repoPath = repo) =>
  [
    `name: ${name}`,
    'targets:',
    `  repos: [local:${repoPath}]`,
    'agent:',
    '  driver: claude-code',
    'prompt: Add a CHANGED.md file.',
    'sandbox:',
    '  profile: native',
    'gates:',
    '  - run: test -f CHANGED.md',
    'publish:',
    '  push: false',
    extra,
  ]
    .filter((l) => l !== '')
    .join('\n');

/** A spec that pushes, so its first run waits for an approval. */
const pushing = (name: string) =>
  spec(name).replace('  push: false', '  push: true\n  pull_request: none');

const specFile = (dir: string, name: string, text: string) => {
  const file = path.join(dir, `${name}.yaml`);
  fs.writeFileSync(file, `${text}\n`);
  return file;
};

/** Poll `fn` until it answers something other than undefined. */
async function until<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const json = <T = Record<string, unknown>>(r: CliResult): T => JSON.parse(r.stdout) as T;
const lines = (r: CliResult): Array<Record<string, unknown>> =>
  r.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  if (!runnable) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-e2e-')));
  for (const name of ['HOME', 'CLERQ_KEYCHAIN', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    saved[name] = process.env[name];
  }
  // The gateway in this process keeps nothing of the developer's.
  gatewayHome = path.join(root, 'gateway-home');
  fs.mkdirSync(gatewayHome);
  process.env.HOME = gatewayHome;
  process.env.CLERQ_KEYCHAIN = 'off';

  bare = path.join(root, 'origin.git');
  repo = path.join(root, 'app');
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', bare);
  sh(repo, 'push', '-q', 'origin', 'main');
  sh(repo, 'fetch', '-q', 'origin');
  sh(repo, 'remote', 'set-head', 'origin', 'main');

  // github.com/acme/app is the bare repository, for `repo add --check`; nothing leaves the machine.
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(
    gitConfig,
    `[url "${bare}"]\n\tinsteadOf = https://github.com/acme/app.git\n[url "${path.join(root, 'nowhere')}"]\n\tinsteadOf = https://github.com/acme/gone.git\n`
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const { createGateway } = await import('@clerq/gateway');
  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    automations: {
      driverFor: (id) => scripted(id),
      getSecret: () => undefined,
      secretNames: () => [],
      workspaceCacheDir: path.join(root, 'cache'),
      path: () => process.env.PATH ?? '',
      maxConcurrent: 4,
    },
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await until(async () => {
    const res = await fetch(`${gatewayUrl}/v1/automations`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return res.status === 200 ? true : undefined;
  });
}, 30_000);

afterAll(async () => {
  if (!runnable) return;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!runnable)('login, status and logout', () => {
  it('refuses a token the gateway does not know, and saves nothing', async () => {
    const home = newHome();
    const r = await cli(['login', gatewayUrl, '--token-stdin'], {
      home,
      stdin: 'not-the-gateway-token-0123\n',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused that token. Nothing was saved.');
    expect(fs.existsSync(path.join(home, '.clerq', 'cli.json'))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('not-the-gateway-token');
  });

  it('signs in with --token-stdin, keeps a 0600 profile, and never prints the token', async () => {
    const home = newHome();
    const r = await cli(['login', gatewayUrl, '--token-stdin'], { home, stdin: `${TOKEN}\n` });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Signed in to ${gatewayUrl}`);
    expect(r.stdout).toContain('Saved profile "default" in ~/.clerq/cli.json');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    const file = path.join(home, '.clerq', 'cli.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      profiles: { default: { url: string; token: string } };
    };
    expect(saved.profiles.default).toEqual({ url: gatewayUrl, token: TOKEN });
    if (posix) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps only the path of a token file with --token-file', async () => {
    const home = newHome();
    const tokenFile = path.join(home, 'my-token');
    fs.writeFileSync(tokenFile, `${TOKEN}\n`);
    const r = await cli(['login', gatewayUrl, '--token-file', tokenFile, '--profile', 'filed'], {
      home,
    });
    expect(r.code, r.stderr).toBe(0);
    const saved = fs.readFileSync(path.join(home, '.clerq', 'cli.json'), 'utf8');
    expect(saved).not.toContain(TOKEN);
    expect(JSON.parse(saved).profiles.filed).toEqual({ url: gatewayUrl, tokenFile });
    // And the profile works, reading the file each time.
    const s = await cli(['status', '--profile', 'filed'], { home });
    expect(s.code, s.stderr).toBe(0);
    expect(s.stdout).toMatch(/Token is\s+accepted/);
  });

  it('answers status, with the versions and where each setting came from', async () => {
    const home = await signedIn();
    const r = await cli(['status'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(gatewayUrl);
    expect(r.stdout).toContain('from the profile "default" in ~/.clerq/cli.json');
    expect(r.stdout).toMatch(/OpenClerq \d+\.\d+\.\d+, API 1 \(serves 1\), store schema \d+/);
    expect(r.stdout).toMatch(/Compatible\s+yes/);
    expect(r.stdout).toMatch(/Token is\s+accepted/);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it('gives status as data under --json, with no token in it', async () => {
    const home = await signedIn();
    const r = await cli(['status', '--json'], { home });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const status = json<Record<string, any>>(r);
    expect(status).toMatchObject({
      url: gatewayUrl,
      profile: 'default',
      source: { url: 'default-profile', token: 'default-profile' },
      cli: { api: { version: 1 } },
      gateway: { api: { version: 1, supported: [1] } },
      compatibility: { ok: true, kind: 'compatible', reason: null },
      token: { present: true, state: 'accepted' },
    });
    expect(typeof status.gateway.schema).toBe('number');
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it('uses the gateway on this computer, and its token file, when nothing else is set', async () => {
    const home = newHome();
    fs.mkdirSync(path.join(home, '.clerq'));
    fs.writeFileSync(path.join(home, '.clerq', 'gateway-token'), `${TOKEN}\n`);
    const r = await cli(['status'], { home, localUrl: gatewayUrl });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('(the gateway on this computer, the default)');
    expect(r.stdout).toContain('in ~/.clerq/gateway-token');
    // `clerq login` with no address only checks it works, and says nothing was saved.
    const l = await cli(['login'], { home, localUrl: gatewayUrl });
    expect(l.code, l.stderr).toBe(0);
    expect(l.stdout).toContain('accepted the token in ~/.clerq/gateway-token');
    expect(l.stdout).toContain('Nothing was saved');
    expect(fs.existsSync(path.join(home, '.clerq', 'cli.json'))).toBe(false);
  });

  it('takes the environment for the address and the token, and the flag over it', async () => {
    const home = newHome();
    const env = { CLERQ_GATEWAY_URL: gatewayUrl, CLERQ_GATEWAY_TOKEN: TOKEN };
    const r = await cli(['status', '--json'], { home, env });
    expect(r.code, r.stderr).toBe(0);
    expect(json<Record<string, any>>(r).source).toEqual({ url: 'env', token: 'env' });
    // A wrong address on the flag beats the environment's.
    const down = await cli(['status', '--gateway', 'http://127.0.0.1:9'], { home, env });
    expect(down.code).toBe(3);
  });

  it('logs out: the profile and its token go, a token file stays', async () => {
    const home = await signedIn();
    const r = await cli(['logout'], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Removed profile "default"');
    expect(fs.existsSync(path.join(home, '.clerq', 'cli.json'))).toBe(false);
    const again = await cli(['logout'], { home });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Nothing is stored for profile "default"');
    // With nothing stored and no token anywhere, a command says what to do.
    const s = await cli(['automation', 'list', '--gateway', gatewayUrl], { home });
    expect(s.code).toBe(1);
    expect(s.stderr).toContain('There is no token');
    expect(s.stderr).toContain('clerq login');
  });
});

describe.skipIf(!runnable)('login, more ways', () => {
  it('asks for the token on the terminal without showing it', async () => {
    const home = newHome();
    const stdin = new FakeStdin('', true);
    const c = capture(stdin, true);
    const pending = runCli(['login', gatewayUrl], {
      env: { HOME: home, NO_COLOR: '1' },
      io: c.io,
      home,
      cwd: home,
    });
    await until(async () => (c.stderr().includes('Token for') ? true : undefined));
    expect(stdin.raw).toBe(true);
    stdin.type(`${TOKEN}\r`);
    expect(await pending).toBe(0);
    expect(stdin.raw).toBe(false);
    // What is typed is not echoed, and the saved profile holds it.
    expect(c.stdout() + c.stderr()).not.toContain(TOKEN);
    expect(c.stderr()).toContain(`Token for ${gatewayUrl} (not shown): `);
    expect(
      JSON.parse(fs.readFileSync(path.join(home, '.clerq', 'cli.json'), 'utf8')).profiles.default
        .token
    ).toBe(TOKEN);
  });

  it('refuses to save a token shorter than 16 characters, from any source, before sending it', async () => {
    const home = newHome();
    const short = 'abcdefghijklmno'; // 15
    const stdin = await cli(['login', gatewayUrl, '--token-stdin'], { home, stdin: `${short}\n` });
    expect(stdin.code).toBe(1);
    expect(stdin.stderr).toContain(
      'That token is only 15 characters; a token to save must have at least 16.'
    );
    expect(stdin.stderr).toContain('Nothing was saved.');
    expect(stdin.stdout + stdin.stderr).not.toContain(short);

    const file = path.join(home, 'short-token');
    fs.writeFileSync(file, `${short}\n`);
    const fromFile = await cli(['login', gatewayUrl, '--token-file', file], { home });
    expect(fromFile.code).toBe(1);
    expect(fromFile.stderr).toContain('only 15 characters');

    const typed = new FakeStdin('', true);
    const c = capture(typed, true);
    const pending = runCli(['login', gatewayUrl], {
      env: { HOME: home, NO_COLOR: '1' },
      io: c.io,
      home,
      cwd: home,
    });
    await until(async () => (c.stderr().includes('Token for') ? true : undefined));
    typed.type(`${short}\r`);
    expect(await pending).toBe(1);
    expect(c.stdout() + c.stderr()).not.toContain(short);
    expect(fs.existsSync(path.join(home, '.clerq', 'cli.json'))).toBe(false);

    // Sixteen is enough to be tried (and here refused, since the gateway does not know it).
    const sixteen = await cli(['login', gatewayUrl, '--token-stdin'], {
      home,
      stdin: `${short}p\n`,
    });
    expect(sixteen.stderr).toContain('refused that token');
  });

  it('does not take the token from the environment, and without a terminal says what to do', async () => {
    const home = newHome();
    const r = await cli(['login', gatewayUrl], { home, env: { CLERQ_GATEWAY_TOKEN: TOKEN } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('There is no terminal to ask for the token on. Pass --token-stdin');
    expect(fs.existsSync(path.join(home, '.clerq', 'cli.json'))).toBe(false);
  });

  it('signs in again to a profile’s own address when none is given, replacing the token', async () => {
    const home = await signedIn();
    const wrong = await cli(['login', '--profile', 'default', '--token-stdin'], {
      home,
      stdin: 'some-other-token-0123456789\n',
    });
    expect(wrong.code).toBe(1);
    const again = await cli(['login', '--profile', 'default', '--token-stdin'], {
      home,
      stdin: `${TOKEN}\n`,
    });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`Signed in to ${gatewayUrl}`);
  });

  it('keeps several profiles side by side, and each token goes only to its own address', async () => {
    const home = await signedIn();
    // A second profile for an address that is not up: it must not get the first one's token.
    const stub = http.createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ''));
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/version') {
        res.end(
          JSON.stringify({
            gateway: '0.5.1',
            api: { version: 1, supported: [1] },
            store: { schema: 21 },
          })
        );
      } else res.writeHead(401).end('{"error":"unauthorized"}');
    });
    const seen: string[] = [];
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const other = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      const l = await cli(['login', other, '--profile', 'other', '--token-stdin'], {
        home,
        stdin: 'the-other-gateways-token-01\n',
      });
      expect(l.code).toBe(1); // the stub refuses it
      // --gateway to that address, with the saved default profile: no token of the first goes there.
      seen.length = 0;
      const r = await cli(['approvals', '--gateway', other], { home, env: {} });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('There is no token for');
      expect(seen.join(' ')).not.toContain(TOKEN);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

describe.skipIf(!runnable)('exit codes when the gateway cannot be used', () => {
  it('exits 3 and says why when nothing answers', async () => {
    const home = newHome();
    const r = await cli(['automation', 'list', '--gateway', 'http://127.0.0.1:9'], {
      home,
      env: { CLERQ_GATEWAY_TOKEN: TOKEN },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Cannot reach the gateway at http://127.0.0.1:9');
  });

  it('exits 3 with the plain reason when the gateway speaks another API version', async () => {
    const stub = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/version') {
        res.end(
          JSON.stringify({
            gateway: '9.0.0',
            api: { version: 2, supported: [2] },
            store: { schema: 40 },
          })
        );
      } else res.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      for (const argv of [['automation', 'list'], ['status'], ['approvals']]) {
        const r = await cli([...argv, '--gateway', url], {
          home: newHome(),
          env: { CLERQ_GATEWAY_TOKEN: TOKEN },
        });
        expect(r.code, argv.join(' ')).toBe(3);
        expect(r.stderr, argv.join(' ')).toContain(
          'This gateway speaks API 2; this app needs API 1.'
        );
      }
      // Login stops at the same place, before it asks for a token.
      const l = await cli(['login', url, '--token-stdin'], {
        home: newHome(),
        stdin: `${TOKEN}\n`,
      });
      expect(l.code).toBe(3);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  it('exits 1 when the token is refused, and says how to fix it', async () => {
    const r = await cli(['automation', 'list', '--gateway', gatewayUrl], {
      home: newHome(),
      env: { CLERQ_GATEWAY_TOKEN: 'a-token-the-gateway-has-never-seen' },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused the token');
    expect(r.stderr).toContain('clerq login');
    expect(r.stderr).not.toContain('a-token-the-gateway-has-never-seen');
  });

  it('refuses plain http to another computer, before any request, unless --insecure', async () => {
    const r = await cli(['automation', 'list', '--gateway', 'http://nas.invalid:18790'], {
      home: newHome(),
      env: { CLERQ_GATEWAY_TOKEN: TOKEN },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('plain http to another computer');
    expect(r.stderr).toContain('--insecure');
    // With the flag it tries, and the host does not exist.
    const b = await cli(
      ['automation', 'list', '--gateway', 'http://nas.invalid:18790', '--insecure'],
      {
        home: newHome(),
        env: { CLERQ_GATEWAY_TOKEN: TOKEN },
      }
    );
    expect(b.code).toBe(3);
    // Login refuses before it asks for a token.
    const l = await cli(['login', 'http://nas.invalid:18790', '--token-stdin'], {
      home: newHome(),
      stdin: `${TOKEN}\n`,
    });
    expect(l.code).toBe(1);
    expect(l.stderr).toContain('plain http to another computer');
  });

  it('exits 64 for a mistake in the command line, and sends nothing', async () => {
    const home = newHome();
    for (const argv of [
      ['runn', 'x'],
      ['repo'],
      ['run'],
      ['status', '--nope'],
      ['login', '--token', 'abc'],
    ]) {
      const r = await cli(argv, { home });
      expect(r.code, argv.join(' ')).toBe(64);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^clerq: /);
    }
  });
});

describe.skipIf(!runnable)('repositories', () => {
  it('adds a folder, says so, and returns the same repository the second time', async () => {
    const home = await signedIn();
    const folder = path.join(root, 'shop');
    fs.mkdirSync(folder);
    sh(folder, 'init', '-q', '-b', 'main');

    const first = await cli(['repo', 'add', folder, '--json'], { home });
    expect(first.code, first.stderr).toBe(0);
    const added = json<Record<string, any>>(first);
    expect(added).toMatchObject({
      ok: true,
      kind: 'local',
      name: 'shop',
      created: true,
      path: { value: folder, exists: true, role: 'repository' },
    });
    const human = await cli(['repo', 'add', `local:${folder}`], { home });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(
      `shop (local, id ${added.id}) was already listed; nothing changed.`
    );
  });

  it('turns a relative folder into a full path from where it is run', async () => {
    const home = await signedIn();
    const r = await cli(['repo', 'add', 'app', '--json'], { home, cwd: root });
    expect(r.code, r.stderr).toBe(0);
    expect(json<Record<string, any>>(r).path.value).toBe(repo);
  });

  it('says why a target cannot be added, and exits 1', async () => {
    const home = await signedIn();
    const plain = path.join(root, 'plain-folder');
    fs.mkdirSync(plain);
    const cases: Array<[string, RegExp]> = [
      [path.join(root, 'no-such-folder'), /does not exist/],
      [plain, /not a git work tree/],
      ['github:acme', /not a repository this release can work on/],
      ['https://example.com/acme/app', /not a repository this release can work on/],
      ['git@github.com:acme/app.git', /not a repository this release can work on/],
    ];
    for (const [target, message] of cases) {
      const r = await cli(['repo', 'add', target], { home });
      expect(r.code, target).toBe(1);
      expect(r.stderr, target).toMatch(message);
    }
  });

  it('adds a remote, and with --check reaches it and names its default branch', async () => {
    const home = await signedIn();
    const r = await cli(['repo', 'add', 'github:acme/app', '--check', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const added = json<Record<string, any>>(r);
    expect(added).toMatchObject({
      kind: 'github',
      name: 'acme/app',
      created: true,
      check: {
        reachable: true,
        defaultBranch: 'main',
        credential: { secret: 'GITHUB_TOKEN', present: false },
      },
    });
    const text = await cli(['repo', 'add', 'github:acme/app', '--check'], { home });
    expect(text.stdout).toContain('Reached github.com/acme/app without a credential');
    expect(text.stdout).toContain('Default branch: main.');
  });

  it('adds nothing for a remote that cannot be reached, and exits 1', async () => {
    const home = await signedIn();
    const r = await cli(['repo', 'add', 'github:acme/gone', '--check'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Could not reach github.com/acme/gone');
    expect(r.stderr).toContain('Nothing was added.');
    const list = await cli(['repo', 'list', '--json'], { home });
    const names = json<{ repos: Array<{ name: string }> }>(list).repos.map((x) => x.name);
    expect(names).not.toContain('acme/gone');
  });

  it('lists and shows repositories, by name as well as by id', async () => {
    const home = await signedIn();
    await cli(['repo', 'add', 'github:acme/app'], { home });
    const list = await cli(['repo', 'list'], { home });
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/NAME\s+KIND\s+WHERE\s+AUTOMATIONS\s+RUNS\s+LAST RUN\s+ID/);
    expect(list.stdout).toContain('acme/app');
    expect(list.stdout).toContain('shop');
    const show = await cli(['repo', 'show', 'acme/app'], { home });
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain('acme/app (github)');
    expect(show.stdout).toContain('Reached with  GITHUB_TOKEN (not in the vault)');
    const byUrl = await cli(['repo', 'show', 'github:acme/app', '--json'], { home });
    expect(json<Record<string, any>>(byUrl).name).toBe('acme/app');
    const missing = await cli(['repo', 'show', 'acme/nothing'], { home });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No repository "acme/nothing"');
  });
});

describe.skipIf(!runnable)('automation apply', () => {
  it('creates a switched-off automation, then finds it unchanged, then updates it', async () => {
    const home = await signedIn();
    const file = specFile(home, 'applied', spec('applied'));

    const created = await cli(['automation', 'apply', '-f', file], { home });
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toMatch(/Created applied \(aut_[0-9a-f-]+\)\./);
    expect(created.stdout).toContain('applied is switched off.');
    const listed = await cli(['automation', 'list', '--json'], { home });
    const row = json<{ automations: Array<{ name: string; enabled: boolean }> }>(
      listed
    ).automations.find((a) => a.name === 'applied');
    expect(row?.enabled).toBe(false);

    const same = await cli(['automation', 'apply', '-f', file, '--json'], { home });
    expect(same.code).toBe(0);
    expect(json<Record<string, any>>(same)).toMatchObject({
      ok: true,
      action: 'unchanged',
      name: 'applied',
      enabled: false,
    });

    // Line endings and a trailing blank line are not a change.
    fs.writeFileSync(file, `${spec('applied').replace(/\n/g, '\r\n')}\r\n\r\n`);
    const crlf = await cli(['automation', 'apply', '-f', file, '--json'], { home });
    expect(json<Record<string, any>>(crlf).action).toBe('unchanged');

    fs.writeFileSync(
      file,
      `${spec('applied').replace('Add a CHANGED.md file.', 'Add a CHANGED.md file, please.')}\n`
    );
    const updated = await cli(['automation', 'apply', '-f', file], { home });
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stdout).toContain('Updated applied');
    const shown = await cli(['automation', 'show', 'applied', '--source'], { home });
    expect(shown.stdout).toContain('Add a CHANGED.md file, please.');
  });

  it('prints an error with its line and column, exits 1, and saves nothing', async () => {
    const home = await signedIn();
    const text = spec('badly', 'on:\n  schedule: nope');
    const file = specFile(home, 'bad', text);
    const line = text.split('\n').findIndex((l) => l.includes('schedule: nope')) + 1;
    const r = await cli(['automation', 'apply', '-f', file], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${file}:${line}:`);
    expect(r.stderr).toContain('"nope" is not a valid cron expression.');
    const listed = await cli(['automation', 'list', '--json'], { home });
    expect(
      json<{ automations: Array<{ name: string }> }>(listed).automations.map((a) => a.name)
    ).not.toContain('badly');

    const data = await cli(['automation', 'apply', '-f', file, '--json'], { home });
    expect(data.code).toBe(1);
    expect(json<Record<string, any>>(data)).toMatchObject({
      ok: false,
      errors: [{ line, message: '"nope" is not a valid cron expression.' }],
    });
  });

  it('prints an error the check found on this machine, and a warning, without a line', async () => {
    const home = await signedIn();
    const missing = path.join(root, 'no-such-repo');
    const file = specFile(home, 'norepo', spec('norepo', '', missing));
    const r = await cli(['automation', 'apply', '-f', file], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${file}: ${missing} does not exist.`);
    // The native profile is warned about, whatever else is wrong.
    expect(r.stderr).toContain('Warning:');
    expect(r.stderr).toContain('without isolation');
    expect(r.stdout).toBe('');
  });

  it('with --dry-run says what it would do and does nothing', async () => {
    const home = await signedIn();
    const file = specFile(home, 'dry', spec('dry-one'));
    const r = await cli(['automation', 'apply', '-f', file, '--dry-run', '--enable'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Would create dry-one.');
    expect(r.stdout).toContain('Would switch on dry-one.');
    expect(r.stdout).toContain('Dry run: nothing was changed.');
    const listed = await cli(['automation', 'list', '--json'], { home });
    expect(
      json<{ automations: Array<{ name: string }> }>(listed).automations.map((a) => a.name)
    ).not.toContain('dry-one');
  });

  it('with --enable switches it on, also when it already exists, and enable/disable do the same', async () => {
    const home = await signedIn();
    const file = specFile(home, 'enabled', spec('enabled-one'));
    const first = await cli(['automation', 'apply', '-f', file, '--enable', '--json'], { home });
    expect(json<Record<string, any>>(first)).toMatchObject({
      action: 'created',
      enabled: true,
      switchedOn: true,
    });
    const again = await cli(['automation', 'apply', '-f', file, '--enable', '--json'], { home });
    expect(json<Record<string, any>>(again)).toMatchObject({
      action: 'unchanged',
      enabled: true,
      switchedOn: false,
    });

    const off = await cli(['automation', 'disable', 'enabled-one'], { home });
    expect(off.stdout).toContain('Switched off enabled-one.');
    const offAgain = await cli(['automation', 'disable', 'enabled-one'], { home });
    expect(offAgain.stdout).toContain('already switched off');
    const on = await cli(['automation', 'apply', '-f', file, '--enable'], { home });
    expect(on.stdout).toContain('Unchanged: enabled-one already has this spec.');
    expect(on.stdout).toContain('Switched on enabled-one.');
    await cli(['automation', 'disable', 'enabled-one'], { home });
    const direct = await cli(['automation', 'enable', 'enabled-one'], { home });
    expect(direct.stdout).toContain('Switched on enabled-one.');
    await cli(['automation', 'disable', 'enabled-one'], { home });
  });

  it('reads the spec from standard input with -f -, and needs -f', async () => {
    const home = await signedIn();
    const r = await cli(['automation', 'apply', '-f', '-'], { home, stdin: spec('from-stdin') });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Created from-stdin');
    const none = await cli(['automation', 'apply'], { home });
    expect(none.code).toBe(64);
    expect(none.stderr).toContain('needs -f <file>');
    const gone = await cli(['automation', 'apply', '-f', path.join(home, 'nothing.yaml')], {
      home,
    });
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain('no such file');
  });

  it('shows and lists, and says which names exist for one that does not', async () => {
    const home = await signedIn();
    const show = await cli(['automation', 'show', 'applied'], { home });
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain('applied  switched off');
    expect(show.stdout).toContain('The spec as saved: clerq automation show applied --source');
    const list = await cli(['automation', 'list'], { home });
    expect(list.stdout).toMatch(/NAME\s+STATE\s+SCHEDULE\s+AGENT\s+REPOSITORY\s+LAST RUN/);
    expect(list.stdout).toContain('applied');
    const none = await cli(['automation', 'show', 'nope'], { home });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('No automation named "nope". The ones that exist:');
    expect(none.stderr).toContain('applied');
  });
});

describe.skipIf(!runnable)('run and logs', () => {
  it('runs an automation and follows it to success', async () => {
    mode = 'edit';
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'first', spec('first-run'))], { home });
    const r = await cli(['run', 'first-run', '--follow'], { home });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/Started run run_[0-9a-f-]+ of first-run\./);
    expect(r.stdout).toContain('Gate: test -f CHANGED.md');
    expect(r.stdout).toMatch(/Write {2}CHANGED\.md {2}\[done\]/);
    expect(r.stdout).toContain('(1000 tokens in, 200 out, $0.25)');
    expect(r.stdout).toContain('Run succeeded.');
    expect(r.stdout).toContain('Committed to the local branch');
    expect(r.stdout).toContain('Cost: $0.25');
    // Each line that tells what happened starts with the time it did.
    expect(r.stdout).toMatch(/^\d{2}:\d{2}:\d{2} {2}\S/m);
    // Plain words, no escape codes, in a pipe.
    expect(r.stdout).not.toContain('\u001b');
  });

  it('without --follow prints the run and how to watch it; logs shows it afterwards', async () => {
    mode = 'edit';
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'second', spec('second-run'))], {
      home,
    });
    const started = await cli(['run', 'second-run', '--json'], { home });
    expect(started.code, started.stderr).toBe(0);
    const { runId, queued, automation } = json<Record<string, any>>(started);
    expect(runId).toMatch(/^run_/);
    expect(queued).toBe(false);
    expect(automation.name).toBe('second-run');

    // Watching a run that is already under way (or done) ends when it does.
    const watched = await cli(['logs', runId, '--follow'], { home });
    expect(watched.code, watched.stderr + watched.stdout).toBe(0);
    expect(watched.stdout).toContain(`Run ${runId} of second-run:`);
    expect(watched.stdout).toContain('Run succeeded.');

    const logs = await cli(['logs', runId], { home });
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain(`Run ${runId} of second-run: succeeded`);
    expect(logs.stdout).toMatch(/Started +\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(by hand\)/);
    expect(logs.stdout).toMatch(/Branch +auto\/second-run\//);
    expect(logs.stdout).toContain('Updating the changelog.');
    expect(logs.stdout).toContain('Gate: test -f CHANGED.md');
    expect(logs.stdout).toContain('Write  CHANGED.md  [done]');
    // The tool call is one line: the step that records it is not printed again.
    expect(logs.stdout.match(/CHANGED\.md/g)?.length).toBe(2);

    // The latest run of an automation, by its name.
    const latest = await cli(['logs', 'second-run'], { home });
    expect(latest.stdout).toContain(`Run ${runId} of second-run`);

    const data = await cli(['logs', runId, '--json'], { home });
    const run = json<{ type: string; run: Record<string, any> }>(data);
    expect(run.type).toBe('run');
    expect(run.run).toMatchObject({ id: runId, status: 'done' });
    expect(run.run.steps.length).toBeGreaterThan(3);
    expect(run.run.toolCalls).toHaveLength(1);
  });

  it('streams one JSON object per line under --follow --json, ending with the result', async () => {
    mode = 'edit';
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'third', spec('third-run'))], { home });
    const r = await cli(['run', 'third-run', '--follow', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const all = lines(r);
    expect(all[0]).toMatchObject({ type: 'started', automation: { name: 'third-run' } });
    const types = all.map((l) => l.type);
    expect(types).toContain('step');
    expect(types).toContain('tool');
    expect(types).toContain('finished');
    expect(all[all.length - 1]).toMatchObject({
      type: 'result',
      status: 'done',
      exitCode: 0,
      costUsd: 0.25,
    });
    // Messages stay off stdout.
    expect(r.stdout).not.toContain('Started run');
  });

  it('exits 1 when the run fails, and says why', async () => {
    mode = 'fail';
    try {
      const home = await signedIn();
      await cli(['automation', 'apply', '-f', specFile(home, 'failing', spec('failing-run'))], {
        home,
      });
      const r = await cli(['run', 'failing-run', '--follow'], { home });
      expect(r.code, r.stdout).toBe(1);
      expect(r.stdout).toContain('Run failed.');
      expect(r.stderr).toBe('');
    } finally {
      mode = 'edit';
    }
  });

  it('says once that a chosen model is used as chosen, and the run records it', async () => {
    mode = 'edit';
    agentModels = [];
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'chosen', spec('chosen-run'))], {
      home,
    });
    const r = await cli(['run', 'chosen-run', '--model', 'claude-test-model', '-f'], { home });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const note =
      'Model claude-test-model is used as chosen: if it is unavailable the run fails; it does not fall back to another model.';
    expect(r.stdout.split(note)).toHaveLength(2);
    expect(agentModels).toContain('claude-test-model');
    const logs = await cli(['logs', 'chosen-run'], { home });
    expect(logs.stdout).toContain(
      'Model    claude-test-model, chosen for this run: used as chosen, with no fallback'
    );
    const bad = await cli(['run', 'chosen-run', '--stop-at-approval'], { home });
    expect(bad.code).toBe(64);
  });

  it('refuses to start what is not there, and a run that does not exist', async () => {
    const home = await signedIn();
    const r = await cli(['run', 'no-such-automation'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No automation named "no-such-automation"');
    const l = await cli(['logs', 'run_00000000-0000-0000-0000-000000000000'], { home });
    expect(l.code).toBe(1);
    expect(l.stderr).toContain('There is no run');
  });
});

describe.skipIf(!runnable)('approvals', () => {
  it('stops at an approval with exit 2, lists it, approves it, and the run finishes', async () => {
    mode = 'edit';
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'pushing', pushing('pushing-one'))], {
      home,
    });
    const r = await cli(['run', 'pushing-one', '--follow', '--stop-at-approval'], { home });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    const asked = /Waiting for approval (\d+): Push \(git\.push\)/.exec(r.stdout);
    expect(asked, r.stdout).not.toBeNull();
    const id = asked?.[1] as string;
    expect(r.stdout).toContain(`Approve: clerq approve ${id}    Deny: clerq deny ${id}`);
    const runId = /Started run (run_[0-9a-f-]+)/.exec(r.stdout)?.[1] as string;

    const list = await cli(['approvals'], { home });
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/ID\s+FROM\s+TOOL\s+WHY\s+ASKED/);
    expect(list.stdout).toContain(`Run ${runId} of pushing-one`);
    expect(list.stdout).toContain('Push (git.push)');
    const data = await cli(['approvals', '--json'], { home });
    expect(json<{ approvals: Array<Record<string, any>> }>(data).approvals[0]).toMatchObject({
      id: Number(id),
      runId,
      tool: 'git.push',
      from: `Run ${runId} of pushing-one`,
    });

    const approved = await cli(['approve', id], { home });
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.stdout).toContain(`Approved ${id}.`);
    const done = await cli(['logs', runId, '--follow'], { home });
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toContain('Run succeeded.');
    expect(done.stdout).toMatch(/Published: .*auto\/pushing-one/);
    expect(sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toContain(
      'auto/pushing-one/'
    );

    // Deciding again says it is no longer waiting.
    const twice = await cli(['approve', id], { home });
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain(`Approval ${id} is not waiting for an answer`);
    const empty = await cli(['approvals'], { home });
    expect(empty.stdout).toContain('Nothing is waiting for an answer.');
  });

  it('keeps waiting through an approval with --follow, prints how to answer it, and ends when the run does', async () => {
    mode = 'edit';
    const home = await signedIn();
    const other = await signedIn();
    await cli(
      ['automation', 'apply', '-f', specFile(home, 'waiting', pushing('waiting-one')), '--enable'],
      { home }
    );
    // First pushes always wait for a person, whatever the spec says.
    const following = cli(['run', 'waiting-one', '--follow'], { home, pollMs: 200 });
    const id = await until(async () => {
      const a = json<{ approvals: Array<{ id: number }> }>(
        await cli(['approvals', '--json'], { home: other })
      ).approvals;
      return a[0]?.id;
    });
    // It is still going while it waits.
    await new Promise((r) => setTimeout(r, 300));
    const approved = await cli(['approve', String(id)], { home: other });
    expect(approved.code, approved.stderr).toBe(0);
    const r = await following;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.match(new RegExp(`Waiting for approval ${id}:`, 'g'))).toHaveLength(1);
    expect(r.stdout).toContain(`Approve: clerq approve ${id}`);
    expect(r.stdout).toContain('Run succeeded.');
    await cli(['automation', 'disable', 'waiting-one'], { home });
  });

  it('stops watching on Ctrl-C with exit 130, and the run carries on', async () => {
    mode = 'edit';
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'watched', pushing('watched-one'))], {
      home,
    });
    const stop = new AbortController();
    const following = cli(['run', 'watched-one', '--follow'], {
      home,
      signal: stop.signal,
      pollMs: 200,
    });
    const id = await until(async () => {
      const a = json<{ approvals: Array<{ id: number; runId: string }> }>(
        await cli(['approvals', '--json'], { home })
      ).approvals;
      return a.find((x) => x.runId && x.id)?.id;
    });
    stop.abort();
    const r = await following;
    expect(r.code).toBe(130);
    expect(r.stdout).toContain(
      'Stopped watching. The run goes on. Watch it again: clerq logs run_'
    );
    // It is still waiting; answering it finishes it.
    expect((await cli(['approve', String(id)], { home })).code).toBe(0);
    const runId = /Started run (run_[0-9a-f-]+)/.exec(r.stdout)?.[1] as string;
    expect((await cli(['logs', runId, '--follow'], { home })).code).toBe(0);
  });

  it('denies with a reason, and the run does not publish', async () => {
    mode = 'edit';
    const home = await signedIn();
    await cli(['automation', 'apply', '-f', specFile(home, 'denied', pushing('denied-one'))], {
      home,
    });
    const started = await cli(['run', 'denied-one', '--follow', '--stop-at-approval', '--json'], {
      home,
    });
    expect(started.code).toBe(2);
    const approval = lines(started).find((l) => l.type === 'approval') as {
      approval: { id: number };
    };
    const runId = lines(started)[0].runId as string;

    const denied = await cli(
      ['deny', String(approval.approval.id), '--reason', 'Not on a Friday'],
      { home }
    );
    expect(denied.code, denied.stderr).toBe(0);
    expect(denied.stdout).toContain(`Denied ${approval.approval.id}.`);
    const done = await cli(['logs', runId, '--follow'], { home });
    expect(done.code, done.stdout).toBe(1);
    expect(done.stdout).toMatch(/Run (failed|cancelled)\./);
    expect(sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).not.toContain(
      'denied-one'
    );
    const bad = await cli(['deny', 'seven'], { home });
    expect(bad.code).toBe(64);
  });
});
