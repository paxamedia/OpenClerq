/**
 * Sub-agents of the builtin agent, end to end: a parent run's agent calls
 * `sessions.spawn`, the child runs as a run of its own, linked to the parent,
 * under a policy cut from the parent's, sharing its budget, stopped with it,
 * asking for approval in the same inbox. The store, the repository and the
 * builtin driver are real; the model API is a fake that answers from a script.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtin } from '@clerq/drivers';
import { parseRegistry } from '@clerq/providers';
import { closeStore, getStore, initStore } from '../store.js';
import {
  cancelAllRuns,
  cancelRun,
  createRun,
  getRun,
  INTERRUPTED,
  listRuns,
  reapInterruptedRuns,
} from '../runs.js';
import { subscribeEvents, type ClerqEvent } from '../events.js';
import { warmGatewayIdentity } from '../agent-processes.js';
import { decide, denyAllPending, listPending, requestApproval } from '../approvals.js';
import { recoverAfterRestart } from './recovery.js';
import { createSubagentSession, getSession, listMessages, listSessions } from '../chat/sessions.js';
import { addRecord, clearMemory } from '../memory-layer.js';
import { createAutomation, getAutomation, monthSpendUsd, setAutomationEnabled } from './store.js';
import {
  cancelQueuedRuns,
  enqueueAutomationRun,
  resumeAutomationQueue,
  startAutomationQueue,
  stopAutomationQueue,
} from './queue.js';
import type { RunnerDeps } from './runner.js';
import { SpendPool, spawnRefusal } from './subagents.js';
import { parseSpec } from './spec.js';

// ---------------------------------------------------------------------------
// A model API that answers from a script, by who is asking
// ---------------------------------------------------------------------------

const REGISTRY_YAML = `
providers:
  - id: fake
    label: Fake
    adapter: anthropic
    baseUrl: https://fake.invalid/v1
    authEnv: FAKE_SUBAGENT_KEY
    models:
      - id: priced
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: second
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: dear
        context: 8000
        inputPerM: 1
        outputPerM: 1000
      - id: unpriced
        context: 200000
  - id: elsewhere
    label: Elsewhere
    adapter: anthropic
    baseUrl: https://elsewhere.invalid/v1
    authEnv: FAKE_SUBAGENT_KEY
    models:
      - id: m
        context: 200000
        inputPerM: 1
        outputPerM: 2
`;
const REGISTRY = parseRegistry(REGISTRY_YAML);

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const spawn = (id: string, input: Record<string, unknown>) => use(id, 'spawn_agent', input);

interface Ask {
  /** `parent`: the automation's own agent; `child`: a sub-agent. */
  role: 'parent' | 'child';
  /** The task, as the first message has it. */
  task: string;
  model: string;
  /** This agent's calls so far, from 1. */
  turn: number;
  tools: string[];
  body: Record<string, unknown>;
}
interface Reply {
  status?: number;
  content?: Block[];
  outputTokens?: number;
  /** Hold the answer until this settles (or the call is aborted). */
  wait?: Promise<void>;
}
let respond: (ask: Ask) => Reply = () => ({ content: [text('Done.')] });
const asks: Ask[] = [];
/** Model calls waiting right now, by role. */
const inFlight = { parent: 0, child: 0, mostChildren: 0 };

const fakeModel = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  const role = JSON.stringify(body.system ?? '').includes('You are a sub-agent')
    ? 'child'
    : 'parent';
  const first = JSON.stringify((body.messages as unknown[])[0] ?? '');
  const task = /Task:\\n(.*?)(?:\\n|")/.exec(first)?.[1] ?? '';
  const turn = asks.filter((a) => a.role === role && a.task === task).length + 1;
  const ask: Ask = {
    role,
    task,
    model: String(body.model),
    turn,
    tools: ((body.tools as Array<{ name: string }>) ?? []).map((t) => t.name),
    body,
  };
  asks.push(ask);
  const reply = respond(ask);
  if (reply.wait) {
    inFlight[role] += 1;
    if (role === 'child') inFlight.mostChildren = Math.max(inFlight.mostChildren, inFlight.child);
    try {
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        reply.wait?.then(resolve, reject);
      });
    } finally {
      inFlight[role] -= 1;
    }
  }
  if (reply.status && reply.status !== 200) {
    return { ok: false, status: reply.status, text: async () => 'overloaded' } as Response;
  }
  const content = reply.content ?? [text('Done.')];
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 10, output_tokens: reply.outputTokens ?? 5 },
      }),
  } as Response;
}) as unknown as typeof fetch;

const builtinDriver = builtin({ registry: () => REGISTRY, fetch: fakeModel });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string;
let repo: string;
let savedProvidersFile: string | undefined;

