/**
 * Automations end to end: worktree → agent → commit → gates → approval → push
 * → draft PR, through the gateway's HTTP API.
 *
 * The repository is real. Its origin is a GitHub URL that git rewrites
 * (url.insteadOf) to a bare repository on disk, so the push takes the same
 * path it would against GitHub. The agent and the GitHub API are fakes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Driver, DriverEvent, DriverRunInput } from '@clerq/drivers';
import type { Fetcher } from '@clerq/workspaces';
import { createGateway } from '../gateway.js';
import { getStore } from '../store.js';

const TOKEN = 'automations-test-token-0123456789';
const FORGE_TOKEN = 'ghp_fake-forge-token-for-tests-000';

type Mode = 'edit' | 'no-change' | 'fail' | 'slow';
let mode: Mode = 'edit';
let agentCalls = 0;
let lastAgentInput: DriverRunInput | undefined;

/** A scripted agent: edits a file, or not, or fails, or takes its time. */
const fakeDriver: Driver = {
  id: 'claude-code',
  async detect() {
    return { id: 'claude-code', available: true, version: 'test', path: '/fake/claude' };
  },
  async *run(input: DriverRunInput): AsyncIterable<DriverEvent> {
    agentCalls += 1;
    lastAgentInput = input;
    yield { type: 'started', model: 'fake-model' };
    yield { type: 'text', text: 'Updating the changelog.' };
    if (mode === 'slow') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 15_000);
        input.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (mode === 'edit' || mode === 'slow') {
      yield { type: 'tool_call', id: 't1', name: 'Write', input: { file_path: 'CHANGED.md' } };
      fs.writeFileSync(path.join(input.cwd, 'CHANGED.md'), `changed by run ${agentCalls}\n`);
      yield { type: 'tool_result', id: 't1', output: 'written', isError: false };
    }
    const cancelled = input.signal?.aborted ?? false;
    yield {
      type: 'finished',
      result: {
        ok: mode !== 'fail' && !cancelled,
        summary: mode === 'fail' ? 'The agent gave up.' : 'Added CHANGED.md',
        costUsd: 0.25,
        tokensIn: 1000,
        tokensOut: 200,
        durationMs: 5,
        exitCode: mode === 'fail' ? 1 : 0,
        timedOut: false,
        cancelled,
        permissionDenials: [],
        warnings: ['Running without isolation (profile "native").'],
      },
    };
  },
};

const pullRequests: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
const fakeForge: Fetcher = async (url, init) => {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  pullRequests.push({ url, body, auth: init.headers.Authorization });
  const number = pullRequests.length;
  return {
    ok: true,
    status: 201,
    text: async () =>
      JSON.stringify({ html_url: `https://github.com/acme/app/pull/${number}`, number }),
  };
};

let root: string;
let repo: string;
let bare: string;
let baseUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
let secrets: Record<string, string> = {};

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

function spec(name: string, extra = ''): string {
  return [
    `name: ${name}`,
    'targets:',
    `  repos: [local:${repo}]`,
    'agent:',
    '  driver: claude-code',
    '  model: sonnet',
    'prompt: Add a CHANGED.md file.',
    'sandbox:',
    '  profile: native',
    'gates:',
    '  - run: test -f CHANGED.md',
    extra,
  ].join('\n');
}

async function create(name: string, extra = ''): Promise<string> {
  const { status, body } = await json<{ id: string; enabled: boolean }>('/automations', {
    method: 'POST',
    body: JSON.stringify({ spec: spec(name, extra) }),
  });
  expect(status).toBe(201);
  expect(body.enabled).toBe(false);
  return body.id;
}

