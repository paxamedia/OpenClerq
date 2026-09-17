import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveTarget, getLLMProviderStatus, listProviders } from './llm-provider.js';

const VARS = [
  'CLERQ_PROVIDERS_FILE',
  'CLERQ_LLM_PROVIDER',
  'CLERQ_MODEL',
  'CLERQ_LLM_BASE_URL',
  'CLERQ_OLLAMA_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
  // Never pick up the developer's own ~/.clerq/providers.yaml.
  process.env.CLERQ_PROVIDERS_FILE = '/nonexistent/clerq-test-providers.yaml';
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('resolveTarget', () => {
  it('defaults to Anthropic and its default model', () => {
    const t = resolveTarget();
    expect(t.provider.id).toBe('anthropic');
    expect(t.model).toBe('claude-haiku-4-5');
    expect(t.keyOptional).toBe(false);
  });

  it('selects any registry provider by id', () => {
    process.env.CLERQ_LLM_PROVIDER = 'DeepSeek';
    expect(resolveTarget().provider.id).toBe('deepseek');
    expect(resolveTarget().model).toBe('deepseek-chat');
  });

  it('lets a qualified CLERQ_MODEL choose the provider', () => {
    process.env.CLERQ_LLM_PROVIDER = 'anthropic';
    process.env.CLERQ_MODEL = 'zai/glm-4.6';
    const t = resolveTarget();
    expect(t.provider.id).toBe('zai');
    expect(t.model).toBe('glm-4.6');
  });

  it('refuses an unknown provider, naming the variable', () => {
    process.env.CLERQ_LLM_PROVIDER = 'skynet';
    expect(() => resolveTarget()).toThrow(/Unknown CLERQ_LLM_PROVIDER "skynet"/);
  });

  it('keeps the pre-0.5 LM Studio setup working without a key', () => {
    process.env.CLERQ_LLM_PROVIDER = 'openai';
    process.env.CLERQ_LLM_BASE_URL = 'http://localhost:1234/v1';
    process.env.CLERQ_MODEL = 'qwen3-8b';
    const t = resolveTarget();
    expect(t.provider.baseUrl).toBe('http://localhost:1234/v1');
    expect(t.model).toBe('qwen3-8b');
    expect(t.keyOptional).toBe(true);
  });

  it('applies CLERQ_LLM_BASE_URL only to the generic OpenAI-compatible provider', () => {
    process.env.CLERQ_LLM_PROVIDER = 'deepseek';
    process.env.CLERQ_LLM_BASE_URL = 'http://leftover.example/v1';
    const t = resolveTarget();
    expect(t.provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(t.keyOptional).toBe(false);
  });

  it('treats a slash in a model id as part of the id when the prefix is no provider', () => {
    process.env.CLERQ_LLM_PROVIDER = 'lmstudio';
    const t = resolveTarget('lmstudio-community/qwen3-8b');
    expect(t.provider.id).toBe('lmstudio');
    expect(t.model).toBe('lmstudio-community/qwen3-8b');
  });

  it('never sends another provider to the overridden endpoint', () => {
    // A request for DeepSeek must not be routed to the local LM Studio URL —
    // and, worse, must not send the DeepSeek key there.
    process.env.CLERQ_LLM_PROVIDER = 'openai';
    process.env.CLERQ_LLM_BASE_URL = 'http://localhost:1234/v1';
    const t = resolveTarget('deepseek/deepseek-chat');
    expect(t.provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(t.keyOptional).toBe(false);
  });

  it('accepts CLERQ_OLLAMA_URL with or without the /v1 suffix', () => {
    process.env.CLERQ_LLM_PROVIDER = 'ollama';
    process.env.CLERQ_OLLAMA_URL = 'http://gpu-box:11434/';
    expect(resolveTarget().provider.baseUrl).toBe('http://gpu-box:11434/v1');
    process.env.CLERQ_OLLAMA_URL = 'http://gpu-box:11434/v1';
    expect(resolveTarget().provider.baseUrl).toBe('http://gpu-box:11434/v1');
  });
});

describe('getLLMProviderStatus', () => {
  it('names the missing key', () => {
    expect(getLLMProviderStatus()).toMatchObject({
      provider: 'anthropic',
      mode: 'api',
      available: false,
      hint: 'Set ANTHROPIC_API_KEY',
    });
  });

  it('reports a local model as local and available', () => {
    process.env.CLERQ_LLM_PROVIDER = 'ollama';
    expect(getLLMProviderStatus()).toMatchObject({ mode: 'local', available: true });
  });

  it('reports a misconfiguration instead of throwing', () => {
    process.env.CLERQ_LLM_PROVIDER = 'skynet';
    const status = getLLMProviderStatus();
    expect(status.available).toBe(false);
    expect(status.hint).toMatch(/Unknown CLERQ_LLM_PROVIDER/);
  });
});

describe('listProviders', () => {
  it('lists every vendor with qualified model references', () => {
    const providers = listProviders();
    const deepseek = providers.find((p) => p.id === 'deepseek');
    expect(deepseek?.models.map((m) => m.ref)).toContain('deepseek/deepseek-chat');
    expect(deepseek?.ready).toBe(false);
    expect(deepseek?.reason).toBe('Set DEEPSEEK_API_KEY');
  });

  it('counts a keyless self-hosted endpoint as ready', () => {
    process.env.CLERQ_LLM_PROVIDER = 'openai';
    process.env.CLERQ_LLM_BASE_URL = 'http://localhost:1234/v1';
    expect(listProviders().find((p) => p.id === 'openai')?.ready).toBe(true);
  });

  it('does not expose endpoint URLs, which may carry credentials', () => {
    process.env.CLERQ_LLM_PROVIDER = 'openai';
    process.env.CLERQ_LLM_BASE_URL = 'http://user:secret@proxy.internal/v1';
    expect(JSON.stringify(listProviders())).not.toContain('secret');
  });
});
