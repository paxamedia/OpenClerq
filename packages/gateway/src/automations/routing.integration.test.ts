/**
 * Model routing for automation runs, end to end: a model that is unavailable
 * is replaced by the next fallback model, a model a person chose is not, and
 * the budget, the record and the event bus keep telling the truth. The store
 * and the repositories are real; the agents and the model APIs are fakes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  builtin,
  type Driver,
  type DriverAvailability,
  type DriverEvent,
  type DriverResult,
  type DriverRunInput,
} from '@clerq/drivers';
import { parseRegistry } from '@clerq/providers';
import { closeStore, getStore, initStore } from '../store.js';
import { cancelRun, getRun, reapInterruptedRuns } from '../runs.js';
import { subscribeEvents, type ClerqEvent } from '../events.js';
import { warmGatewayIdentity } from '../agent-processes.js';
import { createAutomation, getAutomation, setAutomationEnabled } from './store.js';
import {
  cancelQueuedRuns,
  enqueueAutomationRun,
  resumeAutomationQueue,
  startAutomationQueue,
  stopAutomationQueue,
} from './queue.js';
import { fallbackCandidates, interruptedPrompt, policyFor, type RunnerDeps } from './runner.js';
import { judgeChain, type ModelPlan } from './model-chain.js';
import { parseSpec } from './spec.js';
import { addRecord, clearMemory } from '../memory-layer.js';
import { readableMemoryTypes } from '@clerq/policy';

// ---------------------------------------------------------------------------
// A scripted CLI agent, which can be unavailable by model
// ---------------------------------------------------------------------------

interface Call {
  model?: string;
  prompt: string;
  maxBudgetUsd?: number;
  cwd: string;
  fallbackModels?: string[];
}
const calls: Call[] = [];

type Behaviour = (input: DriverRunInput) => Promise<Partial<DriverResult>> | Partial<DriverResult>;
/** What the agent does for a model; a model not named here does the default. */
let behaviour: Record<string, Behaviour> = {};
let fallbackBehaviour: Behaviour = () => ({});
let costPerCall = 0.25;
/** Models `detect` reports unavailable, with the reason, and what kind of fault it says it is. */
let unavailable: Record<string, string> = {};
let unavailableKind: DriverAvailability['reasonKind'] = 'no_key';

const write =
  (file: string, text: string): Behaviour =>
  (input) => {
    fs.writeFileSync(path.join(input.cwd, file), text);
    return {};
  };
/** The provider answered 529 and the CLI printed it. */
const overloaded: Behaviour = () => ({
  ok: false,
  exitCode: 1,
  costUsd: 0,
  summary: 'The model is overloaded.',
  apiError: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
});
/** The key was refused: the model is no better with another, and the CLI says so. */
const signedOut: Behaviour = () => ({
  ok: false,
  exitCode: 1,
  costUsd: 0,
  summary: 'Invalid API key.',
  apiError: 'API Error: 401 invalid x-api-key',
});

