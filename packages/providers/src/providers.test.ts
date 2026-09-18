import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRegistry,
  loadRegistry,
  findProvider,
  resolveModel,
  estimateCost,
  defaultModelFor,
  overrideProvider,
  availableProviders,
  call,
  callStream,
  ProviderError,
  DEFAULT_REGISTRY_YAML,
  type Registry,
} from './index.js';

const registry: Registry = parseRegistry(DEFAULT_REGISTRY_YAML);

describe('bundled registry', () => {
  it('parses and carries every vendor the roadmap names', () => {
    const ids = registry.providers.map((p) => p.id);
    for (const id of ['anthropic', 'openai', 'deepseek', 'moonshot', 'zai', 'minimax']) {
      expect(ids).toContain(id);
    }
  });

  it('offers a local, key-free option', () => {
    const ollama = findProvider(registry, 'ollama');
    expect(ollama.authEnv ?? null).toBeNull();
  });

  it('uses the openai-compat adapter for everything except Anthropic', () => {
    for (const p of registry.providers) {
      expect(p.adapter).toBe(p.id === 'anthropic' ? 'anthropic' : 'openai-compat');
    }
  });

  it('does not list Cursor, which has no public model API', () => {
    expect(registry.providers.map((p) => p.id)).not.toContain('cursor');
  });

  it('names a default model that the provider actually lists', () => {
    for (const p of registry.providers) {
      if (!p.defaultModel) continue;
      expect(
        p.models.map((m) => m.id),
        p.id
      ).toContain(p.defaultModel);
    }
  });

  it('defaults Anthropic to its least expensive model, not its most', () => {
    expect(defaultModelFor(findProvider(registry, 'anthropic'))).toBe('claude-haiku-4-5');
  });

  it('gives every priced model both rates', () => {
    for (const p of registry.providers) {
      for (const m of p.models) {
        if (m.inputPerM === undefined && m.outputPerM === undefined) continue;
        expect(m.inputPerM, `${p.id}/${m.id}`).toBeTypeOf('number');
        expect(m.outputPerM, `${p.id}/${m.id}`).toBeTypeOf('number');
      }
    }
  });
});

describe('parseRegistry', () => {
  it('rejects invalid YAML', () => {
    expect(() => parseRegistry('a:\n  - [unclosed')).toThrow(ProviderError);
  });

  it('rejects a registry with no providers list', () => {
    expect(() => parseRegistry('version: 1')).toThrow(/must contain a "providers" list/);
  });

  it('rejects an entry missing required fields', () => {
    expect(() => parseRegistry('providers:\n  - id: x\n')).toThrow(
      /missing id, baseUrl or adapter/
    );
  });

  it('rejects an unknown adapter', () => {
    expect(() =>
      parseRegistry('providers:\n  - id: x\n    baseUrl: https://e.com\n    adapter: telepathy\n')
    ).toThrow(/unknown adapter/);
  });

  it('rejects a price that is not a non-negative number', () => {
    const yaml = (price: string) =>
      `providers:\n  - id: x\n    baseUrl: https://e.com\n    adapter: openai-compat\n    models:\n      - id: m\n        inputPerM: ${price}\n        outputPerM: 1\n`;
    expect(() => parseRegistry(yaml('"3"'))).toThrow(/invalid inputPerM/);
    expect(() => parseRegistry(yaml('-1'))).toThrow(/invalid inputPerM/);
    expect(() => parseRegistry(yaml('3'))).not.toThrow();
  });

  it('defaults a missing models list to empty', () => {
    const r = parseRegistry(
      'providers:\n  - id: x\n    label: X\n    baseUrl: https://e.com\n    adapter: openai-compat\n'
    );
    expect(r.providers[0].models).toEqual([]);
  });
});