const deps: RunnerDeps = {
  getSecret: () => undefined,
  path: () => process.env.PATH ?? '',
  driverFor: () => builtinDriver,
  workspaceCacheDir: '',
  maxConcurrent: 2,
  leaseMs: 2_000,
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

let counter = 0;
function automation(
  opts: {
    model?: string;
    fallback?: string;
    extra?: string;
    timeout?: string;
    mode?: string;
    tools?: string;
    /** The `agent.subagents` lines, under it; default `enabled: true`. Empty: no key. */
    subagents?: string[];
  } = {}
) {
  counter += 1;
  const source = [
    `name: sub-${counter}`,
    'targets:',
    `  repos: [local:${repo}]`,
    'agent:',
    '  driver: builtin',
    '  model:',
    `    primary: ${opts.model ?? 'fake/priced'}`,
    ...(opts.fallback ? [`    fallback: ${opts.fallback}`] : []),
    ...(opts.mode ? [`  permission_mode: ${opts.mode}`] : []),
    ...(opts.tools ? [`  allowed_tools: ${opts.tools}`] : []),
    ...((opts.subagents ?? ['enabled: true']).length > 0
      ? ['  subagents:', ...(opts.subagents ?? ['enabled: true']).map((l) => `    ${l}`)]
      : []),
    `prompt: parent task ${counter}`,
    'sandbox:',
    '  profile: native',
    ...(opts.timeout ? [`  timeout: ${opts.timeout}`] : []),
    'publish:',
    '  push: false',
    opts.extra ?? '',
  ].join('\n');
  return setAutomationEnabled(createAutomation(source).id, true);
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

async function until<T>(what: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = what();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const finished = (r: RunView | null) =>
  Boolean(r && ['done', 'failed', 'cancelled'].includes(r.status));
const waitFor = (id: string): Promise<RunView> =>
  until(() => {
    const r = getRun(id);
    return r && finished(r) ? r : undefined;
  });

function enqueue(a: ReturnType<typeof createAutomation>): string {
  return enqueueAutomationRun(getAutomation(a.id)!, 'manual', deps, { ifBusy: 'refuse' })!.runId;
}

let events: ClerqEvent[] = [];
let unsubscribe: (() => void) | undefined;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-subagents-')));
  savedProvidersFile = process.env.CLERQ_PROVIDERS_FILE;
  fs.writeFileSync(path.join(root, 'providers.yaml'), REGISTRY_YAML);
  process.env.CLERQ_PROVIDERS_FILE = path.join(root, 'providers.yaml');
  deps.workspaceCacheDir = path.join(root, 'cache');
  repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\nThe answer is 42.\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  await initStore(path.join(root, 'clerq.db'));
  await warmGatewayIdentity();
  startAutomationQueue(deps);
  unsubscribe = subscribeEvents((e) => events.push(e));
}, 20_000);

afterAll(() => {
  if (savedProvidersFile === undefined) delete process.env.CLERQ_PROVIDERS_FILE;
  else process.env.CLERQ_PROVIDERS_FILE = savedProvidersFile;
  unsubscribe?.();
  stopAutomationQueue();
  closeStore();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  asks.length = 0;
  events = [];
  inFlight.parent = 0;
  inFlight.child = 0;
  inFlight.mostChildren = 0;
  respond = () => ({ content: [text('Done.')] });
  process.env.FAKE_SUBAGENT_KEY = 'fake-key';
  resumeAutomationQueue();
});

afterEach(async () => {
  cancelQueuedRuns('test over');
  for (const r of getStore()
    .prepare("SELECT id FROM runs WHERE status NOT IN ('done','failed','cancelled')")
    .all()) {
    cancelRun(String(r.id), 'test over');
  }
  await until(
    () =>
      Number(
        getStore()
          .prepare(
            "SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('done','failed','cancelled')"
          )
          .get()?.n
      ) === 0
  );
  reapInterruptedRuns();
});

/** A parent that spawns once on its first turn, then writes a file and answers. */
function parentSpawning(spawnInput: Record<string, unknown>, ask: Ask): Reply {
  if (ask.turn === 1) return { content: [spawn('s1', spawnInput)] };
  if (ask.turn === 2) {
    return { content: [use('w1', 'write_file', { path: 'OUT.md', content: 'x\n' })] };
  }
  return { content: [text('Parent done.')] };
}

// ---------------------------------------------------------------------------

describe('a sub-agent run', () => {
  it('is its own run and session, linked to the parent, recorded like a builtin run', async () => {
    respond = (ask) => {
      if (ask.role === 'parent')
        return parentSpawning({ task: 'CHILD-A: what is the answer?' }, ask);
      if (ask.turn === 1) return { content: [use('r1', 'read_file', { path: 'README.md' })] };
      return { content: [text('The answer is 42, in README.md.')] };
    };
    const parentId = enqueue(automation());
    const parent = await waitFor(parentId);
    expect(parent.status).toBe('done');

    expect(parent.children).toHaveLength(1);
    const [childLink] = parent.children;
    expect(childLink).toMatchObject({ status: 'done', input: 'CHILD-A: what is the answer?' });
    const child = getRun(childLink.id) as RunView;
    expect(child).toMatchObject({
      trigger: 'subagent',
      parentRunId: parentId,
      status: 'done',
      repoId: parent.repoId,
    });
    expect(child.automationId).toBeUndefined();

    // Steps, tool calls and cost, as for any builtin run.
    expect(named(child, 'subagent.start')[0]).toMatchObject({
      input: { parentRunId: parentId, toolCallId: 's1', tools: 'read-only', strict: false },
    });
    expect(named(child, 'fs.read')).toHaveLength(1);
    const llm = steps(child).filter((s) => s.kind === 'llm' && s.status === 'ok');
    expect(llm).toHaveLength(2);
    const toolCalls = getStore()
      .prepare('SELECT name, status FROM tool_calls WHERE run_id = ?')
      .all(child.id);
    expect(toolCalls).toEqual([{ name: 'fs.read', status: 'ok' }]);
    expect(child.costUsd).toBeGreaterThan(0);
    expect(parent.childCostUsd).toBeCloseTo(child.costUsd, 9);

    // The parent's spawn call is a step and a tool call of its own, with the answer.
    const spawnStep = named(parent, 'sessions.spawn')[0];
    expect(spawnStep.status).toBe('ok');
    expect(String(spawnStep.output?.text)).toContain('The answer is 42, in README.md.');
    expect(String(spawnStep.output?.text)).toContain(`Sub-agent run ${child.id}`);
    expect(String(spawnStep.output?.text)).toContain('1 tool call (fs.read)');

    // Its transcript is a session, not listed among the chats.
    const session = getSession(child.sessionId as string);
    expect(session?.title).toBe('CHILD-A: what is the answer?');
    expect(listMessages(child.sessionId as string).map((m) => [m.role, m.content])).toEqual([
      ['user', 'CHILD-A: what is the answer?'],
      ['assistant', 'The answer is 42, in README.md.'],
    ]);
    expect(listSessions(500).map((s) => s.id)).not.toContain(child.sessionId);

    // GET /runs lists it.
    expect(listRuns(50).find((r) => r.id === child.id)).toMatchObject({
      trigger: 'subagent',
      parentRunId: parentId,
    });

    // Its run events carry the parent's id.
    const childEvents = events.filter((e) => e.context.runId === child.id);
    for (const name of ['run.started', 'run.completed', 'model.called', 'tool.started']) {
      expect(childEvents.find((e) => e.name === name)?.context, name).toMatchObject({
        runId: child.id,
        parentRunId: parentId,
        sessionId: child.sessionId,
      });
    }
  });

  it('reports a sub-agent that failed to the parent, which carries on', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') return parentSpawning({ task: 'CHILD-F: fail' }, ask);
      return { status: 400 };
    };
    const parent = await waitFor(enqueue(automation()));
    expect(parent.status).toBe('done');
    const child = getRun(parent.children[0].id) as RunView;
    expect(child.status).toBe('failed');
    const spawnStep = named(parent, 'sessions.spawn')[0];
    expect(spawnStep.status).toBe('error');
    expect(String(spawnStep.output?.text)).toContain('The sub-agent did not finish');
  });
});