function scripted(id: string): Driver {
  return {
    id,
    async detect(options): Promise<DriverAvailability> {
      const reason = options?.model ? unavailable[options.model] : undefined;
      if (reason) return { id, available: false, reason, reasonKind: unavailableKind };
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
    fallbackModels: input.fallbackModels,
  });
  yield { type: 'started', model: input.model ?? 'fake-model' };
  const step = (input.model && behaviour[input.model]) || fallbackBehaviour;
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

// ---------------------------------------------------------------------------
// The builtin agent, over a model API that answers from a script
// ---------------------------------------------------------------------------

/** The model registry, as YAML: the gateway checks a spec's models against it as well as the agent. */
const MODEL_REGISTRY_YAML = `
providers:
  - id: fake
    label: Fake
    adapter: anthropic
    baseUrl: https://fake.invalid/v1
    authEnv: FAKE_ROUTING_KEY
    models:
      - id: priced
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: second
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: third
        context: 200000
        inputPerM: 1
        outputPerM: 2
      - id: unpriced
        context: 200000
  - id: other
    label: Other
    adapter: openai-compat
    baseUrl: https://other.invalid/v1
    authEnv: OTHER_ROUTING_KEY
    models:
      - id: m
        context: 200000
        inputPerM: 1
        outputPerM: 2
  - id: local
    label: Local
    adapter: openai-compat
    baseUrl: http://local.invalid/v1
    authEnv: null
    models:
      - id: m
`;
const MODEL_REGISTRY = parseRegistry(MODEL_REGISTRY_YAML);
/** Status per model id, call by call; a model not listed answers 200. */
let modelStatuses: Record<string, number[]> = {};
/** What an Anthropic-shaped model says, call by call, as content blocks; a model not listed says "Done." */
let modelContent: Record<string, Array<Array<Record<string, unknown>>>> = {};
const modelRequests: Array<{ model: string; headers: Record<string, string> }> = [];
const fakeModel = (async (url: string, init: RequestInit) => {
  // The probe of a local server that is not running.
  if (url.endsWith('/models')) throw new TypeError('fetch failed');
  const body = JSON.parse(String(init.body)) as { model: string };
  modelRequests.push({ model: body.model, headers: init.headers as Record<string, string> });
  const status = modelStatuses[body.model]?.shift() ?? 200;
  if (status !== 200) {
    return { ok: false, status, text: async () => 'busy' } as Response;
  }
  const openai = url.startsWith('https://other.invalid');
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(
        openai
          ? {
              choices: [
                { message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }
          : (() => {
              const content = modelContent[body.model]?.shift() ?? [
                { type: 'text', text: 'Done.' },
              ];
              return {
                content,
                stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
                usage: { input_tokens: 10, output_tokens: 5 },
              };
            })()
      ),
  } as Response;
}) as unknown as typeof fetch;
const builtinDriver = builtin({ registry: () => MODEL_REGISTRY, fetch: fakeModel });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string;
let savedProvidersFile: string | undefined;
let repo: string;
let vaultKey: string | undefined;

const deps: RunnerDeps = {
  getSecret: (name) => (name === 'MY_KEY' ? vaultKey : undefined),
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

let counter = 0;
function automation(extra = '', opts: { driver?: string } = {}) {
  counter += 1;
  const source = [
    `name: route-${counter}`,
    'targets:',
    `  repos: [local:${repo}]`,
    'agent:',
    `  driver: ${opts.driver ?? 'claude-code\n  model:\n    primary: main\n    fallback: [backup, spare]'}`,
    `prompt: task ${counter}`,
    'sandbox:',
    '  profile: native',
    'publish:',
    '  push: false',
    extra,
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

async function waitFor(runId: string, until: (r: RunView) => boolean, ms = 15_000) {
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

function enqueue(
  a: ReturnType<typeof createAutomation>,
  trigger: 'manual' | 'schedule' = 'manual',
  model?: string
): string {
  const queued = enqueueAutomationRun(getAutomation(a.id)!, trigger, deps, {
    ifBusy: 'refuse',
    model,
  });
  return queued!.runId;
}

let events: ClerqEvent[] = [];
let unsubscribe: (() => void) | undefined;
const fallbackEvents = () => events.filter((e) => e.name === 'model.fallback');

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-routing-')));
  savedProvidersFile = process.env.CLERQ_PROVIDERS_FILE;
  fs.writeFileSync(path.join(root, 'providers.yaml'), MODEL_REGISTRY_YAML);
  process.env.CLERQ_PROVIDERS_FILE = path.join(root, 'providers.yaml');
  deps.workspaceCacheDir = path.join(root, 'cache');
  repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
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
  calls.length = 0;
  events = [];
  behaviour = {};
  fallbackBehaviour = write('OUT.md', 'x\n');
  costPerCall = 0.25;
  unavailable = {};
  unavailableKind = 'no_key';
  modelStatuses = {};
  modelContent = {};
  modelRequests.length = 0;
  vaultKey = undefined;
  process.env.FAKE_ROUTING_KEY = 'fake-key';
  process.env.OTHER_ROUTING_KEY = 'other-key';
  resumeAutomationQueue();
});

afterEach(async () => {
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

describe('fallback for an agent that is a CLI', () => {
  it('starts again with the next model at once when the provider is overloaded', async () => {
    behaviour = { main: overloaded };
    const id = enqueue(automation());
    const run = await waitFor(id, finished);

    expect(run.status).toBe('done');
    expect(calls.map((c) => c.model)).toEqual(['main', 'backup']);
    // Not a retry: the same attempt of the run, no backoff, none of the retries used.
    expect(getStore().prepare('SELECT attempt FROM runs WHERE id = ?').get(id)?.attempt).toBe(1);
    expect(named(run, 'run.retry')).toHaveLength(0);

    const [fallback] = named(run, 'model.fallback');
    expect(fallback).toMatchObject({
      kind: 'tool',
      status: 'warning',
      input: { from: 'main', to: 'backup' },
    });
    expect(String(fallback.output?.reason)).toMatch(/overloaded/);
    const [event] = fallbackEvents();
    expect(event).toMatchObject({
      context: { runId: id },
      payload: { from: 'main', to: 'backup', scope: 'automation' },
    });
    // The failed attempt is on the record next to the one that worked.
    expect(
      steps(run)
        .filter((s) => s.kind === 'llm')
        .map((s) => s.status)
    ).toEqual(['error', 'ok']);
  });

  it('does the same for a scheduled run, and for a run started by hand without a model', async () => {
    behaviour = { main: overloaded };
    for (const trigger of ['schedule', 'manual'] as const) {
      calls.length = 0;
      const run = await waitFor(enqueue(automation(), trigger), finished);
      expect(run.status, trigger).toBe('done');
      expect(
        calls.map((c) => c.model),
        trigger
      ).toEqual(['main', 'backup']);
    }
  });

  it('walks the whole chain, then fails with the last error', async () => {
    behaviour = { main: overloaded, backup: overloaded, spare: overloaded };
    const run = await waitFor(enqueue(automation()), finished);
    expect(run.status).toBe('failed');
    expect(calls.map((c) => c.model)).toEqual(['main', 'backup', 'spare']);
    expect(named(run, 'model.fallback').map((s) => `${s.input?.from}>${s.input?.to}`)).toEqual([
      'main>backup',
      'backup>spare',
    ]);
  });

  it('is tried again from the primary by a retry, after every model was unavailable', async () => {
    behaviour = { main: overloaded, backup: overloaded };
    let round = 0;
    behaviour.spare = () => {
      round += 1;
      return round === 1 ? overloaded({} as DriverRunInput) : {};
    };
    const id = enqueue(automation('retry:\n  max_retries: 1\n  backoff: 50ms'));
    const run = await waitFor(id, finished);
    expect(run.status).toBe('done');
    expect(getStore().prepare('SELECT attempt FROM runs WHERE id = ?').get(id)?.attempt).toBe(2);
    // The second attempt begins again with the primary, which may have recovered.
    expect(calls.map((c) => c.model)).toEqual([
      'main',
      'backup',
      'spare',
      'main',
      'backup',
      'spare',
    ]);
  });

  it('keeps the budget: each attempt gets what is left after the one before', async () => {
    behaviour = { main: () => ({ ...overloaded({} as DriverRunInput), costUsd: 0.2 }) };
    const run = await waitFor(enqueue(automation('budget:\n  max_usd_per_run: 1')), finished);
    expect(run.status).toBe('done');
    expect(calls.map((c) => c.maxBudgetUsd)).toEqual([1, 0.8]);
    expect(run.costUsd).toBeCloseTo(0.45);
  });

  it('stops moving on once the run budget is spent', async () => {
    behaviour = { main: () => ({ ...overloaded({} as DriverRunInput), costUsd: 1.5 }) };
    const run = await waitFor(enqueue(automation('budget:\n  max_usd_per_run: 1')), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/run's budget of \$1\.00 is spent/);
    expect(calls).toHaveLength(1);
  });

  it('tells the next model what the interrupted one left in the worktree', async () => {
    behaviour = {
      main: (input) => {
        fs.writeFileSync(path.join(input.cwd, 'PARTIAL.md'), 'half\n');
        return overloaded(input);
      },
    };
    fallbackBehaviour = () => ({});
    const run = await waitFor(enqueue(automation()), finished);
    expect(run.status).toBe('done');
    expect(calls[0].prompt).not.toMatch(/interrupted/);
    expect(calls[1].prompt).toBe(interruptedPrompt(calls[0].prompt));
    expect(calls[1].prompt).toMatch(/interrupted when its model became unavailable/);
  });

  it('leaves the prompt alone when the interrupted attempt changed nothing', async () => {
    behaviour = { main: overloaded };
    await waitFor(enqueue(automation()), finished);
    expect(calls[1].prompt).toBe(calls[0].prompt);
  });

  it('never moves on for a failure that is not the model being unavailable', async () => {
    for (const failing of [
      () => ({ ok: false, summary: 'The agent gave up.' }),
      // The CLI's key was refused: another model of the same CLI would be refused too.
      signedOut,
      // The agent's own words are not an outage.
      () => ({ ok: false, summary: 'The endpoint returned 503 and was overloaded; I stopped.' }),
      () => ({ ok: false, crashed: true, summary: 'claude exited before reporting a result.' }),
    ] as Behaviour[]) {
      calls.length = 0;
      behaviour = { main: failing };
      const run = await waitFor(enqueue(automation()), finished);
      expect(run.status).toBe('failed');
      expect(calls.map((c) => c.model)).toEqual(['main']);
      expect(named(run, 'model.fallback')).toHaveLength(0);
    }
  });

  it('does not go back to a model that already failed the gates when escalating', async () => {
    // main is down, backup does the work and fails the gate, escalation reaches
    // `strong`, which is down too: the models left are not ones already tried.
    behaviour = { main: overloaded, strong: overloaded };
    const run = await waitFor(
      enqueue(
        automation('gates:\n  - run: test -f NEVER.md', {
          driver:
            'claude-code\n  model:\n    primary: main\n    escalate: [strong]\n    fallback: [backup]',
        })
      ),
      finished
    );
    expect(run.status).toBe('failed');
    expect(calls.map((c) => c.model)).toEqual(['main', 'backup', 'strong']);
    expect(named(run, 'agent.escalate')[0].output).toMatchObject({ from: 'backup' });
  });

  it('uses a fallback model for an escalation that is unavailable, when it was not tried', async () => {
    behaviour = { strong: overloaded, backup: write('OUT.md', 'ok\n') };
    const run = await waitFor(
      enqueue(
        automation('gates:\n  - run: grep -q ok OUT.md', {
          driver:
            'claude-code\n  model:\n    primary: main\n    escalate: [strong]\n    fallback: [backup]',
        })
      ),
      finished
    );
    expect(calls.map((c) => c.model)).toEqual(['main', 'strong', 'backup']);
    expect(run.status).toBe('done');
  });
});

describe('strictness: a model a person chose is not replaced', () => {
  it('runs a manual run with the model named for it, and fails plainly when it is unavailable', async () => {
    behaviour = { picked: overloaded };
    const id = enqueue(automation(), 'manual', 'picked');
    const run = await waitFor(id, finished);
    expect(run.status).toBe('failed');
    expect(run.modelOverride).toBe('picked');
    // Not the spec's primary, and no fallback.
    expect(calls.map((c) => c.model)).toEqual(['picked']);
    expect(named(run, 'model.fallback')).toHaveLength(0);
    expect(fallbackEvents()).toHaveLength(0);
    expect(run.exitReason).toMatch(/overloaded/i);
  });

  it('runs fine with the chosen model when it is available', async () => {
    const run = await waitFor(enqueue(automation(), 'manual', 'picked'), finished);
    expect(run.status).toBe('done');
    expect(calls.map((c) => c.model)).toEqual(['picked']);
  });

  it('fails plainly, before any work, when the chosen model is unavailable up front', async () => {
    unavailable = { picked: 'picked is not installed.' };
    const run = await waitFor(enqueue(automation(), 'manual', 'picked'), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toBe('picked is not installed.');
    expect(calls).toHaveLength(0);
  });

  it('keeps the choice through a retry', async () => {
    behaviour = { picked: () => ({ ...overloaded({} as DriverRunInput) }) };
    const id = enqueue(automation('retry:\n  max_retries: 1\n  backoff: 50ms'), 'manual', 'picked');
    const run = await waitFor(id, finished);
    expect(run.status).toBe('failed');
    expect(calls.map((c) => c.model)).toEqual(['picked', 'picked']);
  });
});

describe('an unavailable primary at the start of a run', () => {
  it('starts with the first fallback model that can be used, and says so', async () => {
    unavailable = { main: 'main has no key.', backup: 'backup has no key.' };
    const run = await waitFor(enqueue(automation()), finished);
    expect(run.status).toBe('done');
    expect(calls.map((c) => c.model)).toEqual(['spare']);
    expect(fallbackEvents()[0]).toMatchObject({
      context: { runId: run.id },
      payload: { from: 'main', to: 'spare', reason: 'main has no key.' },
    });
    // The fallback that could not be used is a warning, not an error.
    const detect = named(run, 'driver.detect');
    expect(detect.map((s) => s.status)).toEqual(['error', 'warning', 'ok']);
  });

  it('is not tried again when it fails later in the run', async () => {
    unavailable = { main: 'main has no key.' };
    behaviour = { backup: overloaded };
    const run = await waitFor(enqueue(automation()), finished);
    expect(run.status).toBe('done');
    // main is known to be down: after backup, the next is spare, not main.
    expect(calls.map((c) => c.model)).toEqual(['backup', 'spare']);
  });

  it('fails with the primary’s reason when nothing in the chain can be used', async () => {
    unavailable = { main: 'main has no key.', backup: 'no.', spare: 'no.' };
    const run = await waitFor(enqueue(automation()), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toBe('main has no key.');
    expect(calls).toHaveLength(0);
  });

  it('refuses an escalation model that is unavailable, as before', async () => {
    unavailable = { strong: 'strong is gone.' };
    const run = await waitFor(
      enqueue(
        automation('', {
          driver:
            'claude-code\n  model:\n    primary: main\n    escalate: [strong]\n    fallback: [backup]',
        })
      ),
      finished
    );
    expect(run.exitReason).toBe('Escalation model strong: strong is gone.');
    expect(calls).toHaveLength(0);
  });
});

describe('fallback for the builtin agent', () => {
  const builtinSpec = (fallback: string, extra = '') =>
    automation(extra, {
      driver: `builtin\n  model:\n    primary: fake/priced\n    fallback: ${fallback}`,
    });

  it('moves to the next model in the middle of the run, recording the failed call and the move', async () => {
    modelStatuses = { priced: [529] };
    const id = enqueue(builtinSpec('[fake/second]', 'budget:\n  max_usd_per_run: 1'));
    const run = await waitFor(id, finished);

    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.model)).toEqual(['priced', 'second']);
    expect(
      steps(run)
        .filter((s) => s.kind === 'llm' && s.status !== 'text')
        .map((s) => s.status)
    ).toEqual(['error', 'ok']);
    const [fallback] = named(run, 'model.fallback');
    expect(fallback.input).toMatchObject({ from: 'fake/priced', to: 'fake/second' });
    expect(String(fallback.output?.reason)).toMatch(/returned 529/);
    expect(fallbackEvents()[0]).toMatchObject({
      context: { runId: id },
      payload: { from: 'fake/priced', to: 'fake/second', scope: 'automation' },
    });
    // The agent was given the models to move to, once.
    expect(getRun(id)?.status).toBe('done');
  });

  it('sends the spec’s key only to its own provider', async () => {
    vaultKey = 'vault-key-for-fake';
    modelStatuses = { priced: [503] };
    const run = await waitFor(
      enqueue(
        automation('budget:\n  max_usd_per_run: 1', {
          driver:
            'builtin\n  model:\n    primary: fake/priced\n    fallback: [other/m]\n  api_key_secret: MY_KEY',
        })
      ),
      finished
    );
    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.model)).toEqual(['priced', 'm']);
    expect(modelRequests[0].headers['x-api-key']).toBe('vault-key-for-fake');
    expect(modelRequests[1].headers.authorization).toBe('Bearer other-key');
    expect(JSON.stringify(modelRequests[1])).not.toContain('vault-key-for-fake');
  });

  it('never sends the spec’s key to the provider of a model a person named for the run', async () => {
    vaultKey = 'vault-key-for-fake';
    const a = automation('budget:\n  max_usd_per_run: 1', {
      driver: 'builtin\n  model: fake/priced\n  api_key_secret: MY_KEY',
    });
    const run = await waitFor(enqueue(a, 'manual', 'other/m'), finished);
    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.model)).toEqual(['m']);
    expect(modelRequests[0].headers.authorization).toBe('Bearer other-key');
    // Its own provider's model, named by hand, does get it.
    modelRequests.length = 0;
    await waitFor(enqueue(a, 'manual', 'fake/second'), finished);
    expect(modelRequests[0].headers['x-api-key']).toBe('vault-key-for-fake');
  });

  it('does not hand an escalation a model the agent found down in the middle of the run', async () => {
    // priced is down, then second; third does the work and fails the gate; the
    // escalation model is down too. Neither second nor priced is asked again.
    modelStatuses = { priced: [503], second: [503], unpriced: [503] };
    modelContent = {
      third: [
        [
          {
            type: 'tool_use',
            id: 'w1',
            name: 'write_file',
            input: { path: 'OUT.md', content: 'x\n' },
          },
        ],
        [{ type: 'text', text: 'Done.' }],
      ],
    };
    const run = await waitFor(
      enqueue(
        automation('gates:\n  - run: grep -q strong OUT.md', {
          driver:
            'builtin\n  model:\n    primary: fake/priced\n    escalate: [fake/unpriced]\n    fallback: [fake/second, fake/third]',
        })
      ),
      finished
    );
    expect(modelRequests.map((r) => r.model)).toEqual([
      'priced',
      'second',
      'third',
      'third',
      'unpriced',
    ]);
    expect(run.status).toBe('failed');
    expect(named(run, 'agent.escalate')[0].output).toMatchObject({ from: 'fake/third' });
    expect(named(run, 'model.fallback').map((s) => `${s.input?.from}>${s.input?.to}`)).toEqual([
      'fake/priced>fake/second',
      'fake/second>fake/third',
    ]);
  });

  it('refuses before any work a fallback model with no price when the spec has a dollar budget', async () => {
    const run = await waitFor(
      enqueue(builtinSpec('[fake/unpriced]', 'budget:\n  max_usd_per_run: 1')),
      finished
    );
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Fallback model fake\/unpriced: fake\/unpriced has no price/);
    expect(modelRequests).toHaveLength(0);
  });

  it('allows the same model without a dollar budget', async () => {
    modelStatuses = { priced: [503] };
    const run = await waitFor(enqueue(builtinSpec('[fake/unpriced]')), finished);
    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.model)).toEqual(['priced', 'unpriced']);
  });

  it('holds a run to the model it was given by hand', async () => {
    modelStatuses = { second: [503] };
    const run = await waitFor(
      enqueue(builtinSpec('[other/m]', 'budget:\n  max_usd_per_run: 1'), 'manual', 'fake/second'),
      finished
    );
    expect(run.status).toBe('failed');
    expect(modelRequests.map((r) => r.model)).toEqual(['second']);
    expect(fallbackEvents()).toHaveLength(0);
  });
});

