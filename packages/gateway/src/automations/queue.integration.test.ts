/**
 * The automation queue end to end, against a real store on disk and real git
 * repositories, with a scripted agent: queued runs surviving a restart, lease
 * expiry, missed-schedule catch-up, fairness across repositories, retries,
 * model escalation on a failed gate, and diff assertions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  builtin,
  type Driver,
  type DriverEvent,
  type DriverResult,
  type DriverRunInput,
} from '@clerq/drivers';
import { parseRegistry } from '@clerq/providers';
import { closeStore, getStore, initStore } from '../store.js';
import {
  addRunStep,
  cancelRun,
  claimAbandonedRun,
  createRun,
  failAbandonedRun,
  getRun,
  reapInterruptedRuns,
  requeueRun,
  unfinishedOf,
} from '../runs.js';
import { subscribeEvents, type ClerqEvent } from '../events.js';
import { readProcessTable, warmGatewayIdentity } from '../agent-processes.js';
import {
  createAutomation,
  ensureRepoRow,
  getAutomation,
  setAutomationEnabled,
  setLastSlotAt,
} from './store.js';
import {
  cancelQueuedRuns,
  enqueueAutomationRun,
  pauseAutomationQueue,
  resumeAutomationQueue,
  startAutomationQueue,
  stopAutomationQueue,
} from './queue.js';
import { MAX_RELAUNCHES, reclaimExpiredLeases, recoverAfterRestart } from './recovery.js';
import {
  checkSchedules,
  lastMissedSlots,
  startAutomationSchedules,
  stopAutomationSchedules,
  takeDueSlots,
} from './scheduler.js';
import type { RunnerDeps } from './runner.js';

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// A scripted agent
// ---------------------------------------------------------------------------

interface Call {
  model?: string;
  prompt: string;
  maxBudgetUsd?: number;
  cwd: string;
}
const calls: Call[] = [];

type Behaviour = (input: DriverRunInput) => Promise<Partial<DriverResult>> | Partial<DriverResult>;
/** What the agent does, call by call; the last one repeats. */
let script: Behaviour[] = [];
let costPerCall = 0.25;
/** Calls to the `hold` agent wait here until released. */
let releases: Array<() => void> = [];

const write =
  (file: string, text: string): Behaviour =>
  (input) => {
    fs.writeFileSync(path.join(input.cwd, file), text);
    return {};
  };
const hold: Behaviour = (input) =>
  new Promise((resolve) => {
    releases.push(() => resolve({}));
    input.signal?.addEventListener('abort', () => resolve({ cancelled: true, ok: false }));
  });
const crash: Behaviour = () => ({
  ok: false,
  crashed: true,
  exitCode: null,
  costUsd: null,
  summary: 'claude exited with code none before reporting a result.',
});

function scripted(id: string): Driver {
  return {
    id,
    async detect() {
      return { id, available: true, version: 'test', path: `/fake/${id}` };
    },
    run: (input) => runScripted(input),
  };
}

async function* runScripted(input: DriverRunInput): AsyncIterable<DriverEvent> {
  calls.push({
    model: input.model,
    prompt: input.prompt,
    maxBudgetUsd: input.maxBudgetUsd,
    cwd: input.cwd,
  });
  const step = script[Math.min(calls.length - 1, script.length - 1)] ?? write('OUT.md', 'x\n');
  yield { type: 'started', model: input.model ?? 'fake-model' };
  const over = await step(input);
  yield {
    type: 'finished',
    result: {
      ok: true,
      summary: 'Did the task.',
      costUsd: costPerCall,
      tokensIn: 100,
      tokensOut: 10,
      durationMs: 1,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      permissionDenials: [],
      warnings: [],
      ...over,
    },
  };
}