describe("a sub-agent's policy", () => {
  it('is read-only by default and never offered sessions.spawn', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') return parentSpawning({ task: 'CHILD-R: look' }, ask);
      if (ask.turn === 1) {
        // It tries to write and to start a sub-agent of its own: neither is there.
        return {
          content: [
            use('w', 'write_file', { path: 'CHILD.md', content: 'x' }),
            spawn('s', { task: 'grandchild' }),
          ],
        };
      }
      return { content: [text('Could not.')] };
    };
    const parent = await waitFor(enqueue(automation()));
    expect(parent.status).toBe('done');
    const parentAsk = asks.find((a) => a.role === 'parent');
    expect(parentAsk?.tools).toContain('spawn_agent');
    const childAsk = asks.find((a) => a.role === 'child');
    expect(childAsk?.tools).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'git_status',
      'git_diff',
    ]);
    // Only the one level: no grandchild run exists.
    expect(parent.children).toHaveLength(1);
    const child = getRun(parent.children[0].id) as RunView;
    expect(child.children).toHaveLength(0);
    expect(named(child, 'subagent.start')[0].output).toMatchObject({
      deny: expect.arrayContaining(['sessions.spawn']),
    });
  });

  it('gets writes when it asks and the parent has them, and nothing the parent lacks', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') {
        return parentSpawning(
          { task: 'CHILD-W: write', tools: ['fs.write', 'runtime.shell', 'fs.read'] },
          ask
        );
      }
      if (ask.turn === 1) {
        return { content: [use('w', 'write_file', { path: 'CHILD.md', content: 'child\n' })] };
      }
      return { content: [text('Wrote it.')] };
    };
    // The parent may not run commands: its tools are the file tools and spawning.
    const parent = await waitFor(enqueue(automation({ tools: '[group:fs, sessions.spawn]' })));
    expect(parent.status).toBe('done');
    const childAsk = asks.find((a) => a.role === 'child');
    expect(childAsk?.tools).toEqual(['read_file', 'write_file']);
    const child = getRun(parent.children[0].id) as RunView;
    expect(named(child, 'fs.write')[0].status).toBe('ok');
    // The parent's commit has the child's file.
    const diff = getStore()
      .prepare("SELECT blob FROM artifacts WHERE run_id = ? AND kind = 'diff'")
      .get(parent.id);
    expect(String(diff?.blob)).toContain('CHILD.md');
  });

  it('cannot be started by a run that is itself a sub-agent', async () => {
    respond = (ask) =>
      ask.role === 'parent'
        ? parentSpawning({ task: 'CHILD-D: depth' }, ask)
        : { content: [text('ok')] };
    const parent = await waitFor(enqueue(automation()));
    const childId = parent.children[0].id;
    expect(spawnRefusal(parent.id)).toBeUndefined();
    expect(spawnRefusal(childId)).toMatch(/one level deep/);
    expect(() => createRun({ trigger: 'subagent' })).toThrow(/needs the run that started it/);
  });
});

