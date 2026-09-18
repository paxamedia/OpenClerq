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
 * every few weeks.
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
  /** True when the caller cancelled the call, as opposed to it failing. */
  readonly cancelled: boolean;
  constructor(message: string, opts: { cancelled?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.cancelled = opts.cancelled ?? false;
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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallOptions {
  system?: string;
  /** A single user turn. Ignored when `messages` is given. */
  prompt?: string;
  /** A conversation, for multi-turn chat. Takes precedence over `prompt`. */
  messages?: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Override the key rather than reading it from the provider's authEnv. */
  apiKey?: string;
  /** Proceed without a key when authEnv is unset — for self-hosted endpoints. */
  keyOptional?: boolean;
  signal?: AbortSignal;
  /**
   * Largest response accepted, in bytes. A streamed answer is cut off at the
   * limit and marked truncated; a buffered one over the limit is refused.
   * Defaults to CLERQ_MAX_RESPONSE_BYTES, or 8 MiB.
   */
  maxResponseBytes?: number;
}

export interface CallResult {
  text: string;
  model: string;
  provider: string;
  usage: Usage;
  /**
   * False when the provider reported no usage at all — a streaming endpoint
   * that omits it, most often. Zeros then mean "not said", not "none used",
   * and cost is null rather than a misleading $0.
   */
  usageReported: boolean;
  /** US dollars; null when the model's price is unknown. */
  costUsd: number | null;
  latencyMs: number;
  /** The request body sent, kept for the chat console's raw mode. */
  request?: unknown;
  /** True when a streamed answer hit maxResponseBytes and was cut off. */
  truncated?: boolean;
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
  return run(registry, modelRef, opts, fetchImpl);
}

/**
 * Call a model and receive the answer as it arrives.
 *
 * `onText` is called with each delta; the resolved result is the same shape a
 * buffered call returns, so a caller can record tokens and cost either way.
 */
export async function callStream(
  registry: Registry,
  modelRef: string,
  opts: CallOptions,
  onText: (delta: string) => void,
  fetchImpl: FetchLike = globalThis.fetch
): Promise<CallResult> {
  return run(registry, modelRef, opts, fetchImpl, onText);
}

async function run(
  registry: Registry,
  modelRef: string,
  opts: CallOptions,
  fetchImpl: FetchLike,
  onText?: (delta: string) => void
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
  const anthropic = provider.adapter === 'anthropic';
  const prepared = anthropic
    ? prepareAnthropic(ctx, Boolean(onText))
    : prepareOpenAi(ctx, Boolean(onText));

  try {
    const outcome = onText
      ? await readStream(ctx, prepared, onText, anthropic ? anthropicDelta : openAiDelta)
      : parseBody(anthropic, await postJson(ctx, prepared));

    return {
      text: outcome.text,
      model: model.id,
      provider: provider.id,
      usage: outcome.usage,
      usageReported: outcome.usageReported,
      // A keyless provider is one running on hardware the user already owns.
      costUsd: outcome.usageReported
        ? (estimateCost(model, outcome.usage) ?? (provider.authEnv ? null : 0))
        : null,
      latencyMs: Date.now() - started,
      request: prepared.body,
      ...(outcome.truncated ? { truncated: true } : {}),
    };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (timeout.signal.aborted) {
      throw new ProviderError(`${provider.label} did not respond within ${timeoutMs} ms.`);
    }
    if (opts.signal?.aborted) {
      throw new ProviderError(`Call to ${provider.label} was cancelled.`, { cancelled: true });
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

interface PreparedRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Outcome {
  text: string;
  usage: Usage;
  usageReported: boolean;
  truncated?: boolean;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Nothing else bounded a response: a misbehaving endpoint could stream until
 * the gateway ran out of memory, and the store would then try to keep it all.
 */
function responseLimit(opts: CallOptions): number {
  if (opts.maxResponseBytes && opts.maxResponseBytes > 0) return opts.maxResponseBytes;
  const fromEnv = Number(process.env.CLERQ_MAX_RESPONSE_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_RESPONSE_BYTES;
}

/** The conversation to send: an explicit history, or the single prompt. */
function turns(opts: CallOptions): Array<{ role: string; content: string }> {
  if (opts.messages?.length)
    return opts.messages.map((m) => ({ role: m.role, content: m.content }));
  return [{ role: 'user', content: opts.prompt ?? '' }];
}

function prepareAnthropic(ctx: CallContext, stream: boolean): PreparedRequest {
  const { model, opts, apiKey } = ctx;
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return {
    endpoint: '/messages',
    headers,
    body: {
      model: model.id,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      messages: turns(opts),
      ...(stream ? { stream: true } : {}),
    },
  };
}

function prepareOpenAi(ctx: CallContext, stream: boolean): PreparedRequest {
  const { model, opts, apiKey } = ctx;
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const messages = turns(opts);
  if (opts.system) messages.unshift({ role: 'system', content: opts.system });

  return {
    endpoint: '/chat/completions',
    headers,
    body: {
      model: model.id,
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      // Usage is not sent with a stream unless asked for, and without it every
      // streamed call would look free.
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    },
  };
}

function parseBody(anthropic: boolean, data: unknown): Outcome {
  if (anthropic) {
    const d = data as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: d.content?.find((b) => b.type === 'text')?.text ?? '',
      usage: {
        inputTokens: d.usage?.input_tokens ?? 0,
        outputTokens: d.usage?.output_tokens ?? 0,
      },
      usageReported: d.usage !== undefined,
    };
  }
  const d = data as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: d.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: d.usage?.prompt_tokens ?? 0,
      outputTokens: d.usage?.completion_tokens ?? 0,
    },
    usageReported: d.usage !== undefined,
  };
}

async function postJson(ctx: CallContext, prepared: PreparedRequest): Promise<unknown> {
  const res = await send(ctx, prepared);
  const text = await readCapped(res, responseLimit(ctx.opts), ctx.provider.label);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(
      `${ctx.provider.label} returned a response that is not JSON: ${text.slice(0, 120)}`
    );
  }
}

async function send(ctx: CallContext, prepared: PreparedRequest): Promise<Response> {
  const { provider, fetchImpl, signal } = ctx;
  const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}${prepared.endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...prepared.headers },
    body: JSON.stringify(prepared.body),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    // Not every OpenAI-compatible server understands stream_options. Rather
    // than guess per vendor, drop it and retry once when that is the complaint.
    if (res.status === 400 && 'stream_options' in prepared.body && /stream_options/i.test(body)) {
      const { stream_options: _dropped, ...rest } = prepared.body;
      return send(ctx, { ...prepared, body: rest });
    }
    throw new ProviderError(`${provider.label} returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

/** One SSE frame's meaning, as far as this module cares. */
interface Delta {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function anthropicDelta(event: Record<string, unknown>): Delta {
  const type = event.type;
  if (type === 'content_block_delta') {
    const delta = event.delta as { type?: string; text?: string } | undefined;
    return { text: delta?.type === 'text_delta' ? (delta.text ?? '') : undefined };
  }
  if (type === 'message_start') {
    const usage = (event.message as { usage?: { input_tokens?: number; output_tokens?: number } })
      ?.usage;
    return { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens };
  }
  if (type === 'message_delta') {
    const usage = event.usage as { output_tokens?: number } | undefined;
    return { outputTokens: usage?.output_tokens };
  }
  if (type === 'error') {
    const error = event.error as { message?: string } | undefined;
    throw new ProviderError(`Stream failed: ${error?.message ?? 'unknown error'}`);
  }
  return {};
}

function openAiDelta(event: Record<string, unknown>): Delta {
  const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
  const usage = event.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | null
    | undefined;
  return {
    text: choices?.[0]?.delta?.content,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
  };
}

async function readStream(
  ctx: CallContext,
  prepared: PreparedRequest,
  onText: (delta: string) => void,
  toDelta: (event: Record<string, unknown>) => Delta
): Promise<Outcome> {
  const res = await send(ctx, prepared);
  if (!res.body) throw new ProviderError(`${ctx.provider.label} returned an empty stream.`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const limit = responseLimit(ctx.opts);
  let received = 0;
  let truncated = false;
  let buffer = '';
  let text = '';
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let usageReported = false;

  const handle = (payload: string): void => {
    if (!payload || payload === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return; // a keep-alive or a comment line; nothing to do
    }
    const delta = toDelta(event);
    if (delta.text) {
      text += delta.text;
      onText(delta.text);
    }
    if (typeof delta.inputTokens === 'number') {
      usage.inputTokens = delta.inputTokens;
      usageReported = true;
    }
    if (typeof delta.outputTokens === 'number') {
      usage.outputTokens = delta.outputTokens;
      usageReported = true;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      // Keep what arrived; stop the provider sending more.
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line; a frame may carry several lines.
    let sep: number;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + (/\r\n\r\n/.test(buffer.slice(sep, sep + 4)) ? 4 : 2));
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
  }
  for (const line of buffer.split(/\r?\n/)) {
    if (line.startsWith('data:')) handle(line.slice(5).trim());
  }

  return { text, usage, usageReported, truncated };
}

/** Read a buffered body, refusing one larger than `limit`. */
async function readCapped(res: Response, limit: number, label: string): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError(`${label} sent a response larger than ${limit} bytes; refused.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
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
