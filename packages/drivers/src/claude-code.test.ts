import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCode, buildClaudeArgs, ClaudeStream, locate, type DriverEvent } from './index.js';

const isWindows = process.platform === 'win32';

let dir: string;
let work: string;
let fakeBin: string;

/**
 * A stand-in for the claude CLI. It records its arguments and environment,
 * then speaks stream-json according to FAKE_MODE.
 */
const FAKE = String.raw`#!/bin/sh
printf '%s\n' "$@" > "$FAKE_LOG.args"
env > "$FAKE_LOG.env"
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
case "$FAKE_MODE" in
  success)
    echo '{"type":"system","subtype":"init","model":"claude-test","tools":["Edit","Bash"]}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Creating the file."},{"type":"tool_use","id":"toolu_1","name":"Write","input":{"file_path":"hello.txt"}}]}}'
    echo hi > hello.txt
    echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"File written"}]}]}}'
    echo 'not json at all'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"done","num_turns":2,"total_cost_usd":0.0123,"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":20},"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}]}'
    ;;
  not_signed_in)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","total_cost_usd":0,"usage":{}}'
    exit 1
    ;;
  budget)
    echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.5,"usage":{}}'
    exit 1
    ;;
  crash)
    echo "boom: something broke" >&2
    exit 2
    ;;
  secret)
    echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"key=$ANTHROPIC_API_KEY\",\"usage\":{}}"
    ;;
  slow)
    echo '{"type":"system","subtype":"init"}'
    sleep 30
    ;;
esac
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-drv-'));
  work = path.join(dir, 'work');
  fs.mkdirSync(work);
  fakeBin = path.join(dir, 'claude');
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
  extra: Partial<Parameters<ReturnType<typeof claudeCode>['run']>[0]> = {}
) {
  const log = path.join(dir, `log-${mode}-${Math.random().toString(36).slice(2)}`);
  const driver = claudeCode({ bin: fakeBin });
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

describe('buildClaudeArgs', () => {
  it('puts the prompt after "--", so a leading dash is not read as an option', () => {
    const args = buildClaudeArgs({
      prompt: '- update the lockfile',
      cwd: '/x',
      model: 'sonnet',
      maxBudgetUsd: 2,
      allowedTools: ['Bash(pnpm test:*)', 'Edit'],
    });
    expect(args.slice(-2)).toEqual(['--', '- update the lockfile']);
    // The variadic tools list ends at the separator.
    expect(args.indexOf('--allowedTools')).toBeLessThan(args.indexOf('--'));
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--max-budget-usd', '2']));
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose'])
    );
  });

  it('accepts edits by default and never skips permissions', () => {
    const args = buildClaudeArgs({ prompt: 'x', cwd: '/x' });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).not.toContain('dangerously');
  });
});

describe('ClaudeStream', () => {
  it('turns stream-json lines into driver events', () => {
    const s = new ClaudeStream();
    expect(
      s.consume('{"type":"system","subtype":"init","model":"m","tools":["Edit"]}', 'stdout')
    ).toEqual([{ type: 'started', model: 'm', tools: ['Edit'] }]);
    expect(
      s.consume(
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
        'stdout'
      )
    ).toEqual([{ type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
    expect(
      s.consume(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"denied","is_error":true}]}}',
        'stdout'
      )
    ).toEqual([{ type: 'tool_result', id: 't1', output: 'denied', isError: true }]);
    expect(s.consume('garbage', 'stdout')).toEqual([
      { type: 'log', stream: 'stdout', line: 'garbage' },
    ]);
    expect(s.consume('', 'stdout')).toEqual([]);
  });

  it('caps very large tool output', () => {
    const s = new ClaudeStream();
    const big = 'x'.repeat(100_000);
    const [event] = s.consume(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] },
      }),
      'stdout'
    );
    expect(event.type === 'tool_result' && event.output.length).toBeLessThan(70_000);
  });
});

describe.skipIf(isWindows)('claude-code driver', () => {
  it('detects the CLI and its version', async () => {
    const found = await claudeCode({ bin: fakeBin }).detect();
    expect(found).toMatchObject({ id: 'claude-code', available: true, version: '9.9.9' });
  });

  it('says plainly when the CLI cannot run', async () => {
    const missing = claudeCode({ bin: path.join(dir, 'nope') });
    const found = await missing.detect();
    expect(found.available).toBe(false);
    expect(found.reason).toBeTruthy();
    const result = finished(await collect(missing.run({ prompt: 'x', cwd: work })));
    expect(result.ok).toBe(false);
  });

  it('finds a CLI on PATH, then in the usual install locations', () => {
    expect(locate('claude', dir)).toBe(fakeBin);
    expect(locate('definitely-not-a-real-cli-xyz', dir)).toBeNull();
  });

  it('streams what the agent did and reports cost and tokens', async () => {
    const { events } = runFake('success');
    const all = await events;
    expect(all.map((e) => e.type)).toEqual([
      'started',
      'text',
      'tool_call',
      'tool_result',
      'log',
      'finished',
    ]);
    const result = finished(all);
    expect(result).toMatchObject({
      ok: true,
      summary: 'done',
      costUsd: 0.0123,
      tokensIn: 115,
      tokensOut: 20,
      turns: 2,
      exitCode: 0,
      permissionDenials: [{ tool: 'Bash', input: { command: 'rm -rf /' } }],
    });
    expect(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8').trim()).toBe('hi');
  });

  it('passes the run options on the command line', async () => {
    const { events, log } = runFake('success', {
      model: 'opus',
      maxBudgetUsd: 1.5,
      allowedTools: ['Bash(pnpm test:*)'],
    });
    await events;
    const args = fs.readFileSync(`${log}.args`, 'utf8').trim().split('\n');
    expect(args.slice(-2)).toEqual(['--', 'do the thing']);
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus', '--max-budget-usd', '1.5']));
  });

  it('does not hand the gateway environment to the agent', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-gateway-own-key-000000';
    process.env.CLAUDE_CODE_SIMPLE = '1';
    try {
      const { events, log } = runFake('secret');
      const result = finished(await events);
      expect(result.summary).toBe('key=');
      const env = fs.readFileSync(`${log}.env`, 'utf8');
      expect(env).not.toContain('sk-gateway-own-key');
      // Bare mode would skip the Keychain where the user's login lives.
      expect(env).not.toContain('CLAUDE_CODE_SIMPLE');
      expect(env).toContain('DISABLE_AUTOUPDATER=1');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_SIMPLE;
    }
  });

  it('passes an API key given as a secret, and redacts it', async () => {
    const { events } = runFake('secret', {
      secrets: { ANTHROPIC_API_KEY: 'xxxxxxxxxxxxxxxxxxxx' },
    });
    expect(finished(await events).summary).toBe('key=«redacted»');
  });

  it('explains a missing sign-in', async () => {
    const result = finished(await runFake('not_signed_in').events);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not signed in/);
  });

  it('reports why the agent stopped', async () => {
    const result = finished(await runFake('budget').events);
    expect(result).toMatchObject({ ok: false, costUsd: 0.5 });
    expect(result.summary).toBe('Stopped: max budget usd.');
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
    const iter = claudeCode({ bin: fakeBin }).run({
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
});
