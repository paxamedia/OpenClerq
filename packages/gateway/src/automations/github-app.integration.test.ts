/**
 * Runs with the user's GitHub App, end to end through the gateway's HTTP API.
 *
 * GitHub's API is a fake server on 127.0.0.1 (`github/fake-github.ts`) that the
 * gateway reaches through `CLERQ_GITHUB_API`; the app is connected with the real
 * import route and the real vault (HOME is a temporary directory). The remote
 * repository is a GitHub URL that git rewrites to a bare repository on disk, as
 * in the other remote-repository tests. A `git` placed first on PATH records the
 * header each git command that carries a credential was given, which shows
 * which token reached git.
 *
 * No request leaves the machine.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Driver, DriverAvailability, DriverEvent, DriverRunInput } from '@clerq/drivers';
import { createGateway } from '../gateway.js';
import { FakeGithub, type FakeToken } from '../github/fake-github.js';
import { getStore } from '../store.js';

const TOKEN = 'github-app-run-test-token-0123456789';
const VAULT_PAT = 'ghp_vault_personal_token_for_run_tests';
const PAT_LOGIN = 'acme-user';
/** GitHub's website, for the gateway and the fake. */
const WEB = 'http://github.test';

type Mode = 'edit' | 'fail' | 'slow' | 'leak';
let mode: Mode = 'edit';
let agentCalls = 0;
let lastAgentInput: DriverRunInput | undefined;

let root: string;
let bare: string;
let log: string;
let baseUrl: string;
let fake: FakeGithub;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
let secrets: Record<string, string> = {};
const saved: Record<string, string | undefined> = {};
const ENV = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'CLERQ_KEYCHAIN',
  'CLERQ_GITHUB_API',
  'CLERQ_GITHUB_WEB',
  'GIT_SHIM_LOG',
  'REAL_GIT',
];

