/**
 * The builtin driver moving to another model when the one in use is
 * unavailable, in the middle of a run. The repository is real; the models are
 * a fake fetch that routes by endpoint and model id, so nothing leaves the process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRegistry, type Registry } from '@clerq/providers';
import {
  builtin,
  BUILTIN_KEY_ENV,
  type DriverEvent,
  type DriverResult,
  type DriverRunInput,
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
        inputPerM: 1
        outputPerM: 1
      - id: second
        context: 200000
        inputPerM: 1
        outputPerM: 1
      - id: tiny
        context: 6000
        inputPerM: 1
        outputPerM: 1
      - id: unpriced
        context: 200000
  - id: other
    label: Other
    adapter: openai-compat
    baseUrl: https://other.invalid/v1
    authEnv: OTHER_MODEL_KEY
    models:
      - id: m
        context: 200000
        inputPerM: 1
        outputPerM: 1
`);

type Block = Record<string, unknown>;
/** What one call to a model gets: the blocks it answers with, or an HTTP error. */
type Answer = { blocks: Block[]; usage?: [number, number] } | { status: number; body?: string };

const text = (t: string): Block => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const thinking = (sig: string): Block => ({ type: 'thinking', thinking: 'hm', signature: sig });
const down = (status = 503): Answer => ({ status });

interface Seen {
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Models by id, each with the answers it gives in turn (the last repeats when
 * `repeat` is set). A call with nothing left to say is a test failure.
 */
function fakeModels(script: Record<string, Answer[]>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const model = String(body.model);
    seen.push({
      model,
      endpoint: url,
      headers: init.headers as Record<string, string>,
      body,
    });
    const answer = script[model]?.shift();
    if (!answer) throw new Error(`No answer scripted for ${model}.`);
    if ('status' in answer) {
      return {
        ok: false,
        status: answer.status,
        text: async () => answer.body ?? 'Service Unavailable',
      } as Response;
    }
    const [inTok, outTok] = answer.usage ?? [1_000, 100];
    const calls = answer.blocks.filter((b) => b.type === 'tool_use');
    if (url.startsWith('https://other.invalid')) {
      const content = answer.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: content || null,
                  ...(calls.length
                    ? {
                        tool_calls: calls.map((c) => ({
                          id: c.id,
                          type: 'function',
                          function: { name: c.name, arguments: JSON.stringify(c.input) },
                        })),
                      }
                    : {}),
                },
                finish_reason: calls.length ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: inTok, completion_tokens: outTok },
          }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: answer.blocks,
          stop_reason: calls.length ? 'tool_use' : 'end_turn',
          usage: { input_tokens: inTok, output_tokens: outTok },
        }),
    } as Response;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
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
  process.env.OTHER_MODEL_KEY = 'other-key-from-env';
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-fallback-')));
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(repo, { recursive: true, force: true });
});

async function run(
  fetchImpl: typeof fetch,
  input: Partial<DriverRunInput> = {}
): Promise<{ events: DriverEvent[]; result: DriverResult }> {
  const events: DriverEvent[] = [];
  const iter = builtin({ registry: () => REGISTRY, fetch: fetchImpl }).run({
    prompt: 'Look around.',
    cwd: repo,
    model: 'fake/priced',
    env: { PATH: process.env.PATH ?? '' },
    ...input,
  });
  for await (const e of iter) events.push(e);
  const last = events.at(-1);
  if (last?.type !== 'finished') throw new Error('no finished event');
  return { events, result: last.result };
}

const calls = (events: DriverEvent[]) =>
  events.flatMap((e) => (e.type === 'model_call' ? [e.call] : []));
const fallbacks = (events: DriverEvent[]) =>
  events.flatMap((e) => (e.type === 'model_fallback' ? [e] : []));

