/**
 * The builtin driver against a scripted model. The repository and the commands
 * are real; the model is a fake fetch that answers in the Messages API shape,
 * so no request leaves the process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRegistry, type Registry } from '@clerq/providers';
import {
  allowedToolProblem,
  builtin,
  builtinPolicy,
  offeredTools,
  shellDescriptor,
  BUILTIN_KEY_ENV,
  type DriverEvent,
  type DriverResult,
  type DriverRunInput,
  type ToolApprovalRequest,
} from './index.js';

const isWindows = process.platform === 'win32';

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
        inputPerM: 1
        outputPerM: 1
      - id: tiny
        context: 6000
        inputPerM: 1
        outputPerM: 1
      - id: unpriced
        context: 200000
  - id: local
    label: Local
    adapter: openai-compat
    baseUrl: http://127.0.0.1:9/v1
    authEnv: null
    models:
      - id: m
`);

type Block = Record<string, unknown>;
interface Reply {
  content: Block[];
  stop?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

const text = (t: string): Block => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** A model that answers from a script, recording what it was sent. */
function scriptedModel(
  replies: Array<Reply | ((body: Record<string, unknown>) => Reply | Promise<Reply>)>
) {
  const requests: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    headers.push(init.headers as Record<string, string>);
    const next = replies.shift();
    if (!next) throw new Error('The script ran out of replies.');
    const reply = typeof next === 'function' ? await next(body) : next;
    const hasTools = reply.content.some((b) => b.type === 'tool_use');
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: reply.content,
          stop_reason: reply.stop ?? (hasTools ? 'tool_use' : 'end_turn'),
          usage: reply.usage ?? { input_tokens: 1_000, output_tokens: 100 },
        }),
    } as Response;
  }) as unknown as typeof fetch;
  return { requests, headers, fetchImpl };
}

let repo: string;
const saved = { ...process.env };

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

beforeEach(() => {
  process.env.FAKE_MODEL_KEY = 'fake-key-from-env';
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-builtin-')));
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\nversion 1\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const answer = 41;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(repo, { recursive: true, force: true });
});

async function collect(
  iter: AsyncIterable<DriverEvent>
): Promise<{ events: DriverEvent[]; result: DriverResult }> {
  const events: DriverEvent[] = [];
  for await (const e of iter) events.push(e);
  const last = events.at(-1);
  if (last?.type !== 'finished') throw new Error('no finished event');
  return { events, result: last.result };
}

function run(
  fetchImpl: typeof fetch,
  input: Partial<DriverRunInput> = {},
  options: Parameters<typeof builtin>[0] = {}
) {
  return collect(
    builtin({ registry: () => REGISTRY, fetch: fetchImpl, ...options }).run({
      prompt: 'Bump the answer to 42.',
      cwd: repo,
      model: 'fake/priced',
      env: { PATH: process.env.PATH ?? '' },
      ...input,
    })
  );
}

const toolResults = (events: DriverEvent[]) =>
  events.filter(
    (e): e is Extract<DriverEvent, { type: 'tool_result' }> => e.type === 'tool_result'
  );