interface RunView {
  id: string;
  status: string;
  exitReason?: string;
  branch?: string;
  prUrl?: string;
  costUsd: number;
  steps: Array<{
    kind: string;
    status?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
  artifacts: Array<{ id: number; kind: string }>;
}

async function waitForRun(
  runId: string,
  until: (r: RunView) => boolean,
  ms = 15_000
): Promise<RunView> {
  const end = Date.now() + ms;
  for (;;) {
    const { body } = await json<RunView>(`/runs/${runId}`);
    if (until(body)) return body;
    if (Date.now() > end)
      throw new Error(`run ${runId} stuck in ${body.status}: ${body.exitReason ?? ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const finished = (r: RunView) => ['done', 'failed', 'cancelled'].includes(r.status);

async function start(id: string): Promise<string> {
  const { status, body } = await json<{ runId: string }>(`/automations/${id}/run`, {
    method: 'POST',
  });
  expect(status).toBe(202);
  return body.runId;
}

async function approvalFor(runId: string): Promise<number> {
  await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
  const { body } = await json<{
    approvals: Array<{ id: number; runId: string; tool: string; reason: string }>;
  }>('/approvals');
  const found = body.approvals.find((a) => a.runId === runId);
  if (!found) throw new Error(`no approval for ${runId}`);
  expect(found.tool).toBe('git.push');
  return found.id;
}

function remoteBranches(): string[] {
  const out = sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
  return out ? out.split('\n') : [];
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-aut-')));
  bare = path.join(root, 'origin.git');
  repo = path.join(root, 'app');
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  // Any push to the GitHub URL lands in the bare repository instead.
  sh(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
  sh(repo, 'push', '-q', 'origin', 'main');
  sh(repo, 'fetch', '-q', 'origin');
  sh(repo, 'remote', 'set-head', 'origin', 'main');

  process.env.CLERQ_KEYCHAIN = 'off';
  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    automations: {
      driverFor: () => fakeDriver,
      fetcher: fakeForge,
      getSecret: (name) => secrets[name],
      workspaceCacheDir: path.join(root, 'cache'),
      path: () => process.env.PATH ?? '',
      maxConcurrent: 4,
    },
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // The store opens just after the socket does.
  for (let i = 0; i < 50; i++) {
    if ((await api('/automations')).status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mode = 'edit';
  secrets = { GITHUB_TOKEN: FORGE_TOKEN };
});

describe('automations API', () => {
  it('saves a new automation disabled, and refuses a bad spec with its line', async () => {
    const id = await create('saved-disabled');
    const { body } = await json<{ automations: Array<{ id: string; enabled: boolean }> }>(
      '/automations'
    );
    expect(body.automations.find((a) => a.id === id)?.enabled).toBe(false);

    const bad = await json<{ error: string; line: number }>('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('bad-one', 'on:\n  schedule: nope') }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_spec', line: 13 });

    const dup = await json('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('saved-disabled') }),
    });
    expect(dup.status).toBe(409);
  });

  it('previews what a spec would do without running it', async () => {
    const { status, body } = await json<{
      ready: boolean;
      repo: { project: string; base: string };
      checks: Array<{ level: string; message: string }>;
      nextRunAt: string | null;
    }>('/automations/preview', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('preview-me', "on:\n  schedule: '0 3 * * *'") }),
    });
    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.repo).toMatchObject({ project: 'acme/app', base: 'main' });
    expect(new Date(body.nextRunAt as string).getHours()).toBe(3);
    expect(body.checks.map((c) => c.message).join('\n')).toMatch(/waits for your approval/);
    expect(agentCalls).toBe(0);

    secrets = {};
    const noToken = await json<{ ready: boolean }>('/automations/preview', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('preview-me') }),
    });
    expect(noToken.body.ready).toBe(false);
  });

  it('lists a stored spec that no longer parses, and refuses to run or enable it', async () => {
    // As if saved by a release whose parser accepted a spec this one does not.
    getStore()
      .prepare(
        `INSERT INTO automations (id, name, spec, enabled, created_at, updated_at)
         VALUES ('aut_stale', 'stale', 'name: stale\nprompt: x\n', 0, 'now', 'now')`
      )
      .run();
    const { status, body } = await json<{ automations: Array<{ id: string; problem: string }> }>(
      '/automations'
    );
    expect(status).toBe(200);
    expect(body.automations.find((a) => a.id === 'aut_stale')?.problem).toMatch(/targets.repos/);
    expect((await api('/automations/aut_stale/run', { method: 'POST' })).status).toBe(400);
    expect((await api('/automations/aut_stale/enable', { method: 'POST' })).status).toBe(400);
    expect((await api('/automations/aut_stale', { method: 'DELETE' })).status).toBe(200);
  });

  it('schedules an enabled automation and stops when disabled', async () => {
    const id = await create('scheduled', "on:\n  schedule: '0 4 * * *'");
    const on = await json<{ enabled: boolean; nextRunAt: string }>(`/automations/${id}/enable`, {
      method: 'POST',
    });
    expect(on.body.enabled).toBe(true);
    expect(new Date(on.body.nextRunAt).getHours()).toBe(4);
    const off = await json<{ enabled: boolean; nextRunAt: string | null }>(
      `/automations/${id}/disable`,
      {
        method: 'POST',
      }
    );
    expect(off.body).toMatchObject({ enabled: false, nextRunAt: null });
  });
});

describe('an automation run', () => {
  it('runs the agent in a worktree, passes its gates, waits for approval, pushes and opens a draft PR', async () => {
    const id = await create('full-run');
    const runId = await start(id);

    const approval = await approvalFor(runId);
    // Nothing has left the machine yet.
    expect(remoteBranches()).toEqual(['main']);

    const decided = await api(`/approvals/${approval}/approve`, { method: 'POST' });
    expect(decided.status).toBe(200);
    const run = await waitForRun(runId, finished);

    expect(run.status).toBe('done');
    expect(run.prUrl).toBe('https://github.com/acme/app/pull/1');
    expect(run.exitReason).toBe('Published: https://github.com/acme/app/pull/1');
    expect(run.costUsd).toBe(0.25);
    expect(run.branch).toMatch(/^auto\/full-run\/\d{4}-\d{2}-\d{2}-/);

    // The branch reached origin with the agent's change and the run's trailer.
    expect(remoteBranches()).toContain(run.branch);
    const message = sh(bare, 'log', '-1', '--format=%B', run.branch as string);
    expect(message).toContain('full-run: Added CHANGED.md');
    expect(message).toContain(`OpenClerq-Run: ${runId}`);
    expect(sh(bare, 'show', `${run.branch}:CHANGED.md`)).toBe('changed by run 1');

    // A draft PR from the branch into main, with the token in the header only.
    const pr = pullRequests[pullRequests.length - 1];
    expect(pr.url).toBe('https://api.github.com/repos/acme/app/pulls');
    expect(pr.body).toMatchObject({ head: run.branch, base: 'main', draft: true });
    expect(pr.auth).toBe(`Bearer ${FORGE_TOKEN}`);

    // Every stage left a step, and the diff is kept with the run.
    const kinds = run.steps.map((s) => `${s.kind}:${s.status}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['tool:ok', 'git:ok', 'llm:text', 'llm:ok', 'gate:passed'])
    );
    const diff = run.artifacts.find((a) => a.kind === 'diff');
    const content = await json<{ content: string }>(`/runs/${runId}/artifacts/${diff?.id}`);
    expect(content.body.content).toContain('+changed by run 1');

    // The worktree and the local branch are gone; the user's checkout is untouched.
    expect(fs.readdirSync(path.join(root, 'cache', '.worktrees'))).toEqual([]);
    expect(sh(repo, 'branch', '--list', run.branch as string)).toBe('');
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    expect(lastAgentInput).toMatchObject({ model: 'sonnet', permissionMode: 'acceptEdits' });
    expect(lastAgentInput?.cwd).not.toBe(repo);
  });

  it('pushes without asking once approvals.push is auto and the automation has published before', async () => {
    const id = await create('auto-push', 'approvals:\n  push: auto');
    // First push still waits.
    const first = await start(id);
    await api(`/approvals/${await approvalFor(first)}/approve`, { method: 'POST' });
    expect((await waitForRun(first, finished)).status).toBe('done');

    const second = await start(id);
    const run = await waitForRun(second, finished);
    expect(run.status).toBe('done');
    expect(run.prUrl).toMatch(/\/pull\/\d+$/);
  });

  it('does not publish when a gate fails', async () => {
    const id = await create('gate-fails', '  - run: exit 3');
    const runId = await start(id);
    const run = await waitForRun(runId, finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toBe('Gate failed: exit 3 (exit 3)');
    expect(remoteBranches()).not.toContain(run.branch);
    expect(sh(repo, 'branch', '--list', run.branch as string)).toBe('');
    // The diff is still there to look at.
    expect(run.artifacts.some((a) => a.kind === 'diff')).toBe(true);
  });

  it('ends without a commit when the agent changes nothing', async () => {
    mode = 'no-change';
    const id = await create('no-change');
    const run = await waitForRun(await start(id), finished);
    expect(run).toMatchObject({
      status: 'done',
      exitReason: 'No changes: the agent left the repository as it was.',
    });
  });

  it('fails with the agent’s reason when the agent fails', async () => {
    mode = 'fail';
    const id = await create('agent-fails');
    const run = await waitForRun(await start(id), finished);
    expect(run).toMatchObject({ status: 'failed', exitReason: 'The agent gave up.' });
  });

  it('records a refused push as cancelled and pushes nothing', async () => {
    const id = await create('push-denied');
    const runId = await start(id);
    await api(`/approvals/${await approvalFor(runId)}/deny`, { method: 'POST' });
    const run = await waitForRun(runId, finished);
    expect(run).toMatchObject({ status: 'cancelled', exitReason: 'The push was not approved.' });
    expect(remoteBranches()).not.toContain(run.branch);
  });

  it('can be cancelled while the agent works, and refuses a second run meanwhile', async () => {
    mode = 'slow';
    const id = await create('cancel-me');
    const runId = await start(id);
    await waitForRun(runId, (r) => r.status === 'executing');

    const again = await api(`/automations/${id}/run`, { method: 'POST' });
    expect(again.status).toBe(409);

    expect((await api(`/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(200);
    const run = await waitForRun(runId, finished);
    expect(run.status).toBe('cancelled');
    expect(remoteBranches()).not.toContain(run.branch);
  });

  it('stops before doing any work when the forge token is missing', async () => {
    secrets = {};
    const before = agentCalls;
    const id = await create('no-token');
    const run = await waitForRun(await start(id), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/store one in the vault as GITHUB_TOKEN/);
    expect(agentCalls).toBe(before);
  });

  it('keeps the branch locally when told not to push', async () => {
    const id = await create('local-only', 'publish:\n  push: false');
    const run = await waitForRun(await start(id), finished);
    expect(run).toMatchObject({ status: 'done' });
    expect(run.exitReason).toBe(`Committed to the local branch ${run.branch}; not pushed.`);
    expect(sh(repo, 'branch', '--list', run.branch as string)).toContain(run.branch);
    expect(remoteBranches()).not.toContain(run.branch);
  });

  it("starts from origin's copy of the base branch, not a stale local one", async () => {
    // Someone else pushes to main; the local main never pulls it.
    const other = path.join(root, 'other');
    sh(root, 'clone', '-q', bare, other);
    fs.writeFileSync(path.join(other, 'REMOTE_ONLY.md'), 'from origin\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'remote change');
    sh(other, 'push', '-q', 'origin', 'main');
    expect(fs.existsSync(path.join(repo, 'REMOTE_ONLY.md'))).toBe(false);

    const id = await create('fresh-base', 'publish:\n  push: false');
    const run = await waitForRun(await start(id), finished);
    expect(run.status).toBe('done');
    expect(sh(repo, 'show', `${run.branch}:REMOTE_ONLY.md`)).toBe('from origin');
    expect(run.steps.find((s) => s.input?.action === 'fetch')?.status).toBe('ok');
    // The user's own checkout is left as it was.
    expect(fs.existsSync(path.join(repo, 'REMOTE_ONLY.md'))).toBe(false);
  });

  it('pauses an automation that spends its monthly budget', async () => {
    const id = await create(
      'budgeted',
      'publish:\n  push: false\nbudget:\n  max_usd_per_month: 0.2'
    );
    await api(`/automations/${id}/enable`, { method: 'POST' });
    await waitForRun(await start(id), finished);
    let enabled = true;
    for (let i = 0; i < 40 && enabled; i++) {
      const { body } = await json<{ enabled: boolean }>(`/automations/${id}`);
      enabled = body.enabled;
      if (enabled) await new Promise((r) => setTimeout(r, 25));
    }
    expect(enabled).toBe(false);
    // And the next run refuses to start work.
    const next = await waitForRun(await start(id), finished);
    expect(next.exitReason).toMatch(/monthly budget of \$0.2 is spent/);
  });
});