describe('builtin driver: model fallback', () => {
  it('moves to the next model when the first is unavailable, and carries on with it', async () => {
    const m = fakeModels({
      priced: [down(529)],
      m: [{ blocks: [text('Done on the other model.')] }],
    });
    const { events, result } = await run(m.fetchImpl, { fallbackModels: ['other/m'] });

    expect(result).toMatchObject({ ok: true, summary: 'Done on the other model.', turns: 1 });
    // The failed call is recorded, then the move, then the call that worked.
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'model_call',
      'model_fallback',
      'model_call',
      'text',
      'finished',
    ]);
    const [failed, ok] = calls(events);
    expect(failed).toMatchObject({
      provider: 'fake',
      model: 'priced',
      ok: false,
      unavailable: true,
      turn: 1,
    });
    expect(failed.error).toMatch(/returned 529/);
    expect(ok).toMatchObject({ provider: 'other', model: 'm', ok: true, turn: 1 });
    expect(fallbacks(events)[0]).toMatchObject({
      type: 'model_fallback',
      from: 'fake/priced',
      to: 'other/m',
    });
    expect(fallbacks(events)[0].reason).toMatch(/Fake returned 529/);
    expect(m.seen.map((s) => s.model)).toEqual(['priced', 'm']);
    // Only the call that answered is paid for.
    expect(result.tokensIn).toBe(1_000);
  });

  it('moves on at the first sign of 429, a refused key, a timeout or no connection', async () => {
    for (const trouble of [down(429), down(401), down(500)]) {
      const m = fakeModels({
        priced: [trouble],
        second: [{ blocks: [text('ok')] }],
      });
      const { result, events } = await run(m.fetchImpl, { fallbackModels: ['fake/second'] });
      expect(result.ok).toBe(true);
      expect(fallbacks(events)).toHaveLength(1);
    }
    const refused = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    }) as unknown as typeof fetch;
    const { events } = await run(refused, { fallbackModels: ['other/m'] });
    // Both are unreachable here: the first fails over to the second, which fails too.
    expect(fallbacks(events)).toHaveLength(1);
    expect(calls(events).every((c) => c.unavailable)).toBe(true);
  });

  it('keeps the tool round across the move, without the first model’s reasoning', async () => {
    const m = fakeModels({
      priced: [
        { blocks: [thinking('sig-1'), text('Looking.'), use('t1', 'git_status', {})] },
        down(503),
      ],
      second: [{ blocks: [text('Finished.')] }],
    });
    const { result } = await run(m.fetchImpl, { fallbackModels: ['fake/second'] });
    expect(result.ok).toBe(true);

    const [first, wentDown, takeover] = m.seen;
    expect([first.model, wentDown.model, takeover.model]).toEqual(['priced', 'priced', 'second']);
    // The model that went down was sent its own thinking block back, as the API requires.
    expect(JSON.stringify(wentDown.body.messages)).toContain('sig-1');
    // The one that took over was not: the signature belongs to another model.
    const sentToNext = takeover.body.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(sentToNext)).not.toContain('sig-1');
    expect(JSON.stringify(sentToNext)).not.toContain('thinking');
    // The call and its result are still paired.
    expect(sentToNext[1].content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'git_status', input: {} },
    ]);
    expect((sentToNext[2].content as Block[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
    });
  });

  it('hands the conversation to another adapter in that adapter’s own shape', async () => {
    const m = fakeModels({
      priced: [{ blocks: [thinking('sig-1'), use('t1', 'git_status', {})] }, down(503)],
      m: [{ blocks: [text('Finished.')] }],
    });
    const { result } = await run(m.fetchImpl, { fallbackModels: ['other/m'] });
    expect(result.ok).toBe(true);
    const takeover = m.seen.at(-1) as Seen;
    expect(takeover.endpoint).toBe('https://other.invalid/v1/chat/completions');
    const messages = takeover.body.messages as Array<Record<string, unknown>>;
    const roles = messages.map((x) => x.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect((messages[2].tool_calls as Array<{ id: string }>)[0].id).toBe('t1');
    expect(messages[3].tool_call_id).toBe('t1');
    expect(JSON.stringify(messages)).not.toContain('sig-1');
  });

  it('does not count the turn an outage cost against the turn limit', async () => {
    const m = fakeModels({
      priced: [down(), down()],
      second: [{ blocks: [use('a', 'git_status', {})] }, { blocks: [text('Done.')] }],
    });
    const { result } = await run(m.fetchImpl, { fallbackModels: ['fake/second'] });
    // `priced` is not tried again after the move.
    expect(m.seen.map((s) => s.model)).toEqual(['priced', 'second', 'second']);
    expect(result).toMatchObject({ ok: true, turns: 2 });
  });

  it('tries each model once, in order, then fails with the last error', async () => {
    const m = fakeModels({
      priced: [down(503)],
      second: [down(529)],
      m: [down(500)],
    });
    const { result, events } = await run(m.fetchImpl, {
      fallbackModels: ['fake/second', 'other/m'],
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/Other returned 500/);
    expect(m.seen.map((s) => s.model)).toEqual(['priced', 'second', 'm']);
    expect(fallbacks(events).map((f) => `${f.from}>${f.to}`)).toEqual([
      'fake/priced>fake/second',
      'fake/second>other/m',
    ]);
  });

  it('never moves on for a request the provider refused, or for what the agent wrote', async () => {
    const refused = fakeModels({
      priced: [{ status: 400, body: 'invalid request' }],
      second: [{ blocks: [text('never')] }],
    });
    const a = await run(refused.fetchImpl, { fallbackModels: ['fake/second'] });
    expect(a.result.ok).toBe(false);
    expect(a.result.summary).toMatch(/returned 400/);
    expect(refused.seen).toHaveLength(1);
    expect(fallbacks(a.events)).toHaveLength(0);

    // The agent's own words about an outage are not an outage.
    const talks = fakeModels({
      priced: [{ blocks: [text('The upstream endpoint returned 503 and was overloaded.')] }],
      second: [{ blocks: [text('never')] }],
    });
    const b = await run(talks.fetchImpl, { fallbackModels: ['fake/second'] });
    expect(b.result).toMatchObject({ ok: true });
    expect(talks.seen).toHaveLength(1);
    expect(fallbacks(b.events)).toHaveLength(0);
  });

  it('does not move on when the run was cancelled', async () => {
    const controller = new AbortController();
    const m = fakeModels({ second: [{ blocks: [text('never')] }] });
    const cancelling = (async () => {
      controller.abort();
      throw new TypeError('fetch failed', { cause: new Error('aborted') });
    }) as unknown as typeof fetch;
    const { result, events } = await run(cancelling, {
      fallbackModels: ['fake/second'],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(m.seen).toHaveLength(0);
    expect(fallbacks(events)).toHaveLength(0);
  });

  it('without fallback models, an unavailable model fails the run as before', async () => {
    const m = fakeModels({ priced: [down(503)] });
    const { result, events } = await run(m.fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/returned 503/);
    expect(calls(events)[0].unavailable).toBe(true);
  });
});

describe('builtin driver: fallback and the run’s own key', () => {
  it('sends the key it was given to its own provider only', async () => {
    delete process.env.FAKE_MODEL_KEY;
    const m = fakeModels({
      priced: [down(503)],
      m: [{ blocks: [text('ok')] }],
    });
    const { result } = await run(m.fetchImpl, {
      fallbackModels: ['other/m'],
      secrets: { [BUILTIN_KEY_ENV]: 'vault-key-for-fake' },
    });
    expect(result.ok).toBe(true);
    // The first model got the run's key; the other provider got its own, never that one.
    expect(m.seen[0].headers['x-api-key']).toBe('vault-key-for-fake');
    expect(m.seen[1].headers.authorization).toBe('Bearer other-key-from-env');
    expect(JSON.stringify(m.seen[1])).not.toContain('vault-key-for-fake');
  });

  it('skips another provider’s model it has no key for, naming why', async () => {
    delete process.env.OTHER_MODEL_KEY;
    const m = fakeModels({
      priced: [down(503)],
      second: [{ blocks: [text('ok')] }],
    });
    const { result, events } = await run(m.fetchImpl, {
      fallbackModels: ['other/m', 'fake/second'],
      secrets: { [BUILTIN_KEY_ENV]: 'vault-key-for-fake' },
    });
    expect(result.ok).toBe(true);
    expect(m.seen.map((s) => s.model)).toEqual(['priced', 'second']);
    expect(fallbacks(events)[0]).toMatchObject({
      to: 'fake/second',
      skipped: [{ model: 'other/m', reason: expect.stringContaining('OTHER_MODEL_KEY') }],
    });
    // The run's key went to its own provider's second model, which is the same provider.
    expect(m.seen[1].headers['x-api-key']).toBe('vault-key-for-fake');
  });

  it('skips an unpriced model when the run has a dollar budget', async () => {
    const m = fakeModels({
      priced: [down(503)],
      second: [{ blocks: [text('ok')] }],
    });
    const { result, events } = await run(m.fetchImpl, {
      fallbackModels: ['fake/unpriced', 'fake/second'],
      maxBudgetUsd: 1,
    });
    expect(result.ok).toBe(true);
    expect(m.seen.map((s) => s.model)).toEqual(['priced', 'second']);
    expect(fallbacks(events)[0].skipped?.[0]).toMatchObject({ model: 'fake/unpriced' });
    expect(fallbacks(events)[0].skipped?.[0].reason).toMatch(/no price/);
  });

  it('keeps the budget across the move: the failed call cost nothing, the next is held to what is left', async () => {
    const m = fakeModels({
      priced: [down(503)],
      second: [{ blocks: [use('a', 'git_status', {})], usage: [1_000, 599_000] }],
    });
    const { result } = await run(m.fetchImpl, {
      fallbackModels: ['fake/second'],
      maxBudgetUsd: 0.5,
    });
    // $0.60 for the one call that answered, which is past the $0.50 budget.
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/budget of \$0.50 is spent/);
    expect(result.costUsd).toBeCloseTo(0.6, 6);
  });
});

describe('builtin driver: fallback and the context window', () => {
  it('fits the conversation to the next model’s window before it calls it', async () => {
    fs.writeFileSync(
      path.join(repo, 'big.txt'),
      Array.from({ length: 380 }, (_, i) => `row ${i} ${'x'.repeat(16)}`).join('\n')
    );
    const m = fakeModels({
      priced: [
        { blocks: [use('a', 'read_file', { path: 'big.txt' })], usage: [800, 20] },
        { blocks: [use('b', 'read_file', { path: 'big.txt', offset: 2 })], usage: [3_300, 20] },
        down(503),
      ],
      // The small model is asked to summarise first, then to take the turn.
      tiny: [
        { blocks: [text('Read big.txt twice.')], usage: [2_000, 30] },
        { blocks: [text('done')], usage: [1_000, 10] },
      ],
    });
    const events: DriverEvent[] = [];
    const iter = builtin({
      registry: () => REGISTRY,
      fetch: m.fetchImpl,
      maxOutputTokens: 1_024,
    }).run({
      prompt: 'Look around.',
      cwd: repo,
      model: 'fake/priced',
      fallbackModels: ['fake/tiny'],
      env: { PATH: process.env.PATH ?? '' },
    });
    for await (const e of iter) events.push(e);

    const order = events.flatMap((e) => (e.type === 'finished' ? [] : [e.type]));
    expect(order.slice(-6)).toEqual([
      'model_call', // the failed turn on the big model
      'model_fallback',
      'model_call', // the summary, asked of the small model
      'context',
      'model_call', // the turn
      'text',
    ]);
    expect(m.seen.map((s) => s.model)).toEqual(['priced', 'priced', 'priced', 'tiny', 'tiny']);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'finished', result: { ok: true, summary: 'done' } });
  });
});