describe('sub-agents at once', () => {
  it('runs at most four at a time; a fifth and sixth wait for a place', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    respond = (ask) => {
      if (ask.role === 'parent') {
        if (ask.turn === 1) {
          return {
            content: [1, 2, 3, 4, 5, 6].map((n) => spawn(`s${n}`, { task: `CHILD-${n}: go` })),
          };
        }
        return { content: [text('All six answered.')] };
      }
      return { content: [text(`answer ${ask.task}`)], wait: gate };
    };
    const parentId = enqueue(automation());
    await until(() => inFlight.child === 4);
    // Give a fifth the chance to start, if anything would let it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inFlight.child).toBe(4);
    expect(getRun(parentId)?.children).toHaveLength(4);
    open();
    const parent = await waitFor(parentId);
    expect(parent.status).toBe('done');
    expect(inFlight.mostChildren).toBe(4);
    expect(parent.children).toHaveLength(6);
    expect(parent.children.every((c) => c.status === 'done')).toBe(true);
    const results = named(parent, 'sessions.spawn').map((s) => String(s.output?.text));
    expect(results.map((t) => /answer CHILD-(\d)/.exec(t)?.[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  });
});

describe('budget', () => {
  it('is shared: the children spend from what the parent has left, and never past it', async () => {
    // At these prices a call may cost up to about $2.00 (its full output limit)
    // and costs $0.50 (500 tokens out).
    respond = (ask) => {
      if (ask.role === 'parent') {
        if (ask.turn === 1)
          return { content: [spawn('s1', { task: 'CHILD-B: spend' })], outputTokens: 500 };
        return { content: [text('Parent done.')], outputTokens: 500 };
      }
      // The child keeps working until it is stopped.
      return { content: [use(`r${ask.turn}`, 'list_files', {})], outputTokens: 500 };
    };
    const a = automation({ model: 'fake/dear', extra: 'budget:\n  max_usd_per_run: 4' });
    const parent = await waitFor(enqueue(a));
    const child = getRun(parent.children[0].id) as RunView;

    // The child stopped once the next call could take the two of them past $4:
    // parent $0.50 + child $1.50 + up to $2.00 more.
    expect(child.status).toBe('failed');
    expect(child.exitReason).toMatch(/would pass the run's budget of \$4\.00/);
    expect(child.costUsd).toBeCloseTo(1.5, 2);
    // Then the parent, for the same reason.
    expect(parent.status).toBe('failed');
    expect(parent.exitReason).toMatch(/budget/);
    expect(parent.costUsd).toBeCloseTo(0.5, 2);
    expect(parent.childCostUsd).toBeCloseTo(1.5, 2);
    expect(parent.costUsd + parent.childCostUsd).toBeLessThanOrEqual(4);
    // The automation's month counts both.
    expect(monthSpendUsd(a.id)).toBeCloseTo(2, 2);
  });

  it('pools spend and holds, and says what is left', () => {
    const pool = new SpendPool(1);
    const parent = pool.member('p');
    const child = pool.member('c');
    const release = child.hold(0.3);
    expect(parent.othersUsd()).toBeCloseTo(0.3, 9);
    expect(pool.leftUsd()).toBeCloseTo(0.7, 9);
    release(0.1);
    release(5); // a second release is ignored
    expect(parent.othersUsd()).toBeCloseTo(0.1, 9);
    expect(child.othersUsd()).toBe(0);
    parent.hold(0)(0.95);
    expect(pool.leftUsd()).toBe(0);
    expect(new SpendPool().leftUsd()).toBeUndefined();
  });
});

describe('stopping', () => {
  it('cancelling the parent cancels its sub-agents', async () => {
    const never = new Promise<void>(() => undefined);
    respond = (ask) => {
      if (ask.role === 'parent') {
        return {
          content: [
            spawn('s1', { task: 'CHILD-C1: wait' }),
            spawn('s2', { task: 'CHILD-C2: wait' }),
          ],
        };
      }
      return { content: [text('never')], wait: never };
    };
    const parentId = enqueue(automation());
    await until(() => inFlight.child === 2);
    cancelRun(parentId, 'Cancelled by request');
    const parent = await waitFor(parentId);
    expect(parent.status).toBe('cancelled');
    for (const c of parent.children) {
      const child = await waitFor(c.id);
      expect(child.status).toBe('cancelled');
      expect(child.exitReason).toBe('The run that started this sub-agent stopped.');
    }
    expect(
      events.find((e) => e.name === 'run.cancelled' && e.context.parentRunId === parentId)
    ).toBeTruthy();
  });

  it('the parent running out of time stops its sub-agents', async () => {
    const never = new Promise<void>(() => undefined);
    respond = (ask) =>
      ask.role === 'parent'
        ? { content: [spawn('s1', { task: 'CHILD-T: wait' })] }
        : { content: [text('never')], wait: never };
    const parent = await waitFor(enqueue(automation({ timeout: '2s' })));
    expect(parent.status).toBe('failed');
    expect(parent.exitReason).toMatch(/Timed out/);
    const child = getRun(parent.children[0].id) as RunView;
    expect(child.status).toBe('cancelled');
  });
});

describe('approvals', () => {
  it('a sub-agent asks in the same inbox, naming the parent run, which waits meanwhile', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') {
        return parentSpawning({ task: 'CHILD-P: push', tools: ['*'] }, ask);
      }
      if (ask.turn === 1) {
        return { content: [use('p1', 'run_shell', { command: 'git push origin HEAD' })] };
      }
      return { content: [text('The push was refused.')] };
    };
    const parentId = enqueue(automation());
    const pending = await until(() => listPending()[0]);
    const child = getRun(parentId)?.children[0];
    expect(pending).toMatchObject({ runId: child?.id, parentRunId: parentId, tool: 'git.push' });
    expect(pending.reason).toContain(`A sub-agent of run ${parentId}`);
    expect(getRun(parentId)?.status).toBe('awaiting_approval');
    expect(getRun(child?.id as string)?.status).toBe('awaiting_approval');
    expect(events.find((e) => e.name === 'approval.requested')?.context).toMatchObject({
      runId: child?.id,
      parentRunId: parentId,
    });

    decide(pending.id, { decision: 'denied' });
    const parent = await waitFor(parentId);
    expect(parent.status).toBe('done');
    const childRun = getRun(child?.id as string) as RunView;
    expect(named(childRun, 'git.push')[0].status).toBe('denied');
  });
});