describe('builtin driver: the loop', () => {
  it('reads, edits, runs a command and finishes, recording each model call with its cost', async () => {
    const model = scriptedModel([
      { content: [text('Looking.'), use('t1', 'read_file', { path: 'src/index.ts' })] },
      {
        content: [use('t2', 'edit_file', { path: 'src/index.ts', old_text: '41', new_text: '42' })],
      },
      { content: [use('t3', 'run_shell', { command: 'cat src/index.ts; echo done >&2' })] },
      {
        content: [text('Changed the answer to 42.')],
        usage: { input_tokens: 2_000, output_tokens: 50 },
      },
    ]);
    const { events, result } = await run(model.fetchImpl);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Changed the answer to 42.');
    expect(fs.readFileSync(path.join(repo, 'src', 'index.ts'), 'utf8')).toBe(
      'export const answer = 42;\n'
    );

    expect(events[0]).toMatchObject({ type: 'started', model: 'fake/priced' });
    const calls = events
      .filter((e) => e.type === 'tool_call')
      .map((e) => (e as { name: string }).name);
    expect(calls).toEqual(['fs.read', 'fs.edit', 'runtime.shell']);
    const outputs = toolResults(events);
    expect(outputs[0].output).toContain('1\texport const answer = 41;');
    expect(outputs[2].output).toContain('[exit code 0]');
    expect(outputs[2].output).toContain('export const answer = 42;');
    expect(outputs[2].output).toContain('[stderr]\ndone');
    expect(outputs.every((o) => o.approval === 'not_required')).toBe(true);

    const modelCalls = events
      .filter((e) => e.type === 'model_call')
      .map((e) => (e as { call: { costUsd: number | null; turn: number } }).call);
    expect(modelCalls).toHaveLength(4);
    expect(modelCalls.map((c) => c.turn)).toEqual([1, 2, 3, 4]);
    // 1000 in + 100 out at $1/M each, three times, then 2000 + 50.
    expect(result.costUsd).toBeCloseTo(3 * 0.0011 + 0.00205, 9);
    expect(result.tokensIn).toBe(5_000);
    expect(result.turns).toBe(4);

    // The second request carries the first round in the Messages API shape.
    const second = model.requests[1].messages as Array<{ role: string; content: unknown }>;
    expect(second[0]).toEqual({ role: 'user', content: 'Task:\nBump the answer to 42.' });
    expect(second[1].content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/index.ts' } },
    ]);
    expect((second[2].content as Block[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
    });
    expect((model.requests[0].tools as Block[]).map((t) => t.name)).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'write_file',
      'edit_file',
      'run_shell',
      'git_status',
      'git_diff',
    ]);
  });

  it('uses the key a run hands over, and never gives it to commands', async () => {
    const model = scriptedModel([
      {
        content: [
          use('t1', 'run_shell', { command: `echo "[$${BUILTIN_KEY_ENV}][$FAKE_MODEL_KEY]"` }),
        ],
      },
      { content: [text('ok')] },
    ]);
    const { events } = await run(model.fetchImpl, { secrets: { [BUILTIN_KEY_ENV]: 'vault-key' } });
    expect(model.headers[0]['x-api-key']).toBe('vault-key');
    expect(toolResults(events)[0].output).toContain('[][]');
  });

  it('lists, searches and diffs the worktree', async () => {
    const model = scriptedModel([
      {
        content: [
          use('a', 'list_files', { path: '.', depth: 2 }),
          use('b', 'search_files', { pattern: 'answer = 4[0-9]' }),
          use('c', 'write_file', { path: 'docs/new.md', content: 'hello\n' }),
          use('d', 'git_status', {}),
          use('e', 'git_diff', { stat: true }),
        ],
      },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl);
    const [list, search, write, status] = toolResults(events);
    expect(list.output.split('\n')).toEqual(['README.md', 'src/', 'src/index.ts']);
    expect(search.output).toBe('src/index.ts:1:export const answer = 41;');
    expect(write.output).toBe('Created docs/new.md (6 bytes).');
    expect(status.output).toContain('?? docs/');
    // All five results go back in one user turn, in order.
    const last = model.requests[1].messages as Array<{ content: Block[] }>;
    expect(last.at(-1)?.content.map((b) => b.tool_use_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps every path inside the worktree, links included', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
    if (!isWindows) fs.symlinkSync(outside, path.join(repo, 'link'));
    const model = scriptedModel([
      {
        content: [
          use('a', 'read_file', { path: '../secret.txt' }),
          use('b', 'read_file', { path: path.join(outside, 'secret.txt') }),
          use('c', 'write_file', { path: 'link/secret.txt', content: 'overwritten' }),
        ],
      },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl);
    const [a, b, c] = toolResults(events);
    expect(a).toMatchObject({ isError: true });
    expect(a.output).toContain('outside the configured root');
    expect(b.output).toContain('Absolute paths are not allowed');
    if (!isWindows) expect(c.output).toContain('symbolic link');
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('pages a long file and says how to read on', async () => {
    fs.writeFileSync(
      path.join(repo, 'long.txt'),
      Array.from({ length: 1_000 }, (_, i) => `line ${i + 1}`).join('\n')
    );
    const model = scriptedModel([
      {
        content: [
          use('a', 'read_file', { path: 'long.txt' }),
          use('b', 'read_file', { path: 'long.txt', offset: 990, limit: 50 }),
        ],
      },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl);
    const [first, second] = toolResults(events);
    expect(first.output).toContain('[Lines 1-400 of 1000. Read with offset 401 to see more.]');
    expect(second.output.split('\n')[0]).toBe(' 990\tline 990');
    expect(second.output).not.toContain('Read with offset');
  });

  it('cuts long command output, keeping the end, with a marker', async () => {
    const model = scriptedModel([
      { content: [use('a', 'run_shell', { command: 'seq 1 20000; echo THE-END; exit 3' })] },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl);
    const out = toolResults(events)[0];
    expect(out.isError).toBe(true);
    expect(out.output.startsWith('[exit code 3]\n1\n2\n')).toBe(true);
    expect(out.output).toContain('output truncated');
    expect(out.output.trimEnd().endsWith('THE-END')).toBe(true);
  });

  it('answers malformed tool input and unknown tools with an error, and carries on', async () => {
    const model = scriptedModel([
      { content: [use('a', 'no_such_tool', {}), use('b', 'read_file', {})] },
      { content: [text('ok')] },
    ]);
    const { events, result } = await run(model.fetchImpl);
    const [a, b] = toolResults(events);
    expect(a.output).toContain('There is no tool "no_such_tool"');
    expect(b.output).toBe('"path" is required.');
    expect(result.ok).toBe(true);
  });

  it('asks the model to continue when a reply stops at the output limit', async () => {
    const model = scriptedModel([
      { content: [text('Half a')], stop: 'max_tokens' },
      { content: [text('Whole answer.')] },
    ]);
    const { result } = await run(model.fetchImpl);
    expect(result.summary).toBe('Whole answer.');
    const second = model.requests[1].messages as Array<{ role: string; content: unknown }>;
    expect(second.at(-1)?.content).toContain('output limit');
  });

  it('fails plainly when the model declines', async () => {
    const model = scriptedModel([{ content: [text('No.')], stop: 'refusal' }]);
    const { result } = await run(model.fetchImpl);
    expect(result).toMatchObject({ ok: false, summary: 'The model declined to continue: No.' });
  });
});

describe('builtin driver: policy and approvals', () => {
  it('offers only reading tools in plan mode, and refuses the rest as unknown', async () => {
    const model = scriptedModel([
      { content: [use('a', 'write_file', { path: 'x', content: 'y' })] },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl, { permissionMode: 'plan' });
    expect((events[0] as { tools: string[] }).tools).toEqual([
      'fs.read',
      'fs.list',
      'fs.search',
      'git.status',
      'git.diff',
    ]);
    expect(toolResults(events)[0].output).toContain('There is no tool "write_file"');
    expect(fs.existsSync(path.join(repo, 'x'))).toBe(false);
  });

  it('in default mode, asks before writing, and does not write when refused', async () => {
    const asked: ToolApprovalRequest[] = [];
    const model = scriptedModel([
      { content: [use('a', 'write_file', { path: 'x.txt', content: 'one' })] },
      { content: [use('b', 'write_file', { path: 'y.txt', content: 'two' })] },
      { content: [text('done')] },
    ]);
    let answer = false;
    const { events, result } = await run(model.fetchImpl, {
      permissionMode: 'default',
      onApproval: async (request) => {
        asked.push(request);
        const a = answer;
        answer = true;
        return a;
      },
    });
    expect(asked.map((a) => [a.tool, a.risk])).toEqual([
      ['fs.write', 'write'],
      ['fs.write', 'write'],
    ]);
    expect(asked[0].reason).toContain('requires approval');
    const [refused, allowed] = toolResults(events);
    expect(refused).toMatchObject({ denied: true, approval: 'denied', isError: true });
    expect(allowed).toMatchObject({ approval: 'approved', isError: false });
    expect(fs.existsSync(path.join(repo, 'x.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'y.txt'), 'utf8')).toBe('two');
    expect(result.permissionDenials).toEqual([
      { tool: 'fs.write', input: { path: 'x.txt', content: 'one' } },
    ]);
  });

  it('lets a push from the shell wait for approval even with full access', async () => {
    const asked: string[] = [];
    const model = scriptedModel([
      { content: [use('a', 'run_shell', { command: 'git push origin HEAD' })] },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl, {
      onApproval: async (r) => {
        asked.push(r.tool);
        return false;
      },
    });
    expect(asked).toEqual(['git.push']);
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ name: 'git.push' });
    expect(toolResults(events)[0]).toMatchObject({ denied: true });
  });

  it('refuses a call that needs approval when nobody can be asked', async () => {
    const model = scriptedModel([
      { content: [use('a', 'write_file', { path: 'x.txt', content: 'one' })] },
      { content: [text('done')] },
    ]);
    const { events } = await run(model.fetchImpl, { permissionMode: 'default' });
    expect(toolResults(events)[0].output).toContain('Approval required');
  });

  it('stops waiting for an approval when the run is cancelled', async () => {
    const controller = new AbortController();
    const model = scriptedModel([
      { content: [use('a', 'write_file', { path: 'x.txt', content: 'one' })] },
    ]);
    const { result } = await run(model.fetchImpl, {
      permissionMode: 'default',
      signal: controller.signal,
      onApproval: () => {
        setTimeout(() => controller.abort(), 20);
        return new Promise<boolean>(() => undefined); // nobody answers
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: true, summary: 'Cancelled.' });
    expect(fs.existsSync(path.join(repo, 'x.txt'))).toBe(false);
  });

  it('narrows the tools to agent.allowed_tools', () => {
    const rules = builtinPolicy('acceptEdits', ['group:fs']);
    expect(offeredTools(rules).map((t) => t.name)).toEqual([
      'fs.read',
      'fs.list',
      'fs.search',
      'fs.write',
      'fs.edit',
    ]);
    expect(builtinPolicy('acceptEdits', ['runtime.shell']).allow).toEqual([
      'runtime.shell',
      'git.push',
    ]);
    expect(allowedToolProblem('fs.*')).toBeUndefined();
    expect(allowedToolProblem('Bash(git:*)')).toContain('names none of the builtin agent');
  });

  it('gives full access by default: nothing in the worktree waits for approval', () => {
    const rules = builtinPolicy();
    expect(rules.approvalRequired).toEqual(['git.push']);
    expect(offeredTools(rules)).toHaveLength(8);
  });

  it('recognises commands that publish', () => {
    expect(shellDescriptor('git push -u origin main').name).toBe('git.push');
    expect(shellDescriptor('cd x && git -C . push').name).toBe('git.push');
    expect(shellDescriptor('gh pr create --fill').name).toBe('git.push');
    expect(shellDescriptor('git status && echo push').name).toBe('runtime.shell');
    expect(shellDescriptor('pnpm test').name).toBe('runtime.shell');
  });
});

describe('builtin driver: limits', () => {
  it('stops at the run budget, measured from recorded cost', async () => {
    const model = scriptedModel([
      {
        content: [use('a', 'git_status', {})],
        usage: { input_tokens: 1_000, output_tokens: 599_000 },
      },
      {
        content: [use('b', 'git_status', {})],
        usage: { input_tokens: 1_000, output_tokens: 599_000 },
      },
      { content: [text('never')] },
    ]);
    const { result } = await run(model.fetchImpl, { maxBudgetUsd: 1 });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("the run's budget of $1.00 is spent");
    expect(result.costUsd).toBeCloseTo(1.2, 6);
    expect(model.requests).toHaveLength(2);
  });

  it('refuses a budget it cannot keep: an unpriced cloud model', async () => {
    const model = scriptedModel([]);
    const { result } = await run(model.fetchImpl, { model: 'fake/unpriced', maxBudgetUsd: 1 });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('has no price in providers.yaml');
    expect(model.requests).toHaveLength(0);
  });

  it('reports an unpriced model as unknown cost, not free', async () => {
    const model = scriptedModel([{ content: [text('done')] }]);
    const { result, events } = await run(model.fetchImpl, { model: 'fake/unpriced' });
    expect(result.costUsd).toBeNull();
    expect(events.find((e) => e.type === 'model_call')).toMatchObject({
      call: { costUsd: null, tokensIn: 1_000 },
    });
  });

  it('stops after the turn limit', async () => {
    const model = scriptedModel(
      Array.from({ length: 5 }, (_, i) => ({ content: [use(`t${i}`, 'git_status', {})] }))
    );
    const { result } = await run(model.fetchImpl, {}, { maxTurns: 3 });
    expect(result).toMatchObject({
      ok: false,
      summary: 'Stopped after 3 model turns without finishing.',
    });
    expect(model.requests).toHaveLength(3);
  });

  it('stops at the wall-clock limit, even inside a command', async () => {
    const model = scriptedModel([{ content: [use('a', 'run_shell', { command: 'sleep 30' })] }]);
    const started = Date.now();
    const { result } = await run(model.fetchImpl, { timeoutMs: 1_500 });
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('is cancelled by the caller, mid-command', async () => {
    const controller = new AbortController();
    const model = scriptedModel([{ content: [use('a', 'run_shell', { command: 'sleep 30' })] }]);
    setTimeout(() => controller.abort(), 300);
    const { result } = await run(model.fetchImpl, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, cancelled: true, timedOut: false });
  });

  it('reports each command it starts, and when it ends', async () => {
    const seen: string[] = [];
    const model = scriptedModel([
      { content: [use('a', 'run_shell', { command: 'true' })] },
      { content: [text('ok')] },
    ]);
    await run(model.fetchImpl, {
      onToolProcess: (p) => {
        seen.push(`start ${p.command}`);
        return () => seen.push('end');
      },
    });
    expect(seen).toEqual([isWindows ? 'start cmd.exe' : 'start /bin/sh', 'end']);
  });
});

describe('builtin driver: context', () => {
  it('compacts older turns through the model when the window fills, and records it', async () => {
    // The tiny model's window is 6000 tokens; each file read returns ~2500.
    fs.writeFileSync(
      path.join(repo, 'big.txt'),
      Array.from({ length: 380 }, (_, i) => `row ${i} ${'x'.repeat(16)}`).join('\n')
    );
    const model = scriptedModel([
      {
        content: [use('a', 'read_file', { path: 'big.txt' })],
        usage: { input_tokens: 800, output_tokens: 20 },
      },
      {
        content: [use('b', 'read_file', { path: 'big.txt', offset: 2 })],
        usage: { input_tokens: 3_300, output_tokens: 20 },
      },
      (body) => {
        // The summary request: no tools, the transcript in one user turn.
        expect(body.tools).toBeUndefined();
        expect(JSON.stringify(body.messages)).toContain('TOOL CALL read_file');
        return {
          content: [text('Read big.txt twice; it is rows of x.')],
          usage: { input_tokens: 2_000, output_tokens: 30 },
        };
      },
      (body) => {
        const messages = body.messages as Array<{ role: string; content: unknown }>;
        // Pinned task first, then the summary, then the kept round.
        expect(messages[0].content).toBe('Task:\nBump the answer to 42.');
        expect(String(messages[1].content)).toContain('Read big.txt twice');
        return { content: [text('done')], usage: { input_tokens: 1_000, output_tokens: 10 } };
      },
    ]);
    const { events, result } = await run(
      model.fetchImpl,
      { model: 'fake/tiny' },
      { maxOutputTokens: 1_024 }
    );
    expect(result.summary).toBe('done');
    const context = events.find((e) => e.type === 'context');
    expect(context).toMatchObject({
      action: 'compacted',
      method: 'summary',
      summary: 'Read big.txt twice; it is rows of x.',
    });
    const purposes = events
      .filter((e) => e.type === 'model_call')
      .map((e) => (e as { call: { purpose: string } }).call.purpose);
    expect(purposes).toEqual(['turn', 'turn', 'compaction', 'turn']);
    // The compaction call is paid for like any other.
    expect(result.tokensIn).toBe(800 + 3_300 + 2_000 + 1_000);
  });
});

describe('builtin driver: detect', () => {
  it('needs a qualified model', async () => {
    const d = await builtin({ registry: () => REGISTRY }).detect({ model: 'priced' });
    expect(d).toMatchObject({ available: false });
    expect(d.reason).toContain('provider/model');
  });

  it('says which key is missing, unless the run brings one', async () => {
    delete process.env.FAKE_MODEL_KEY;
    const driver = builtin({ registry: () => REGISTRY });
    const without = await driver.detect({ model: 'fake/priced' });
    expect(without.available).toBe(false);
    expect(without.reason).toContain('FAKE_MODEL_KEY');
    expect((await driver.detect({ model: 'fake/priced', apiKey: true })).available).toBe(true);
  });

  it('refuses a budget for an unpriced cloud model', async () => {
    const d = await builtin({ registry: () => REGISTRY }).detect({
      model: 'fake/unpriced',
      budget: true,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toContain('has no price');
    expect(
      (await builtin({ registry: () => REGISTRY }).detect({ model: 'fake/unpriced' })).available
    ).toBe(true);
  });

  it('checks that a local server answers', async () => {
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const up = (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;
    const d = await builtin({ registry: () => REGISTRY, fetch: down }).detect({
      model: 'local/m',
      budget: true,
    });
    expect(d.available).toBe(false);
    expect(d.reason).toContain('Nothing answers at http://127.0.0.1:9/v1');
    expect(
      (
        await builtin({ registry: () => REGISTRY, fetch: up }).detect({
          model: 'local/m',
          budget: true,
        })
      ).available
    ).toBe(true);
  });

  it('without a model, reports each provider and whether any has a key', async () => {
    const d = await builtin({ registry: () => REGISTRY }).detect();
    expect(d.available).toBe(true);
    expect(d.providers).toEqual([
      { id: 'fake', label: 'Fake', ready: true, local: false },
      { id: 'local', label: 'Local', ready: true, local: true },
    ]);
    delete process.env.FAKE_MODEL_KEY;
    const none = await builtin({ registry: () => REGISTRY }).detect();
    expect(none.available).toBe(false);
    expect(none.reason).toContain('No model provider has a key set');
  });
});