describe('a primary that cannot be used, and why', () => {
  const builtinOf = (primary: string, fallback: string, extra = '') =>
    automation(extra, {
      driver: `builtin\n  model:\n    primary: ${primary}\n    fallback: [${fallback}]`,
    });

  it('starts with the fallback when the primary’s provider has no key', async () => {
    delete process.env.FAKE_ROUTING_KEY;
    const run = await waitFor(enqueue(builtinOf('fake/priced', 'other/m')), finished);
    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.model)).toEqual(['m']);
    expect(fallbackEvents()[0].payload).toMatchObject({
      from: 'fake/priced',
      to: 'other/m',
      reason: expect.stringContaining('FAKE_ROUTING_KEY'),
    });
  });

  it('starts with the fallback when a local server is not running', async () => {
    const run = await waitFor(enqueue(builtinOf('local/m', 'fake/priced')), finished);
    expect(run.status).toBe('done');
    expect(modelRequests.map((r) => r.model)).toEqual(['priced']);
    expect(String((fallbackEvents()[0].payload as { reason: string }).reason)).toMatch(
      /Nothing answers at http:\/\/local\.invalid/
    );
  });

  it('does not hide a provider the registry does not know behind the fallback', async () => {
    // Saved while the registry knew it; the registry has since lost it, or the spec was never checked.
    const ghost = path.join(root, 'ghost.yaml');
    fs.writeFileSync(
      ghost,
      `${MODEL_REGISTRY_YAML}  - id: ghost\n    label: Ghost\n    adapter: openai-compat\n    baseUrl: https://ghost.invalid/v1\n    authEnv: null\n    models:\n      - id: x\n`
    );
    const known = process.env.CLERQ_PROVIDERS_FILE;
    process.env.CLERQ_PROVIDERS_FILE = ghost;
    const a = builtinOf('ghost/x', 'fake/priced');
    process.env.CLERQ_PROVIDERS_FILE = known;

    const run = await waitFor(enqueue(a), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/Unknown provider "ghost"/);
    expect(modelRequests).toHaveLength(0);
    expect(fallbackEvents()).toHaveLength(0);
    expect(named(run, 'model.fallback')).toHaveLength(0);
  });

  it('does not move off a primary that is unpriced under a dollar budget either', async () => {
    const run = await waitFor(
      enqueue(builtinOf('fake/unpriced', 'fake/priced', 'budget:\n  max_usd_per_run: 1')),
      finished
    );
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/fake\/unpriced has no price/);
    expect(modelRequests).toHaveLength(0);
  });

  it('does not move off a CLI that is missing or signed out, which no other model helps', async () => {
    unavailable = { main: 'claude is not signed in.' };
    unavailableKind = undefined;
    const run = await waitFor(enqueue(automation()), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toBe('claude is not signed in.');
    expect(calls).toHaveLength(0);
  });

  it('refuses a fallback model that is a fault in the spec, and only warns about one that is merely down', async () => {
    unavailable = { backup: 'backup is down.' };
    unavailableKind = 'invalid';
    const refused = await waitFor(enqueue(automation()), finished);
    expect(refused.status).toBe('failed');
    expect(refused.exitReason).toBe('Fallback model backup: backup is down.');
    expect(calls).toHaveLength(0);

    unavailableKind = 'unreachable';
    const warned = await waitFor(enqueue(automation()), finished);
    expect(warned.status).toBe('done');
    expect(named(warned, 'driver.detect').map((s) => s.status)).toEqual(['ok', 'warning', 'ok']);
  });
});

