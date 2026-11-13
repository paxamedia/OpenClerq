import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex, buildCodexArgs, CodexStream, type DriverEvent } from './index.js';

const isWindows = process.platform === 'win32';

let dir: string;
let work: string;
let fakeBin: string;

/**
 * A stand-in for the codex CLI. It records its arguments and environment, then
 * speaks `exec --json` according to FAKE_MODE. `login status` answers from a
 * marker file beside it, so a test can sign the fake out.
 */
const FAKE = String.raw`#!/bin/sh
here=$(dirname "$0")
case "$1" in
  --version) echo "codex-cli 9.9.9"; exit 0 ;;
  login)
    if [ -f "$here/signed-out" ]; then echo "Not logged in"; exit 1; fi
    echo "Logged in using ChatGPT"; exit 0 ;;
esac
printf '%s\n' "$@" > "$FAKE_LOG.args"
env > "$FAKE_LOG.env"
case "$FAKE_MODE" in
  success)
    printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}'
    printf '%s\n' '{"type":"turn.started"}'
    printf '%s\n' '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"bash -lc ls","aggregated_output":"README.md\n","exit_code":0,"status":"completed"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"Thinking about it"}}'
    echo hi > hello.txt
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"hello.txt","kind":"add"}],"status":"completed"}}'
    printf '%s\n' '{"type":"item.updated","item":{"id":"item_3","type":"todo_list","items":[{"text":"x","completed":false}]}}'
    echo 'not json at all'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Created hello.txt"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50,"reasoning_output_tokens":10}}'
    ;;
  tools)
    printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"rm -rf /","aggregated_output":"","exit_code":null,"status":"declined"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"false","aggregated_output":"oops","exit_code":1,"status":"failed"}}'
    printf '%s\n' '{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"x"},"status":"in_progress"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"x"},"result":{"content":[{"type":"text","text":"found it"}]},"error":null,"status":"completed"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_3","type":"web_search","query":"clerq"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_4","type":"error","message":"model refused a tool"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"Done."}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'
    ;;
  two_turns)
    printf '%s\n' '{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"first"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"b","type":"agent_message","text":"second"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":2}}'
    ;;
  not_signed_in)
    printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}'
    printf '%s\n' '{"type":"turn.failed","error":{"message":"401 Unauthorized: Missing bearer or basic authentication in header"}}'
    exit 1
    ;;
  not_signed_in_stderr)
    echo "Error: Not logged in. Run codex login" >&2
    exit 1
    ;;
  turn_failed)
    printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}'
    printf '%s\n' '{"type":"error","message":"Reconnecting... 1/5"}'
    printf '%s\n' '{"type":"turn.failed","error":{"message":"The model is overloaded"}}'
    exit 0
    ;;
  no_turn)
    printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}'
    exit 0
    ;;
  crash)
    echo "boom: something broke" >&2
    exit 2
    ;;
  secret)
    printf '%s\n' "{\"type\":\"item.completed\",\"item\":{\"id\":\"i\",\"type\":\"agent_message\",\"text\":\"key=$CODEX_API_KEY openai=$OPENAI_API_KEY\"}}"
    printf '%s\n' '{"type":"turn.completed","usage":{}}'
    ;;
  slow)
    printf '%s\n' '{"type":"thread.started","thread_id":"t-1"}'
    sleep 30
    ;;
esac
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-codex-'));
  work = path.join(dir, 'work');
  fs.mkdirSync(work);
  fakeBin = path.join(dir, 'codex');
  fs.writeFileSync(fakeBin, FAKE, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const out: DriverEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function runFake(
  mode: string,
  extra: Partial<Parameters<ReturnType<typeof codex>['run']>[0]> = {}
) {
  const log = path.join(dir, `log-${mode}-${Math.random().toString(36).slice(2)}`);
  const driver = codex({ bin: fakeBin });
  const events = collect(
    driver.run({
      prompt: 'do the thing',
      cwd: work,
      ...extra,
      env: { FAKE_MODE: mode, FAKE_LOG: log, ...extra.env },
    })
  );
  return { events, log };
}

function finished(events: DriverEvent[]) {
  const last = events[events.length - 1];
  if (last?.type !== 'finished') throw new Error('no finished event');
  return last.result;
}

describe('buildCodexArgs', () => {
  it('puts the prompt after "--", so a leading dash is not read as an option', () => {
    const args = buildCodexArgs({ prompt: '- update the lockfile', cwd: '/x', model: 'gpt-5' });
    expect(args.slice(-2)).toEqual(['--', '- update the lockfile']);
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('--'));
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--model', 'gpt-5']));
  });

  it('lets the agent edit the workspace by default, and never lifts the sandbox', () => {
    const args = buildCodexArgs({ prompt: 'x', cwd: '/x' });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    const all = args.join(' ');
    expect(all).not.toMatch(/danger|yolo|bypass|full-auto/);
  });

  it('uses the read-only sandbox for every mode that does not accept edits', () => {
    for (const permissionMode of ['plan', 'default', 'dontAsk'] as const) {
      const args = buildCodexArgs({ prompt: 'x', cwd: '/x', permissionMode });
      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    }
    const edit = buildCodexArgs({ prompt: 'x', cwd: '/x', permissionMode: 'acceptEdits' });
    expect(edit[edit.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });
});

describe('CodexStream', () => {
  it('turns exec --json lines into driver events', () => {
    const s = new CodexStream('gpt-5');
    expect(s.consume('{"type":"thread.started","thread_id":"t"}', 'stdout')).toEqual([
      { type: 'started', model: 'gpt-5' },
    ]);
    expect(s.consume('{"type":"turn.started"}', 'stdout')).toEqual([]);
    expect(
      s.consume(
        '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","status":"in_progress"}}',
        'stdout'
      )
    ).toEqual([{ type: 'tool_call', id: 'i1', name: 'Bash', input: { command: 'ls' } }]);
    expect(
      s.consume(
        '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a\\nb","exit_code":0,"status":"completed"}}',
        'stdout'
      )
    ).toEqual([{ type: 'tool_result', id: 'i1', output: 'a\nb', isError: false }]);
    expect(s.consume('garbage', 'stdout')).toEqual([
      { type: 'log', stream: 'stdout', line: 'garbage' },
    ]);
    expect(s.consume('', 'stdout')).toEqual([]);
  });

  it('shows a call that only ever arrives completed, once', () => {
    const s = new CodexStream();
    const events = s.consume(
      '{"type":"item.completed","item":{"id":"c","type":"file_change","changes":[{"path":"a.ts","kind":"update"},{"path":"b.ts","kind":"delete"}],"status":"completed"}}',
      'stdout'
    );
    // The first event of any stream is `started`.
    expect(events.map((e) => e.type)).toEqual(['started', 'tool_call', 'tool_result']);
    expect(events[2]).toMatchObject({ output: 'update a.ts\ndelete b.ts', isError: false });
  });

  it('caps very large command output', () => {
    const s = new CodexStream();
    const events = s.consume(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'big',
          type: 'command_execution',
          command: 'cat log',
          aggregated_output: 'x'.repeat(100_000),
          exit_code: 0,
          status: 'completed',
        },
      }),
      'stdout'
    );
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.output.length).toBeLessThan(70_000);
  });

  it('ignores items and events it does not know', () => {
    const s = new CodexStream();
    s.consume('{"type":"thread.started","thread_id":"t"}', 'stdout');
    expect(
      s.consume('{"type":"item.completed","item":{"id":"z","type":"hologram"}}', 'stdout')
    ).toEqual([]);
    expect(s.consume('{"type":"something.new","x":1}', 'stdout')).toEqual([]);
    expect(s.consume('[1,2,3]', 'stdout')).toEqual([
      { type: 'log', stream: 'stdout', line: '[1,2,3]' },
    ]);
  });
});

describe.skipIf(isWindows)('codex driver', () => {
  it('detects the CLI, its version and the sign-in', async () => {
    const found = await codex({ bin: fakeBin }).detect();
    expect(found).toMatchObject({ id: 'codex', available: true, version: '9.9.9', signedIn: true });
  });

  it('says plainly when the CLI is missing', async () => {
    const missing = codex({ bin: path.join(dir, 'nope') });
    const found = await missing.detect();
    expect(found.available).toBe(false);
    expect(found.reason).toBeTruthy();
    const result = finished(await collect(missing.run({ prompt: 'x', cwd: work })));
    expect(result.ok).toBe(false);
  });

  it('says plainly when it is not signed in, unless the run brings an API key', async () => {
    const marker = path.join(dir, 'signed-out');
    fs.writeFileSync(marker, '');
    try {
      const driver = codex({ bin: fakeBin });
      const out = await driver.detect();
      expect(out).toMatchObject({ available: false, signedIn: false });
      expect(out.reason).toMatch(/not signed in.*codex login/);
      // The key stands in for the sign-in.
      expect(await driver.detect({ apiKey: true })).toMatchObject({ available: true });
    } finally {
      fs.rmSync(marker);
    }
  });

  it('streams what the agent did and reports tokens, with no cost', async () => {
    const { events } = runFake('success', { model: 'gpt-5-codex' });
    const all = await events;
    expect(all.map((e) => e.type)).toEqual([
      'started',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'log',
      'text',
      'finished',
    ]);
    expect(all[0]).toEqual({ type: 'started', model: 'gpt-5-codex' });
    expect(all[2]).toMatchObject({ type: 'tool_result', id: 'item_0', output: 'README.md\n' });
    const result = finished(all);
    expect(result).toMatchObject({
      ok: true,
      summary: 'Created hello.txt',
      costUsd: null,
      tokensIn: 1000,
      tokensOut: 50,
      turns: 1,
      exitCode: 0,
      permissionDenials: [],
    });
    expect(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8').trim()).toBe('hi');
  });

  it('records refused and failed commands, MCP calls and searches', async () => {
    const all = await runFake('tools').events;
    const results = all.filter((e) => e.type === 'tool_result');
    expect(results).toEqual([
      { type: 'tool_result', id: 'item_0', output: '', isError: true },
      { type: 'tool_result', id: 'item_1', output: 'oops\n[exit 1]', isError: true },
      { type: 'tool_result', id: 'item_2', output: 'found it', isError: false },
      { type: 'tool_result', id: 'item_3', output: '', isError: false },
    ]);
    const calls = all
      .filter((e) => e.type === 'tool_call')
      .map((e) => e.type === 'tool_call' && e.name);
    expect(calls).toEqual(['Bash', 'Bash', 'mcp__docs__search', 'WebSearch']);
    expect(all).toContainEqual({ type: 'log', stream: 'stderr', line: 'model refused a tool' });
    expect(finished(all)).toMatchObject({
      ok: true,
      permissionDenials: [{ tool: 'Bash', input: { command: 'rm -rf /' } }],
    });
  });

  it('adds up the tokens of every turn', async () => {
    const result = finished(await runFake('two_turns').events);
    expect(result).toMatchObject({
      ok: true,
      summary: 'second',
      tokensIn: 30,
      tokensOut: 3,
      turns: 2,
    });
  });

  it('passes the model and the sandbox on the command line, and the prompt last', async () => {
    const { events, log } = runFake('success', { model: 'o3', permissionMode: 'plan' });
    await events;
    const args = fs.readFileSync(`${log}.args`, 'utf8').trim().split('\n');
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'o3', '--sandbox', 'read-only', '--ephemeral'])
    );
    expect(args.slice(-2)).toEqual(['--', 'do the thing']);
  });

  it('says what it could not pass on, rather than ignoring it', async () => {
    const result = finished(
      await runFake('success', { maxBudgetUsd: 2, allowedTools: ['Bash(pnpm test:*)'] }).events
    );
    expect(result.warnings.join('\n')).toMatch(/no spend limit/);
    expect(result.warnings.join('\n')).toMatch(/no tool list|takes no tool list/);
    expect(result.ok).toBe(true);
  });

  it('does not hand the gateway environment to the agent', async () => {
    process.env.OPENAI_API_KEY = 'sk-gateway-own-key-000000';
    process.env.CODEX_API_KEY = 'sk-gateway-codex-key-000000';
    try {
      const { events, log } = runFake('secret');
      const result = finished(await events);
      expect(result.summary).toBe('key= openai=');
      const env = fs.readFileSync(`${log}.env`, 'utf8');
      expect(env).not.toContain('sk-gateway');
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.CODEX_API_KEY;
    }
  });

  it('passes an API key given as a secret, and redacts it', async () => {
    const { events } = runFake('secret', {
      secrets: { CODEX_API_KEY: 'xxxxxxxxxxxxxxxxxxxx' },
    });
    expect(finished(await events).summary).toBe('key=«redacted» openai=');
  });

  it('explains a missing sign-in, from the stream or from stderr', async () => {
    for (const mode of ['not_signed_in', 'not_signed_in_stderr']) {
      const result = finished(await runFake(mode).events);
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/not signed in.*codex login/);
    }
  });

  it('fails a turn that failed even when the process exited 0', async () => {
    const result = finished(await runFake('turn_failed').events);
    expect(result).toMatchObject({ ok: false, exitCode: 0 });
    expect(result.summary).toBe('Codex stopped: The model is overloaded');
  });

  it('fails a run that ended without finishing a turn', async () => {
    const result = finished(await runFake('no_turn').events);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/before finishing the turn/);
  });

  it('reports a crash with its stderr', async () => {
    const result = finished(await runFake('crash').events);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.summary).toContain('boom: something broke');
  });

  it('stops the agent when the signal aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = finished(await runFake('slow', { signal: controller.signal }).events);
    expect(result).toMatchObject({ ok: false, cancelled: true, summary: 'Cancelled.' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops the agent at its time limit', async () => {
    const result = finished(await runFake('slow', { timeoutMs: 300 }).events);
    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  it('stops the agent when the caller stops listening', async () => {
    const log = path.join(dir, 'log-abandon');
    const iter = codex({ bin: fakeBin }).run({
      prompt: 'x',
      cwd: work,
      env: { FAKE_MODE: 'slow', FAKE_LOG: log },
    });
    const started = Date.now();
    for await (const e of iter) {
      if (e.type === 'started') break;
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports the process it started, so a crashed gateway can find it', async () => {
    const seen: Array<{ pid: number; pgid: number; command: string }> = [];
    const { events } = runFake('success', { onSpawn: (p) => seen.push(p) });
    await events;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ command: fakeBin });
    expect(seen[0].pgid).toBe(seen[0].pid);
  });
});