describe('the model', () => {
  it('a sub-agent that names its own model uses it, with no fallback', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') {
        return parentSpawning({ task: 'CHILD-M: named', model: 'fake/second' }, ask);
      }
      return { status: 529 };
    };
    // The parent's chain has a fallback; a model named for the sub-agent does not use it.
    const parent = await waitFor(
      enqueue(
        automation({
          model: 'fake/priced',
          fallback: '[fake/dear]',
          subagents: ['enabled: true', 'models: [fake/second]'],
        })
      )
    );
    const child = getRun(parent.children[0].id) as RunView;
    expect(child.status).toBe('failed');
    expect(named(child, 'subagent.start')[0].input).toMatchObject({
      model: 'fake/second',
      strict: true,
    });
    expect(asks.filter((a) => a.role === 'child').map((a) => a.model)).toEqual(['second']);
    expect(named(child, 'model.fallback')).toHaveLength(0);
  });

  it('a sub-agent that inherits the model may fall back along the parent’s chain', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') return parentSpawning({ task: 'CHILD-I: inherit' }, ask);
      if (ask.model === 'priced') return { status: 529 };
      return { content: [text('Answered on the fallback.')] };
    };
    const parent = await waitFor(enqueue(automation({ fallback: '[fake/second]' })));
    const child = getRun(parent.children[0].id) as RunView;
    expect(child.status).toBe('done');
    expect(asks.filter((a) => a.role === 'child').map((a) => a.model)).toEqual([
      'priced',
      'second',
    ]);
    expect(named(child, 'model.fallback')[0].input).toMatchObject({
      from: 'fake/priced',
      to: 'fake/second',
    });
    const fallback = events.find(
      (e) => e.name === 'model.fallback' && e.context.runId === child.id
    );
    expect(fallback?.context.parentRunId).toBe(parent.id);
  });

  it('refuses a model outside the spec’s chain and agent.subagents.models, before any run starts', async () => {
    // elsewhere/m is in the registry and has a key: only the spec stands in the way.
    for (const wanted of ['elsewhere/m', 'nowhere/model', 'fake/second']) {
      asks.length = 0;
      respond = (ask) =>
        ask.role === 'parent'
          ? parentSpawning({ task: `CHILD-X: ${wanted}`, model: wanted }, ask)
          : { content: [text('no')] };
      const parent = await waitFor(
        enqueue(automation({ fallback: '[fake/dear]', subagents: ['enabled: true'] }))
      );
      expect(parent.status, wanted).toBe('done');
      expect(parent.children, wanted).toHaveLength(0);
      expect(
        asks.filter((a) => a.role === 'child'),
        wanted
      ).toHaveLength(0);
      const spawnStep = named(parent, 'sessions.spawn')[0];
      expect(spawnStep.status, wanted).toBe('error');
      expect(String(spawnStep.output?.text), wanted).toContain(
        `${wanted} is not one of the models this automation may use (fake/priced, fake/dear)`
      );
    }
  });

  it('accepts a model of the spec’s own chain by name', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') {
        return parentSpawning({ task: 'CHILD-E: chain', model: 'fake/dear' }, ask);
      }
      return { content: [text('ok')] };
    };
    const parent = await waitFor(enqueue(automation({ fallback: '[fake/dear]' })));
    expect(parent.children[0].status).toBe('done');
    expect(asks.filter((a) => a.role === 'child').map((a) => a.model)).toEqual(['dear']);
  });

  it('refuses a listed model that cannot be used now, before any run starts', async () => {
    respond = (ask) =>
      ask.role === 'parent'
        ? parentSpawning({ task: 'CHILD-U: unpriced', model: 'fake/unpriced' }, ask)
        : { content: [text('no')] };
    const parent = await waitFor(
      enqueue(
        automation({
          subagents: ['enabled: true', 'models: [fake/unpriced]'],
          extra: 'budget:\n  max_usd_per_run: 5',
        })
      )
    );
    expect(parent.children).toHaveLength(0);
    expect(String(named(parent, 'sessions.spawn')[0].output?.text)).toMatch(
      /fake\/unpriced cannot be used.*no price/
    );
  });
});