describe('judging the chain', () => {
  const available = { id: 'builtin', available: true } as const;
  const down = (kind?: DriverAvailability['reasonKind']): DriverAvailability => ({
    id: 'builtin',
    available: false,
    reason: `down (${kind})`,
    reasonKind: kind,
  });
  const chain = (
    primary: DriverAvailability,
    fallback: DriverAvailability,
    plan: Partial<ModelPlan> = {}
  ) => {
    const p: ModelPlan = {
      primary: 'a/p',
      escalate: [],
      fallback: ['a/f'],
      strict: false,
      ...plan,
    };
    return judgeChain(p, [
      { model: 'a/p', role: 'primary', availability: primary },
      ...(p.fallback.length
        ? [{ model: 'a/f', role: 'fallback' as const, availability: fallback }]
        : []),
    ]);
  };

  it('moves off a primary only for a missing key or a server that is not running', () => {
    for (const kind of ['no_key', 'unreachable'] as const) {
      const v = chain(down(kind), available);
      expect(v.errors, kind).toEqual([]);
      expect(v.start).toBe('a/f');
      expect(v.movedOff).toMatchObject({ from: 'a/p', to: 'a/f' });
    }
    for (const kind of ['invalid', 'unpriced', undefined] as const) {
      const v = chain(down(kind), available);
      expect(v.errors, String(kind)).toEqual([`down (${kind})`]);
      expect(v.movedOff, String(kind)).toBeUndefined();
    }
  });

  it('never moves off a primary a person chose', () => {
    const v = chain(down('no_key'), available, { fallback: [], strict: true });
    expect(v.errors).toEqual(['down (no_key)']);
  });

  it('errors on a fallback that is a fault in the spec, and warns about one that is down', () => {
    expect(chain(available, down('invalid')).errors).toEqual([
      'Fallback model a/f: down (invalid)',
    ]);
    expect(chain(available, down('unpriced')).errors).toEqual([
      'Fallback model a/f: down (unpriced)',
    ]);
    for (const kind of ['no_key', 'unreachable', undefined] as const) {
      const v = chain(available, down(kind));
      expect(v.errors, String(kind)).toEqual([]);
      expect(v.warnings, String(kind)).toHaveLength(1);
    }
  });
});

