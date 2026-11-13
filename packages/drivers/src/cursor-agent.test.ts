import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cursorAgent,
  buildCursorArgs,
  CursorStream,
  DRIVER_CAPABILITIES,
  DRIVER_IDS,
  getDriver,
  type DriverEvent,
} from './index.js';

const isWindows = process.platform === 'win32';

let dir: string;
let work: string;
let fakeBin: string;

/**
 * A stand-in for the cursor-agent CLI. It records its arguments and
 * environment, then speaks stream-json according to FAKE_MODE. `status`
 * answers from a marker file beside it, so a test can sign the fake out.
 */
const FAKE = String.raw`#!/bin/sh
here=$(dirname "$0")
case "$1" in
  --version) echo "2099.01.01-abcdef0"; exit 0 ;;
  --help)
    if [ -f "$here/broken-help" ]; then echo "usage error" >&2; exit 1; fi
    echo "Usage: cursor-agent [options] [prompt...]"
    echo "  -p, --print                 Print responses"
    echo "  --output-format <format>    text, json or stream-json"
    echo "  --model <model>             Model to use"
    [ -f "$here/no-trust" ] || echo "  --trust                     Trust the workspace"
    [ -f "$here/no-mode" ] || echo "  --mode <mode>               plan or ask"
    echo "  -f, --force                 Allow commands"
    exit 0 ;;
  status)
    if [ -f "$here/signed-out" ]; then echo "Not logged in"; exit 1; fi
    echo "Logged in as test@example.com"; exit 0 ;;
esac
printf '%s\n' "$@" > "$FAKE_LOG.args"
env > "$FAKE_LOG.env"
case "$FAKE_MODE" in
  success)
    printf '%s\n' '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/w","session_id":"s","model":"Test Model","permissionMode":"default"}'
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do the thing"}]},"session_id":"s"}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the readme."}]},"session_id":"s"}'
    printf '%s\n' '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"s"}'
    printf '%s\n' '{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"# app","isEmpty":false,"totalLines":1}}}},"session_id":"s"}'
    echo hi > hello.txt
    printf '%s\n' '{"type":"tool_call","subtype":"started","call_id":"c2","tool_call":{"writeToolCall":{"args":{"path":"hello.txt","fileText":"hi\n"}}},"session_id":"s"}'
    printf '%s\n' '{"type":"tool_call","subtype":"completed","call_id":"c2","tool_call":{"writeToolCall":{"args":{"path":"hello.txt"},"result":{"success":{"path":"/w/hello.txt","linesCreated":1,"fileSize":3}}}},"session_id":"s"}'
    echo 'not json at all'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Created hello.txt."}]},"session_id":"s"}'
    printf '%s\n' '{"type":"result","subtype":"success","duration_ms":1234,"duration_api_ms":1234,"is_error":false,"result":"Created hello.txt.","session_id":"s","request_id":"r"}'
    ;;
  tools)
    printf '%s\n' '{"type":"system","subtype":"init","model":"Test Model"}'
    printf '%s\n' '{"type":"tool_call","subtype":"started","call_id":"a","tool_call":{"shellToolCall":{"args":{"command":"rm -rf /"}}}}'
    printf '%s\n' '{"type":"tool_call","subtype":"completed","call_id":"a","tool_call":{"shellToolCall":{"args":{"command":"rm -rf /"},"result":{"rejected":{"command":"rm -rf /","reason":"not allowed"}}}}}'
    printf '%s\n' '{"type":"tool_call","subtype":"completed","call_id":"b","tool_call":{"shellToolCall":{"args":{"command":"ls"},"result":{"success":{"command":"ls","exitCode":0,"stdout":"a\nb\n","stderr":""}}}}}'
    printf '%s\n' '{"type":"tool_call","subtype":"completed","call_id":"c","tool_call":{"shellToolCall":{"args":{"command":"false"},"result":{"success":{"exitCode":1,"stdout":"","stderr":"nope"}}}}}'
    printf '%s\n' '{"type":"tool_call","subtype":"started","call_id":"d","tool_call":{"function":{"args":{"name":"search_docs","arguments":"{\"q\":\"x\"}"}}}}'
    printf '%s\n' '{"type":"tool_call","subtype":"completed","call_id":"d","tool_call":{"function":{"args":{"name":"search_docs","arguments":"{\"q\":\"x\"}"},"result":{"error":{"message":"server down"}}}}}'
    printf '%s\n' '{"type":"thinking","subtype":"delta","text":"hmm"}'
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":50,"cacheWriteTokens":5}}'
    ;;
  not_signed_in)
    echo "Error: Not logged in. Run cursor-agent login or set CURSOR_API_KEY" >&2
    exit 1
    ;;
  talks_about_auth)
    echo "warning: unauthorized request retried" >&2
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"Fixed the 401 Unauthorized handler. Not logged in users now see a banner.","session_id":"s"}'
    ;;
  error_not_signed_in)
    printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Not logged in. Run cursor-agent login"}'
    exit 1
    ;;
  error_result)
    printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"The model could not continue"}'
    exit 1
    ;;
  no_result)
    printf '%s\n' '{"type":"system","subtype":"init","model":"m"}'
    exit 0
    ;;
  crash)
    echo "boom: something broke" >&2
    exit 2
    ;;
  secret)
    printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"key=$CURSOR_API_KEY\"}"
    ;;
  slow)
    printf '%s\n' '{"type":"system","subtype":"init","model":"m"}'
    sleep 30
    ;;
esac
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cursor-'));
  work = path.join(dir, 'work');
  fs.mkdirSync(work);
  fakeBin = path.join(dir, 'cursor-agent');
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
  extra: Partial<Parameters<ReturnType<typeof cursorAgent>['run']>[0]> = {}
) {
  const log = path.join(dir, `log-${mode}-${Math.random().toString(36).slice(2)}`);
  const driver = cursorAgent({ bin: fakeBin });
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

describe('driver registry', () => {
  it('knows every driver, and what each CLI can honour', () => {
    expect(DRIVER_IDS).toEqual(['claude-code', 'codex', 'cursor-agent', 'builtin']);
    for (const id of DRIVER_IDS) {
      expect(getDriver(id).id).toBe(id);
      expect(DRIVER_CAPABILITIES[id].apiKeyEnv).toMatch(/_API_KEY$/);
    }
    expect(DRIVER_CAPABILITIES['claude-code']).toMatchObject({
      budgetLimit: true,
      reportsCost: true,
      allowedTools: true,
    });
    expect(DRIVER_CAPABILITIES.codex).toMatchObject({ budgetLimit: false, reportsCost: false });
    expect(DRIVER_CAPABILITIES['cursor-agent']).toMatchObject({
      budgetLimit: false,
      allowedTools: false,
    });
    expect(DRIVER_CAPABILITIES.builtin).toMatchObject({
      budgetLimit: true,
      reportsCost: true,
      allowedTools: true,
    });
    expect(() => getDriver('nope')).toThrow(/Known: claude-code, codex, cursor-agent, builtin/);
  });
});

describe('buildCursorArgs', () => {
  it('puts the prompt after "--", so a leading dash is not read as an option', () => {
    const args = buildCursorArgs({ prompt: '- update the lockfile', cwd: '/x', model: 'sonnet-4' });
    expect(args.slice(-2)).toEqual(['--', '- update the lockfile']);
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('--'));
    expect(args).toEqual(
      expect.arrayContaining(['--print', '--output-format', 'stream-json', '--model', 'sonnet-4'])
    );
  });

  it('trusts the prepared workspace but never forces every action through', () => {
    const args = buildCursorArgs({ prompt: 'x', cwd: '/x' });
    expect(args).toContain('--trust');
    expect(args.join(' ')).not.toMatch(/--force|--yolo|-f\b/);
    expect(args).not.toContain('--mode');
  });

  it('runs agent mode only for acceptEdits', () => {
    const mode = (permissionMode: 'plan' | 'default' | 'acceptEdits' | 'dontAsk') => {
      const args = buildCursorArgs({ prompt: 'x', cwd: '/x', permissionMode });
      return args.includes('--mode') ? args[args.indexOf('--mode') + 1] : null;
    };
    expect(mode('plan')).toBe('plan');
    expect(mode('default')).toBe('ask');
    expect(mode('acceptEdits')).toBeNull();
    // Nothing here may ask a person, so what is not granted is denied.
    expect(mode('dontAsk')).toBe('ask');
  });
});

describe('CursorStream', () => {
  it('turns stream-json lines into driver events', () => {
    const s = new CursorStream();
    expect(
      s.consume(
        '{"type":"system","subtype":"init","model":"Claude 4 Sonnet","session_id":"s"}',
        'stdout'
      )
    ).toEqual([{ type: 'started', model: 'Claude 4 Sonnet' }]);
    expect(
      s.consume(
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
        'stdout'
      )
    ).toEqual([]);
    expect(
      s.consume(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}',
        'stdout'
      )
    ).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(
      s.consume(
        '{"type":"tool_call","subtype":"started","call_id":"c","tool_call":{"readToolCall":{"args":{"path":"a"}}}}',
        'stdout'
      )
    ).toEqual([{ type: 'tool_call', id: 'c', name: 'Read', input: { path: 'a' } }]);
    expect(
      s.consume(
        '{"type":"tool_call","subtype":"completed","call_id":"c","tool_call":{"readToolCall":{"args":{"path":"a"},"result":{"success":{"content":"text"}}}}}',
        'stdout'
      )
    ).toEqual([{ type: 'tool_result', id: 'c', output: 'text', isError: false }]);
    expect(s.consume('garbage', 'stdout')).toEqual([
      { type: 'log', stream: 'stdout', line: 'garbage' },
    ]);
    expect(s.consume('', 'stdout')).toEqual([]);
  });

  it('shows a call that only ever arrives completed, once', () => {
    const s = new CursorStream();
    const events = s.consume(
      '{"type":"tool_call","subtype":"completed","call_id":"x","tool_call":{"grepToolCall":{"args":{"pattern":"a"},"result":{"success":{"matches":3}}}}}',
      'stdout'
    );
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
    expect(events[0]).toMatchObject({ name: 'Grep' });
    expect(events[1]).toMatchObject({ output: '{"matches":3}' });
  });

  it('ignores events it does not know, and a tool call with no tool in it', () => {
    const s = new CursorStream();
    expect(s.consume('{"type":"thinking","subtype":"delta"}', 'stdout')).toEqual([]);
    expect(s.consume('{"type":"something.new"}', 'stdout')).toEqual([]);
    expect(s.consume('{"type":"tool_call","subtype":"started","call_id":"z"}', 'stdout')).toEqual(
      []
    );
    expect(s.consume('[1]', 'stdout')).toEqual([{ type: 'log', stream: 'stdout', line: '[1]' }]);
  });

  it('caps very large tool output', () => {
    const s = new CursorStream();
    const events = s.consume(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'big',
        tool_call: {
          readToolCall: {
            args: { path: 'a' },
            result: { success: { content: 'x'.repeat(100_000) } },
          },
        },
      }),
      'stdout'
    );
    const result = events.find((e) => e.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.output.length).toBeLessThan(70_000);
  });
});

describe.skipIf(isWindows)('cursor-agent driver', () => {
  it('detects the CLI, its version and the sign-in', async () => {
    const found = await cursorAgent({ bin: fakeBin }).detect();
    expect(found).toMatchObject({
      id: 'cursor-agent',
      available: true,
      version: '2099.01.01-abcdef0',
      signedIn: true,
    });
  });

  it('says plainly when the CLI is missing', async () => {
    const missing = cursorAgent({ bin: path.join(dir, 'nope') });
    const found = await missing.detect();
    expect(found.available).toBe(false);
    expect(found.reason).toBeTruthy();
    const result = finished(await collect(missing.run({ prompt: 'x', cwd: work })));
    expect(result.ok).toBe(false);
  });

  describe('flags the installed CLI must know', () => {
    const marker = (name: string) => path.join(dir, name);
    const without = async (name: string, check: () => Promise<void>) => {
      fs.writeFileSync(marker(name), '');
      try {
        await check();
      } finally {
        fs.rmSync(marker(name));
      }
    };

    it('says which flag an older CLI lacks, with its version, instead of failing every run', () =>
      without('no-trust', async () => {
        const found = await cursorAgent({ bin: fakeBin }).detect();
        expect(found).toMatchObject({ available: false, version: '2099.01.01-abcdef0' });
        expect(found.reason).toContain('2099.01.01-abcdef0');
        expect(found.reason).toContain('--trust');
        expect(found.reason).toContain('cursor-agent --help');
        // Not mistaken for a sign-in problem.
        expect(found.signedIn).toBeUndefined();
        expect(found.reason).not.toMatch(/signed in/);
      }));

    it('asks for --mode only of a run that uses it', () =>
      without('no-mode', async () => {
        const driver = cursorAgent({ bin: fakeBin });
        expect((await driver.detect()).available).toBe(true);
        expect((await driver.detect({ permissionMode: 'acceptEdits' })).available).toBe(true);
        for (const permissionMode of ['plan', 'default', 'dontAsk'] as const) {
          const found = await driver.detect({ permissionMode });
          expect(found).toMatchObject({ available: false });
          expect(found.reason).toContain('--mode');
        }
      }));

    it('stays tolerant when help itself cannot be read', () =>
      without('broken-help', async () => {
        expect(await cursorAgent({ bin: fakeBin }).detect()).toMatchObject({
          available: true,
          signedIn: true,
        });
      }));

    it('checks the flags even when a vault key will stand in for the sign-in', () =>
      without('no-trust', async () => {
        expect((await cursorAgent({ bin: fakeBin }).detect({ apiKey: true })).available).toBe(
          false
        );
      }));
  });

  it('says plainly when it is not signed in, unless the run brings an API key', async () => {
    const marker = path.join(dir, 'signed-out');
    fs.writeFileSync(marker, '');
    try {
      const driver = cursorAgent({ bin: fakeBin });
      const out = await driver.detect();
      expect(out).toMatchObject({ available: false, signedIn: false });
      expect(out.reason).toMatch(/not signed in.*cursor-agent login/);
      expect(await driver.detect({ apiKey: true })).toMatchObject({ available: true });
    } finally {
      fs.rmSync(marker);
    }
  });

  it('streams what the agent did, with no cost or tokens it was not told', async () => {
    const all = await runFake('success').events;
    expect(all.map((e) => e.type)).toEqual([
      'started',
      'text',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'log',
      'text',
      'finished',
    ]);
    expect(all[0]).toEqual({ type: 'started', model: 'Test Model' });
    expect(all[5]).toMatchObject({ output: 'Wrote 1 lines to /w/hello.txt', isError: false });
    expect(finished(all)).toMatchObject({
      ok: true,
      summary: 'Created hello.txt.',
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      exitCode: 0,
    });
    expect(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8').trim()).toBe('hi');
  });

  it('records refused and failed tools, and reads token usage when the CLI gives it', async () => {
    const all = await runFake('tools').events;
    const results = all.filter((e) => e.type === 'tool_result');
    expect(results).toEqual([
      { type: 'tool_result', id: 'a', output: 'not allowed', isError: true },
      { type: 'tool_result', id: 'b', output: 'a\nb\n', isError: false },
      { type: 'tool_result', id: 'c', output: 'nope', isError: true },
      { type: 'tool_result', id: 'd', output: 'server down', isError: true },
    ]);
    const calls = all.filter((e) => e.type === 'tool_call');
    expect(calls.map((c) => c.type === 'tool_call' && c.name)).toEqual([
      'Bash',
      'Bash',
      'Bash',
      'search_docs',
    ]);
    expect(calls[3]).toMatchObject({ input: { q: 'x' } });
    expect(finished(all)).toMatchObject({
      ok: true,
      tokensIn: 155,
      tokensOut: 20,
      permissionDenials: [{ tool: 'Bash', input: { command: 'rm -rf /' } }],
    });
  });

  it('passes the model, mode and trust on the command line, and the prompt last', async () => {
    const { events, log } = runFake('success', { model: 'gpt-5', permissionMode: 'plan' });
    await events;
    const args = fs.readFileSync(`${log}.args`, 'utf8').trim().split('\n');
    expect(args.slice(0, 1)).toEqual(['--print']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--trust',
        '--mode',
        'plan',
        '--model',
        'gpt-5',
      ])
    );
    expect(args.slice(-2)).toEqual(['--', 'do the thing']);
  });

  it('says what it could not pass on, rather than ignoring it', async () => {
    const result = finished(
      await runFake('success', { maxBudgetUsd: 2, allowedTools: ['Bash(pnpm test:*)'] }).events
    );
    expect(result.warnings.join('\n')).toMatch(/no spend limit/);
    expect(result.warnings.join('\n')).toMatch(/takes no tool list/);
    expect(result.ok).toBe(true);
  });

  it('does not hand the gateway environment to the agent', async () => {
    process.env.CURSOR_API_KEY = 'key-gateway-own-000000';
    try {
      const { events, log } = runFake('secret');
      expect(finished(await events).summary).toBe('key=');
      expect(fs.readFileSync(`${log}.env`, 'utf8')).not.toContain('key-gateway-own');
    } finally {
      delete process.env.CURSOR_API_KEY;
    }
  });

  it('passes an API key given as a secret, and redacts it', async () => {
    const { events } = runFake('secret', { secrets: { CURSOR_API_KEY: 'xxxxxxxxxxxxxxxxxxxx' } });
    expect(finished(await events).summary).toBe('key=«redacted»');
  });

  it('explains a missing sign-in', async () => {
    const result = finished(await runFake('not_signed_in').events);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not signed in.*cursor-agent login/);
  });

  it('does not read a successful run as a missing sign-in because it talks about one', async () => {
    const result = finished(await runFake('talks_about_auth').events);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.summary).toBe(
      'Fixed the 401 Unauthorized handler. Not logged in users now see a banner.'
    );
  });

  it('still explains a missing sign-in when the run failed with it in the result', async () => {
    const result = finished(await runFake('error_not_signed_in').events);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.summary).toMatch(/not signed in.*cursor-agent login/);
  });

  it('reports an error result with its text', async () => {
    const result = finished(await runFake('error_result').events);
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.summary).toBe('The agent reported an error. The model could not continue');
  });

  it('fails a run that ended without a result, even with exit 0', async () => {
    const result = finished(await runFake('no_result').events);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/before reporting a result/);
    expect(result.crashed).toBe(true);
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
    const iter = cursorAgent({ bin: fakeBin }).run({
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
