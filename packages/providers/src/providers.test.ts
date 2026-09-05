import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRegistry,
  loadRegistry,
  findProvider,
  resolveModel,
  estimateCost,
  availableProviders,
  call,
  ProviderError,
  type Registry,
} from './index.js';

const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers.yaml');
const registry: Registry = parseRegistry(fs.readFileSync(bundled, 'utf8'));

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

  it('defaults a missing models list to empty', () => {
    const r = parseRegistry(
      'providers:\n  - id: x\n    label: X\n    baseUrl: https://e.com\n    adapter: openai-compat\n'
    );
    expect(r.providers[0].models).toEqual([]);
  });
});

describe('loadRegistry', () => {
  it('falls back to the bundled registry', () => {
    expect(loadRegistry(bundled).providers.length).toBeGreaterThan(0);
  });

  it('reports clearly when nothing is found', () => {
    expect(() => loadRegistry('/nonexistent/providers.yaml')).toThrow(/No provider registry/);
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

  it('is free when the registry carries no prices', () => {
    expect(estimateCost({ id: 'local' }, { inputTokens: 9999, outputTokens: 9999 })).toBe(0);
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

  it('treats absent usage as zero rather than failing', async () => {
    const res = await call(registry, 'deepseek/deepseek-chat', { prompt: 'hi' }, (async () =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] })) as unknown as typeof fetch);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(res.costUsd).toBe(0);
  });
});
