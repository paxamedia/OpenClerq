/**
 * The builtin driver's side of sub-agents: when `sessions.spawn` is offered,
 * the rules a sub-agent gets, spawn calls running side by side, and a budget
 * shared with other agents. Starting the sub-agent itself is the caller's (the
 * gateway's); here it is a stub. The model is a scripted fake.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, isNarrowerOrEqual, SPAWN_TOOL, type PolicyRules } from '@clerq/policy';
import { parseRegistry, type Registry } from '@clerq/providers';
import {
  builtin,
  builtinPolicy,
  offeredTools,
  subagentPolicy,
  BUILTIN_UNIVERSE,
  SUBAGENT_SYSTEM_PROMPT,
  type DriverEvent,
  type DriverResult,
  type DriverRunInput,
  type SharedBudget,
  type SubagentOutcome,
  type SubagentRequest,
} from './index.js';

const REGISTRY: Registry = parseRegistry(`
providers:
  - id: fake
    label: Fake
    adapter: anthropic
    baseUrl: https://fake.invalid/v1
    authEnv: FAKE_MODEL_KEY
    models:
      - id: priced
        context: 200000
        inputPerM: 1000
        outputPerM: 1000
`);

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function scriptedModel(replies: Block[][]) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    const content = replies.shift();
    if (!content) throw new Error('The script ran out of replies.');
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content,
          stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          // $0.001 a call at these prices.
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
    } as Response;
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

let repo: string;
const saved = { ...process.env };
beforeEach(() => {
  process.env.FAKE_MODEL_KEY = 'k';
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-spawn-')));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(repo, { recursive: true, force: true });
});

async function run(fetchImpl: typeof fetch, input: Partial<DriverRunInput> = {}) {
  const events: DriverEvent[] = [];
  for await (const e of builtin({ registry: () => REGISTRY, fetch: fetchImpl }).run({
    prompt: 'Do the task.',
    cwd: repo,
    model: 'fake/priced',
    env: { PATH: process.env.PATH ?? '' },
    ...input,
  }))
    events.push(e);
  const last = events.at(-1);
  if (last?.type !== 'finished') throw new Error('no finished event');
  return { events, result: last.result as DriverResult };
}

const done = (answer: string, extra: Partial<SubagentOutcome> = {}): SubagentOutcome => ({
  ok: true,
  answer,
  trace: 'Sub-agent run run_x: 0 tool calls, 1 model turn, $0.0010.',
  runId: 'run_x',
  costUsd: 0.001,
  ...extra,
});

describe('which runs are offered sessions.spawn', () => {
  it('only a run that can start sub-agents, and only when its policy allows it', () => {
    const rules = builtinPolicy();
    expect(rules.allow).toContain('sessions.spawn');
    expect(offeredTools(rules).map((t) => t.name)).not.toContain('sessions.spawn');
    expect(offeredTools(rules, { spawn: true }).map((t) => t.name)).toContain('sessions.spawn');
    // Read-only modes and a tool list that does not name it leave it out.
    for (const narrow of [
      builtinPolicy('plan'),
      builtinPolicy('dontAsk'),
      builtinPolicy('acceptEdits', ['group:fs']),
    ]) {
      expect(offeredTools(narrow, { spawn: true }).map((t) => t.name)).not.toContain(
        'sessions.spawn'
      );
    }
    // Named, it is kept; in default mode it waits for a person, as a write does.
    expect(builtinPolicy('acceptEdits', ['sessions.spawn', 'fs.read']).allow).toContain(
      'sessions.spawn'
    );
    expect(evaluate(builtinPolicy('default'), SPAWN_TOOL).decision).toBe('needs_approval');
  });

  it('shows the tool to the model when the caller can start sub-agents', async () => {
    const model = scriptedModel([[text('Nothing to do.')]]);
    await run(model.fetchImpl, { onSubagent: async () => done('x') });
    const names = (model.requests[0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('spawn_agent');

    const plain = scriptedModel([[text('Nothing to do.')]]);
    await run(plain.fetchImpl);
    expect((plain.requests[0].tools as Array<{ name: string }>).map((t) => t.name)).not.toContain(
      'spawn_agent'
    );
  });
});

describe("a sub-agent's policy", () => {
  const modes = ['acceptEdits', 'default', 'dontAsk', 'plan'] as const;
  const requests: Array<string[] | undefined> = [
    undefined,
    [],
    ['fs.read'],
    ['fs.write', 'fs.edit'],
    ['runtime.shell'],
    ['*'],
    ['group:fs', 'group:git', 'group:runtime', 'group:sessions'],
    ['sessions.spawn'],
    ['risk:external', 'git.push'],
  ];
  const allowedTools: Array<string[] | undefined> = [
    undefined,
    ['fs.read', 'fs.list'],
    ['group:fs', 'sessions.spawn'],
    ['runtime.shell', 'sessions.spawn'],
  ];

  it('is never wider than its parent, for every mode, tool list and request', () => {
    for (const mode of modes) {
      for (const tools of allowedTools) {
        const parent = builtinPolicy(mode, tools);
        for (const asked of requests) {
          const child = subagentPolicy(parent, asked);
          const where = `${mode} ${JSON.stringify(tools)} ${JSON.stringify(asked)}`;
          expect(isNarrowerOrEqual(child, parent, BUILTIN_UNIVERSE), where).toBe(true);
          // No sub-agent can start one of its own (depth 1), whatever it asks.
          expect(evaluate(child, SPAWN_TOOL).decision, where).toBe('deny');
          expect(child.maxCallsPerRun, where).toBe(parent.maxCallsPerRun);
          // Narrowing a sub-agent's rules again never widens them either.
          expect(
            isNarrowerOrEqual(subagentPolicy(child, ['*']), child, BUILTIN_UNIVERSE),
            where
          ).toBe(true);
        }
      }
    }
  });

  it('reads by default, and writes only when it asks and the parent may', () => {
    const decide = (rules: PolicyRules, name: string) =>
      evaluate(rules, BUILTIN_UNIVERSE.find((t) => t.name === name) ?? { name, risk: 'execute' })
        .decision;
    const readOnly = subagentPolicy(builtinPolicy());
    expect(decide(readOnly, 'fs.read')).toBe('allow');
    expect(decide(readOnly, 'git.diff')).toBe('allow');
    expect(decide(readOnly, 'fs.write')).toBe('deny');
    expect(decide(readOnly, 'runtime.shell')).toBe('deny');

    const writer = subagentPolicy(builtinPolicy(), ['fs.write', 'fs.edit']);
    expect(decide(writer, 'fs.write')).toBe('allow');
    expect(decide(writer, 'fs.read')).toBe('deny');

    // The parent in default mode is asked before writing; so is its sub-agent.
    expect(decide(subagentPolicy(builtinPolicy('default'), ['fs.write']), 'fs.write')).toBe(
      'needs_approval'
    );
    // A read-only parent cannot hand out writes.
    expect(decide(subagentPolicy(builtinPolicy('plan'), ['*']), 'fs.write')).toBe('deny');
    // A push from a sub-agent's shell waits for approval, as the parent's does.
    expect(decide(subagentPolicy(builtinPolicy(), ['*']), 'git.push')).toBe('needs_approval');
  });
});

describe('spawn calls', () => {
  it('pass the task, the tools, the model and the parent rules, and return the answer', async () => {
    const seen: SubagentRequest[] = [];
    const model = scriptedModel([
      [
        use('s1', 'spawn_agent', {
          task: 'Find where the answer is defined.',
          tools: ['fs.read'],
          model: 'fake/priced',
        }),
      ],
      [text('Done.')],
    ]);
    const { events, result } = await run(model.fetchImpl, {
      onSubagent: async (req) => {
        seen.push(req);
        return done('It is in a.txt.');
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolCallId: 's1',
      task: 'Find where the answer is defined.',
      tools: ['fs.read'],
      model: 'fake/priced',
    });
    expect(seen[0].parentRules).toEqual(builtinPolicy());
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].deadline).toBeGreaterThan(Date.now());
    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ name: 'sessions.spawn' });
    const out = events.find((e) => e.type === 'tool_result');
    expect(out).toMatchObject({ isError: false });
    expect((out as { output: string }).output).toContain('It is in a.txt.');
    expect((out as { output: string }).output).toContain('Sub-agent run run_x');
  });

  it('report a sub-agent that failed, or could not start, as a failed call', async () => {
    const model = scriptedModel([
      [use('s1', 'spawn_agent', { task: 'One.' }), use('s2', 'spawn_agent', { task: 'Two.' })],
      [text('Done.')],
    ]);
    const { events } = await run(model.fetchImpl, {
      onSubagent: async (req) => {
        if (req.task === 'One.') return done('Out of time.', { ok: false });
        throw new Error('The run has no budget left for a sub-agent.');
      },
    });
    const outs = events.filter((e) => e.type === 'tool_result') as Array<{
      output: string;
      isError: boolean;
    }>;
    expect(outs[0].isError).toBe(true);
    expect(outs[0].output).toContain('The sub-agent did not finish: Out of time.');
    expect(outs[1].isError).toBe(true);
    expect(outs[1].output).toContain('no budget left');
  });

  it('in one reply run at the same time, and their results come back in order', async () => {
    let running = 0;
    let most = 0;
    const release: Array<() => void> = [];
    const model = scriptedModel([
      [
        use('s1', 'spawn_agent', { task: 'One.' }),
        use('s2', 'spawn_agent', { task: 'Two.' }),
        use('s3', 'spawn_agent', { task: 'Three.' }),
        use('r1', 'read_file', { path: 'a.txt' }),
      ],
      [text('Done.')],
    ]);
    const finished = run(model.fetchImpl, {
      onSubagent: (req) =>
        new Promise((resolve) => {
          running += 1;
          most = Math.max(most, running);
          release.push(() => {
            running -= 1;
            resolve(done(`answer to ${req.task}`));
          });
        }),
    });
    // All three are started before any of them ends.
    for (let i = 0; i < 100 && release.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(release).toHaveLength(3);
    // Finish them out of order.
    release[2]();
    release[0]();
    release[1]();
    const { events } = await finished;
    expect(most).toBe(3);
    const results = events.filter((e) => e.type === 'tool_result') as Array<{
      id: string;
      output: string;
    }>;
    expect(results.map((r) => r.id)).toEqual(['s1', 's2', 's3', 'r1']);
    expect(results[1].output).toContain('answer to Two.');
    // The calls' events: the three spawns first, as they started.
    expect(
      events.filter((e) => e.type === 'tool_call').map((e) => (e as { id: string }).id)
    ).toEqual(['s1', 's2', 's3', 'r1']);
    // The model gets every result, in the order of its calls.
    const last = model.requests.at(-1)?.messages as Array<{ content: unknown }>;
    const blocks = last.at(-1)?.content as Array<{ tool_use_id: string }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['s1', 's2', 's3', 'r1']);
  });

  it('are refused by a policy without sessions.spawn even if the model calls it', async () => {
    const model = scriptedModel([[use('s1', 'spawn_agent', { task: 'One.' })], [text('Done.')]]);
    let asked = 0;
    const { events } = await run(model.fetchImpl, {
      policy: subagentPolicy(builtinPolicy(), ['*']),
      onSubagent: async () => {
        asked += 1;
        return done('x');
      },
    });
    expect(asked).toBe(0);
    const out = events.find((e) => e.type === 'tool_result') as {
      output: string;
      isError: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.output).toContain('There is no tool "spawn_agent"');
  });
});

describe("a sub-agent's run", () => {
  it('uses the rules and the system prompt it is given', async () => {
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    const model = scriptedModel([
      [use('w1', 'write_file', { path: 'b.txt', content: 'changed\n' })],
      [text('Could not write.')],
    ]);
    const { events } = await run(model.fetchImpl, {
      policy: subagentPolicy(builtinPolicy()),
      system: SUBAGENT_SYSTEM_PROMPT,
    });
    expect(model.requests[0].system).toBe(SUBAGENT_SYSTEM_PROMPT);
    const names = (model.requests[0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(['read_file', 'list_files', 'search_files', 'git_status', 'git_diff']);
    // A tool it is not given is not even offered: the call fails, nothing is written.
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('b\n');
  });
});

describe('a shared budget', () => {
  /** A pool like the gateway's: what each member spent and holds. */
  function pool() {
    const spent = new Map<string, number>();
    const held = new Map<string, number>();
    const holds: number[] = [];
    const member = (id: string): SharedBudget => ({
      othersUsd: () =>
        [...spent].filter(([k]) => k !== id).reduce((a, [, v]) => a + v, 0) +
        [...held].filter(([k]) => k !== id).reduce((a, [, v]) => a + v, 0),
      hold: (usd) => {
        holds.push(usd);
        held.set(id, (held.get(id) ?? 0) + usd);
        return (cost) => {
          held.set(id, (held.get(id) ?? 0) - usd);
          spent.set(id, (spent.get(id) ?? 0) + cost);
        };
      },
    });
    return { spent, held, holds, member };
  }

  it('holds each call while it runs and records what it cost', async () => {
    const p = pool();
    const model = scriptedModel([[use('r1', 'read_file', { path: 'a.txt' })], [text('Done.')]]);
    const { result } = await run(model.fetchImpl, {
      maxBudgetUsd: 100,
      sharedBudget: p.member('parent'),
    });
    expect(result.ok).toBe(true);
    expect(p.holds).toHaveLength(2);
    expect(p.holds.every((h) => h > 0)).toBe(true);
    expect(p.held.get('parent')).toBeCloseTo(0, 9);
    expect(p.spent.get('parent')).toBeCloseTo(0.002, 9);
  });

  it('stops before a call that what the others spent leaves no room for', async () => {
    const p = pool();
    // Another agent has spent all but a little of the $10.
    p.member('child').hold(0)(9.999);
    const model = scriptedModel([[text('Done.')]]);
    const { result } = await run(model.fetchImpl, {
      maxBudgetUsd: 10,
      sharedBudget: p.member('parent'),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/would pass the run's budget of \$10\.00/);
    expect(result.summary).toMatch(/sub-agents and parent together/);
    expect(model.requests).toHaveLength(0);
  });
});
