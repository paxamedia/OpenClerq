/**
 * The gateway's model calls, routed through the provider registry.
 *
 * Every vendor in @clerq/providers is reachable here: set CLERQ_LLM_PROVIDER to
 * a registry id (anthropic, openai, deepseek, moonshot, zai, minimax, ollama,
 * lmstudio) or name a qualified model such as `deepseek/deepseek-chat`.
 *
 * Each call is accounted for: metrics, a `model.called` event, and — inside a
 * run — a step carrying its tokens and cost.
 *
 * The pre-0.5 variables keep working: CLERQ_LLM_PROVIDER=openai with
 * CLERQ_LLM_BASE_URL still means "an OpenAI-compatible server at this URL", and
 * CLERQ_OLLAMA_URL still moves Ollama.
 */

import fs from 'node:fs';
import {
  call,
  callStream,
  defaultModelFor,
  findProvider,
  loadRegistry,
  overrideProvider,
  userRegistryPath,
  ProviderError,
  type CallResult,
  type ChatMessage,
  type ProviderSpec,
  type Registry,
} from '@clerq/providers';
import { loadReasoning } from '../reasoning-config.js';
import { recordLLMSuccess, recordLLMFailure } from '../observability.js';
import { recordModelCall, currentRunSignal } from '../runs.js';

export interface LLMCallResult {
  text: string;
  model: string;
  provider: string;
  /** US dollars; null when the registry has no price for the model. */
  costUsd: number | null;
}

let cached: { key: string; registry: Registry } | undefined;

/**
 * The provider registry, reloaded when the user's copy changes so an edited
 * price or a new model applies without restarting the gateway.
 */
export function getRegistry(): Registry {
  const file = userRegistryPath();
  let key = 'built-in';
  try {
    key = `${file}@${fs.statSync(file).mtimeMs}`;
  } catch {
    // No user copy; the built-in registry applies.
  }
  if (cached?.key !== key) cached = { key, registry: loadRegistry() };
  return cached.registry;
}

interface Target {
  /** The registry with any endpoint override applied. */
  registry: Registry;
  provider: ProviderSpec;
  model: string;
  /** True when the endpoint was overridden, so a key may legitimately be absent. */
  keyOptional: boolean;
}

/** Split "provider/model" — but only when the prefix really is a provider. */
function splitQualified(
  registry: Registry,
  ref: string
): { providerId: string; model: string } | undefined {
  const slash = ref.indexOf('/');
  if (slash <= 0) return undefined;
  const providerId = ref.slice(0, slash);
  // Model ids contain slashes of their own (`lmstudio-community/qwen3`); those
  // belong to the configured provider rather than naming a new one.
  if (!registry.providers.some((p) => p.id === providerId)) return undefined;
  return { providerId, model: ref.slice(slash + 1) };
}

/**
 * The two endpoint variables that predate the registry, each scoped to the one
 * provider it has always meant. Applying CLERQ_LLM_BASE_URL to every provider
 * would let a leftover value send, say, a DeepSeek key to an unrelated server.
 * Anything else is moved by editing providers.yaml, where the change is explicit.
 */
function endpointOverride(providerId: string): string | undefined {
  if (providerId === 'openai') return process.env.CLERQ_LLM_BASE_URL?.trim() || undefined;
  const ollama = process.env.CLERQ_OLLAMA_URL?.trim();
  if (providerId === 'ollama' && ollama) {
    // Accept the server root or its /v1 API root; both have been documented.
    const root = ollama.replace(/\/+$/, '');
    return /\/v1$/.test(root) ? root : `${root}/v1`;
  }
  return undefined;
}

/** Work out which provider, model and endpoint a call goes to. */
export function resolveTarget(modelOverride?: string): Target {
  const base = getRegistry();

  const envModel = process.env.CLERQ_MODEL?.trim() || undefined;
  const configured = (envModel && splitQualified(base, envModel)) || {
    providerId: (process.env.CLERQ_LLM_PROVIDER ?? 'anthropic').trim().toLowerCase(),
    model: envModel,
  };
  if (!base.providers.some((p) => p.id === configured.providerId)) {
    throw new ProviderError(
      `Unknown CLERQ_LLM_PROVIDER "${configured.providerId}". ` +
        `Known: ${base.providers.map((p) => p.id).join(', ')}.`
    );
  }

  const override = modelOverride?.trim() || undefined;
  const requested = override
    ? (splitQualified(base, override) ?? { providerId: configured.providerId, model: override })
    : configured;

  // An endpoint override belongs to the configured provider only. A request
  // naming another provider must not be sent to that endpoint.
  let registry = base;
  let keyOptional = false;
  const endpoint =
    requested.providerId === configured.providerId
      ? endpointOverride(configured.providerId)
      : undefined;
  if (endpoint) {
    registry = overrideProvider(base, configured.providerId, { baseUrl: endpoint });
    keyOptional = true;
  }

  const provider = findProvider(registry, requested.providerId);
  return {
    registry,
    provider,
    model: requested.model ?? defaultModelFor(provider),
    keyOptional,
  };
}

