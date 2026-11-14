/**
 * POST /repos through the gateway's HTTP API: who may call it, a local
 * repository, a remote with and without `check`, adding twice, bad targets, and
 * no token anywhere in an answer.
 *
 * The remotes are github.com URLs that git rewrites (a throwaway global config,
 * `url.<base>.insteadOf`) to a bare repository on disk, or to a local HTTP server
 * that answers 401, so nothing leaves the machine. The credential hook is a fake
 * that records what it was asked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway.js';
import { issueToken } from '../security/scoped-tokens.js';
import { getStore } from '../store.js';
import { pauseAutomationQueue } from './queue.js';
import type { CredentialRequest, ForgeCredential } from './credentials.js';
import { parseSpec } from './spec.js';
import { ensureRepoRow } from './store.js';

const TOKEN = 'repos-add-test-token-0123456789';
/** What the forge credential hook hands out: it must never appear in an answer. */
const FORGE_TOKEN = 'ghp_forge-token-that-must-stay-out-of-answers';

let root: string;
let baseUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
let authServer: http.Server;
let authPort: number;
/** Accepts a connection and never answers, as a forge that has stalled. */
let silentServer: net.Server;
let silentPort: number;
const silentSockets: net.Socket[] = [];
const savedEnv: Record<string, string | undefined> = {};

/** What the hook was asked, and what it answers. */
let asked: CredentialRequest[] = [];
let hookAnswer: ForgeCredential | undefined;
let hookError: Error | undefined;
const vault = new Set<string>(['GITHUB_TOKEN']);

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });

const add = (body: unknown) => api('/repos', { method: 'POST', body: JSON.stringify(body) });

interface Added {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  path: { value: string; exists: boolean; role: string } | null;
  credential: { secret: string; present: boolean } | null;
  created: boolean;
  check?: {
    reachable: boolean;
    message: string;
    defaultBranch?: string;
    credential: { secret: string; present: boolean; source?: string };
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

function makeRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const rows = () =>
  getStore().prepare('SELECT id, kind, url, local_path, credential_ref FROM repos').all();

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-repos-add-')));
  for (const name of ['CLERQ_KEYCHAIN', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    savedEnv[name] = process.env[name];
  }
  process.env.CLERQ_KEYCHAIN = 'off';

  // A server that wants a login for everything, as GitHub does for a private repository.
  authServer = http.createServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forge"' });
    res.end();
  });
  await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  authPort = (authServer.address() as AddressInfo).port;