describe('loadRegistry', () => {
  const saved = process.env.CLERQ_PROVIDERS_FILE;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-providers-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLERQ_PROVIDERS_FILE;
    else process.env.CLERQ_PROVIDERS_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the built-in registry when the user has no copy', () => {
    process.env.CLERQ_PROVIDERS_FILE = path.join(dir, 'absent.yaml');
    expect(loadRegistry().providers.map((p) => p.id)).toContain('anthropic');
  });

  it("prefers the user's copy, replacing the built-in one entirely", () => {
    const file = path.join(dir, 'providers.yaml');
    fs.writeFileSync(
      file,
      'providers:\n  - id: mine\n    label: Mine\n    baseUrl: http://127.0.0.1:1/v1\n    adapter: openai-compat\n'
    );
    process.env.CLERQ_PROVIDERS_FILE = file;
    expect(loadRegistry().providers.map((p) => p.id)).toEqual(['mine']);
  });

  it('reports clearly when an explicit path does not exist', () => {
    expect(() => loadRegistry(path.join(dir, 'nope.yaml'))).toThrow(/No provider registry found/);
  });
});

describe('defaultModelFor', () => {
  it('falls back to the first listed model', () => {
    expect(
      defaultModelFor({
        id: 'x',
        label: 'X',
        adapter: 'openai-compat',
        baseUrl: 'https://x',
        models: [{ id: 'first' }, { id: 'second' }],
      })
    ).toBe('first');
  });

  it('refuses when there is nothing to fall back to', () => {
    expect(() => defaultModelFor(findProvider(registry, 'lmstudio'))).toThrow(/no default model/);
  });
});

describe('overrideProvider', () => {
  it('replaces one provider without mutating the original registry', () => {
    const moved = overrideProvider(registry, 'ollama', { baseUrl: 'http://10.0.0.5:11434/v1' });
    expect(findProvider(moved, 'ollama').baseUrl).toBe('http://10.0.0.5:11434/v1');
    expect(findProvider(registry, 'ollama').baseUrl).toBe('http://localhost:11434/v1');
  });

  it('refuses an unknown provider', () => {
    expect(() => overrideProvider(registry, 'nope', {})).toThrow(/Unknown provider/);
  });
});

describe('resolveModel', () => {
  it('resolves a qualified reference', () => {
    const { provider, model } = resolveModel(registry, 'deepseek/deepseek-reasoner');
    expect(provider.id).toBe('deepseek');
    expect(model.id).toBe('deepseek-reasoner');
  });

  it('resolves an unambiguous bare model id', () => {
    const { provider } = resolveModel(registry, 'glm-4.6');
    expect(provider.id).toBe('zai');
  });

  it('refuses an unknown bare model', () => {
    expect(() => resolveModel(registry, 'no-such-model')).toThrow(/No provider offers model/);
  });

  it('allows a qualified model the registry has not enumerated', () => {
    // Vendors ship models faster than the registry is updated; a qualified
    // reference must still work.
    const { model } = resolveModel(registry, 'openai/some-future-model');
    expect(model.id).toBe('some-future-model');
  });

  it('refuses an unknown provider', () => {
    expect(() => resolveModel(registry, 'nope/model')).toThrow(/Unknown provider/);
  });

  it('demands qualification when two providers share a model id', () => {
    const dup: Registry = {
      version: 1,
      providers: [
        {
          id: 'a',
          label: 'A',
          adapter: 'openai-compat',
          baseUrl: 'https://a',
          models: [{ id: 'm' }],
        },
        {
          id: 'b',
          label: 'B',
          adapter: 'openai-compat',
          baseUrl: 'https://b',
          models: [{ id: 'm' }],
        },
      ],
    };
    expect(() => resolveModel(dup, 'm')).toThrow(/Qualify it as "provider\/model"/);
  });
});

describe('estimateCost', () => {
  it('prices input and output separately', () => {
    const cost = estimateCost(
      { id: 'm', inputPerM: 3, outputPerM: 15 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    );
    expect(cost).toBe(18);
  });

  it('keeps sub-cent precision, which matters over many small calls', () => {
    const cost = estimateCost(
      { id: 'm', inputPerM: 3, outputPerM: 15 },
      { inputTokens: 100, outputTokens: 50 }
    );
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.00105, 6);
  });

  it('reports an unpriced model as unknown, not as free', () => {
    expect(estimateCost({ id: 'm' }, { inputTokens: 9999, outputTokens: 9999 })).toBeNull();
  });

  it('is free when the registry prices a model at zero', () => {
    expect(
      estimateCost({ id: 'm', inputPerM: 0, outputPerM: 0 }, { inputTokens: 9, outputTokens: 9 })
    ).toBe(0);
  });
});