describe('turning sub-agents on', () => {
  it('is off for a builtin spec that does not ask, even with every tool allowed', async () => {
    respond = () => ({ content: [text('Done.')] });
    for (const opts of [{ subagents: [] }, { subagents: [], tools: '["*"]' }]) {
      asks.length = 0;
      const parent = await waitFor(enqueue(automation(opts)));
      expect(parent.status).toBe('done');
      expect(asks[0].tools).not.toContain('spawn_agent');
    }
  });

  it('is on when allowed_tools names sessions.spawn itself', async () => {
    respond = () => ({ content: [text('Done.')] });
    await waitFor(enqueue(automation({ subagents: [], tools: '[group:fs, sessions.spawn]' })));
    expect(asks[0].tools).toContain('spawn_agent');
  });

  it('is checked when the spec is saved', () => {
    const spec = (agent: string[]) =>
      [
        'name: check',
        'targets:',
        `  repos: [local:${repo}]`,
        'agent:',
        ...agent.map((l) => `  ${l}`),
        'prompt: x',
        'sandbox:',
        '  profile: native',
      ].join('\n');
    const builtinAgent = ['driver: builtin', 'model: fake/priced'];
    expect(parseSpec(spec([...builtinAgent])).agent.subagents).toEqual({
      enabled: false,
      maxConcurrent: 4,
      models: [],
    });
    expect(
      parseSpec(
        spec([
          ...builtinAgent,
          'subagents:',
          '  enabled: true',
          '  max_concurrent: 2',
          '  models: [fake/second]',
        ])
      ).agent.subagents
    ).toEqual({ enabled: true, maxConcurrent: 2, models: ['fake/second'] });
    expect(() => parseSpec(spec([...builtinAgent, 'subagents:', '  max_concurrent: 5']))).toThrow(
      /from 1 to 4/
    );
    expect(() => parseSpec(spec([...builtinAgent, 'subagents:', '  models: [second]']))).toThrow(
      /as provider\/model/
    );
    expect(() =>
      parseSpec(spec([...builtinAgent, 'subagents:', '  models: [nowhere/m]']), {
        registry: REGISTRY,
      })
    ).toThrow(/Unknown provider "nowhere"/);
    expect(() =>
      parseSpec(
        spec([...builtinAgent, 'allowed_tools: [group:fs]', 'subagents:', '  enabled: true'])
      )
    ).toThrow(/leaves "sessions.spawn" out/);
    expect(() => parseSpec(spec(['driver: claude-code', 'subagents:', '  enabled: true']))).toThrow(
      /only the builtin agent/
    );
  });

  it('honours agent.subagents.max_concurrent', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    respond = (ask) => {
      if (ask.role === 'parent') {
        if (ask.turn === 1) {
          return { content: [1, 2, 3].map((n) => spawn(`s${n}`, { task: `CHILD-K${n}: go` })) };
        }
        return { content: [text('done')] };
      }
      return { content: [text('ok')], wait: gate };
    };
    const id = enqueue(automation({ subagents: ['enabled: true', 'max_concurrent: 2'] }));
    await until(() => inFlight.child === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inFlight.child).toBe(2);
    open();
    const parent = await waitFor(id);
    expect(parent.children).toHaveLength(3);
    expect(inFlight.mostChildren).toBe(2);
  });
});