  silentServer = net.createServer((socket) => {
    silentSockets.push(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
  silentPort = (silentServer.address() as AddressInfo).port;

  // A bare repository with a commit on main, standing in for acme/app.
  const seed = makeRepo(path.join(root, 'seed'));
  const bare = path.join(root, 'acme-app.git');
  sh(root, 'clone', '-q', '--bare', seed, bare);
  sh(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  // git rewrites these GitHub URLs; the global config is only for this test.
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(
    gitConfig,
    [
      `[url "${bare}"]`,
      '\tinsteadOf = https://github.com/acme/app.git',
      // Not a repository, and the path carries the token, as a git error message could.
      `[url "${path.join(root, 'nowhere', FORGE_TOKEN)}"]`,
      '\tinsteadOf = https://github.com/acme/gone.git',
      `[url "http://127.0.0.1:${authPort}/private.git"]`,
      '\tinsteadOf = https://github.com/acme/private.git',
      `[url "http://127.0.0.1:${silentPort}/stalled.git"]`,
      '\tinsteadOf = https://github.com/acme/stalled.git',
      '',
    ].join('\n')
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    automations: {
      getSecret: (name) => (vault.has(name) ? FORGE_TOKEN : undefined),
      secretNames: () => [...vault],
      forgeCredentials: (request) => {
        asked.push(request);
        if (hookError) throw hookError;
        return hookAnswer;
      },
      workspaceCacheDir: path.join(root, 'cache'),
      path: () => process.env.PATH ?? '',
      // A stalled forge must not hold a request for the real 20 s.
      repoCheckTimeoutMs: 1500,
    },
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 50; i++) {
    if ((await api('/automations')).status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  pauseAutomationQueue();
}, 20_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => authServer.close(() => resolve()));
  silentSockets.forEach((s) => s.destroy());
  await new Promise<void>((resolve) => silentServer.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  asked = [];
  hookError = undefined;
  hookAnswer = { token: FORGE_TOKEN, source: 'vault:GITHUB_TOKEN' };
});

describe('who may add a repository', () => {
  it('refuses a request without a token, or with a wrong one', async () => {
    const body = JSON.stringify({ target: 'github:acme/app' });
    expect((await fetch(`${baseUrl}/repos`, { method: 'POST', body })).status).toBe(401);
    const wrong = await fetch(`${baseUrl}/repos`, {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
    });
    expect(wrong.status).toBe(401);
    expect(rows()).toHaveLength(0);
  });

  it('refuses a scoped token whose scopes do not name it', async () => {
    const { token } = issueToken({
      kind: 'device',
      subject: 'dev_1',
      scopes: ['GET /repos', 'GET /runs'],
      ttlMs: 60_000,
    });
    const res = await fetch(`${baseUrl}/repos`, {
      method: 'POST',
      body: JSON.stringify({ target: 'github:acme/app' }),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it('answers under /v1 as well', async () => {
    const res = await api('/v1/repos', {
      method: 'POST',
      body: JSON.stringify({ target: 'not a target' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('clerq-api-version')).toBe('1');
  });
});

describe('a local repository', () => {
  it('adds a git work tree, and adding it again returns the same row', async () => {
    const dir = makeRepo(path.join(root, 'shop'));
    const first = await add({ target: `local:${dir}` });
    expect(first.status).toBe(201);
    const a = (await first.json()) as Added;
    expect(a).toMatchObject({
      kind: 'local',
      name: 'shop',
      url: null,
      path: { value: dir, exists: true, role: 'repository' },
      credential: null,
      created: true,
    });
    expect(a.check).toBeUndefined();

    const second = await add({ target: `local:${dir}` });
    expect(second.status).toBe(200);
    const b = (await second.json()) as Added;
    expect(b).toMatchObject({ id: a.id, created: false });
    expect(rows().filter((r) => r.local_path === dir)).toHaveLength(1);

    // GET /repos lists it.
    const listed = (await (await api('/repos')).json()) as { repos: Array<{ id: string }> };
    expect(listed.repos.map((r) => r.id)).toContain(a.id);
  });

  it('makes the row an automation naming the same path would find', async () => {
    const dir = makeRepo(path.join(root, 'same-key'));
    const { id } = (await (await add({ target: `local:${dir}` })).json()) as Added;
    const spec = parseSpec(
      [
        'name: same-key',
        'targets:',
        `  repos: [local:${dir}]`,
        'agent:',
        '  driver: claude-code',
        'prompt: Keep it tidy.',
      ].join('\n')
    );
    expect(ensureRepoRow(spec)).toBe(id);
  });

  it('expands ~ and ignores a #branch, which belongs to the automation', async () => {
    // ~ is this account's home: point it at a folder of the test's own.
    const home = path.join(root, 'home');
    const dir = makeRepo(path.join(home, 'code', 'app'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const res = await add({ target: 'local:~/code/app#develop' });
      expect(res.status).toBe(201);
      expect(((await res.json()) as Added).path?.value).toBe(dir);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it('refuses a path that does not exist, a folder that is not a repository, and a subfolder', async () => {
    const missing = path.join(root, 'no-such-folder');
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const repo = makeRepo(path.join(root, 'with-sub'));
    fs.mkdirSync(path.join(repo, 'src'));
    const file = path.join(root, 'a-file.txt');
    fs.writeFileSync(file, 'x');

    const before = rows().length;
    const cases: Array<[string, number, string, RegExp]> = [
      [`local:${missing}`, 400, 'repo_path_missing', /does not exist/],
      [`local:${plain}`, 400, 'not_a_repository', /not a git work tree/],
      [`local:${file}`, 400, 'not_a_repository', /not a folder/],
      [`local:${path.join(repo, 'src')}`, 400, 'not_a_repository', /inside the git repository at/],
      ['local:relative/path', 400, 'invalid_target', /not a full path/],
      ['local:', 400, 'invalid_target', /needs a path/],
    ];
    for (const [target, status, error, message] of cases) {
      const res = await add({ target });
      expect(res.status, target).toBe(status);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error, target).toBe(error);
      expect(body.message, target).toMatch(message);
    }
    expect(rows()).toHaveLength(before);
  });

  it('says so when git will not use a folder because another user owns it', async () => {
    const dir = makeRepo(path.join(root, 'not-mine'));
    // git's own switch for pretending the folder belongs to someone else.
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      const res = await add({ target: `local:${dir}` });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('not_a_repository');
      expect(body.message).toContain('belongs to another user');
      expect(body.message).toContain(`git config --global --add safe.directory ${dir}`);
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    }
    expect(rows().some((r) => r.local_path === dir)).toBe(false);
  });

  it('refuses a bare repository, which has no work tree', async () => {
    const bare = path.join(root, 'just-bare.git');
    sh(root, 'init', '-q', '--bare', bare);
    const res = await add({ target: `local:${bare}` });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('not_a_repository');
  });

  it('does not look for a credential, whatever check says', async () => {
    const dir = makeRepo(path.join(root, 'no-check'));
    const res = await add({ target: `local:${dir}`, check: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Added).check).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('bad targets', () => {
  it('says what is wrong in the words the spec uses', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /A repository is a string/],
      [42, /A repository is a string/],
      ['', /A repository is a string/],
      ['github:acme', /not a repository this release can work on/],
      ['https://example.com/acme/app', /not a repository this release can work on/],
      ['ftp://github.com/acme/app', /not a repository this release can work on/],
      ['github:acme/app#a#b', /at most one #branch/],
      ['github:acme/app#../x', /not a branch name/],
    ];
    const before = rows().length;
    for (const [target, message] of cases) {
      const res = await add({ target });
      expect(res.status, String(target)).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_target');
      expect(body.message, String(target)).toMatch(message);
    }
    expect(rows()).toHaveLength(before);
  });

  it('refuses a check that is not true or false', async () => {
    const res = await add({ target: 'github:acme/app', check: 'yes' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_check');
  });
});

describe('a remote repository', () => {
  it('adds it by URL with the forge’s default secret, and returns the row when added again', async () => {
    const first = await add({ target: 'github:acme/widgets' });
    expect(first.status).toBe(201);
    const a = (await first.json()) as Added;
    expect(a).toMatchObject({
      kind: 'github',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets.git',
      path: null,
      credential: { secret: 'GITHUB_TOKEN', present: true },
      created: true,
    });
    // No check was asked for: nothing was reached and no credential was looked up.
    expect(a.check).toBeUndefined();
    expect(asked).toEqual([]);

    // Another spelling of the same repository finds the row.
    const again = await add({ target: 'https://github.com/acme/widgets.git/' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Added).id).toBe(a.id);
    expect(rows().filter((r) => r.url === 'https://github.com/acme/widgets.git')).toHaveLength(1);
  });

  it('uses GITLAB_TOKEN for gitlab, and says the vault does not hold it', async () => {
    const res = await add({ target: 'gitlab:lab/sub/tools' });
    expect(res.status).toBe(201);
    expect((await res.json()) as Added).toMatchObject({
      kind: 'gitlab',
      name: 'lab/sub/tools',
      credential: { secret: 'GITLAB_TOKEN', present: false },
    });
  });

  it('keeps the secret an automation chose when the same repository is added by hand', async () => {
    const spec = parseSpec(
      [
        'name: acme-owned',
        'targets:',
        '  repos: [github:acme/owned]',
        'agent:',
        '  driver: claude-code',
        'prompt: Keep it tidy.',
        'publish:',
        '  token_secret: ACME_TOKEN',
      ].join('\n')
    );
    const id = ensureRepoRow(spec);
    const res = await add({ target: 'github:acme/owned' });
    expect(res.status).toBe(200);
    expect((await res.json()) as Added).toMatchObject({
      id,
      created: false,
      credential: { secret: 'ACME_TOKEN', present: false },
    });
    const row = rows().find((r) => r.id === id);
    expect(row?.credential_ref).toBe('ACME_TOKEN');
  });

  it('records who added it, once', async () => {
    const audits = getStore()
      .prepare("SELECT subject, detail FROM audit_log WHERE action = 'repo.added'")
      .all();
    const widgets = rows().find((r) => r.url === 'https://github.com/acme/widgets.git');
    const mine = audits.filter((a) => a.subject === widgets?.id);
    expect(mine).toHaveLength(1);
    expect(JSON.parse(String(mine[0].detail))).toEqual({
      target: 'https://github.com/acme/widgets.git',
    });
  });
});

describe('check: true on a remote', () => {
  it('reaches it through the credential hook, reports the default branch, and never says the token', async () => {
    const res = await add({ target: 'github:acme/app', check: true });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(FORGE_TOKEN);
    const body = JSON.parse(text) as Added;
    expect(body.created).toBe(true);
    expect(body.check).toMatchObject({
      reachable: true,
      defaultBranch: 'main',
      credential: { secret: 'GITHUB_TOKEN', present: true, source: 'vault:GITHUB_TOKEN' },
    });
    expect(body.check?.message).toContain('github.com/acme/app');
    expect(asked).toEqual([
      {
        forge: 'github',
        project: 'acme/app',
        purpose: 'fetch',
        secretName: 'GITHUB_TOKEN',
        automationId: '',
        runId: '',
      },
    ]);
  });

  it('reaches a public repository when the hook has no credential', async () => {
    hookAnswer = undefined;
    const res = await add({ target: 'github:acme/app', check: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Added;
    expect(body.created).toBe(false);
    expect(body.check).toMatchObject({
      reachable: true,
      credential: { secret: 'GITHUB_TOKEN', present: false },
    });
    expect(body.check?.message).toContain('without a credential');
  });

  it('stores nothing for a remote it cannot reach, and takes the token out of git’s own words', async () => {
    const before = rows().length;
    const res = await add({ target: 'github:acme/gone', check: true });
    expect(res.status).toBe(422);
    const text = await res.text();
    // The failed path in git's message contains the token; the answer must not.
    expect(text).not.toContain(FORGE_TOKEN);
    const body = JSON.parse(text) as {
      error: string;
      message: string;
      check: { reachable: boolean };
    };
    expect(body.error).toBe('repo_unreachable');
    expect(body.message).toContain('Could not reach github.com/acme/gone');
    expect(body.message).toContain('***');
    expect(body.check.reachable).toBe(false);
    expect(rows()).toHaveLength(before);
  });

  it('says a refused login in words, with and without a credential', async () => {
    const withToken = await add({ target: 'github:acme/private', check: true });
    expect(withToken.status).toBe(422);
    const a = (await withToken.json()) as { message: string };
    expect(a.message).toContain('refused GITHUB_TOKEN');

    hookAnswer = undefined;
    const without = await add({ target: 'github:acme/private', check: true });
    expect(without.status).toBe(422);
    const b = (await without.json()) as { message: string };
    expect(b.message).toContain('There is no GITHUB_TOKEN in the vault');
    expect(rows().some((r) => String(r.url).includes('acme/private'))).toBe(false);
  });

  it('keeps a row that already exists when the check fails, and says so', async () => {
    const first = await add({ target: 'github:acme/private' });
    expect(first.status).toBe(201);
    const id = ((await first.json()) as Added).id;
    const res = await add({ target: 'github:acme/private', check: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Added;
    expect(body).toMatchObject({ id, created: false });
    expect(body.check?.reachable).toBe(false);
  });

  it('answers a forge that never answers within the timeout, and leaves no git process behind', async () => {
    const before = rows().length;
    const started = Date.now();
    const res = await add({ target: 'github:acme/stalled', check: true });
    expect(Date.now() - started).toBeLessThan(1500 + 2000);
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain(FORGE_TOKEN);
    const body = JSON.parse(text) as {
      error: string;
      message: string;
      check: { reachable: boolean };
    };
    expect(body.error).toBe('repo_unreachable');
    expect(body.message).toContain('github.com/acme/stalled did not answer within 1.5 seconds.');
    expect(body.check.reachable).toBe(false);
    expect(rows()).toHaveLength(before);
    // git-remote-http was started for it, with the stalled listener's port on its command line.
    if (process.platform !== 'win32') {
      for (let i = 0; i < 40; i++) {
        const ps = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
        if (!ps.includes(`127.0.0.1:${silentPort}`)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const ps = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
      expect(ps.split('\n').filter((l) => l.includes(`127.0.0.1:${silentPort}`))).toEqual([]);
    }
  });

  it('reports a credential hook that throws as unreachable, never as a 500, and with no token', async () => {
    hookError = new Error('the app is not installed on acme/hooked');
    const res = await add({ target: 'github:acme/hooked', check: true });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('repo_unreachable');
    expect(body.message).toBe(
      'Could not look up the credential GITHUB_TOKEN: the app is not installed on acme/hooked'
    );
    expect(rows().some((r) => String(r.url).includes('acme/hooked'))).toBe(false);
  });
});