describe('availableProviders', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('marks a keyless local provider ready', () => {
    const ollama = availableProviders(registry).find((p) => p.id === 'ollama');
    expect(ollama?.ready).toBe(true);
  });

  it('reports which variable to set when a key is missing', () => {
    delete process.env.DEEPSEEK_API_KEY;
    const ds = availableProviders(registry).find((p) => p.id === 'deepseek');
    expect(ds?.ready).toBe(false);
    expect(ds?.reason).toBe('Set DEEPSEEK_API_KEY');
  });

  it('marks a provider ready once its key is present', () => {
    process.env.DEEPSEEK_API_KEY = 'x';
    expect(availableProviders(registry).find((p) => p.id === 'deepseek')?.ready).toBe(true);
  });
});

describe('call', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const jsonResponse = (body: unknown, ok = true, status = 200) =>
    ({
      ok,
      status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  it('uses the Anthropic message shape and reports usage and cost', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    let seenHeaders: Record<string, string> = {};

    const res = await call(
      registry,
      'anthropic/claude-haiku-4-5',
      { prompt: 'hi', system: 'be brief' },
      (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenBody = JSON.parse(init.body as string);
        seenHeaders = init.headers as Record<string, string>;
        return jsonResponse({
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 1000, output_tokens: 2000 },
        });
      }) as unknown as typeof fetch
    );

    expect(seenUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(seenHeaders['x-api-key']).toBe('test-anthropic-key');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
    expect(seenBody.system).toBe('be brief');
    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 2000 });
    // 1000 in @ $1/M + 2000 out @ $5/M
    expect(res.costUsd).toBeCloseTo(0.001 + 0.01, 6);
  });

  it('uses the chat-completions shape for every other vendor', async () => {
    let seenUrl = '';
    let seenBody: { messages?: Array<{ role: string }> } = {};

    const res = await call(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi', system: 'sys' },
      (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenBody = JSON.parse(init.body as string);
        return jsonResponse({
          choices: [{ message: { content: 'yo' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        });
      }) as unknown as typeof fetch
    );

    expect(seenUrl).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(seenBody.messages?.[0].role).toBe('system');
    expect(res.text).toBe('yo');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('sends no authorization header for a keyless local provider', async () => {
    let seenHeaders: Record<string, string> = {};
    await call(registry, 'ollama/llama3.2', { prompt: 'hi' }, (async (
      _url: string,
      init: RequestInit
    ) => {
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse({ choices: [{ message: { content: 'x' } }] });
    }) as unknown as typeof fetch);
    expect(seenHeaders.authorization).toBeUndefined();
  });

  it('names the missing variable when a key is absent', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    await expect(
      call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
        jsonResponse({})) as unknown as typeof fetch)
    ).rejects.toThrow(/needs DEEPSEEK_API_KEY/);
  });

  it('surfaces an API error with its status', async () => {
    await expect(
      call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
        jsonResponse({ error: 'rate limited' }, false, 429)) as unknown as typeof fetch)
    ).rejects.toThrow(/returned 429/);
  });

  it('costs a keyless local model nothing even when it is unpriced', async () => {
    const res = await call(registry, 'lmstudio/qwen3-8b', { prompt: 'hi' }, (async () =>
      jsonResponse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      })) as unknown as typeof fetch);
    expect(res.costUsd).toBe(0);
  });

  it('reports an unpriced cloud model as unknown cost', async () => {
    const res = await call(
      registry,
      'openai/some-future-model',
      { prompt: 'hi', apiKey: 'k' },
      (async () =>
        jsonResponse({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        })) as unknown as typeof fetch
    );
    expect(res.costUsd).toBeNull();
  });

  it('proceeds without a key when told the endpoint needs none', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    let seenHeaders: Record<string, string> = {};
    await call(registry, 'deepseek/deepseek-chat', { prompt: 'hi', keyOptional: true }, (async (
      _url: string,
      init: RequestInit
    ) => {
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse({ choices: [{ message: { content: 'x' } }] });
    }) as unknown as typeof fetch);
    expect(seenHeaders.authorization).toBeUndefined();
  });

  it('names the endpoint when it cannot be reached', async () => {
    await expect(
      call(registry, 'ollama/llama3.2', { prompt: 'hi' }, (async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      }) as unknown as typeof fetch)
    ).rejects.toThrow(/unreachable at http:\/\/localhost:11434\/v1: connect ECONNREFUSED/);
  });

  it('times out rather than hanging, even with a caller-supplied signal', async () => {
    const neverAborted = new AbortController();
    await expect(
      call(
        registry,
        'ollama/llama3.2',
        { prompt: 'hi', timeoutMs: 20, signal: neverAborted.signal },
        ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })) as unknown as typeof fetch
      )
    ).rejects.toThrow(/did not respond within 20 ms/);
  });

  it('reports a cancelled call as cancelled', async () => {
    const controller = new AbortController();
    const pending = call(
      registry,
      'ollama/llama3.2',
      { prompt: 'hi', signal: controller.signal },
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/was cancelled/);
  });

  it('refuses a success response that is not JSON', async () => {
    await expect(
      call(
        registry,
        'ollama/llama3.2',
        { prompt: 'hi' },
        (async () =>
          ({
            ok: true,
            status: 200,
            text: async () => '<html>proxy login</html>',
          }) as unknown as Response) as unknown as typeof fetch
      )
    ).rejects.toThrow(/not JSON/);
  });

  it('does not price a call the provider reported no usage for', async () => {
    const res = await call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] })) as unknown as typeof fetch);
    expect(res.usageReported).toBe(false);
    // Zero tokens here means "not said", so a $0 cost would be a fabrication.
    expect(res.costUsd).toBeNull();
  });

  it('reports zero tokens rather than failing when usage is absent', async () => {
    const res = await call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] })) as unknown as typeof fetch);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('sends a conversation when one is given, instead of the single prompt', async () => {
    let seen: { messages?: Array<{ role: string; content: string }> } = {};
    await call(
      registry,
      'deepseek/deepseek-chat',
      {
        system: 'sys',
        prompt: 'ignored',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'second' },
        ],
      },
      (async (_url: string, init: RequestInit) => {
        seen = JSON.parse(init.body as string);
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }) as unknown as typeof fetch
    );
    expect(seen.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('keeps the request body, for the console to show', async () => {
    const res = await call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] })) as unknown as typeof fetch);
    expect(res.request).toMatchObject({ model: 'deepseek-chat' });
  });
});