describe('candidates', () => {
  it('lists the model, then the fallback models not used up', () => {
    const none = new Set<string>();
    expect(fallbackCandidates('a', ['b', 'c'], none, none)).toEqual(['a', 'b', 'c']);
    expect(fallbackCandidates('a', ['a', 'b'], none, none)).toEqual(['a', 'b']);
    expect(fallbackCandidates('a', ['b', 'c'], new Set(['b']), new Set(['c']))).toEqual(['a']);
    expect(fallbackCandidates(undefined, ['b'], none, none)).toEqual([undefined, 'b']);
    // The model meant for this attempt stays first even when it is known to be down.
    expect(fallbackCandidates('a', ['b'], none, new Set(['a']))).toEqual(['a', 'b']);
  });
});

describe('memory a run may read', () => {
  const cli = (memory: string) => automation(memory, { driver: 'claude-code\n  model: main' });

  beforeEach(() => {
    clearMemory();
    addRecord({ key: 'tone', value: 'Keep commit messages short.', type: 'preference' });
    addRecord({
      key: 'tests',
      value: 'Before you finish a task, run pnpm test.',
      type: 'procedure',
    });
    addRecord({ key: 'secret', value: 'Every task touches the tests directory', type: 'fact' });
  });
  afterEach(() => clearMemory());

  it('reads nothing unless the spec asks, so saved notes are not sent to a model unasked', async () => {
    const run = await waitFor(enqueue(cli('')), finished);
    expect(run.status).toBe('done');
    expect(calls[0].prompt).not.toContain('<memory>');
    expect(named(run, 'memory.read')).toHaveLength(0);
  });

  it('adds the notes of the types the spec names, under the run’s policy, and records it', async () => {
    const run = await waitFor(enqueue(cli('memory:\n  read: [procedure]')), finished);
    expect(run.status).toBe('done');
    const prompt = calls[0].prompt;
    expect(prompt.startsWith('task ')).toBe(true);
    expect(prompt).toContain('<memory>');
    expect(prompt).toContain('- [procedure] tests: Before you finish a task, run pnpm test.');
    // Neither a type that was not named nor a preference the spec did not allow.
    expect(prompt).not.toContain('[fact]');
    expect(prompt).not.toContain('[preference]');
    expect(named(run, 'memory.read')[0]).toMatchObject({
      input: { types: ['procedure'] },
      output: { notes: 1 },
    });
  });

  it('carries the notes into every attempt, an escalation’s too', async () => {
    fallbackBehaviour = write('OUT.md', 'weak\n');
    const run = await waitFor(
      enqueue(
        automation(
          'memory:\n  read: [procedure, preference]\ngates:\n  - run: grep -q strong OUT.md',
          {
            driver: 'claude-code\n  model:\n    primary: main\n    escalate: [strong]',
          }
        )
      ),
      finished
    );
    expect(run.status).toBe('failed');
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.prompt).toContain('- [preference] tone:');
      expect(c.prompt).toContain('- [procedure] tests:');
    }
    // The failed check follows the task, and the notes come after it.
    expect(calls[1].prompt.indexOf('did not pass this check')).toBeLessThan(
      calls[1].prompt.indexOf('<memory>')
    );
  });

  it('is part of the run’s policy: only the types named are allowed', () => {
    const spec = parseSpec(
      [
        'name: p',
        'targets:',
        '  repos: [local:/tmp/x]',
        'agent:',
        '  driver: claude-code',
        'prompt: x',
        'sandbox:',
        '  profile: native',
        'memory:',
        '  read: [fact, note]',
      ].join('\n')
    );
    expect(spec.memory.read).toEqual(['fact', 'note']);
    expect(readableMemoryTypes(policyFor(spec, false))).toEqual(['fact', 'note']);
    expect(readableMemoryTypes(policyFor({ ...spec, memory: { read: [] } }, false))).toEqual([]);
  });
});
