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
import {
  builtin,
  type Driver,
  type DriverAvailability,
  type DriverEvent,
  type DriverRunInput,
} from '@clerq/drivers';
import { parseRegistry } from '@clerq/providers';
import type { Fetcher } from '@clerq/workspaces';
import { createGateway } from '../gateway.js';
import { getStore } from '../store.js';
import { listToolCalls } from '../runs.js';

const TOKEN = 'automations-test-token-0123456789';
const FORGE_TOKEN = 'ghp_fake-forge-token-for-tests-000';

type Mode = 'edit' | 'no-change' | 'fail' | 'slow';
let mode: Mode = 'edit';
let agentCalls = 0;
let lastAgentInput: DriverRunInput | undefined;
let lastDetect: { id: string; options: unknown } | undefined;
/** What detect() says, for the drivers a test wants to be unavailable. */
let unavailable: Record<string, string> = {};

/** A scripted agent: edits a file, or not, or fails, or takes its time. */
function scripted(id: string): Driver {
  return {
    id,
    async detect(options): Promise<DriverAvailability> {
      lastDetect = { id, options };
      if (unavailable[id]) return { id, available: false, reason: unavailable[id] };
      return { id, available: true, version: 'test', path: `/fake/${id}` };
    },
    run: (input) => runScripted(id, input),
  };
}

async function* runScripted(id: string, input: DriverRunInput): AsyncIterable<DriverEvent> {
  agentCalls += 1;
  lastAgentInput = input;
  // The process the driver started, as the sandbox would report it.
  input.onSpawn?.({ pid: process.pid, pgid: process.pid, command: `/fake/${id}` });
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
}

/**
 * The builtin agent is the real driver, over a scripted model: each reply is
 * the next Messages API response, so no request leaves the process.
 */
/** The model registry, as YAML: the gateway checks a spec's models against it as well as the agent. */
const MODEL_REGISTRY_YAML = `
providers:
  - id: fake
    label: Fake
    adapter: anthropic
    baseUrl: https://fake.invalid/v1
    authEnv: FAKE_AUTOMATION_MODEL_KEY
    models:
      - id: priced
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: unpriced
        context: 200000
  - id: other
    label: Other
    adapter: openai-compat
    baseUrl: https://other.invalid/v1
    authEnv: FAKE_OTHER_KEY
    models:
      - id: m
        context: 200000
        inputPerM: 1
        outputPerM: 2
`;
const MODEL_REGISTRY = parseRegistry(MODEL_REGISTRY_YAML);
let modelReplies: Array<Array<Record<string, unknown>>> = [];
const modelRequests: Array<{ key?: string; body: Record<string, unknown> }> = [];
const fakeModel = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  modelRequests.push({ key: (init.headers as Record<string, string>)['x-api-key'], body });
  const content = modelReplies.shift() ?? [{ type: 'text', text: 'Done.' }];
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 10_000, output_tokens: 1_000 },
      }),
  } as Response;
}) as unknown as typeof fetch;
const builtinDriver = builtin({ registry: () => MODEL_REGISTRY, fetch: fakeModel });

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
let savedProvidersFile: string | undefined;
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
  savedProvidersFile = process.env.CLERQ_PROVIDERS_FILE;
  fs.writeFileSync(path.join(root, 'providers.yaml'), MODEL_REGISTRY_YAML);
  process.env.CLERQ_PROVIDERS_FILE = path.join(root, 'providers.yaml');
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
      driverFor: (id) => (id === 'builtin' ? builtinDriver : scripted(id)),
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
  if (savedProvidersFile === undefined) delete process.env.CLERQ_PROVIDERS_FILE;
  else process.env.CLERQ_PROVIDERS_FILE = savedProvidersFile;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mode = 'edit';
  unavailable = {};
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
    const listed = await json<{
      automations: Array<{ id: string; nextFirings: string[]; monthBudgetUsd: number | null }>;
    }>('/automations');
    const mine = listed.body.automations.find(
      (a) => a.id === id
    )! as (typeof listed.body.automations)[number] & Record<string, unknown>;
    expect(mine.nextFirings).toHaveLength(10);
    expect(mine.nextFirings[0]).toBe(on.body.nextRunAt);
    expect(new Date(mine.nextFirings[1]).getTime() - new Date(mine.nextFirings[0]).getTime()).toBe(
      86_400_000
    );
    expect(mine.monthBudgetUsd).toBeNull();
    expect(mine).toMatchObject({ queued: false, catchUp: false, missedSlots: null });
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
    expect((await json<{ monthBudgetUsd: number }>(`/automations/${id}`)).body.monthBudgetUsd).toBe(
      0.2
    );
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

