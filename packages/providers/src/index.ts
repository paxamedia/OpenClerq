/**
 * Model providers.
 *
 * Six of the seven vendors this project targets speak the same
 * `/chat/completions` dialect, so the work is a registry plus two adapters, not
 * seven integrations. Anthropic gets its own adapter; everything else — OpenAI,
 * DeepSeek, Moonshot (Kimi), Z.ai (GLM), MiniMax, Ollama, LM Studio — is a row
 * in providers.yaml.
 *
 * Cursor is deliberately absent: it has no public model API and enters as a CLI
 * driver instead.
 *
 * Base URLs, model ids and prices are data rather than code because they change
 * every few weeks. Hardcoding them is how the pre-0.4 model list ended up
 * two years stale.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export type AdapterKind = 'anthropic' | 'openai-compat';

export interface ModelSpec {
  id: string;
  context?: number;
  /** US dollars per million input tokens. */
  inputPerM?: number;
  /** US dollars per million output tokens. */
  outputPerM?: number;
}

export interface ProviderSpec {
  id: string;
  label: string;
  adapter: AdapterKind;
  baseUrl: string;
  /** Environment variable holding the key. Null for local providers. */
  authEnv?: string | null;
  models: ModelSpec[];
}

export interface Registry {
  version: number;
  providers: ProviderSpec[];
}

export class ProviderError extends Error {
  readonly code = 'provider_error';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function userRegistryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'providers.yaml');
}

function bundledRegistryPath(): string {
  return path.join(__dirname, 'providers.yaml');
}

export function parseRegistry(text: string): Registry {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ProviderError(
      `providers.yaml is not valid YAML: ${e instanceof Error ? e.message : e}`
    );
  }
  const r = raw as Partial<Registry>;
  if (!r || typeof r !== 'object' || !Array.isArray(r.providers)) {
    throw new ProviderError('providers.yaml must contain a "providers" list.');
  }
  for (const p of r.providers) {
    if (!p.id || !p.baseUrl || !p.adapter) {
      throw new ProviderError(
        `Provider entry is missing id, baseUrl or adapter: ${JSON.stringify(p).slice(0, 120)}`
      );
    }
    if (p.adapter !== 'anthropic' && p.adapter !== 'openai-compat') {
      throw new ProviderError(`Provider "${p.id}" has unknown adapter "${p.adapter}".`);
    }
    if (!Array.isArray(p.models)) p.models = [];
  }
  return { version: r.version ?? 1, providers: r.providers };
}

/**
 * Load the registry: the user's copy at ~/.clerq/providers.yaml when present,
 * otherwise the bundled one.
 */
export function loadRegistry(explicitPath?: string): Registry {
  const candidates = explicitPath ? [explicitPath] : [userRegistryPath(), bundledRegistryPath()];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return parseRegistry(fs.readFileSync(c, 'utf8'));
  }
  throw new ProviderError(`No provider registry found (looked in: ${candidates.join(', ')}).`);
}

export function findProvider(registry: Registry, id: string): ProviderSpec {
  const p = registry.providers.find((x) => x.id === id);
  if (!p) {
    throw new ProviderError(
      `Unknown provider "${id}". Known: ${registry.providers.map((x) => x.id).join(', ')}.`
    );
  }
  return p;
}

/**
 * Resolve a model reference.
 * Accepts "provider/model" or a bare model id, which is matched across
 * providers and must be unambiguous.
 */
export function resolveModel(
  registry: Registry,
  ref: string
): { provider: ProviderSpec; model: ModelSpec } {
  if (ref.includes('/')) {
    const [providerId, ...rest] = ref.split('/');
    const provider = findProvider(registry, providerId);
    const modelId = rest.join('/');
    const model = provider.models.find((m) => m.id === modelId) ?? { id: modelId };
    return { provider, model };
  }

  const hits = registry.providers.flatMap((p) =>
    p.models.filter((m) => m.id === ref).map((m) => ({ provider: p, model: m }))
  );
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    throw new ProviderError(`No provider offers model "${ref}". Qualify it as "provider/model".`);
  }
  throw new ProviderError(
    `Model "${ref}" is offered by ${hits.map((h) => h.provider.id).join(', ')}. Qualify it as "provider/model".`
  );
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Cost in US dollars. Returns 0 when the registry carries no prices. */
export function estimateCost(model: ModelSpec, usage: Usage): number {
  const inRate = model.inputPerM ?? 0;
  const outRate = model.outputPerM ?? 0;
  const cost =
    (usage.inputTokens / 1_000_000) * inRate + (usage.outputTokens / 1_000_000) * outRate;
  // Sub-cent precision matters when a run makes hundreds of small calls.
  return Math.round(cost * 1e6) / 1e6;
}

export interface CallOptions {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Override the key rather than reading it from the provider's authEnv. */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface CallResult {
  text: string;
  model: string;
  provider: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
}

export type FetchLike = typeof globalThis.fetch;

function keyFor(provider: ProviderSpec, override?: string): string | undefined {
  if (override) return override;
  if (!provider.authEnv) return undefined; // local provider, no key needed
  const key = process.env[provider.authEnv];
  if (!key) {
    throw new ProviderError(
      `${provider.label} needs ${provider.authEnv} to be set, and it is not.`
    );
  }
  return key;
}

/** Call a model. Adapter is chosen from the registry, not from the caller. */
export async function call(
  registry: Registry,
  modelRef: string,
  opts: CallOptions,
  fetchImpl: FetchLike = globalThis.fetch
): Promise<CallResult> {
  const { provider, model } = resolveModel(registry, modelRef);
  const apiKey = keyFor(provider, opts.apiKey);
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  const signal = opts.signal ?? controller.signal;

  try {
    const { text, usage } =
      provider.adapter === 'anthropic'
        ? await callAnthropic(provider, model, opts, apiKey, fetchImpl, signal)
        : await callOpenAiCompatible(provider, model, opts, apiKey, fetchImpl, signal);

    return {
      text,
      model: model.id,
      provider: provider.id,
      usage,
      costUsd: estimateCost(model, usage),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(
  provider: ProviderSpec,
  model: ModelSpec,
  opts: CallOptions,
  apiKey: string | undefined,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<{ text: string; usage: Usage }> {
  const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      messages: [{ role: 'user', content: opts.prompt }],
    }),
    signal,
  });

  const body = await res.text();
  if (!res.ok) {
    throw new ProviderError(`${provider.label} returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = JSON.parse(body) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = data.content?.find((b) => b.type === 'text')?.text ?? '';
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

async function callOpenAiCompatible(
  provider: ProviderSpec,
  model: ModelSpec,
  opts: CallOptions,
  apiKey: string | undefined,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<{ text: string; usage: Usage }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model.id,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    }),
    signal,
  });

  const body = await res.text();
  if (!res.ok) {
    throw new ProviderError(`${provider.label} returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/** Providers that have their key configured, for a status view. */
export function availableProviders(registry: Registry): Array<{
  id: string;
  label: string;
  ready: boolean;
  reason?: string;
}> {
  return registry.providers.map((p) => {
    if (!p.authEnv) return { id: p.id, label: p.label, ready: true };
    const ready = Boolean(process.env[p.authEnv]);
    return {
      id: p.id,
      label: p.label,
      ready,
      reason: ready ? undefined : `Set ${p.authEnv}`,
    };
  });
}