describe('callStream', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  /** A Response whose body streams the given chunks, split where a real one might split. */
  const sseResponse = (chunks: string[], ok = true, status = 200) =>
    ({
      ok,
      status,
      text: async () => chunks.join(''),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      }),
    }) as unknown as Response;

  it('streams Anthropic deltas and totals its usage', async () => {
    const deltas: string[] = [];
    const res = await callStream(
      registry,
      'anthropic/claude-haiku-4-5',
      { prompt: 'hi' },
      (d) => deltas.push(d),
      (async () =>
        sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":0}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
          // A frame arriving split across two network reads must still parse.
          'event: content_block_delta\ndata: {"type":"content_block_de',
          'lta","delta":{"type":"text_delta","text":"lo"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2000}}\n\n',
        ])) as unknown as typeof fetch
    );

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res.text).toBe('Hello');
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 2000 });
    expect(res.usageReported).toBe(true);
    expect(res.costUsd).toBeCloseTo(0.001 + 0.01, 6);
  });

  it('streams chat-completions deltas and stops at [DONE]', async () => {
    const deltas: string[] = [];
    let body: Record<string, unknown> = {};
    const res = await callStream(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi' },
      (d) => deltas.push(d),
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"one "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"two"}}]}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }) as unknown as typeof fetch
    );

    expect(body.stream).toBe(true);
    // Without this, a streamed call reports no usage and looks free.
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(deltas).toEqual(['one ', 'two']);
    expect(res.text).toBe('one two');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('retries without stream_options when the server rejects it', async () => {
    // Not every OpenAI-compatible server understands the field.
    const bodies: Array<Record<string, unknown>> = [];
    const res = await callStream(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi' },
      () => {},
      (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if ('stream_options' in body) {
          return {
            ok: false,
            status: 400,
            text: async () => '{"error":"unknown field stream_options"}',
          } as unknown as Response;
        }
        return sseResponse(['data: {"choices":[{"delta":{"content":"fallback"}}]}\n\n']);
      }) as unknown as typeof fetch
    );

    expect(bodies).toHaveLength(2);
    expect('stream_options' in bodies[1]).toBe(false);
    expect(res.text).toBe('fallback');
    // Nothing reported usage, so the cost is unknown rather than zero.
    expect(res.usageReported).toBe(false);
    expect(res.costUsd).toBeNull();
  });

  it('surfaces an error frame mid-stream', async () => {
    await expect(
      callStream(registry, 'anthropic/claude-haiku-4-5', { prompt: 'hi' }, () => {}, (async () =>
        sseResponse([
          'data: {"type":"error","error":{"message":"overloaded"}}\n\n',
        ])) as unknown as typeof fetch)
    ).rejects.toThrow(/Stream failed: overloaded/);
  });

  it('reports an HTTP error before any streaming begins', async () => {
    await expect(
      callStream(
        registry,
        'deepseek/deepseek-chat',
        { prompt: 'hi' },
        () => {},
        (async () =>
          ({
            ok: false,
            status: 503,
            text: async () => 'busy',
          }) as unknown as Response) as unknown as typeof fetch
      )
    ).rejects.toThrow(/returned 503/);
  });
});