describe('agent drivers', () => {
  it('lists every driver, each with what detect found', async () => {
    unavailable = { codex: 'Codex is not signed in on this machine. Run `codex login`.' };
    const { status, body } = await json<{
      drivers: Array<{ id: string; available: boolean; reason?: string }>;
    }>('/drivers');
    expect(status).toBe(200);
    expect(body.drivers.map((d) => d.id)).toEqual([
      'claude-code',
      'codex',
      'cursor-agent',
      'builtin',
    ]);
    expect(body.drivers.find((d) => d.id === 'codex')).toMatchObject({
      available: false,
      reason: expect.stringContaining('codex login'),
    });
    expect(body.drivers.find((d) => d.id === 'cursor-agent')?.available).toBe(true);
  });

  it('saves a spec for codex or cursor-agent, and refuses what their CLIs cannot do, by line', async () => {
    for (const driver of ['codex', 'cursor-agent']) {
      const ok = await json<{ id: string }>('/automations', {
        method: 'POST',
        body: JSON.stringify({
          spec: spec(`saved-${driver}`).replace('driver: claude-code', `driver: ${driver}`),
        }),
      });
      expect(ok.status).toBe(201);

      const budget = await json<{ error: string; message: string; line: number }>('/automations', {
        method: 'POST',
        body: JSON.stringify({
          spec: spec(`budgeted-${driver}`, 'budget:\n  max_usd_per_run: 3').replace(
            'driver: claude-code',
            `driver: ${driver}`
          ),
        }),
      });
      expect(budget.status).toBe(400);
      expect(budget.body).toMatchObject({ error: 'invalid_spec', line: 13 });
      expect(budget.body.message).toMatch(/max_usd_per_run.*not supported.*no spend limit/);
    }
  });

  it('previews a driver that is not signed in as a problem, unless the spec brings a key', async () => {
    unavailable = { codex: 'Codex is not signed in on this machine. Run `codex login`.' };
    const codexSpec = (key = '') =>
      spec('preview-codex').replace('driver: claude-code', `driver: codex${key}`);
    const preview = (source: string) =>
      json<{ ready: boolean; checks: Array<{ level: string; message: string }> }>(
        '/automations/preview',
        { method: 'POST', body: JSON.stringify({ spec: source }) }
      );

    const out = await preview(codexSpec());
    expect(out.body.ready).toBe(false);
    expect(out.body.checks).toContainEqual({
      level: 'error',
      message: 'Codex is not signed in on this machine. Run `codex login`.',
    });
    expect(lastDetect).toEqual({
      id: 'codex',
      options: { apiKey: false, permissionMode: 'acceptEdits', model: 'sonnet', budget: false },
    });

    // With a key for the CLI, its own sign-in is not what the run depends on.
    secrets = { GITHUB_TOKEN: FORGE_TOKEN, CODEX_API_KEY: 'sk-codex-test-key-000000' };
    await preview(codexSpec('\n  api_key_secret: CODEX_API_KEY'));
    expect(lastDetect).toEqual({
      id: 'codex',
      options: { apiKey: true, permissionMode: 'acceptEdits', model: 'sonnet', budget: false },
    });
  });

  it('runs a codex automation, giving the CLI the vault key under the name it reads', async () => {
    secrets = { GITHUB_TOKEN: FORGE_TOKEN, MY_OPENAI_KEY: 'sk-test-openai-key-000000' };
    const source = spec('codex-run', 'publish:\n  push: false')
      .replace('driver: claude-code', 'driver: codex\n  api_key_secret: MY_OPENAI_KEY')
      .replace('  model: sonnet\n', '  model: gpt-5-codex\n');
    const created = await json<{ id: string }>('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: source }),
    });
    expect(created.status).toBe(201);

    const run = await waitForRun(await start(created.body.id), finished);
    expect(run.status).toBe('done');
    expect(lastDetect).toEqual({
      id: 'codex',
      options: {
        apiKey: true,
        permissionMode: 'acceptEdits',
        model: 'gpt-5-codex',
        budget: false,
      },
    });
    expect(lastAgentInput?.secrets).toEqual({ CODEX_API_KEY: 'sk-test-openai-key-000000' });
    expect(lastAgentInput).toMatchObject({ model: 'gpt-5-codex', permissionMode: 'acceptEdits' });
    // The run's record names the driver that did the work.
    expect(run.steps.find((s) => s.input?.name === 'driver.detect')?.input).toMatchObject({
      driver: 'codex',
    });
  });

  it('records the agent and gate processes a run starts, and closes them when they end', async () => {
    const id = await create('process-record', 'publish:\n  push: false');
    const runId = await start(id);
    await waitForRun(runId, finished);
    const rows = getStore()
      .prepare(
        'SELECT kind, pid, pgid, command, owner_pid, ended_at, outcome FROM run_processes WHERE run_id = ? ORDER BY id'
      )
      .all(runId);
    expect(rows.map((r) => r.kind)).toEqual(['agent', 'gate']);
    expect(rows[0]).toMatchObject({
      command: '/fake/claude-code',
      owner_pid: process.pid,
      outcome: 'exited',
    });
    // The gate is a real shell, started through the sandbox.
    expect(rows[1].command).toBe('/bin/sh');
    expect(Number(rows[1].pid)).toBeGreaterThan(1);
    expect(rows[1].pgid).toBe(rows[1].pid);
    expect(rows.every((r) => r.ended_at !== null)).toBe(true);
  });

  it('stops what a gate left running when the gate finishes', async () => {
    const pidFile = path.join(root, 'stray.pid');
    const id = await create(
      'stray-gate',
      `  - run: 'sleep 60 & echo $! > ${pidFile}'\npublish:\n  push: false`
    );
    const run = await waitForRun(await start(id), finished, 20_000);
    expect(run.status).toBe('done');
    const stray = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(stray).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(stray, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(stray, 'SIGKILL');
    expect(alive).toBe(false);
  });
});