export interface ChatCallOptions {
  /** The conversation to send. */
  messages: ChatMessage[];
  /** Omitted in the console's raw mode: nothing is added to the conversation. */
  system?: string;
  /** A bare model for the configured provider, or "provider/model". */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Called with each delta when the answer should stream. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Send a conversation to a model, accounting for the call either way.
 *
 * One path for every caller — the task pipeline, the chat console, a
 * comparison — so tokens and cost are recorded in exactly one place.
 */
export async function chat(opts: ChatCallOptions): Promise<CallResult> {
  const started = Date.now();
  const promptForRecord = opts.messages.at(-1)?.content ?? '';
  let target: Target | undefined;
  try {
    target = resolveTarget(opts.model);
    const ref = `${target.provider.id}/${target.model}`;
    // A call inside a run stops when the run is cancelled — by the kill switch,
    // or because the client that asked for it went away.
    const signals = [opts.signal, currentRunSignal()].filter(
      (s): s is AbortSignal => s !== undefined
    );
    const callOptions = {
      system: opts.system,
      messages: opts.messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      keyOptional: target.keyOptional,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    };
    const res = opts.onDelta
      ? await callStream(target.registry, ref, callOptions, opts.onDelta)
      : await call(target.registry, ref, callOptions);

    recordLLMSuccess(res.latencyMs, res.usage.inputTokens, res.usage.outputTokens, res.costUsd);
    recordModelCall({
      provider: res.provider,
      model: res.model,
      prompt: promptForRecord,
      status: 'ok',
      text: res.text,
      tokensIn: res.usage.inputTokens,
      tokensOut: res.usage.outputTokens,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
    });
    return res;
  } catch (e) {
    recordLLMFailure();
    recordModelCall({
      provider: target?.provider.id ?? 'unresolved',
      model: target?.model ?? opts.model ?? 'unresolved',
      prompt: promptForRecord,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    });
    throw e;
  }
}

/**
 * Call the configured model with one user turn and the agent's system prompt.
 * @param modelOverride A bare model for the configured provider, or "provider/model".
 */
export async function callLLM(
  system: string,
  userContent: string,
  modelOverride?: string,
  signal?: AbortSignal
): Promise<LLMCallResult> {
  const reasoning = loadReasoning();
  const res = await chat({
    system,
    messages: [{ role: 'user', content: userContent }],
    model: modelOverride,
    temperature: reasoning.temperature,
    maxTokens: reasoning.maxTokens,
    signal,
  });
  return {
    text: res.text || 'No response.',
    model: res.model,
    provider: res.provider,
    costUsd: res.costUsd,
  };
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

export interface LLMProviderStatus {
  provider: string;
  model: string;
  /** 'local' when the model runs on this machine; 'api' when calls leave it. */
  mode: 'api' | 'local';
  available: boolean;
  hint?: string;
}

export function getLLMProviderStatus(): LLMProviderStatus {
  try {
    const t = resolveTarget();
    const needsKey = Boolean(t.provider.authEnv) && !t.keyOptional;
    const hasKey = !needsKey || Boolean(process.env[t.provider.authEnv as string]);
    const mode = !t.provider.authEnv || isLoopback(t.provider.baseUrl) ? 'local' : 'api';
    let hint: string | undefined;
    if (!hasKey) hint = `Set ${t.provider.authEnv}`;
    else if (t.provider.id === 'ollama') hint = `Ensure Ollama is running (ollama run ${t.model})`;
    return { provider: t.provider.id, model: t.model, mode, available: hasKey, hint };
  } catch (e) {
    // A misconfiguration is a status to report, not a reason for /health to fail.
    return {
      provider: (process.env.CLERQ_LLM_PROVIDER ?? 'anthropic').trim().toLowerCase(),
      model: process.env.CLERQ_MODEL ?? '',
      mode: 'api',
      available: false,
      hint: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Models offered by the configured provider. Ollama is asked what it has installed. */
export async function getAvailableModels(): Promise<string[]> {
  let t: Target;
  try {
    t = resolveTarget();
  } catch {
    return [];
  }
  const listed = [...t.provider.models.map((m) => m.id), t.model];

  if (t.provider.id === 'ollama') {
    try {
      const root = t.provider.baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const installed = data.models?.map((m) => m.name) ?? [];
        if (installed.length > 0) listed.unshift(...installed);
      }
    } catch {
      // Ollama not running; fall back to the registry's list.
    }
  }
  return [...new Set(listed)];
}

/** Every provider in the registry, for pickers and the chat console. */
export function listProviders(): Array<{
  id: string;
  label: string;
  local: boolean;
  ready: boolean;
  reason?: string;
  defaultModel: string | null;
  models: Array<{
    id: string;
    ref: string;
    context?: number;
    inputPerM?: number;
    outputPerM?: number;
  }>;
}> {
  const registry = getRegistry();
  let selfHosted: string | undefined;
  try {
    const t = resolveTarget();
    if (t.keyOptional) selfHosted = t.provider.id;
  } catch {
    // Misconfigured; every provider is judged on its key alone.
  }
  return registry.providers.map((p) => {
    const ready = !p.authEnv || p.id === selfHosted || Boolean(process.env[p.authEnv]);
    return {
      id: p.id,
      label: p.label,
      local: !p.authEnv,
      ready,
      reason: ready ? undefined : `Set ${p.authEnv}`,
      defaultModel: p.defaultModel ?? p.models[0]?.id ?? null,
      // Base URLs are left out: an overridden one may carry credentials.
      models: p.models.map((m) => ({
        id: m.id,
        ref: `${p.id}/${m.id}`,
        context: m.context,
        inputPerM: m.inputPerM,
        outputPerM: m.outputPerM,
      })),
    };
  });
}
