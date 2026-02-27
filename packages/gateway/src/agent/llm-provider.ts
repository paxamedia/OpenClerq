/**
 * LLM provider abstraction — Anthropic, Ollama, or OpenAI-compatible (LM Studio, vLLM).
 * Use CLERQ_LLM_PROVIDER to switch. Local models need no API key.
 */

import { loadReasoning } from '../reasoning-config.js';
import { recordLLMSuccess, recordLLMFailure } from '../observability.js';

export type LLMProvider = 'anthropic' | 'ollama' | 'openai';

export interface LLMCallResult {
  text: string;
  model: string;
}

export interface LLMProviderConfig {
  provider: LLMProvider;
  model: string;
}

function getConfig(): LLMProviderConfig {
  const provider = (process.env.CLERQ_LLM_PROVIDER ?? 'anthropic').toLowerCase() as LLMProvider;
  const model = process.env.CLERQ_MODEL ?? getDefaultModel(provider);
  return { provider, model };
}

function getDefaultModel(provider: LLMProvider): string {
  switch (provider) {
    case 'ollama':
      return 'llama3.2';
    case 'openai':
      return 'gpt-4o-mini'; // fallback; LM Studio uses model name from UI
    default:
      return 'claude-3-5-haiku-20241022';
  }
}

async function callAnthropic(
  system: string,
  userContent: string,
  model: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<LLMCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Set it for Anthropic, or use CLERQ_LLM_PROVIDER=ollama for local models.');
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });
  const params = {
    model,
    max_tokens: opts?.maxTokens ?? 1024,
    system,
    messages: [{ role: 'user' as const, content: userContent }],
    ...(opts?.temperature != null && { temperature: opts.temperature }),
  };
  const start = Date.now();
  const message = await client.messages.create(params);
  const elapsed = Date.now() - start;
  const content = 'content' in message ? message.content : [];
  const textBlock = Array.isArray(content) ? content.find((b: { type: string }) => b.type === 'text') : null;
  const text = textBlock && typeof textBlock === 'object' && 'text' in textBlock ? (textBlock as { text: string }).text : 'No response.';
  const usage = 'usage' in message ? (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage : undefined;
  recordLLMSuccess(elapsed, usage?.input_tokens, usage?.output_tokens);
  return { text, model };
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  system: string,
  userContent: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<LLMCallResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts?.maxTokens ?? 1024,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  };
  if (opts?.temperature != null) body.temperature = opts.temperature;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const start = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${err.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? 'No response.';
  const usage = data.usage;
  recordLLMSuccess(elapsed, usage?.prompt_tokens, usage?.completion_tokens);
  return { text, model };
}

/**
 * Fetch available models from the provider. Returns empty when provider has no list API.
 */
export async function getAvailableModels(): Promise<string[]> {
  const provider = (process.env.CLERQ_LLM_PROVIDER ?? 'anthropic').toLowerCase() as LLMProvider;
  const { model } = getConfig();

  switch (provider) {
    case 'ollama': {
      try {
        const baseUrl = process.env.CLERQ_OLLAMA_URL ?? 'http://localhost:11434';
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { method: 'GET' });
        if (!res.ok) return [model];
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const names = data.models?.map((m) => m.name) ?? [];
        return names.length > 0 ? names : [model];
      } catch {
        return [model];
      }
    }
    case 'anthropic':
      return [
        'claude-3-5-haiku-20241022',
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-5-haiku-20240620',
        model,
      ].filter((m, i, arr) => arr.indexOf(m) === i);
    case 'openai':
      return [model];
    default:
      return [model];
  }
}

/**
 * Call the configured LLM with system prompt and user content.
 * @param modelOverride Optional model to use instead of configured default.
 */
export async function callLLM(system: string, userContent: string, modelOverride?: string): Promise<LLMCallResult> {
  const { provider, model } = getConfig();
  const useModel = modelOverride ?? model;
  const reasoning = loadReasoning();
  const opts = {
    temperature: reasoning.temperature,
    maxTokens: reasoning.maxTokens,
  };

  try {
    switch (provider) {
      case 'anthropic':
        return await callAnthropic(system, userContent, useModel, opts);

      case 'ollama': {
        const baseUrl = process.env.CLERQ_OLLAMA_URL ?? 'http://localhost:11434/v1';
        return await callOpenAICompatible(baseUrl, 'ollama', useModel, system, userContent, opts);
      }

    case 'openai': {
      const baseUrl = process.env.CLERQ_LLM_BASE_URL;
      if (!baseUrl) {
        throw new Error('CLERQ_LLM_BASE_URL is required for openai provider (e.g. http://localhost:1234/v1 for LM Studio).');
      }
      const apiKey = process.env.OPENAI_API_KEY ?? process.env.CLERQ_OPENAI_API_KEY;
        return await callOpenAICompatible(baseUrl, apiKey, useModel, system, userContent, opts);
      }

      default:
        throw new Error(`Unknown CLERQ_LLM_PROVIDER: ${provider}. Use anthropic, ollama, or openai.`);
    }
  } catch (e) {
    recordLLMFailure();
    throw e;
  }
}

/**
 * Returns which provider is configured and whether it's available (key set for anthropic, etc.).
 */
/** 'api' = cloud (Anthropic); 'local' = Ollama, LM Studio, etc. */
export function getLLMMode(provider: LLMProvider): 'api' | 'local' {
  return provider === 'anthropic' ? 'api' : 'local';
}

export function getLLMProviderStatus(): {
  provider: LLMProvider;
  model: string;
  available: boolean;
  hint?: string;
} {
  const { provider, model } = getConfig();

  switch (provider) {
    case 'anthropic':
      return {
        provider: 'anthropic',
        model,
        available: Boolean(process.env.ANTHROPIC_API_KEY),
        hint: process.env.ANTHROPIC_API_KEY ? undefined : 'Set ANTHROPIC_API_KEY',
      };
    case 'ollama':
      return {
        provider: 'ollama',
        model,
        available: true,
        hint: 'Ensure Ollama is running (e.g. ollama run llama3.2)',
      };
    case 'openai':
      return {
        provider: 'openai',
        model,
        available: Boolean(process.env.CLERQ_LLM_BASE_URL),
        hint: process.env.CLERQ_LLM_BASE_URL ? undefined : 'Set CLERQ_LLM_BASE_URL (e.g. http://localhost:1234/v1 for LM Studio)',
      };
    default:
      return { provider: 'anthropic', model, available: false, hint: 'Invalid provider' };
  }
}