describe('memory', () => {
  beforeEach(() => {
    clearMemory();
    addRecord({ key: 'how', value: 'CHILD-N notes: run the linter first.', type: 'procedure' });
    addRecord({ key: 'private', value: 'CHILD-N secret fact.', type: 'fact' });
  });
  afterEach(() => clearMemory());

  it('a sub-agent reads at most the types its parent may read', async () => {
    respond = (ask) =>
      ask.role === 'parent'
        ? parentSpawning({ task: 'CHILD-N notes on the linter' }, ask)
        : { content: [text('ok')] };
    const parent = await waitFor(enqueue(automation({ extra: 'memory:\n  read: [procedure]' })));
    const child = getRun(parent.children[0].id) as RunView;
    const prompt = JSON.stringify(asks.find((a) => a.role === 'child')?.body.messages);
    expect(prompt).toContain('run the linter first');
    expect(prompt).not.toContain('secret fact');
    expect(named(child, 'memory.read')[0]).toMatchObject({ input: { types: ['procedure'] } });
  });

  it('a sub-agent of a parent that reads no memory reads none', async () => {
    respond = (ask) =>
      ask.role === 'parent'
        ? parentSpawning({ task: 'CHILD-N notes on the linter' }, ask)
        : { content: [text('ok')] };
    const parent = await waitFor(enqueue(automation()));
    const child = getRun(parent.children[0].id) as RunView;
    const prompt = JSON.stringify(asks.find((a) => a.role === 'child')?.body.messages);
    expect(prompt).not.toContain('linter first');
    expect(named(child, 'memory.read')).toHaveLength(0);
  });
});

describe('overlapping approvals', () => {
  /** A parent in default mode: both spawns of its first reply wait for a person at once. */
  async function twoSpawnsWaiting() {
    respond = (ask) => {
      if (ask.role === 'parent') {
        if (ask.turn === 1) {
          return {
            content: [
              spawn('s1', { task: 'CHILD-O1: look' }),
              spawn('s2', { task: 'CHILD-O2: look' }),
            ],
          };
        }
        return { content: [text('Both looked.')] };
      }
      return { content: [text(`seen by ${ask.task}`)] };
    };
    const id = enqueue(automation({ mode: 'default' }));
    const pending = await until(() => (listPending().length === 2 ? listPending() : undefined));
    expect(pending.every((p) => p.runId === id && p.tool === 'sessions.spawn')).toBe(true);
    expect(getRun(id)?.status).toBe('awaiting_approval');
    return { id, pending };
  }

  for (const [scenario, order] of [
    ['A: the first asked is answered first', [0, 1]],
    ['B: the second asked is answered first', [1, 0]],
  ] as const) {
    it(`keep the parent waiting until the last is answered (${scenario})`, async () => {
      const { id, pending } = await twoSpawnsWaiting();
      decide(pending[order[0]].id, { decision: 'approved' });
      // That sub-agent runs and ends while the other spawn still waits.
      const first = await until(() => getRun(id)?.children.find((c) => c.status === 'done'));
      expect(first).toBeTruthy();
      expect(listPending()).toHaveLength(1);
      expect(getRun(id)?.status).toBe('awaiting_approval');

      decide(pending[order[1]].id, { decision: 'approved' });
      const parent = await waitFor(id);
      expect(parent.status).toBe('done');
      expect(parent.children.map((c) => c.status)).toEqual(['done', 'done']);
    });
  }

  it('keep the parent waiting while a sub-agent waits and the parent asks too', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = (ask) => {
      if (ask.role === 'parent') {
        if (ask.turn === 1)
          return { content: [spawn('s1', { task: 'CHILD-Q: push', tools: ['*'] })] };
        return { content: [text('done')] };
      }
      if (ask.turn === 1) {
        return { content: [use('p1', 'run_shell', { command: 'git push origin HEAD' })] };
      }
      return { content: [text('refused')], wait: gate };
    };
    const id = enqueue(automation());
    const pending = await until(() => listPending()[0]);
    const child = getRun(id)?.children[0].id as string;
    // The parent asked for nothing itself; it waits because its sub-agent does.
    expect(getRun(id)?.status).toBe('awaiting_approval');
    decide(pending.id, { decision: 'denied' });
    await until(() => getRun(child)?.status === 'executing');
    expect(getRun(id)?.status).toBe('executing');
    release();
    expect((await waitFor(id)).status).toBe('done');
  });
});

