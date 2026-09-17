/**
 * Model providers.
 *
 * Six of the seven vendors this project targets speak the same
 * `/chat/completions` dialect, so the work is a registry plus two adapters, not
 * seven integrations. Anthropic gets its own adapter; everything else — OpenAI,
 * DeepSeek, Moonshot (Kimi), Z.ai (GLM), MiniMax, Ollama, LM Studio — is a row
 * in the registry.
 *
 * Cursor is deliberately absent: it has no public model API and enters as a CLI
 * driver instead.
 *
 * Base URLs, model ids and prices are data rather than code because they change
 * every few weeks. Hardcoding them is how the pre-0.4 model list ended up
 * two years stale.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_REGISTRY_YAML } from './default-registry.js';

export { DEFAULT_REGISTRY_YAML };

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
  /** Model used when none is named. Falls back to the first listed model. */
  defaultModel?: string;
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

/** Where a user's own registry lives when CLERQ_PROVIDERS_FILE is not set. */
export function userRegistryPath(): string {
  return process.env.CLERQ_PROVIDERS_FILE || path.join(os.homedir(), '.clerq', 'providers.yaml');
}

function isPrice(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
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
    for (const m of p.models) {
      // A price that is a string or negative would silently corrupt every
      // cost figure derived from it.
      for (const field of ['inputPerM', 'outputPerM'] as const) {
        if (m[field] !== undefined && !isPrice(m[field])) {
          throw new ProviderError(
            `Model "${p.id}/${m.id}" has an invalid ${field}: expected a non-negative number.`
          );
        }
      }
    }
  }
  return { version: r.version ?? 1, providers: r.providers };
}

/**
 * Load the registry.
 *
 * With an explicit path, that file must exist. Otherwise the user's copy
 * (CLERQ_PROVIDERS_FILE, or ~/.clerq/providers.yaml) wins when present, and the
 * built-in registry is used when it is not.
 */
export function loadRegistry(explicitPath?: string): Registry {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new ProviderError(`No provider registry found at ${explicitPath}.`);
    }
    return parseRegistry(fs.readFileSync(explicitPath, 'utf8'));
  }
  const user = userRegistryPath();
  if (fs.existsSync(user)) return parseRegistry(fs.readFileSync(user, 'utf8'));
  return parseRegistry(DEFAULT_REGISTRY_YAML);
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

/** The model a provider uses when none is named. */
export function defaultModelFor(provider: ProviderSpec): string {
  const id = provider.defaultModel ?? provider.models[0]?.id;
  if (!id) {
    throw new ProviderError(`${provider.label} has no default model. Name one explicitly.`);
  }
  return id;
}

/**
 * A copy of the registry with one provider's fields replaced — used to point a
 * provider at a self-hosted or proxied endpoint without editing the registry.
 */
export function overrideProvider(
  registry: Registry,
  id: string,
  patch: Partial<Omit<ProviderSpec, 'id'>>
): Registry {
  findProvider(registry, id);
  return {
    ...registry,
    providers: registry.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  };
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

/**
 * Cost in US dollars, or null when the registry carries no price for the model.
 *
 * Unknown is not the same as free: reporting $0 for an unpriced cloud model
 * would understate spend in exactly the place this project promises to control it.
 */
export function estimateCost(model: ModelSpec, usage: Usage): number | null {
  if (model.inputPerM === undefined || model.outputPerM === undefined) return null;
  const cost =
    (usage.inputTokens / 1_000_000) * model.inputPerM +
    (usage.outputTokens / 1_000_000) * model.outputPerM;
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
  /** Proceed without a key when authEnv is unset — for self-hosted endpoints. */
  keyOptional?: boolean;
  signal?: AbortSignal;
}

export interface CallResult {
  text: string;
  model: string;
  provider: string;
  usage: Usage;
  /** US dollars; null when the model's price is unknown. */
  costUsd: number | null;
  latencyMs: number;
}

export type FetchLike = typeof globalThis.fetch;

function keyFor(provider: ProviderSpec, opts: CallOptions): string | undefined {
  if (opts.apiKey) return opts.apiKey;
  if (!provider.authEnv) return undefined; // local provider, no key needed
  const key = process.env[provider.authEnv];
  if (!key && !opts.keyOptional) {
    throw new ProviderError(
      `${provider.label} needs ${provider.authEnv} to be set, and it is not.`
    );
  }
  return key || undefined;
}

/** Call a model. Adapter is chosen from the registry, not from the caller. */
export async function call(
  registry: Registry,
  modelRef: string,
  opts: CallOptions,
  fetchImpl: FetchLike = globalThis.fetch
): Promise<CallResult> {
  const { provider, model } = resolveModel(registry, modelRef);
  const apiKey = keyFor(provider, opts);
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // The timeout applies even when the caller supplies its own signal.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
  const ctx: CallContext = { provider, model, opts, apiKey, fetchImpl, signal };

  try {
    const { text, usage } =
      provider.adapter === 'anthropic' ? await callAnthropic(ctx) : await callOpenAiCompatible(ctx);

    return {
      text,
      model: model.id,
      provider: provider.id,
      usage,
      // A keyless provider is one running on hardware the user already owns.
      costUsd: estimateCost(model, usage) ?? (provider.authEnv ? null : 0),
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (timeout.signal.aborted) {
      throw new ProviderError(`${provider.label} did not respond within ${timeoutMs} ms.`);
    }
    if (opts.signal?.aborted) {
      throw new ProviderError(`Call to ${provider.label} was cancelled.`);
    }
    // fetch rejects with a bare "fetch failed"; name the endpoint so the cause is findable.
    const cause = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : e;
    throw new ProviderError(`${provider.label} is unreachable at ${provider.baseUrl}: ${cause}`);
  } finally {
    clearTimeout(timer);
  }
}

interface CallContext {
  provider: ProviderSpec;
  model: ModelSpec;
  opts: CallOptions;
  apiKey: string | undefined;
  fetchImpl: FetchLike;
  signal: AbortSignal;
}

async function postJson<T>(
  ctx: CallContext,
  endpoint: string,
  headers: Record<string, string>,
  body: unknown
): Promise<T> {
  const { provider, fetchImpl, signal } = ctx;
  const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`${provider.label} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(
      `${provider.label} returned a response that is not JSON: ${text.slice(0, 120)}`
    );
  }
}

async function callAnthropic(ctx: CallContext): Promise<{ text: string; usage: Usage }> {
  const { model, opts, apiKey } = ctx;
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const data = await postJson<{
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>(ctx, '/messages', headers, {
    model: model.id,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    messages: [{ role: 'user', content: opts.prompt }],
  });

  return {
    text: data.content?.find((b) => b.type === 'text')?.text ?? '',
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

async function callOpenAiCompatible(ctx: CallContext): Promise<{ text: string; usage: Usage }> {
  const { model, opts, apiKey } = ctx;
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const data = await postJson<{
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>(ctx, '/chat/completions', headers, {
    model: model.id,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
  });

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