describe('builtin driver', () => {
  const builtinSpec = (name: string, agent: string, extra = '') =>
    spec(name, extra).replace(
      '  driver: claude-code\n  model: sonnet\n',
      `  driver: builtin\n${agent}`
    );
  const save = (source: string) =>
    json<{ id: string; error?: string; message?: string; line?: number }>('/automations', {
      method: 'POST',
      body: JSON.stringify({ spec: source }),
    });

  beforeEach(() => {
    process.env.FAKE_AUTOMATION_MODEL_KEY = 'fake-env-key';
    modelReplies = [];
    modelRequests.length = 0;
  });

  it('is accepted with a provider/model, and refused without one, by line', async () => {
    const ok = await save(builtinSpec('builtin-saved', '  model: fake/priced\n'));
    expect(ok.status).toBe(201);

    const bare = await save(builtinSpec('builtin-bare', '  model: priced\n'));
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ error: 'invalid_spec', line: 6 });
    expect(bare.body.message).toContain('as provider/model');

    const tools = await save(
      builtinSpec('builtin-tools', '  model: fake/priced\n  allowed_tools: [group:fs, Bash]\n')
    );
    expect(tools.status).toBe(400);
    expect(tools.body.message).toContain('"Bash" names none of the builtin agent');
  });

  it('previews an unpriced model with a dollar budget as a problem', async () => {
    const out = await json<{ ready: boolean; checks: Array<{ level: string; message: string }> }>(
      '/automations/preview',
      {
        method: 'POST',
        body: JSON.stringify({
          spec: builtinSpec(
            'builtin-unpriced',
            '  model: fake/unpriced\n',
            'budget:\n  max_usd_per_run: 2'
          ),
        }),
      }
    );
    expect(out.body.ready).toBe(false);
    expect(out.body.checks.find((c) => c.level === 'error')?.message).toContain(
      'fake/unpriced has no price in providers.yaml'
    );
  });

  it('previews an unpriced escalation model with a dollar budget as a problem', async () => {
    const out = await json<{ ready: boolean; checks: Array<{ level: string; message: string }> }>(
      '/automations/preview',
      {
        method: 'POST',
        body: JSON.stringify({
          spec: builtinSpec(
            'builtin-escalate-unpriced',
            '  model:\n    primary: fake/priced\n    escalate: [fake/unpriced]\n',
            'budget:\n  max_usd_per_run: 2'
          ),
        }),
      }
    );
    expect(out.body.ready).toBe(false);
    const errors = out.body.checks.filter((c) => c.level === 'error').map((c) => c.message);
    expect(errors).toEqual([
      expect.stringMatching(/^Escalation model fake\/unpriced: .*has no price/),
    ]);
    expect(out.body.checks.map((c) => c.message).join('\n')).toMatch(
      /When a gate fails, the agent runs again with fake\/unpriced/
    );
  });

  it('previews fallback models: an unpriced one under a dollar budget is an error, an unusable one a warning', async () => {
    type Checks = { ready: boolean; checks: Array<{ level: string; message: string }> };
    const preview = (agent: string, extra = '') =>
      json<Checks>('/automations/preview', {
        method: 'POST',
        body: JSON.stringify({ spec: builtinSpec('builtin-fallback', agent, extra) }),
      });

    const unpriced = await preview(
      '  model:\n    primary: fake/priced\n    fallback: [fake/unpriced]\n',
      'budget:\n  max_usd_per_run: 2'
    );
    expect(unpriced.body.ready).toBe(false);
    expect(unpriced.body.checks.filter((c) => c.level === 'error').map((c) => c.message)).toEqual([
      expect.stringMatching(/^Fallback model fake\/unpriced: .*has no price/),
    ]);

    // Without a dollar budget the same model is fine; one with no key is only skipped when needed.
    delete process.env.FAKE_OTHER_KEY;
    const unusable = await preview(
      '  model:\n    primary: fake/priced\n    fallback: [fake/unpriced, other/m]\n'
    );
    expect(unusable.body.ready).toBe(true);
    expect(unusable.body.checks.filter((c) => c.level === 'error')).toEqual([]);
    const text = unusable.body.checks.map((c) => `${c.level}: ${c.message}`).join('\n');
    expect(text).toMatch(/warning: Fallback model other\/m: Other needs FAKE_OTHER_KEY/);
    expect(text).toMatch(
      /ok: When the model in use is unavailable .*fake\/unpriced, then other\/m/
    );
    expect(text).toMatch(/never falls back/);

    // A primary without its key starts the run with the fallback instead.
    delete process.env.FAKE_AUTOMATION_MODEL_KEY;
    process.env.FAKE_OTHER_KEY = 'k';
    const moved = await preview('  model:\n    primary: fake/priced\n    fallback: [other/m]\n');
    expect(moved.body.ready).toBe(true);
    expect(moved.body.checks.map((c) => c.message).join('\n')).toMatch(
      /fake\/priced is unavailable \(Fake needs FAKE_AUTOMATION_MODEL_KEY.*a run would start with other\/m/
    );
  });

  it('refuses a provider the registry does not know when saving, previewing or choosing a model for a run', async () => {
    const typo = builtinSpec(
      'builtin-typo',
      '  model:\n    primary: fakee/priced\n    fallback: [fake/priced]\n'
    );
    const saved = await save(typo);
    expect(saved.status).toBe(400);
    expect(saved.body).toMatchObject({ error: 'invalid_spec', line: 7 });
    expect(saved.body.message).toMatch(
      /Unknown provider "fakee" in "fakee\/priced"\. Known: fake, other\./
    );

    const preview = await json<{ error: string; line: number }>('/automations/preview', {
      method: 'POST',
      body: JSON.stringify({ spec: typo }),
    });
    expect(preview.status).toBe(400);
    expect(preview.body).toMatchObject({ error: 'invalid_spec', line: 7 });

    const fine = await save(builtinSpec('builtin-chosen', '  model: fake/priced\n'));
    const run = await json<{ error: string; message: string }>(`/automations/${fine.body.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ model: 'fakee/priced' }),
    });
    expect(run.status).toBe(400);
    expect(run.body).toMatchObject({ error: 'invalid_model' });
    expect(run.body.message).toMatch(/Unknown provider "fakee"/);
  });

  it('reads `version: 1`, and refuses another spec version when saving and previewing, by line', async () => {
    const withVersion = (v: string) => `version: ${v}\n${spec('versioned')}`;

    const newer = await save(withVersion('2'));
    expect(newer.status).toBe(400);
    expect(newer.body).toMatchObject({ error: 'invalid_spec', line: 1, column: 10 });
    expect(newer.body.message).toBe(
      'Line 1, column 10: This automation was written for spec version 2; this OpenClerq reads version 1.'
    );
    const preview = await json<{ error: string; line: number; message: string }>(
      '/v1/automations/preview',
      { method: 'POST', body: JSON.stringify({ spec: withVersion('2') }) }
    );
    expect(preview.status).toBe(400);
    expect(preview.body).toMatchObject({ error: 'invalid_spec', line: 1 });
    expect(preview.body.message).toContain('spec version 2');

    const fine = await save(withVersion('1'));
    expect(fine.status).toBe(201);
  });

  it('refuses a routing strategy with a plain reason, by line', async () => {
    const bad = await save(
      builtinSpec(
        'builtin-strategy',
        '  model:\n    primary: fake/priced\n    strategy: cost_aware\n'
      )
    );
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_spec', line: 8 });
    expect(bad.body.message).toMatch(
      /"agent.model.strategy".*planned after 1\.0.*"agent.model.fallback"/
    );
  });

  it('runs with a model named for the run, used as chosen', async () => {
    const id = await create('run-with-model');
    const refused = await json<{ error: string; message: string }>(`/automations/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ model: 7 }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_model');

    const { status, body } = await json<{ runId: string }>(`/automations/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ model: 'opus' }),
    });
    expect(status).toBe(202);
    const run = await waitForRun(
      body.runId,
      (r) => r.status === 'awaiting_approval' || finished(r)
    );
    expect(lastAgentInput?.model).toBe('opus');
    expect((run as RunView & { modelOverride?: string }).modelOverride).toBe('opus');
    await json(`/runs/${body.runId}/cancel`, { method: 'POST' });
  });

  it('refuses a model without its provider for the builtin agent, naming what is missing', async () => {
    const saved = await save(builtinSpec('builtin-run-model', '  model: fake/priced\n'));
    const res = await json<{ error: string; message: string }>(
      `/automations/${saved.body.id}/run`,
      {
        method: 'POST',
        body: JSON.stringify({ model: 'priced' }),
      }
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must name the provider too, as provider\/model/);
  });

  it('runs the tool loop in the worktree and records each model call, tool call and its cost', async () => {
    secrets = { GITHUB_TOKEN: FORGE_TOKEN, MODEL_KEY: 'vault-model-key' };
    modelReplies = [
      [
        { type: 'text', text: 'Writing the file.' },
        {
          type: 'tool_use',
          id: 'w1',
          name: 'write_file',
          input: { path: 'CHANGED.md', content: 'by builtin\n' },
        },
      ],
      [
        {
          type: 'tool_use',
          id: 's1',
          name: 'run_shell',
          input: { command: 'test -f CHANGED.md && echo present' },
        },
      ],
      [{ type: 'text', text: 'Added CHANGED.md.' }],
    ];
    const created = await save(
      builtinSpec(
        'builtin-run',
        '  model: fake/priced\n  api_key_secret: MODEL_KEY\n',
        'publish:\n  push: false\nbudget:\n  max_usd_per_run: 5'
      )
    );
    expect(created.status).toBe(201);
    const runId = await start(created.body.id);
    const run = await waitForRun(runId, finished);

    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.key)).toEqual([
      'vault-model-key',
      'vault-model-key',
      'vault-model-key',
    ]);
    // Three calls of 10k in at $1/M and 1k out at $2/M.
    expect(run.costUsd).toBeCloseTo(3 * 0.012, 9);
    const llm = run.steps.filter((s) => s.kind === 'llm' && s.status === 'ok');
    expect(llm.map((s) => s.input?.prompt)).toEqual([
      'Agent turn 1',
      'Agent turn 2',
      'Agent turn 3',
    ]);
    expect(
      run.steps.filter((s) => s.kind === 'tool').map((s) => [s.input?.name, s.status])
    ).toEqual(
      expect.arrayContaining([
        ['fs.write', 'ok'],
        ['runtime.shell', 'ok'],
      ])
    );
    expect(listToolCalls(runId).map((c) => [c.name, c.status, c.approvalState])).toEqual([
      ['fs.write', 'ok', 'not_required'],
      ['runtime.shell', 'ok', 'not_required'],
    ]);
    expect(sh(repo, 'show', `${run.branch}:CHANGED.md`)).toBe('by builtin');
    // The command it ran is recorded with the run, like a gate.
    const rows = getStore()
      .prepare('SELECT kind, command, ended_at FROM run_processes WHERE run_id = ? ORDER BY id')
      .all(runId);
    expect(rows[0]).toMatchObject({ kind: 'gate', command: '/bin/sh' });
    expect(rows.every((r) => r.ended_at !== null)).toBe(true);
  });

  it('waits in the approvals inbox for a write in default mode, then carries on', async () => {
    modelReplies = [
      [
        {
          type: 'tool_use',
          id: 'w1',
          name: 'write_file',
          input: { path: 'CHANGED.md', content: 'approved\n' },
        },
      ],
      [{ type: 'text', text: 'Done.' }],
    ];
    const created = await save(
      builtinSpec(
        'builtin-approve',
        '  model: fake/priced\n  permission_mode: default\n',
        'publish:\n  push: false'
      )
    );
    const runId = await start(created.body.id);
    await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
    const { body } = await json<{
      approvals: Array<{ id: number; runId: string; tool: string; tier: string }>;
    }>('/approvals');
    const pending = body.approvals.find((a) => a.runId === runId);
    expect(pending).toMatchObject({ tool: 'fs.write', tier: 'medium' });
    expect((await api(`/approvals/${pending?.id}/approve`, { method: 'POST' })).status).toBe(200);

    const run = await waitForRun(runId, finished);
    expect(run.status).toBe('done');
    expect(listToolCalls(runId)[0]).toMatchObject({
      name: 'fs.write',
      status: 'ok',
      approvalState: 'approved',
    });
  });

  it('closes the approval and keeps the run failed when the agent runs out of time while waiting', async () => {
    modelReplies = [
      [
        {
          type: 'tool_use',
          id: 'w1',
          name: 'write_file',
          input: { path: 'CHANGED.md', content: 'late\n' },
        },
      ],
    ];
    const created = await save(
      builtinSpec(
        'builtin-deadline',
        '  model: fake/priced\n  permission_mode: default\n',
        'publish:\n  push: false'
      ).replace('  profile: native', '  profile: native\n  timeout: 2s')
    );
    expect(created.status).toBe(201);
    const runId = await start(created.body.id);
    await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
    const run = await waitForRun(runId, finished, 10_000);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/Timed out/);
    const { body } = await json<{ approvals: Array<{ runId: string }> }>('/approvals');
    expect(body.approvals.some((a) => a.runId === runId)).toBe(false);
    const decided = getStore()
      .prepare('SELECT decision, decided_by FROM approvals WHERE run_id = ?')
      .all(runId);
    expect(decided).toEqual([{ decision: 'denied', decided_by: 'agent-stopped' }]);
    // Nothing flips the finished run back to executing afterwards.
    await new Promise((r) => setTimeout(r, 200));
    expect((await json<{ status: string }>(`/runs/${runId}`)).body.status).toBe('failed');
  });

  it('keeps vault values the run uses out of its stored steps and tool calls', async () => {
    modelReplies = [
      [
        {
          type: 'tool_use',
          id: 's1',
          name: 'run_shell',
          input: { command: `touch CHANGED.md; printf '%s' '${FORGE_TOKEN}'` },
        },
      ],
      [{ type: 'text', text: 'Done.' }],
    ];
    const created = await save(
      builtinSpec('builtin-scrub', '  model: fake/priced\n', 'publish:\n  pull_request: none')
    );
    const runId = await start(created.body.id);
    const waited = await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
    if (finished(waited)) throw new Error(`run ended: ${waited.status} ${waited.exitReason}`);
    await api(`/approvals/${await approvalFor(runId)}/deny`, { method: 'POST' });
    const run = await waitForRun(runId, finished);
    expect(run.status).toBe('cancelled');
    const stored = JSON.stringify({ steps: run.steps, calls: listToolCalls(runId) });
    expect(stored).not.toContain(FORGE_TOKEN);
    expect(listToolCalls(runId)[0].output).toContain('«redacted»');
  });

  it('can be cancelled while it waits for an approval', async () => {
    modelReplies = [
      [{ type: 'tool_use', id: 's1', name: 'run_shell', input: { command: 'echo hi' } }],
    ];
    const created = await save(
      builtinSpec(
        'builtin-cancel',
        '  model: fake/priced\n  permission_mode: default\n',
        'publish:\n  push: false'
      )
    );
    const runId = await start(created.body.id);
    await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
    expect((await api(`/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(200);
    const run = await waitForRun(runId, finished);
    expect(run.status).toBe('cancelled');
    const { body } = await json<{ approvals: Array<{ runId: string }> }>('/approvals');
    expect(body.approvals.some((a) => a.runId === runId)).toBe(false);
  });
});