describe('response limits and cancellation', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const streamOf = (chunks: string[]) =>
    ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      }),
      text: async () => chunks.join(''),
    }) as unknown as Response;

  const frame = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

  it('cuts a streamed answer off at the limit, keeping what arrived', async () => {
    const res = await callStream(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi', maxResponseBytes: 120 },
      () => {},
      (async () =>
        streamOf([frame('first '), frame('second '), frame('third')])) as unknown as typeof fetch
    );
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).not.toContain('third');
  });

  it('does not mark an answer inside the limit as truncated', async () => {
    const res = await callStream(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi' },
      () => {},
      (async () => streamOf([frame('short')])) as unknown as typeof fetch
    );
    expect(res.truncated).toBeUndefined();
  });

  it('refuses a buffered response over the limit rather than parse half of it', async () => {
    const big = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }] });
    await expect(
      call(
        registry,
        'deepseek/deepseek-chat',
        { prompt: 'hi', maxResponseBytes: 1000 },
        (async () => streamOf([big])) as unknown as typeof fetch
      )
    ).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('reads the limit from the environment when the caller sets none', async () => {
    process.env.CLERQ_MAX_RESPONSE_BYTES = '1000';
    const big = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }] });
    await expect(
      call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
        streamOf([big])) as unknown as typeof fetch)
    ).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('marks a cancelled call as cancelled, distinct from a failure', async () => {
    const controller = new AbortController();
    const pending = call(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi', signal: controller.signal },
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch
    );
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).cancelled).toBe(true);
  });

  it('does not mark an ordinary failure as cancelled', async () => {
    const error = await call(
      registry,
      'deepseek/deepseek-chat',
      { prompt: 'hi' },
      (async () =>
        ({
          ok: false,
          status: 500,
          text: async () => 'boom',
        }) as unknown as Response) as unknown as typeof fetch
    ).catch((e: unknown) => e);
    expect((error as ProviderError).cancelled).toBe(false);
  });
});