/** The builtin agent over a scripted model API, for provider errors and pricing. */
/** The model registry, as YAML: the gateway checks a spec's models against it as well as the agent. */
const MODEL_REGISTRY_YAML = `
providers:
  - id: fake
    label: Fake
    adapter: anthropic
    baseUrl: https://fake.invalid/v1
    authEnv: FAKE_QUEUE_MODEL_KEY
    models:
      - id: priced
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: unpriced
        context: 200000
`;
const MODEL_REGISTRY = parseRegistry(MODEL_REGISTRY_YAML);
let modelStatuses: number[] = [];
const fakeModel = (async () => {
  const status = modelStatuses.shift() ?? 200;
  const body =
    status === 200
      ? JSON.stringify({
          content: [{ type: 'text', text: 'Done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      : '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  return { ok: status === 200, status, text: async () => body } as Response;
}) as unknown as typeof fetch;
const builtinDriver = builtin({ registry: () => MODEL_REGISTRY, fetch: fakeModel });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string;
let savedProvidersFile: string | undefined;
let dbFile: string;
const repos: Record<string, string> = {};

const deps: RunnerDeps = {
  getSecret: () => undefined,
  path: () => process.env.PATH ?? '',
  driverFor: (id) => (id === 'builtin' ? builtinDriver : scripted(id)),
  workspaceCacheDir: '',
  maxConcurrent: 2,
  leaseMs: 400,
};

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

function makeRepo(name: string): string {
  const dir = path.join(root, name);
  sh(root, 'init', '-q', '-b', 'main', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

let counter = 0;
function automation(
  extra = '',
  opts: { repo?: string; prompt?: string; driver?: string; off?: boolean } = {}
) {
  counter += 1;
  const source = [
    `name: q-${counter}`,
    'targets:',
    `  repos: [local:${opts.repo ?? repos.a}]`,
    'agent:',
    `  driver: ${opts.driver ?? 'claude-code'}`,
    `prompt: ${opts.prompt ?? `task ${counter}`}`,
    'sandbox:',
    '  profile: native',
    'publish:',
    '  push: false',
    extra,
  ].join('\n');
  // Switched on, as a scheduled automation is; without a schedule it only runs when queued here.
  const created = createAutomation(source);
  return opts.off ? created : setAutomationEnabled(created.id, true);
}

type RunView = NonNullable<ReturnType<typeof getRun>>;
type Step = {
  kind: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
};
const steps = (r: RunView) => r.steps as Step[];
const named = (r: RunView, name: string) => steps(r).filter((s) => s.input?.name === name);

async function waitFor(
  runId: string,
  until: (r: RunView) => boolean,
  ms = 15_000
): Promise<RunView> {
  const end = Date.now() + ms;
  for (;;) {
    const r = getRun(runId);
    if (r && until(r)) return r;
    if (Date.now() > end)
      throw new Error(`run ${runId} stuck in ${r?.status}: ${r?.exitReason ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const finished = (r: RunView) => ['done', 'failed', 'cancelled'].includes(r.status);

function enqueue(a: ReturnType<typeof createAutomation>): string {
  const queued = enqueueAutomationRun(getAutomation(a.id)!, 'manual', deps, { ifBusy: 'refuse' });
  return queued!.runId;
}

function row(runId: string): Record<string, unknown> {
  return getStore().prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Record<
    string,
    unknown
  >;
}

/** A pid nobody holds: an owner that is gone. */
async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

/** An unfinished run as a gateway that stopped would leave it. */
function abandoned(
  a: ReturnType<typeof createAutomation>,
  status: string,
  owner: { pid: number; start: string | null },
  leaseUntil: string | null
): string {
  const id = createRun({
    trigger: 'schedule',
    automationId: a.id,
    status: 'executing',
    repoId: ensureRepoRow(a.spec!),
  });
  getStore()
    .prepare(
      'UPDATE runs SET status = ?, owner_pid = ?, owner_start = ?, lease_until = ? WHERE id = ?'
    )
    .run(status, owner.pid, owner.start, leaseUntil, id);
  return id;
}

const past = () => new Date(Date.now() - 60_000).toISOString();

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-queue-')));
  savedProvidersFile = process.env.CLERQ_PROVIDERS_FILE;
  fs.writeFileSync(path.join(root, 'providers.yaml'), MODEL_REGISTRY_YAML);
  process.env.CLERQ_PROVIDERS_FILE = path.join(root, 'providers.yaml');
  dbFile = path.join(root, 'clerq.db');
  deps.workspaceCacheDir = path.join(root, 'cache');
  repos.a = makeRepo('repo-a');
  repos.b = makeRepo('repo-b');
  await initStore(dbFile);
  await warmGatewayIdentity();
  startAutomationQueue(deps);
}, 20_000);

afterAll(() => {
  if (savedProvidersFile === undefined) delete process.env.CLERQ_PROVIDERS_FILE;
  else process.env.CLERQ_PROVIDERS_FILE = savedProvidersFile;
  stopAutomationSchedules();
  stopAutomationQueue();
  closeStore();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  script = [write('OUT.md', 'x\n')];
  costPerCall = 0.25;
  modelStatuses = [];
  deps.maxConcurrent = 2;
  resumeAutomationQueue();
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  stopAutomationSchedules();
  // Nothing from one test may still be queued or going in the next.
  cancelQueuedRuns('test over');
  for (const r of getStore()
    .prepare("SELECT id FROM runs WHERE status NOT IN ('done','failed','cancelled')")
    .all()) {
    cancelRun(String(r.id), 'test over');
  }
  for (let i = 0; i < 200; i++) {
    const left = getStore()
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('done','failed','cancelled')")
      .get();
    if (Number(left?.n) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  reapInterruptedRuns();
});

// ---------------------------------------------------------------------------
// A. Durable queue, leases, catch-up
// ---------------------------------------------------------------------------

describe('the run queue', () => {
  it('runs a queued run to the end, through leased, with a lease that is renewed', async () => {
    script = [hold, write('OUT.md', 'x\n')];
    const a = automation();
    const id = enqueue(a);
    const going = await waitFor(id, (r) => r.status === 'executing');
    const first = String(row(id).lease_until);
    expect(Date.parse(first)).toBeGreaterThan(Date.now());
    expect(row(id)).toMatchObject({ owner_pid: process.pid, attempt: 1 });
    expect(going.startedAt).toBeTruthy();
    // Renewed within a few lease periods, however busy the machine is.
    for (let i = 0; i < 100 && String(row(id).lease_until) === first; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(Date.parse(String(row(id).lease_until))).toBeGreaterThan(Date.parse(first));
    releases.splice(0).forEach((r) => r());
    const done = await waitFor(id, finished);
    expect(done.status).toBe('done');
    expect(row(id).lease_until).toBeNull();
  });

  it('keeps queued runs across a restart and starts them when the gateway is back', async () => {
    const a = automation();
    pauseAutomationQueue();
    const id = enqueue(a);
    expect(getRun(id)?.status).toBe('queued');
    expect(getRun(id)?.startedAt).toBeUndefined();

    // The gateway stops: queue gone, store closed. Then it starts again.
    stopAutomationQueue();
    closeStore();
    await initStore(dbFile);
    await recoverAfterRestart();
    expect(getRun(id)?.status).toBe('queued');
    expect(calls).toHaveLength(0);

    startAutomationQueue(deps);
    const run = await waitFor(id, finished);
    expect(run.status).toBe('done');
    expect(calls).toHaveLength(1);
  });

  it('cancels a run that is still waiting, by hand or when its automation is switched off', async () => {
    const a = automation();
    pauseAutomationQueue();
    const id = enqueue(a);
    expect(cancelRun(id, 'Not now')).toBe(true);
    expect(getRun(id)).toMatchObject({ status: 'cancelled', exitReason: 'Not now' });

    setAutomationEnabled(a.id, true);
    const next = enqueue(a);
    setAutomationEnabled(a.id, false);
    expect(getRun(next)).toMatchObject({
      status: 'cancelled',
      exitReason: 'The automation was switched off before this run started.',
    });
    resumeAutomationQueue();
    expect(calls).toHaveLength(0);
  });

  it('refuses a second run of a busy automation by hand, and queues one behind it for a schedule', async () => {
    script = [hold, write('OUT.md', 'x\n')];
    const a = automation();
    const first = enqueue(a);
    await waitFor(first, (r) => r.status === 'executing');
    expect(() => enqueue(a)).toThrow(/already running/);
    const behind = enqueueAutomationRun(getAutomation(a.id)!, 'schedule', deps, { ifBusy: 'once' });
    expect(behind && getRun(behind.runId)?.status).toBe('queued');
    // A third firing while one waits is not queued again.
    expect(
      enqueueAutomationRun(getAutomation(a.id)!, 'schedule', deps, { ifBusy: 'once' })
    ).toBeNull();
    releases.splice(0).forEach((r) => r());
    expect((await waitFor(first, finished)).status).toBe('done');
    expect((await waitFor(behind!.runId, finished)).status).toBe('done');
  });
});

describe.skipIf(isWindows)('lease expiry', () => {
  let other: ChildProcess | undefined;
  afterEach(() => {
    if (other?.pid) process.kill(other.pid, 'SIGKILL');
    other = undefined;
  });

  it('retries a run whose gateway died, once its lease has expired', async () => {
    const a = automation('retry:\n  max_retries: 1\n  backoff: 50ms');
    const id = abandoned(
      a,
      'executing',
      { pid: await deadPid(), start: new Date().toISOString() },
      past()
    );
    await reclaimExpiredLeases();
    const run = await waitFor(id, finished);
    expect(run.status).toBe('done');
    expect(row(id).attempt).toBe(2);
    expect(named(run, 'run.retry')[0]?.output).toMatchObject({
      cause: 'lease_expired',
      stage: 'executing',
    });
    expect(calls).toHaveLength(1);
  });

  it('fails such a run when its spec has no retries, and says why', async () => {
    const a = automation();
    const id = abandoned(a, 'verifying', { pid: await deadPid(), start: null }, past());
    // The queue's own check may get there first; either way it ends the same.
    await reclaimExpiredLeases();
    const run = await waitFor(id, finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/Lease expired/);
    expect(calls).toHaveLength(0);
  });

  it('puts a run that was only leased back in the queue as the same attempt', async () => {
    const a = automation();
    const id = abandoned(a, 'leased', { pid: await deadPid(), start: null }, past());
    await reclaimExpiredLeases();
    const run = await waitFor(id, finished);
    expect(run.status).toBe('done');
    expect(row(id).attempt).toBe(1);
  });

  it('reclaims a run of its own that nothing is working on', async () => {
    const a = automation();
    const id = abandoned(a, 'executing', { pid: process.pid, start: null }, past());
    await reclaimExpiredLeases();
    expect((await waitFor(id, finished)).status).toBe('failed');
  });

  it('leaves alone the run of a gateway that is still running, however old its lease', async () => {
    other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    let startMs: number | undefined;
    for (let i = 0; i < 100 && startMs === undefined; i++) {
      startMs = (await readProcessTable())?.find((p) => p.pid === other!.pid)?.startMs;
      if (startMs === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const a = automation();
    const id = abandoned(
      a,
      'executing',
      { pid: other.pid as number, start: new Date(startMs as number).toISOString() },
      past()
    );
    expect(await reclaimExpiredLeases()).not.toContain(id);
    expect(getRun(id)?.status).toBe('executing');
    // At startup too.
    await recoverAfterRestart();
    expect(getRun(id)?.status).toBe('executing');
    getStore().prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(id);
  });

  it('puts a run that keeps losing its gateway before it starts back only three times', async () => {
    const a = automation();
    const id = abandoned(a, 'leased', { pid: await deadPid(), start: null }, past());
    for (let i = 1; i <= MAX_RELAUNCHES; i++) {
      addRunStep(id, { kind: 'tool', input: { name: 'run.requeue', relaunch: i } });
    }
    await reclaimExpiredLeases();
    const run = await waitFor(id, finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/stopped 4 times before the run could start/);
    expect(calls).toHaveLength(0);
  });

  it('does not retry an abandoned run of an automation that is switched off', async () => {
    const a = automation('retry:\n  max_retries: 2\n  backoff: 10ms', { off: true });
    const id = abandoned(a, 'executing', { pid: await deadPid(), start: null }, past());
    await reclaimExpiredLeases();
    const run = await waitFor(id, finished);
    expect(run.exitReason).toMatch(/Not retried: the automation is switched off/);
    expect(calls).toHaveLength(0);
  });

  it('leaves a run alone when another gateway claims it while this one is still checking', async () => {
    // Two gateways on one store both find this run abandoned. This one reads
    // it, then, while it asks the OS which gateways are alive, the other one
    // claims it. This one's claim must then fail, and remove nothing.
    const a = automation('retry:\n  max_retries: 2\n  backoff: 10ms');
    // Both pids first: from the moment the run exists nothing may yield to the event loop
    // until the other gateway's claim is written, or this gateway's own reaper timer can
    // find the run first on a busy machine.
    const dead = await deadPid();
    const other = await deadPid();
    const id = abandoned(a, 'executing', { pid: dead, start: null }, past());
    const worktree = path.join(root, `wt-${id}`);
    fs.mkdirSync(worktree);
    addRunStep(id, {
      kind: 'git',
      input: { action: 'worktree' },
      output: { path: worktree },
      status: 'ok',
    });
    const checking = reclaimExpiredLeases();
    // The other gateway's claim, as claimAbandonedRun writes it.
    getStore()
      .prepare('UPDATE runs SET owner_pid = ?, owner_start = NULL WHERE id = ? AND owner_pid = ?')
      .run(other, id, dead);
    expect(await checking).not.toContain(id);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(row(id)).toMatchObject({ status: 'executing', owner_pid: other, attempt: 1 });
    getStore().prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(id);
  });

  it('lets only one of two gateways claim an abandoned run read the same way', async () => {
    const a = automation();
    const id = abandoned(a, 'verifying', { pid: await deadPid(), start: null }, past());
    const read = unfinishedOf(row(id));
    const before = new Date().toISOString();
    expect(claimAbandonedRun(read, { leaseMs: 60_000, leaseBefore: before })).toBe(true);
    // The second, from the same stale read: the owner and the lease have changed.
    expect(claimAbandonedRun(read, { leaseMs: 60_000, leaseBefore: before })).toBe(false);
    expect(row(id).owner_pid).toBe(process.pid);
    // And a requeue or failure only takes effect from the state and owner expected.
    expect(failAbandonedRun(id, 'x', { from: 'executing', ownerPid: process.pid })).toBe(false);
    expect(requeueRun(id, { reason: 'x', from: 'verifying', ownerPid: 1 })).toBe(false);
    expect(failAbandonedRun(id, 'gone', { from: 'verifying', ownerPid: process.pid })).toBe(true);
  });

  it('does not retry a run that was waiting for approval when its gateway died', async () => {
    const a = automation('retry:\n  max_retries: 2\n  backoff: 50ms');
    const id = abandoned(a, 'awaiting_approval', { pid: await deadPid(), start: null }, past());
    await recoverAfterRestart();
    expect(getRun(id)).toMatchObject({
      status: 'failed',
      exitReason: expect.stringMatching(/Interrupted/),
    });
  });
});

describe('missed schedule slots', () => {
  // 10:30 local time on a fixed day; the automation last dealt with 07:15.
  const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m).getTime();
  let wall = 0;
  let mono = 0;
  const clock = { now: () => wall, mono: () => mono };

  function scheduled(catchUp: boolean) {
    const a = automation(`on:\n  schedule: '0 * * * *'\n  catch_up: ${catchUp}`);
    setAutomationEnabled(a.id, true);
    setLastSlotAt(a.id, new Date(at(7, 15)));
    return a;
  }
  const runsOf = (id: string) =>
    getStore()
      .prepare('SELECT id FROM runs WHERE automation_id = ? ORDER BY created_at')
      .all(id)
      .map((r) => String(r.id));

  it('catches up the slots missed while the gateway was down with one run, on start', async () => {
    const a = scheduled(true);
    wall = at(10, 30);
    mono = 0;
    startAutomationSchedules(deps, { clock, timers: false });
    const ids = runsOf(a.id);
    expect(ids).toHaveLength(1);
    const run = await waitFor(ids[0], finished);
    expect(run).toMatchObject({ status: 'done', trigger: 'schedule' });
    expect(named(run, 'schedule.catch_up')[0]?.output).toMatchObject({
      missedSlots: 3,
      slot: new Date(at(10)).toISOString(),
      noticed: 'start',
    });
    // Checking again finds nothing new.
    checkSchedules();
    expect(runsOf(a.id)).toHaveLength(1);
    setAutomationEnabled(a.id, false);
  });

  it('skips missed slots without catch_up, and records them', () => {
    const a = scheduled(false);
    wall = at(10, 30);
    startAutomationSchedules(deps, { clock, timers: false });
    expect(runsOf(a.id)).toHaveLength(0);
    expect(lastMissedSlots(a.id)).toMatchObject({
      count: 3,
      first: new Date(at(8)).toISOString(),
      last: new Date(at(10)).toISOString(),
      reason: 'catch_up_off',
      noticed: 'start',
    });
    setAutomationEnabled(a.id, false);
  });

  it('runs the slot that is due on time and records only the earlier ones as missed', async () => {
    const a = scheduled(false);
    wall = at(10, 1);
    startAutomationSchedules(deps, { clock, timers: false });
    const ids = runsOf(a.id);
    expect(ids).toHaveLength(1);
    expect(named(await waitFor(ids[0], finished), 'schedule.catch_up')).toHaveLength(0);
    expect(lastMissedSlots(a.id)).toMatchObject({
      count: 2,
      last: new Date(at(9)).toISOString(),
    });
    setAutomationEnabled(a.id, false);
  });

  it('notices a sleep as the wall clock jumping past the monotonic one, and catches up once', async () => {
    const woke: ClerqEvent[] = [];
    const off = subscribeEvents((e) => {
      if (e.name === 'schedule.woke') woke.push(e);
    });
    const a = scheduled(true);
    setLastSlotAt(a.id, new Date(at(6, 59)));
    wall = at(7, 0);
    mono = 1_000;
    startAutomationSchedules(deps, { clock, timers: false });
    // The 07:00 slot was on time.
    const first = runsOf(a.id);
    expect(first).toHaveLength(1);
    await waitFor(first[0], finished);

    // The lid closes for three and a half hours: the monotonic clock stops.
    wall = at(10, 30);
    mono = 16_000;
    checkSchedules('tick');
    await new Promise((resolve) => setTimeout(resolve, 20));
    off();
    expect(woke).toHaveLength(1);
    expect((woke[0].payload as { sleptMs: number }).sleptMs).toBeGreaterThan(3 * 3_600_000);
    const ids = runsOf(a.id);
    expect(ids).toHaveLength(2);
    const caught = await waitFor(ids[1], finished);
    expect(named(caught, 'schedule.catch_up')[0]?.output).toMatchObject({
      missedSlots: 3,
      noticed: 'wake',
    });
    setAutomationEnabled(a.id, false);
  });

  it('lets only one of two gateways that read the same slot queue its run', async () => {
    const a = scheduled(false);
    wall = at(7, 20);
    startAutomationSchedules(deps, { clock, timers: false });
    expect(runsOf(a.id)).toHaveLength(0);
    // Both gateways read last_slot_at as 07:15, then both find 08:00 due.
    const read = new Date(at(7, 15)).toISOString();
    takeDueSlots(getAutomation(a.id)!, read, new Date(at(8, 0)), 'tick');
    takeDueSlots(getAutomation(a.id)!, read, new Date(at(8, 0)), 'tick');
    const ids = runsOf(a.id);
    expect(ids).toHaveLength(1);
    expect(lastMissedSlots(a.id)).toBeNull();
    expect(
      getStore().prepare('SELECT last_slot_at FROM automations WHERE id = ?').get(a.id)
        ?.last_slot_at
    ).toBe(new Date(at(8)).toISOString());
    await waitFor(ids[0], finished);
    setAutomationEnabled(a.id, false);
  });

  it('records a slot as missed when its run cannot be queued, and does not try it again', () => {
    const a = scheduled(true);
    // The store refuses the run, as a full disk would.
    getStore().exec(
      `CREATE TEMP TRIGGER refuse_run BEFORE INSERT ON runs WHEN NEW.automation_id = '${a.id}'
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
    );
    try {
      wall = at(10, 30);
      startAutomationSchedules(deps, { clock, timers: false });
    } finally {
      getStore().exec('DROP TRIGGER refuse_run');
    }
    expect(runsOf(a.id)).toHaveLength(0);
    expect(lastMissedSlots(a.id)).toMatchObject({
      count: 3,
      reason: 'enqueue_failed',
      error: expect.stringMatching(/disk I\/O error/),
      last: new Date(at(10)).toISOString(),
    });
    // The slots are used up: the next check does not queue them after all.
    checkSchedules();
    expect(runsOf(a.id)).toHaveLength(0);
    setAutomationEnabled(a.id, false);
  });

  it('records a slot as missed when a run of the automation is still waiting', () => {
    const a = scheduled(false);
    pauseAutomationQueue();
    enqueue(a);
    wall = at(8, 0);
    setLastSlotAt(a.id, new Date(at(7, 15)));
    startAutomationSchedules(deps, { clock, timers: false });
    expect(runsOf(a.id)).toHaveLength(1);
    expect(lastMissedSlots(a.id)).toMatchObject({
      count: 1,
      reason: 'already_queued',
      last: new Date(at(8)).toISOString(),
    });
    setAutomationEnabled(a.id, false);
  });

  it('never catches up slots the kill switch held paused', () => {
    const a = scheduled(true);
    wall = at(10, 30);
    startAutomationSchedules(deps, { clock, timers: false, resume: true });
    expect(runsOf(a.id)).toHaveLength(0);
    expect(lastMissedSlots(a.id)).toMatchObject({ count: 3, reason: 'paused' });
    setAutomationEnabled(a.id, false);
  });

  it('counts a new schedule from when it is switched on', () => {
    const a = automation(`on:\n  schedule: '* * * * *'\n  catch_up: true`);
    setAutomationEnabled(a.id, true);
    wall = Date.now();
    startAutomationSchedules(deps, { clock, timers: false });
    expect(runsOf(a.id)).toHaveLength(0);
    setAutomationEnabled(a.id, false);
  });
});

// ---------------------------------------------------------------------------
// B. Fairness
// ---------------------------------------------------------------------------

describe('fair scheduling', () => {
  it('takes runs round-robin across repositories, oldest first within one', async () => {
    deps.maxConcurrent = 1;
    // Repositories no run has used yet, so earlier tests do not count as served.
    const busy = makeRepo('repo-busy');
    const quiet = makeRepo('repo-quiet');
    pauseAutomationQueue();
    const ids: string[] = [];
    for (const [repo, prompt] of [
      [busy, 'a1'],
      [busy, 'a2'],
      [busy, 'a3'],
      [quiet, 'b1'],
    ]) {
      ids.push(enqueue(automation('', { repo, prompt })));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    resumeAutomationQueue();
    for (const id of ids) expect((await waitFor(id, finished)).status).toBe('done');
    expect(calls.map((c) => c.prompt)).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('holds runs beyond the limit in the queue until a place frees', async () => {
    deps.maxConcurrent = 1;
    script = [hold, write('OUT.md', 'x\n')];
    const first = enqueue(automation());
    await waitFor(first, (r) => r.status === 'executing');
    const second = enqueue(automation('', { repo: repos.b }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getRun(second)?.status).toBe('queued');
    releases.splice(0).forEach((r) => r());
    expect((await waitFor(second, finished)).status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// C. Retries and escalation
// ---------------------------------------------------------------------------

describe('retries', () => {
  it('tries a run again after the agent crashed, after its backoff', async () => {
    script = [crash, write('OUT.md', 'x\n')];
    const id = enqueue(automation('retry:\n  max_retries: 2\n  backoff: 100ms'));
    const run = await waitFor(id, finished);
    expect(run.status).toBe('done');
    expect(row(id).attempt).toBe(2);
    const retry = named(run, 'run.retry');
    expect(retry).toHaveLength(1);
    expect(retry[0].output).toMatchObject({ cause: 'driver_crash' });
    expect(calls).toHaveLength(2);
    // The crashed attempt reported no cost, so the run's is a lower bound.
    expect(run).toMatchObject({ costUsd: 0.25, costKnown: false });
    expect((run.steps as Step[]).filter((s) => s.kind === 'llm').map((s) => s.status)).toEqual([
      'unaccounted',
      'ok',
    ]);
  });

  it('gives up once the retries are used up', async () => {
    script = [crash];
    const id = enqueue(automation('retry:\n  max_retries: 1\n  backoff: 50ms'));
    const run = await waitFor(id, finished);
    expect(run).toMatchObject({ status: 'failed' });
    expect(run.exitReason).toMatch(/before reporting a result/);
    expect(calls).toHaveLength(2);
  });

  it('retries a provider that was overloaded (builtin)', async () => {
    process.env.FAKE_QUEUE_MODEL_KEY = 'k';
    modelStatuses = [529];
    const a = automation(
      'retry:\n  max_retries: 1\n  backoff: 50ms\nbudget:\n  max_usd_per_run: 1',
      {
        driver: 'builtin\n  model: fake/priced',
      }
    );
    const run = await waitFor(enqueue(a), finished);
    expect(run.status).toBe('done');
    expect(named(run, 'run.retry')[0]?.output).toMatchObject({ cause: 'provider_unavailable' });
    expect(run.exitReason).toMatch(/No changes/);
  });

  it('never retries a failure that is a decision, a denial or the task itself', async () => {
    for (const behaviour of [
      () => ({ ok: false, summary: 'The agent gave up.' }),
      () => ({ ok: false, crashed: true, permissionDenials: [{ tool: 'Bash' }] }),
      () => ({ ok: false, timedOut: true, summary: 'Timed out after 1s.' }),
    ] as Behaviour[]) {
      calls.length = 0;
      script = [behaviour];
      const run = await waitFor(
        enqueue(automation('retry:\n  max_retries: 3\n  backoff: 10ms')),
        finished
      );
      expect(run.status).toBe('failed');
      expect(named(run, 'run.retry')).toHaveLength(0);
      expect(calls).toHaveLength(1);
    }
  });

  it('does not retry a run of an automation that is switched off', async () => {
    script = [crash, write('OUT.md', 'x\n')];
    const run = await waitFor(
      enqueue(automation('retry:\n  max_retries: 2\n  backoff: 10ms', { off: true })),
      finished
    );
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/Not retried: the automation is switched off\.$/);
    expect(calls).toHaveLength(1);
  });

  it('can be cancelled while it waits out its backoff', async () => {
    script = [crash];
    const id = enqueue(automation('retry:\n  max_retries: 1\n  backoff: 1h'));
    const waiting = await waitFor(id, (r) => r.status === 'queued' && calls.length === 1);
    expect(waiting.exitReason).toMatch(/^Retry 1 of 1 after:/);
    expect(cancelRun(id)).toBe(true);
    expect(getRun(id)?.status).toBe('cancelled');
  });
});

describe('model escalation on a failed gate', () => {
  const gate = 'gates:\n  - run: grep -q strong OUT.md > gate.log 2>&1';
  const escalate = (models: string) =>
    automation(gate, {
      driver: `claude-code\n  model:\n    primary: weak\n    escalate: ${models}`,
    });

  it('runs the agent again with the next model in the same worktree, keeping one commit', async () => {
    const seen: Array<{ out: string; gateLog: boolean }> = [];
    const after =
      (text: string): Behaviour =>
      (input) => {
        // The earlier attempt's work is here, and nothing the gate wrote.
        seen.push({
          out: fs.readFileSync(path.join(input.cwd, 'OUT.md'), 'utf8'),
          gateLog: fs.existsSync(path.join(input.cwd, 'gate.log')),
        });
        fs.writeFileSync(path.join(input.cwd, 'OUT.md'), text);
        return {};
      };
    script = [write('OUT.md', 'weak\n'), after('mid\n'), after('strong\n')];
    const a = escalate('[mid, strong]');
    const run = await waitFor(enqueue(a), finished);
    expect(run.status).toBe('done');
    expect(calls.map((c) => c.model)).toEqual(['weak', 'mid', 'strong']);
    expect(calls[1].prompt).toMatch(/did not pass this check:\n\ngrep -q strong OUT.md/);
    const steps = named(run, 'agent.escalate');
    expect(steps.map((s) => s.input?.model)).toEqual(['mid', 'strong']);
    expect((run.steps as Step[]).filter((s) => s.kind === 'gate').map((s) => s.status)).toEqual([
      'failed',
      'failed',
      'passed',
    ]);
    // One commit on the branch, without the gate's log.
    const files = sh(repos.a, 'show', '--name-only', '--format=', run.branch as string).split('\n');
    expect(files).toEqual(['OUT.md']);
    expect(sh(repos.a, 'rev-list', '--count', `main..${run.branch}`)).toBe('1');
    expect(seen).toEqual([
      { out: 'weak\n', gateLog: false },
      { out: 'mid\n', gateLog: false },
    ]);
    expect(run.costUsd).toBeCloseTo(0.75);
  });

  it('gives each attempt only what is left of the run budget, and stops when it is spent', async () => {
    script = [write('OUT.md', 'weak\n')];
    const roomy = await waitFor(enqueue(escalateWithBudget('0.60')), finished);
    expect(roomy.status).toBe('failed');
    expect(calls.map((c) => c.maxBudgetUsd)).toEqual([0.6, 0.35, 0.1]);

    calls.length = 0;
    const tight = await waitFor(enqueue(escalateWithBudget('0.50')), finished);
    expect(tight.status).toBe('failed');
    expect(tight.exitReason).toMatch(/run's budget of \$0.50 is spent/);
    expect(calls).toHaveLength(2);
  });

  function escalateWithBudget(perRun: string) {
    return automation(`${gate}\nbudget:\n  max_usd_per_run: ${perRun}`, {
      driver: 'claude-code\n  model:\n    primary: weak\n    escalate: [mid, strong]',
    });
  }

  it('stops escalating when the month is spent', async () => {
    script = [write('OUT.md', 'weak\n')];
    const a = automation(`${gate}\nbudget:\n  max_usd_per_month: 0.25`, {
      driver: 'claude-code\n  model:\n    primary: weak\n    escalate: [strong]',
    });
    const run = await waitFor(enqueue(a), finished);
    expect(run.exitReason).toMatch(/monthly budget of \$0.25 is spent/);
    expect(calls).toHaveLength(1);
  });

  it('refuses before any work an unpriced escalation model when the spec has a dollar budget', async () => {
    process.env.FAKE_QUEUE_MODEL_KEY = 'k';
    const a = automation(`${gate}\nbudget:\n  max_usd_per_run: 1`, {
      driver: 'builtin\n  model:\n    primary: fake/priced\n    escalate: [fake/unpriced]',
    });
    const run = await waitFor(enqueue(a), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Escalation model fake\/unpriced: fake\/unpriced has no price/);
    expect((run.steps as Step[]).some((s) => s.kind === 'llm')).toBe(false);
  });

  it('fails with the last gate failure when every model has been tried', async () => {
    script = [write('OUT.md', 'weak\n')];
    const run = await waitFor(enqueue(escalate('[mid]')), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Gate failed: grep -q strong/);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// D. Diff assertions
// ---------------------------------------------------------------------------

describe('diff assertions', () => {
  it('passes a run whose diff keeps to the rules, recording each as a gate step', async () => {
    script = [write('OUT.md', 'one\ntwo\n')];
    const a = automation(
      'gates:\n  - assert: diff.files_changed <= 1\n  - assert: diff.lines_added == 2\n  - assert: diff.touches_none_of [src/**, .github/**]\n  - assert: diff.touches_only [OUT.md]'
    );
    const run = await waitFor(enqueue(a), finished);
    expect(run.status).toBe('done');
    const gates = (run.steps as Step[]).filter((s) => s.kind === 'gate');
    expect(gates.map((g) => [g.input?.assert, g.status])).toEqual([
      ['diff.files_changed <= 1', 'passed'],
      ['diff.lines_added == 2', 'passed'],
      ['diff.touches_none_of [src/**, .github/**]', 'passed'],
      ['diff.touches_only [OUT.md]', 'passed'],
    ]);
    expect(gates[0].output).toMatchObject({ actual: 1 });
  });

  it('fails a run that touches what it must not, naming the paths', async () => {
    script = [
      (input) => {
        fs.writeFileSync(path.join(input.cwd, 'src', 'a.ts'), 'export const x = 1;\n');
        fs.writeFileSync(path.join(input.cwd, 'OUT.md'), 'x\n');
        return {};
      },
    ];
    const a = automation('gates:\n  - assert: diff.touches_none_of [src/**]\n  - run: "true"');
    const run = await waitFor(enqueue(a), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Assertion failed: diff.touches_none_of \[src\/\*\*\]/);
    const gates = (run.steps as Step[]).filter((s) => s.kind === 'gate');
    // The command after it never ran.
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ status: 'failed', output: { offending: ['src/a.ts'] } });
  });
});