/** The token strings a predictable fake hands out, and the Basic forms git would send. */
const LEAKS = ['fetch', 'push', 'pr'].flatMap((purpose) => {
  const token = `ghs_predictable_${purpose}_1`;
  return [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
});

function scripted(): Driver {
  return {
    id: 'claude-code',
    async detect(): Promise<DriverAvailability> {
      return { id: 'claude-code', available: true, version: 'test', path: '/fake/claude' };
    },
    run: (input) => runScripted(input),
  };
}

async function* runScripted(input: DriverRunInput): AsyncIterable<DriverEvent> {
  agentCalls += 1;
  lastAgentInput = input;
  input.onSpawn?.({ pid: process.pid, pgid: process.pid, command: '/fake/claude' });
  yield { type: 'started', model: 'fake-model' };
  if (mode === 'leak') {
    yield { type: 'text', text: `The token is ${LEAKS[2]} and ${LEAKS[3]}.` };
    yield { type: 'tool_call', id: 't0', name: 'Bash', input: { command: `echo ${LEAKS[0]}` } };
    yield { type: 'tool_result', id: 't0', output: `${LEAKS[0]}\n${LEAKS[1]}`, isError: false };
    fs.writeFileSync(path.join(input.cwd, 'LEAK.md'), `${LEAKS.join('\n')}\n`);
  }
  if (mode === 'slow') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 20_000);
      input.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (mode !== 'fail') {
    fs.writeFileSync(path.join(input.cwd, 'CHANGED.md'), `changed by run ${agentCalls}\n`);
  }
  const cancelled = input.signal?.aborted ?? false;
  yield {
    type: 'finished',
    result: {
      ok: mode !== 'fail' && !cancelled,
      summary:
        mode === 'leak'
          ? `Done. Used ${LEAKS.join(' and ')} to push.`
          : mode === 'fail'
            ? 'The agent gave up.'
            : 'Added CHANGED.md',
      costUsd: 0.1,
      tokensIn: 100,
      tokensOut: 20,
      durationMs: 5,
      exitCode: mode === 'fail' ? 1 : 0,
      timedOut: false,
      cancelled,
      permissionDenials: [],
      warnings: [],
    },
  };
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(process.env.REAL_GIT ?? 'git', args, {
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

/** A bare repository with one commit on main, standing in for GitHub's copy. */
function forgeRepo(name: string): string {
  const dir = path.join(root, `${name}.git`);
  const seed = path.join(root, `${name}-seed`);
  sh(root, 'init', '-q', '--bare', '-b', 'main', dir);
  sh(root, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'push', '-q', dir, 'main');
  return dir;
}

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });

async function json<T = Record<string, unknown>>(
  p: string,
  init?: RequestInit
): Promise<{ status: number; body: T }> {
  const res = await api(p, init);
  return { status: res.status, body: (await res.json()) as T };
}

interface RunView {
  id: string;
  status: string;
  exitReason?: string;
  prUrl?: string;
  steps: Array<{
    kind: string;
    status?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
  artifacts: Array<{ id: number; kind: string }>;
}

const finished = (r: RunView) => ['done', 'failed', 'cancelled'].includes(r.status);

async function waitForRun(runId: string, until: (r: RunView) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const { body } = await json<RunView>(`/runs/${runId}`);
    if (until(body)) return body;
    if (Date.now() > end)
      throw new Error(`run ${runId} stuck in ${body.status}: ${body.exitReason ?? ''}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function create(source: string): Promise<string> {
  const { status, body } = await json<{ id: string; message?: string }>('/automations', {
    method: 'POST',
    body: JSON.stringify({ spec: source }),
  });
  if (status !== 201) throw new Error(`create failed: ${body.message}`);
  return body.id;
}

async function start(id: string): Promise<string> {
  const { status, body } = await json<{ runId: string }>(`/automations/${id}/run`, {
    method: 'POST',
  });
  expect(status).toBe(202);
  return body.runId;
}

/** Answer the push approval the run waits for, and wait for the run to end. */
async function decideAndFinish(
  runId: string,
  how: 'approve' | 'deny' = 'approve'
): Promise<RunView> {
  const waiting = await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
  if (finished(waiting)) return waiting;
  const { body } = await json<{ approvals: Array<{ id: number; runId: string }> }>('/approvals');
  const approval = body.approvals.find((a) => a.runId === runId);
  await api(`/approvals/${approval?.id}/${how}`, { method: 'POST' });
  return waitForRun(runId, finished);
}

/** Run a spec to the end. */
async function runSpec(source: string, how: 'approve' | 'deny' = 'approve'): Promise<RunView> {
  return decideAndFinish(await start(await create(source)), how);
}

let counter = 0;
function spec(repo: string, extra = '', gates = ['test -f CHANGED.md']): string {
  counter += 1;
  return [
    `name: app-run-${counter}`,
    'targets:',
    `  repos: [${repo}]`,
    'agent:',
    '  driver: claude-code',
    'prompt: Add a CHANGED.md file.',
    'gates:',
    ...gates.map((g) => `  - run: ${g}`),
    extra,
  ].join('\n');
}

/** What the recording `git` saw: the credential each command carried. */
function gitCredentials(): Array<{ user: string; token: string; args: string }> {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [header, args] = line.split('\t');
      const basic = /^AUTHORIZATION: basic (.+)$/.exec(header)?.[1] ?? '';
      const [user, ...rest] = Buffer.from(basic, 'base64').toString().split(':');
      return { user, token: rest.join(':'), args };
    });
}

/** Tokens the fake made, and what ended them. */
const minted = (): FakeToken[] => [...fake.tokens.values()];
const byPermission = (permissions: Record<string, string>): FakeToken[] =>
  minted().filter((t) => JSON.stringify(t.permissions) === JSON.stringify(permissions));
const PUSH = { contents: 'write' };
const FETCH = { contents: 'read' };
const PULL = { pull_requests: 'write', contents: 'read' };

async function install(repos: string[] | null) {
  fake.installations.length = 0;
  if (repos) fake.install({ id: 3100, repos });
  // Forget what the gateway believed about where the app is installed.
  await api('/github/app?refresh=1');
  fake.seen.length = 0;
}

/** The step that cloned the repository, or found the clone an earlier run left. */
const cloneStep = (run: RunView) =>
  run.steps.find((s) => s.input?.action === 'clone' || s.input?.action === 'cached');

/** Every text the store holds, as one string: for "nowhere" assertions. */
function everythingStored(): string {
  const db = getStore();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => String(r.name));
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-ghapp-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  bare = forgeRepo('remote-app');
  const gone = path.join(root, 'nowhere.git');
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(
    gitconfig,
    `[url "${bare}"]\n\tinsteadOf = https://github.com/acme/remote-app.git\n` +
      `[url "${gone}"]\n\tinsteadOf = https://github.com/acme/gone.git\n` +
      `[protocol "file"]\n\tallow = always\n`
  );

  // A `git` that notes the header it was given, then runs the real one.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  log = path.join(root, 'git-credentials.log');
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
if [ -n "$GIT_CONFIG_VALUE_0" ]; then
  printf '%s\\t%s\\n' "$GIT_CONFIG_VALUE_0" "$*" >> "$GIT_SHIM_LOG"
fi
exec "$REAL_GIT" "$@"
`,
    { mode: 0o755 }
  );

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.CLERQ_KEYCHAIN = 'off';
  process.env.REAL_GIT = realGit;
  process.env.GIT_SHIM_LOG = log;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  process.env.CLERQ_GITHUB_WEB = WEB;

  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    // No `forgeCredentials` and no `fetcher`: the gateway's own default lookup, and the
    // pull request goes to the fake API over HTTP.
    automations: {
      driverFor: () => scripted(),
      getSecret: (name) => secrets[name],
      workspaceCacheDir: path.join(root, 'cache'),
      path: () => process.env.PATH ?? '',
      maxConcurrent: 4,
    },
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 50; i++) {
    if ((await api('/automations')).status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // The app, connected the way a person would with an app they made.
  const imported = await api('/github/app/import', {
    method: 'POST',
    body: JSON.stringify({
      appId: fake.app.id,
      clientId: fake.app.clientId,
      privateKey: fake.privateKeyPem,
    }),
  });
  expect(imported.status).toBe(201);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  mode = 'edit';
  agentCalls = 0;
  lastAgentInput = undefined;
  secrets = { GITHUB_TOKEN: VAULT_PAT };
  fake.reset();
  fake.pats.set(VAULT_PAT, PAT_LOGIN);
  fs.rmSync(log, { force: true });
  await install(['acme/remote-app']);
});

describe('a run with the app installed on the repository', () => {
  it('uses short-lived tokens for one repository, opens the pull request as the app and ends the tokens', async () => {
    const run = await runSpec(spec('github:acme/remote-app'));
    expect(run.status).toBe('done');
    expect(run.prUrl).toBe(`${WEB}/acme/remote-app/pull/1`);

    // Three tokens, each for the one repository and the least its purpose needs.
    const made = fake.calls('POST', '/access_tokens');
    expect(made).toHaveLength(3);
    for (const call of made) {
      expect(call.body).toMatchObject({ repositories: ['remote-app'] });
      expect(call.auth).toBe('jwt');
    }
    expect(byPermission(FETCH)).toHaveLength(1);
    expect(byPermission(PUSH)).toHaveLength(1);
    expect(byPermission(PULL)).toHaveLength(1);

    // Which token reached git: the one to fetch for the clone and the base, the one to push for the push.
    const creds = gitCredentials();
    const [fetchTok] = byPermission(FETCH);
    const [pushTok] = byPermission(PUSH);
    const [prTok] = byPermission(PULL);
    expect(creds.length).toBeGreaterThanOrEqual(3);
    expect(creds.every((c) => c.user === 'x-access-token')).toBe(true);
    const pushes = creds.filter((c) => / push /.test(` ${c.args} `));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].token).toBe(pushTok.token);
    expect(
      creds.filter((c) => /clone|fetch/.test(c.args)).every((c) => c.token === fetchTok.token)
    ).toBe(true);
    // The two read-and-write tokens never went to the command that did not need them.
    expect(creds.some((c) => c.token === prTok.token)).toBe(false);
    expect(creds.some((c) => c.token === VAULT_PAT)).toBe(false);

    // The pull request was opened with its own token, and GitHub shows the app as its author.
    expect(fake.pulls).toHaveLength(1);
    expect(fake.pulls[0]).toMatchObject({
      repo: 'acme/remote-app',
      token: prTok.token,
      author: `${fake.app.slug}[bot]`,
    });
    expect(fake.pulls[0].body).toMatchObject({ draft: true, base: 'main' });

    // The run says so.
    expect(cloneStep(run)?.output?.credential).toBe(
      `github-app:${fake.app.slug}/installation/3100`
    );
    const push = run.steps.find((s) => s.input?.action === 'push');
    expect(push?.output).toMatchObject({
      credential: `github-app:${fake.app.slug}/installation/3100`,
      pushedAs: `${fake.app.slug}[bot]`,
    });
    const pr = run.steps.find((s) => s.input?.action === 'pull_request');
    expect(pr?.output).toMatchObject({
      url: `${WEB}/acme/remote-app/pull/1`,
      openedBy: `${fake.app.slug}[bot]`,
    });

    // Every token was revoked, with itself, when the run ended; none is left.
    const revokes = fake.calls('DELETE', '/installation/token');
    expect(revokes.map((r) => r.token).sort()).toEqual(
      minted()
        .map((t) => t.token)
        .sort()
    );
    expect(fake.live()).toHaveLength(0);

    // The agent never had one, and nothing stored holds one.
    expect(JSON.stringify(lastAgentInput)).not.toContain('ghs_');
    expect(everythingStored()).not.toContain('ghs_');
    expect(JSON.stringify(run)).not.toContain('ghs_');
    // The branch reached GitHub's copy.
    expect(sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toContain('auto/');
  });

  it('makes the token again, and uses the new one, when one is about to end', async () => {
    // Four minutes is under the five the runner keeps clear of an end.
    fake.tokenLifetimeMs = 4 * 60_000;
    const run = await runSpec(spec('github:acme/remote-app'));
    expect(run.status).toBe('done');
    // Push and the pull request each asked twice: at the start, and just before use.
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(5);
    expect(byPermission(PUSH)).toHaveLength(2);
    const [, secondPush] = byPermission(PUSH);
    const pushes = gitCredentials().filter((c) => / push /.test(` ${c.args} `));
    expect(pushes[0].token).toBe(secondPush.token);
    expect(fake.pulls[0].token).toBe(byPermission(PULL)[1].token);
    // Both of each were ended.
    expect(fake.live()).toHaveLength(0);
    expect(fake.calls('DELETE', '/installation/token')).toHaveLength(5);
  });

  it.each([
    ['the agent fails', 'fail', 'approve'],
    ['a gate fails', 'edit', 'approve'],
    ['the push is denied', 'edit', 'deny'],
  ] as const)('ends the tokens when %s', async (_name, agent, how) => {
    mode = agent;
    const gates = _name === 'a gate fails' ? ['test -f MISSING.md'] : ['test -f CHANGED.md'];
    const run = await runSpec(spec('github:acme/remote-app', '', gates), how);
    expect(['failed', 'cancelled']).toContain(run.status);
    expect(fake.tokens.size).toBeGreaterThan(0);
    expect(fake.live()).toHaveLength(0);
    expect(fake.calls('DELETE', '/installation/token')).toHaveLength(fake.tokens.size);
    expect(fake.pulls).toHaveLength(0);
  });

  it('ends the tokens when the run is cancelled', async () => {
    mode = 'slow';
    const runId = await start(await create(spec('github:acme/remote-app')));
    await waitForRun(runId, (r) => r.status === 'executing');
    expect(fake.live().length).toBeGreaterThan(0);
    const res = await api(`/runs/${runId}/cancel`, { method: 'POST' });
    expect(res.status).toBeLessThan(300);
    const run = await waitForRun(runId, finished);
    expect(run.status).toBe('cancelled');
    expect(fake.live()).toHaveLength(0);
    expect(fake.calls('DELETE', '/installation/token')).toHaveLength(fake.tokens.size);
  });

  it('ends the tokens when it cannot clone, and says nothing of them', async () => {
    await install(['acme/gone']);
    const run = await runSpec(spec('github:acme/gone'));
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Could not clone github:acme\/gone/);
    expect(fake.live()).toHaveLength(0);
    expect(fake.tokens.size).toBeGreaterThan(0);
    expect(JSON.stringify(run)).not.toContain('ghs_');
  });

  it('keeps going when ending a token fails, and logs it without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fake.failNext.set('/installation/token', { status: 500, message: 'down' });
      const run = await runSpec(spec('github:acme/remote-app'));
      expect(run.status).toBe('done');
      // One revoke failed and the token is still live at GitHub (it expires by itself).
      expect(fake.live()).toHaveLength(1);
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toContain('Could not revoke a GitHub installation token');
      for (const t of minted()) expect(logged).not.toContain(t.token);
    } finally {
      warn.mockRestore();
    }
  });

  it('takes a minted token out of everything the run stores, wherever the agent put it', async () => {
    fake.predictable = true;
    mode = 'leak';
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      })
    );
    let run: RunView;
    try {
      run = await runSpec(
        spec('github:acme/remote-app', '', ['test -f CHANGED.md', 'cat LEAK.md'])
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(run.status).toBe('done');
    // The tokens were real, and used.
    expect(
      minted()
        .map((t) => t.token)
        .sort()
    ).toEqual(['ghs_predictable_fetch_1', 'ghs_predictable_pr_1', 'ghs_predictable_push_1']);
    expect(fake.pulls[0].token).toBe('ghs_predictable_pr_1');
    // The diff held them, so the push waited for a person and the run says why.
    expect(run.steps.some((s) => s.input?.name === 'diff.secrets')).toBe(true);

    // Not in the run (steps, text, tool calls, gate output, summary), the artifacts, the PR,
    // any table of the store, or the log.
    const artifacts = await Promise.all(
      run.artifacts.map(async (a) => (await api(`/runs/${run.id}/artifacts/${a.id}`)).text())
    );
    expect(artifacts.length).toBeGreaterThan(0);
    const places: Array<[string, string]> = [
      ['the run', JSON.stringify(run)],
      ['the artifacts', artifacts.join('\n')],
      ['the pull request', JSON.stringify(fake.pulls[0].body)],
      ['the store', everythingStored()],
      ['the log', logs.join('\n')],
    ];
    for (const [place, text] of places) {
      for (const leak of LEAKS) {
        expect([place, text.includes(leak)]).toEqual([place, false]);
      }
    }
    // The redaction left its mark, so the test was looking at the right place.
    expect(places[0][1]).toContain('«redacted»');
    expect(places[2][1]).toContain('«redacted»');
    // The gate printed the file: its output is stored, redacted.
    const gate = run.steps.find((s) => s.kind === 'gate' && String(s.input?.run).includes('cat'));
    expect(JSON.stringify(gate)).toContain('«redacted»');
  });

  it('keeps a pull request link only when it is on GitHub’s website', async () => {
    fake.prHtmlUrl = 'javascript:alert(1)';
    const run = await runSpec(spec('github:acme/remote-app'));
    // The pull request exists; the run does not offer a link that is not GitHub's.
    expect(run.status).toBe('done');
    expect(fake.pulls).toHaveLength(1);
    expect(run.prUrl).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain('javascript:');
    const pr = run.steps.find((s) => s.input?.action === 'pull_request');
    expect(pr?.output).toMatchObject({
      number: 1,
      warning:
        "GitHub gave an address for the pull request that is not on GitHub's website; it was left out.",
    });
    expect(run.exitReason).toMatch(/^Published: auto\//);
  });

  it('takes a token out of an error GitHub echoes it in', async () => {
    fake.failNext.set('/pulls', { status: 422, message: 'Validation failed for {token}' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    let run: RunView;
    try {
      run = await runSpec(spec('github:acme/remote-app'));
    } finally {
      spy.mockRestore();
    }
    expect(run.status).toBe('failed');
    expect(run.exitReason).toContain('github refused the pull request (422)');
    expect(run.exitReason).toContain('Validation failed for «redacted»');
    const [prTok] = byPermission(PULL);
    for (const text of [JSON.stringify(run), everythingStored(), logs.join('\n')]) {
      expect(text).not.toContain(prTok.token);
    }
    expect(fake.live()).toHaveLength(0);
  });
});

describe('precedence over the vault secret', () => {
  it('falls back to the vault token where the app is not installed, as before', async () => {
    await install(null);
    const run = await runSpec(spec('github:acme/remote-app'));
    expect(run.status).toBe('done');
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(0);
    expect(fake.pulls[0]).toMatchObject({ token: VAULT_PAT, author: PAT_LOGIN });
    expect(cloneStep(run)?.output?.credential).toBe('vault:GITHUB_TOKEN');
    const pr = run.steps.find((s) => s.input?.action === 'pull_request');
    expect(pr?.output?.credential).toBe('vault:GITHUB_TOKEN');
    expect(pr?.output?.openedBy).toBeUndefined();
    expect(gitCredentials().every((c) => c.token === VAULT_PAT)).toBe(true);
  });

  it('uses only the vault token with publish.auth: token, and never asks GitHub', async () => {
    const run = await runSpec(spec('github:acme/remote-app', 'publish:\n  auth: token'));
    expect(run.status).toBe('done');
    expect(fake.seen.filter((s) => s.auth === 'jwt')).toHaveLength(0);
    expect(fake.pulls[0]).toMatchObject({ token: VAULT_PAT, author: PAT_LOGIN });
  });

  it('fails a run with publish.auth: app before any work when the app is not installed', async () => {
    await install(null);
    const run = await runSpec(spec('github:acme/remote-app', 'publish:\n  auth: app'));
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(
      /publish\.auth is "app", but the GitHub App openclerq-test is not installed on acme\/remote-app\. Install it/
    );
    expect(agentCalls).toBe(0);
    expect(fake.tokens.size).toBe(0);
    // No worktree was made, no clone either.
    expect(run.steps.filter((s) => s.kind === 'git')).toHaveLength(0);
  });

  it('fails a run with publish.auth: app when no app is connected', async () => {
    await api('/github/app', { method: 'DELETE' });
    try {
      const run = await runSpec(spec('github:acme/remote-app', 'publish:\n  auth: app'));
      expect(run.status).toBe('failed');
      expect(run.exitReason).toMatch(/no GitHub App is connected/);
      expect(agentCalls).toBe(0);
    } finally {
      await api('/github/app/import', {
        method: 'POST',
        body: JSON.stringify({
          appId: fake.app.id,
          clientId: fake.app.clientId,
          privateKey: fake.privateKeyPem,
        }),
      });
    }
  });

  it('stops a run that would push as the user when the app is installed but cannot make a token', async () => {
    fake.failNext.set('/access_tokens', { status: 500, message: 'Server Error' });
    const run = await runSpec(spec('github:acme/remote-app'));
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/Could not get a push token.*publish\.auth: token/);
    expect(agentCalls).toBe(0);
    expect(fake.pulls).toHaveLength(0);
  });

  it('refuses publish.auth: app for a GitLab project when it is saved', async () => {
    const { status, body } = await json<{ error: string; message: string; line: number }>(
      '/automations',
      {
        method: 'POST',
        body: JSON.stringify({ spec: spec('gitlab:group/lab-app', 'publish:\n  auth: app') }),
      }
    );
    expect(status).toBe(400);
    expect(body.message).toMatch(/"publish.auth: app" is for GitHub repositories/);
    expect(body.line).toBeGreaterThan(0);
  });

  it('refuses a value that is none of auto, app and token', async () => {
    const { status, body } = await json<{ message: string }>('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('github:acme/remote-app', 'publish:\n  auth: oauth') }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/"publish.auth" must be one of: auto, app, token/);
  });

  it('refuses a spec that names the app’s own secrets', async () => {
    const { status, body } = await json<{ message: string }>('/automations', {
      method: 'POST',
      body: JSON.stringify({
        spec: spec('github:acme/remote-app', 'publish:\n  token_secret: GITHUB_APP_PRIVATE_KEY'),
      }),
    });
    expect(status).toBe(400);
    expect(body.message).toContain('GitHub App connection keeps its private key');
    // Nor may an agent be handed them as its key.
    const key = await json<{ message: string }>('/automations', {
      method: 'POST',
      body: JSON.stringify({
        spec: spec('github:acme/remote-app').replace(
          '  driver: claude-code',
          '  driver: claude-code\n  api_key_secret: GITHUB_APP_CLIENT_SECRET'
        ),
      }),
    });
    expect(key.status).toBe(400);
    expect(key.body.message).toContain('GitHub App connection keeps its private key');
  });
});

describe('the spec preview', () => {
  const preview = async (source: string) =>
    (
      await json<{
        ready: boolean;
        checks: Array<{ level: string; message: string }>;
      }>('/automations/preview', { method: 'POST', body: JSON.stringify({ spec: source }) })
    ).body;
  const said = (p: { checks: Array<{ message: string }> }) =>
    p.checks.map((c) => c.message).join('\n');

  it('says which credential a run would use, and makes no token', async () => {
    const p = await preview(spec('github:acme/remote-app'));
    expect(p.ready).toBe(true);
    expect(said(p)).toContain(
      `with the GitHub App ${fake.app.slug} (installation 3100) as the credential`
    );
    expect(said(p)).toContain(
      `The push and the pull request use the GitHub App ${fake.app.slug} (installation 3100)`
    );
    expect(said(p)).toContain(`the pull request is opened as ${fake.app.slug}[bot]`);
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(0);
    expect(fake.tokens.size).toBe(0);
  });

  it('says the vault secret where the app is not installed', async () => {
    await install(null);
    const p = await preview(spec('github:acme/remote-app'));
    expect(p.ready).toBe(true);
    expect(said(p)).toContain('with GITHUB_TOKEN as the credential');
    expect(said(p)).not.toContain('GitHub App');
  });

  it('says why a run that insists on the app would stop', async () => {
    await install(null);
    const p = await preview(spec('github:acme/remote-app', 'publish:\n  auth: app'));
    expect(p.ready).toBe(false);
    expect(
      p.checks
        .filter((c) => c.level === 'error')
        .map((c) => c.message)
        .join('\n')
    ).toMatch(
      /publish\.auth is "app", but the GitHub App openclerq-test is not installed on acme\/remote-app/
    );
  });

  it('says there is no credential when neither the app nor the secret is there', async () => {
    await install(null);
    secrets = {};
    const p = await preview(spec('github:acme/remote-app'));
    expect(p.ready).toBe(false);
    expect(said(p)).toContain(
      'No GITHUB_TOKEN in the vault; opening a pull request needs one, or your GitHub App installed on this repository.'
    );
  });
});

describe('Repos', () => {
  const repos = async () =>
    (
      await json<{
        repos: Array<{
          id: string;
          name: string;
          credential: { secret: string; present: boolean } | null;
          reachedWith: Record<string, unknown> | null;
          automations: Array<{
            name: string;
            credential: { auth: string; reachedWith: Record<string, unknown> | null } | null;
          }>;
        }>;
      }>('/repos')
    ).body.repos;

  it('says, for a GitHub repository, whether the app reaches it, without making a token', async () => {
    await runSpec(spec('github:acme/remote-app'));
    // One automation of each kind on it (saved, not run).
    await create(spec('github:acme/remote-app', 'publish:\n  auth: app'));
    await create(spec('github:acme/remote-app', 'publish:\n  auth: token'));
    fake.reset();
    fake.pats.set(VAULT_PAT, PAT_LOGIN);
    await install(['acme/remote-app']);
    fake.seen.length = 0;

    let list = await repos();
    let row = list.find((r) => r.name === 'acme/remote-app');
    expect(row?.reachedWith).toEqual({
      via: 'app',
      app: { slug: fake.app.slug, installationId: 3100 },
    });
    // Each automation that targets it says what it would reach it with, by its own publish.auth:
    // the earlier tests left one of each.
    const ways = Object.fromEntries(
      (row?.automations ?? []).map((a) => [a.credential?.auth, a.credential?.reachedWith?.via])
    );
    expect(ways).toEqual({ auto: 'app', app: 'app', token: 'secret' });
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(0);
    // Read from the cache the second time.
    const asked = fake.calls('GET', '/installation').length;
    await repos();
    expect(fake.calls('GET', '/installation')).toHaveLength(asked);

    // Not installed: the vault secret, and the page says the app is not there.
    await install(null);
    list = await repos();
    row = list.find((r) => r.name === 'acme/remote-app');
    expect(row?.reachedWith).toMatchObject({
      via: 'secret',
      secret: 'GITHUB_TOKEN',
      app: { slug: fake.app.slug },
      note: expect.stringContaining('not installed on this repository'),
    });
    const notThere = Object.fromEntries(
      (row?.automations ?? []).map((a) => [a.credential?.auth, a.credential?.reachedWith?.via])
    );
    // A run that insists on the app would stop; the others use the secret.
    expect(notThere).toEqual({ auto: 'secret', app: 'none', token: 'secret' });
    // The vault's value is never in the answer.
    expect(JSON.stringify(list)).not.toContain(VAULT_PAT);
  });

  it('reads the detail of one repository the same way', async () => {
    const row = (await repos()).find((r) => r.name === 'acme/remote-app');
    const { status, body } = await json<{ reachedWith: { via: string } }>(`/repos/${row?.id}`);
    expect(status).toBe(200);
    expect(body.reachedWith.via).toBe('app');
  });

  it('checks a new repository with the app for a read, and ends that token at once', async () => {
    const { status, body } = await json<{
      check: {
        reachable: boolean;
        message: string;
        credential: { source?: string; present: boolean };
      };
    }>('/repos', {
      method: 'POST',
      body: JSON.stringify({ target: 'github:acme/remote-app', check: true }),
    });
    expect(status).toBeLessThan(300);
    expect(body.check.reachable).toBe(true);
    expect(body.check.message).toContain(
      `with the GitHub App ${fake.app.slug} (installation 3100)`
    );
    expect(body.check.credential.source).toBe(`github-app:${fake.app.slug}/installation/3100`);
    // One token, for reading, used by `git ls-remote` and ended.
    expect(minted()).toHaveLength(1);
    expect(minted()[0].permissions).toEqual(FETCH);
    expect(fake.live()).toHaveLength(0);
    expect(gitCredentials().at(-1)?.token).toBe(minted()[0].token);
    expect(JSON.stringify(body)).not.toContain(minted()[0].token);
  });
});