describe('budget, more', () => {
  it('with only a monthly budget, the pool is what is left of the month, checked before every call', async () => {
    respond = (ask) => {
      if (ask.role === 'parent') {
        if (ask.turn === 1) {
          return { content: [spawn('s1', { task: 'CHILD-MB: spend' })], outputTokens: 500 };
        }
        return { content: [text('Parent done.')], outputTokens: 500 };
      }
      return { content: [use(`r${ask.turn}`, 'list_files', {})], outputTokens: 500 };
    };
    const a = automation({ model: 'fake/dear', extra: 'budget:\n  max_usd_per_month: 4' });
    const parent = await waitFor(enqueue(a));
    const child = getRun(parent.children[0].id) as RunView;
    expect(child.status).toBe('failed');
    expect(child.exitReason).toMatch(/would pass the run's budget of \$4\.00/);
    expect(parent.status).toBe('failed');
    expect(parent.costUsd + parent.childCostUsd).toBeLessThanOrEqual(4);
    expect(monthSpendUsd(a.id)).toBeCloseTo(parent.costUsd + parent.childCostUsd, 6);
  });

  it('counts a run’s sub-agents in its automation’s month, and nobody else’s', async () => {
    respond = (ask) =>
      ask.role === 'parent'
        ? parentSpawning({ task: 'CHILD-S: spend' }, ask)
        : { content: [text('ok')], outputTokens: 1_000 };
    const a = automation();
    const other = automation();
    const parent = await waitFor(enqueue(a));
    expect(parent.childCostUsd).toBeGreaterThan(0);
    expect(monthSpendUsd(a.id)).toBeCloseTo(parent.costUsd + parent.childCostUsd, 9);
    expect(monthSpendUsd(other.id)).toBe(0);
    // A month that has not started yet has nothing in it.
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    expect(monthSpendUsd(a.id, next)).toBe(0);
  });
});

describe('stopping, more', () => {
  it('the kill switch reaches sub-agents and their approvals', async () => {
    const never = new Promise<void>(() => undefined);
    respond = (ask) => {
      if (ask.role === 'parent') {
        return {
          content: [
            spawn('s1', { task: 'CHILD-K1: wait' }),
            spawn('s2', { task: 'CHILD-K2: push', tools: ['*'] }),
          ],
        };
      }
      if (ask.task.startsWith('CHILD-K2') && ask.turn === 1) {
        return { content: [use('p1', 'run_shell', { command: 'git push origin HEAD' })] };
      }
      return { content: [text('never')], wait: never };
    };
    const id = enqueue(automation());
    await until(() => inFlight.child === 1 && listPending().length === 1);
    // What the kill switch does (POST /kill).
    denyAllPending('Kill switch engaged');
    expect(cancelAllRuns('Kill switch engaged')).toBeGreaterThanOrEqual(3);
    const parent = await waitFor(id);
    expect(parent.status).toBe('cancelled');
    for (const c of parent.children) {
      expect((await waitFor(c.id)).status).toBe('cancelled');
    }
  });
});

describe('restart recovery', () => {
  it('fails an unfinished sub-agent, refuses its approval, and says whose it was', async () => {
    const dead = await new Promise<number>((resolve) => {
      const p = spawnProcess('true', [], { stdio: 'ignore' });
      p.once('exit', () => resolve(p.pid as number));
    });
    const a = automation();
    const parentId = createRun({ trigger: 'manual', automationId: a.id, status: 'executing' });
    const sessionId = createSubagentSession({ title: 'left behind', parentRunId: parentId });
    const childId = createRun({
      trigger: 'subagent',
      parentRunId: parentId,
      sessionId,
      input: 'left behind',
    });
    const approval = requestApproval({
      runId: childId,
      tool: 'git.push',
      tier: 'high',
      reason: 'push',
      parentRunId: parentId,
    });
    getStore()
      .prepare('UPDATE runs SET status = ?, owner_pid = ?, owner_start = NULL WHERE id IN (?, ?)')
      .run('awaiting_approval', dead, parentId, childId);
    events = [];

    await recoverAfterRestart();

    const child = getRun(childId) as RunView;
    expect(child.status).toBe('failed');
    expect(child.exitReason).toBe(INTERRUPTED);
    expect(child.parentRunId).toBe(parentId);
    expect(getRun(parentId)?.status).toBe('failed');
    expect(
      getStore().prepare('SELECT decision, decided_by FROM approvals WHERE id = ?').get(approval.id)
    ).toEqual({ decision: 'denied', decided_by: 'restart' });
    expect(
      events.find((e) => e.name === 'run.failed' && e.context.runId === childId)?.context
    ).toEqual({ runId: childId, parentRunId: parentId, sessionId });
    expect(
      events.find((e) => e.name === 'approval.decided' && e.context.runId === childId)?.context
    ).toMatchObject({ runId: childId, parentRunId: parentId });
  });
});
