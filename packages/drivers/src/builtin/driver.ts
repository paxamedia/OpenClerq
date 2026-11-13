/**
 * The builtin driver: an agent loop in the gateway's own process, over any
 * model in the provider registry.
 *
 * Each turn sends the conversation and the tool set to the model; each tool
 * call it makes goes through the policy engine (allow, deny, or wait for a
 * person) before it runs in the worktree. The loop is bounded four ways: a
 * turn limit, the run's wall-clock limit, the per-run budget measured from
 * each call's recorded cost, and the policy's cap on tool calls. It reports
 * what it did as the same events the CLI drivers emit, plus one event per
 * model call so tokens and cost are recorded call by call.
 */

import {
  call,
  Conversation,
  contextBudget,
  estimateCost,
  estimateTokens,
  isUnavailable,
  loadRegistry,
  resolveModel,
  SUMMARY_PROMPT,
  type CallResult,
  type ContentBlock,
  type FetchLike,
  type ModelSpec,
  type ProviderSpec,
  type Registry,
  type ToolCall,
} from '@clerq/providers';
import { guard, PolicyViolation, RunBudget, type ToolDescriptor } from '@clerq/policy';
import { PathContainmentError, redact } from '@clerq/sandbox';
import { DEFAULT_TIMEOUT_MS, failed } from '../cli.js';
import type {
  Driver,
  DriverAvailability,
  DetectOptions,
  DriverEvent,
  DriverResult,
  DriverRunInput,
  ModelCallInfo,
} from '../types.js';
import { builtinPolicy, offeredTools } from './policy.js';
import {
  BUILTIN_TOOLS,
  shellDescriptor,
  ToolInputError,
  type BuiltinTool,
  type ToolContext,
} from './tools.js';

const ID = 'builtin';

/**
 * The secret name a run hands the model's API key over as. The driver uses it
 * for the model call only; commands the agent runs never see it.
 */
export const BUILTIN_KEY_ENV = 'CLERQ_PROVIDER_API_KEY';

export const DEFAULT_MAX_TURNS = 60;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
/** No single model call waits longer than this. */
const MAX_CALL_MS = 10 * 60_000;
/** Compaction starts when the next request would use this share of the budget. */
const COMPACT_AT = 0.8;
/** The output limit of a summary call, and its instructions. */
const SUMMARY_MAX_TOKENS = 2_048;
const SUMMARY_SYSTEM = "You summarise an agent's progress so it can continue with less context.";
/** Replies in a row cut off at the output limit before the run gives up. */
const MAX_CUT_OFF = 3;

export interface BuiltinOptions {
  /** The registry to resolve models in. Default: the user's providers.yaml, or the built-in one. */
  registry?: () => Registry;
  fetch?: FetchLike;
  /**
   * Providers whose endpoint was pointed at a self-hosted server, where a key
   * may legitimately be absent.
   */
  keyOptional?: (providerId: string) => boolean;
  maxTurns?: number;
  maxOutputTokens?: number;
  /** The system prompt. Default: SYSTEM_PROMPT, written for automation runs. */
  system?: string;
}

export const SYSTEM_PROMPT = [
  "You are a coding agent working unattended in a git worktree of the user's repository.",
  'Use the tools to inspect the repository, make the change the task asks for, and check it',
  '(run the tests or build when the project has them). Paths are relative to the repository root.',
  'Read a file before you edit it, and prefer edit_file for changes to existing files.',
  'Do not commit, push or open pull requests: when you finish, OpenClerq commits your changes,',
  "runs the automation's checks and publishes them as the automation says.",
  'Nobody will answer questions during the run; make reasonable choices and say what you assumed.',
  'A tool result may be cut short; it says so and how to see the rest.',
  'When the task is done, stop calling tools and reply with a short summary of what you changed and why.',
].join(' ');

/** `value` with every string in it redacted of the run's secret values. */
export function redactDeep(value: unknown, secrets: Record<string, string> | undefined): unknown {
  if (!secrets || Object.keys(secrets).length === 0) return value;
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, secrets)])
    );
  }
  return value;
}

function qualified(ref: string | undefined): string | undefined {
  if (!ref)
    return 'The builtin driver needs agent.model as provider/model, e.g. anthropic/claude-sonnet-4-5.';
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    return `agent.model "${ref}" must name the provider too, as provider/model (e.g. anthropic/${ref}).`;
  }
  return undefined;
}

/** True when a call to this model has a price, or is free because it runs locally. */
export function priced(provider: ProviderSpec, model: ModelSpec): boolean {
  if (model.inputPerM !== undefined && model.outputPerM !== undefined) return true;
  return !provider.authEnv;
}

function unpricedReason(provider: ProviderSpec, model: ModelSpec): string {
  return (
    `${provider.id}/${model.id} has no price in providers.yaml, so a budget in US dollars cannot be kept. ` +
    'Add inputPerM and outputPerM for it, or remove budget.max_usd_per_run and budget.max_usd_per_month.'
  );
}

export function builtin(options: BuiltinOptions = {}): Driver {
  const registryOf = options.registry ?? (() => loadRegistry());
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function detect(opts: DetectOptions = {}): Promise<DriverAvailability> {
    let registry: Registry;
    try {
      registry = registryOf();
    } catch (e) {
      return { id: ID, available: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const providers = registry.providers.map((p) => {
      const local = !p.authEnv;
      const ready =
        local || Boolean(process.env[p.authEnv as string]) || Boolean(options.keyOptional?.(p.id));
      return {
        id: p.id,
        label: p.label,
        ready,
        local,
        ...(ready ? {} : { reason: `Set ${p.authEnv}` }),
      };
    });

    if (!opts.model) {
      const keyed = providers.filter((p) => p.ready && !p.local);
      return {
        id: ID,
        available: keyed.length > 0,
        providers,
        ...(keyed.length > 0
          ? {}
          : {
              reason:
                'No model provider has a key set (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). A spec can still bring ' +
                'one with agent.api_key_secret, or name a local model such as ollama/llama3.2.',
            }),
      };
    }

    const problem = qualified(opts.model);
    if (problem) return { id: ID, available: false, providers, reason: problem };
    let provider: ProviderSpec;
    let model: ModelSpec;
    try {
      ({ provider, model } = resolveModel(registry, opts.model));
    } catch (e) {
      return {
        id: ID,
        available: false,
        providers,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    const ref = `${provider.id}/${model.id}`;
    const base = { id: ID, providers, model: ref };
    if (
      provider.authEnv &&
      !opts.apiKey &&
      !process.env[provider.authEnv] &&
      !options.keyOptional?.(provider.id)
    ) {
      return {
        ...base,
        available: false,
        reason: `${provider.label} needs ${provider.authEnv}: set it for the gateway, or name a vault secret in agent.api_key_secret.`,
      };
    }
    if (opts.budget && !priced(provider, model)) {
      return { ...base, available: false, unpriced: true, reason: unpricedReason(provider, model) };
    }
    if (!provider.authEnv) {
      // A local server: check something answers, so a run does not fail on its first call.
      try {
        const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok && res.status >= 500) throw new Error(`status ${res.status}`);
      } catch (e) {
        return {
          ...base,
          available: false,
          reason: `Nothing answers at ${provider.baseUrl} (${provider.label}): ${e instanceof Error ? e.message : String(e)}. Start it, or point the registry at it.`,
        };
      }
    }
    return { ...base, available: true };
  }

  return {
    id: ID,
    detect,
    run: (input) => runLoop(input, { ...options, registry: registryOf, fetch: fetchImpl }),
  };
}

interface Totals {
  spent: number;
  unknownCost: boolean;
  tokensIn: number;
  tokensOut: number;
  turns: number;
}

/** The model a call goes to now, with what the call needs from it. */
interface Active {
  provider: ProviderSpec;
  model: ModelSpec;
  /** `provider/model`, as the registry names it. */
  ref: string;
  /** The key for this model's provider: the run's own, or none (then the provider's usual one). */
  apiKey: string | undefined;
  keyOptional: boolean;
  /** The most a reply may write: bounded by the model's window. */
  maxOutput: number;
}

async function* runLoop(
  input: DriverRunInput,
  options: BuiltinOptions & { registry: () => Registry; fetch: FetchLike }
): AsyncIterable<DriverEvent> {
  const started = Date.now();
  const deadline = started + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const problem = qualified(input.model);
  if (problem) {
    yield failed(problem);
    return;
  }
  /** The run's key belongs to the provider of the model it starts with. */
  let keyProvider: string | undefined;
  let registry: Registry;
  let start: Active;
  try {
    registry = options.registry();
    start = bind(input.model as string);
  } catch (e) {
    yield failed(e instanceof Error ? e.message : String(e));
    return;
  }
  keyProvider = start.provider.id;
  if (input.maxBudgetUsd !== undefined && !priced(start.provider, start.model)) {
    yield failed(unpricedReason(start.provider, start.model));
    return;
  }

  /**
   * The model `ref` as a target for calls. The run's own key goes only to the
   * provider it was given for: a fallback on another provider uses that
   * provider's usual key, so a key is never sent to a vendor it was not for.
   */
  function bind(ref: string): Active {
    const { provider, model } = resolveModel(registry, ref);
    const maxOutput = Math.min(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      Math.max(1_024, Math.floor((model.context ?? 32_000) / 4))
    );
    return {
      provider,
      model,
      ref: `${provider.id}/${model.id}`,
      // Until the first model is bound the key is for it, whatever it is.
      apiKey:
        keyProvider === undefined || provider.id === keyProvider
          ? input.secrets?.[BUILTIN_KEY_ENV]
          : undefined,
      keyOptional: options.keyOptional?.(provider.id) ?? false,
      maxOutput,
    };
  }

  /**
   * Why a model cannot take over, or undefined when it can: it must be a
   * model the registry resolves, priced when the run has a dollar budget, and
   * have a key (the run's own for its provider, else the provider's usual one).
   */
  function unusable(ref: string): { active?: Active; reason?: string } {
    const bad = qualified(ref);
    if (bad) return { reason: bad };
    let active: Active;
    try {
      active = bind(ref);
    } catch (e) {
      return { reason: e instanceof Error ? e.message : String(e) };
    }
    if (input.maxBudgetUsd !== undefined && !priced(active.provider, active.model)) {
      return { reason: unpricedReason(active.provider, active.model) };
    }
    const authEnv = active.provider.authEnv;
    if (authEnv && !active.apiKey && !active.keyOptional && !process.env[authEnv]) {
      return { reason: `${active.provider.label} needs ${authEnv}, and it is not set.` };
    }
    return { active };
  }

  // The model in use, and the ones to move to when it is unavailable.
  let active = start;
  const chain = [...new Set([active.ref, ...(input.fallbackModels ?? [])])];
  let chainAt = 0;

  // One signal for everything the run starts: the caller's, and the deadline.
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(0, deadline - Date.now())
  );
  const signal = controller.signal;

  const rules = builtinPolicy(input.permissionMode, input.allowedTools);
  const budget = new RunBudget(rules);
  const tools = offeredTools(rules);
  const byModelName = new Map<string, BuiltinTool>(tools.map((t) => [t.definition.name, t]));
  const budgetOf = (a: Active) => contextBudget(a.model, { maxOutputTokens: a.maxOutput }).budget;
  const conversation = new Conversation({
    system: options.system ?? SYSTEM_PROMPT,
    pinned: [{ role: 'user', content: `Task:\n${input.prompt}` }],
    budget: budgetOf(active),
    tools: tools.map((t) => t.definition),
  });

  const totals: Totals = { spent: 0, unknownCost: false, tokensIn: 0, tokensOut: 0, turns: 0 };
  const denials: DriverResult['permissionDenials'] = [];
  const warnings = new Set<string>();
  const ctx: ToolContext = {
    cwd: input.cwd,
    signal,
    deadline,
    sandbox: input.sandbox ?? { profile: 'native' },
    env: input.env ?? { PATH: process.env.PATH ?? '' },
    onProcess: input.onToolProcess,
    warnings,
  };

  const finish = (ok: boolean, summary: string): DriverEvent => ({
    type: 'finished',
    result: {
      ok,
      summary,
      costUsd: totals.unknownCost ? null : Math.round(totals.spent * 1e6) / 1e6,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      turns: totals.turns,
      durationMs: Date.now() - started,
      exitCode: null,
      timedOut: timedOut && !input.signal?.aborted,
      cancelled: Boolean(input.signal?.aborted),
      permissionDenials: denials,
      warnings: [...warnings],
    },
  });
  const stopped = (): DriverEvent | undefined => {
    if (input.signal?.aborted) return finish(false, 'Cancelled.');
    if (timedOut || Date.now() >= deadline) {
      timedOut = true;
      return finish(false, `Timed out after ${Math.round((Date.now() - started) / 1000)}s.`);
    }
    return undefined;
  };

  /**
   * Events to report at the next safe point, in the order they happened: the
   * calls that failed because a model was unavailable, and the moves to the next.
   */
  const outbox: DriverEvent[] = [];
  function* flush(): Generator<DriverEvent> {
    while (outbox.length > 0) yield outbox.shift() as DriverEvent;
  }

  /** One model call to the model in use, accounted. */
  const ask = async (
    purpose: ModelCallInfo['purpose'],
    request: {
      system: string;
      messages: ReturnType<Conversation['messages']>;
      withTools: boolean;
      maxTokens: number;
    }
  ): Promise<{ result?: CallResult; info: ModelCallInfo }> => {
    const t0 = Date.now();
    try {
      const result = await call(
        registry,
        active.ref,
        {
          system: request.system,
          messages: request.messages,
          ...(request.withTools && tools.length ? { tools: tools.map((t) => t.definition) } : {}),
          maxTokens: request.maxTokens,
          apiKey: active.apiKey,
          keyOptional: active.keyOptional,
          signal,
          timeoutMs: Math.max(1_000, Math.min(MAX_CALL_MS, deadline - Date.now())),
        },
        options.fetch
      );
      totals.tokensIn += result.usage.inputTokens;
      totals.tokensOut += result.usage.outputTokens;
      if (result.costUsd === null) totals.unknownCost = true;
      else totals.spent += result.costUsd;
      return {
        result,
        info: {
          purpose,
          provider: result.provider,
          model: result.model,
          turn: totals.turns,
          ok: true,
          stopReason: result.stopReason,
          toolCalls: result.toolCalls.length,
          text: result.text,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
        },
      };
    } catch (e) {
      return {
        info: {
          purpose,
          provider: active.provider.id,
          model: active.model.id,
          turn: totals.turns,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          // Only the adapter's own account of the failure counts, never a message.
          ...(isUnavailable(e) ? { unavailable: true } : {}),
          toolCalls: 0,
          text: '',
          tokensIn: 0,
          tokensOut: 0,
          costUsd: null,
          latencyMs: Date.now() - t0,
        },
      };
    }
  };

  /**
   * After a call that failed because the model is unavailable: move to the
   * next model in the chain that can take over. Returns false when there is
   * none. The conversation goes with it: its budget becomes the new model's,
   * and the old model's reasoning is dropped from the history.
   */
  const moveOn = (failed: ModelCallInfo): boolean => {
    const skipped: Array<{ model: string; reason: string }> = [];
    while (chainAt + 1 < chain.length) {
      chainAt += 1;
      const next = unusable(chain[chainAt]);
      if (!next.active) {
        skipped.push({ model: chain[chainAt], reason: next.reason ?? 'It cannot be used.' });
        continue;
      }
      const from = active.ref;
      active = next.active;
      conversation.switchModel(budgetOf(active));
      outbox.push({
        type: 'model_fallback',
        from,
        to: active.ref,
        reason: failed.error ?? 'The model was unavailable.',
        ...(skipped.length > 0 ? { skipped } : {}),
      });
      return true;
    }
    return false;
  };

  /**
   * Stop before a call the budget cannot cover: its input as estimated, and
   * its output at the full limit the call is allowed, since that is what it
   * may cost.
   */
  const overBudget = (inputTokens: number, outputTokens: number): string | undefined => {
    const max = input.maxBudgetUsd;
    if (max === undefined) return undefined;
    const next = estimateCost(active.model, { inputTokens, outputTokens }) ?? 0;
    if (totals.spent + next <= max) return undefined;
    return `Stopped: the next model call would pass the run's budget of $${max.toFixed(2)} ($${totals.spent.toFixed(4)} spent).`;
  };

  try {
    yield { type: 'started', model: active.ref, tools: tools.map((t) => t.name) };
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    let cutOff = 0;

    for (;;) {
      const stop = stopped();
      if (stop) {
        yield stop;
        return;
      }
      if (totals.turns >= maxTurns) {
        yield finish(false, `Stopped after ${maxTurns} model turns without finishing.`);
        return;
      }

      // Context: compact before the request would no longer fit.
      if (conversation.overBudget(COMPACT_AT)) {
        const record = await conversation.compact(async (transcript) => {
          const prompt = `${transcript}\n\n---\n${SUMMARY_PROMPT}`;
          const why = overBudget(
            estimateTokens(SUMMARY_SYSTEM) + estimateTokens(prompt),
            SUMMARY_MAX_TOKENS
          );
          if (why) throw new Error(why);
          // A summary is asked of the next model too when this one is unavailable.
          for (;;) {
            const { result, info } = await ask('compaction', {
              system: SUMMARY_SYSTEM,
              messages: [{ role: 'user', content: prompt }],
              withTools: false,
              maxTokens: SUMMARY_MAX_TOKENS,
            });
            outbox.push({ type: 'model_call', call: info });
            if (result) return result.text;
            if (info.unavailable && !stopped() && moveOn(info)) continue;
            throw new Error(info.error ?? 'The summary call failed.');
          }
        });
        yield* flush();
        if (record) yield { type: 'context', action: 'compacted', ...record };
        if (conversation.estimate() > conversation.budget) {
          const trimmed = await conversation.trim({
            keepTokens: Math.floor(conversation.budget * 0.1),
          });
          if (trimmed) yield { type: 'context', action: 'compacted', ...trimmed };
        }
        if (conversation.estimate() > conversation.budget) {
          yield finish(
            false,
            `The task and its latest step do not fit in ${active.ref}'s context window (about ${conversation.estimate()} tokens for ${conversation.budget}).`
          );
          return;
        }
        const after = stopped();
        if (after) {
          yield after;
          return;
        }
      }

      const why = overBudget(conversation.estimate(), active.maxOutput);
      if (why) {
        yield finish(false, why);
        return;
      }

      totals.turns += 1;
      const { result, info } = await ask('turn', {
        system: conversation.system,
        messages: conversation.forRequest(),
        withTools: true,
        maxTokens: active.maxOutput,
      });
      outbox.push({ type: 'model_call', call: info });
      if (!result) {
        const over = stopped();
        // Another model takes the turn over, from the top of the loop: its window
        // may be smaller, so the conversation is checked against it first, and a
        // turn lost to an outage does not count against the turn limit.
        if (!over && info.unavailable && moveOn(info)) {
          yield* flush();
          totals.turns -= 1;
          continue;
        }
        yield* flush();
        yield over ?? finish(false, info.error ?? 'The model call failed.');
        return;
      }
      yield* flush();
      if (result.usageReported) conversation.recordUsage(result.usage.inputTokens);
      if (result.content.length > 0)
        conversation.append({ role: 'assistant', content: result.content });
      if (result.text.trim()) yield { type: 'text', text: result.text };

      if (input.maxBudgetUsd !== undefined && totals.spent >= input.maxBudgetUsd) {
        yield finish(
          false,
          `Stopped: the run's budget of $${input.maxBudgetUsd.toFixed(2)} is spent ($${totals.spent.toFixed(4)}).`
        );
        return;
      }
      if (result.stopReason === 'refusal') {
        yield finish(
          false,
          `The model declined to continue${result.text ? `: ${result.text}` : '.'}`
        );
        return;
      }

      if (result.toolCalls.length === 0) {
        if (result.stopReason === 'max_tokens') {
          cutOff += 1;
          if (cutOff >= MAX_CUT_OFF) {
            yield finish(
              false,
              `The model's replies kept stopping at the output limit (${active.maxOutput} tokens).`
            );
            return;
          }
          conversation.append({
            role: 'user',
            content:
              'Your reply stopped at the output limit before it was complete. Continue, in smaller steps.',
          });
          continue;
        }
        if (result.stopReason !== 'end_turn') {
          yield finish(
            false,
            `The model stopped without finishing (stop reason "${result.rawStopReason ?? result.stopReason}").`
          );
          return;
        }
        if (!result.text.trim()) {
          // Only reasoning, or nothing: there is no answer to report.
          yield finish(false, 'The model ended its turn without a final answer.');
          return;
        }
        yield finish(true, result.text.trim());
        return;
      }
      cutOff = 0;

      // Every call gets a result, in one user turn, in the order made.
      const results: ContentBlock[] = [];
      const cut = result.stopReason === 'max_tokens';
      for (const [i, tc] of result.toolCalls.entries()) {
        if (budget.stats.calls >= (rules.maxCallsPerRun ?? Infinity)) {
          yield finish(
            false,
            `Stopped: the run reached its limit of ${rules.maxCallsPerRun} tool calls.`
          );
          return;
        }
        // The last call of a reply cut off at the output limit may be incomplete.
        const outcome = yield* redacted(runTool(tc, cut && i === result.toolCalls.length - 1));
        results.push({
          type: 'tool_result',
          toolUseId: tc.id,
          content: outcome.output,
          isError: outcome.isError,
        });
        const halted = stopped();
        if (halted) {
          yield halted;
          return;
        }
      }
      conversation.append({ role: 'user', content: results });
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }

  function redactValue(value: unknown): unknown {
    return redactDeep(value, input.secrets);
  }

  /**
   * A tool's events and result with the run's secret values taken out, before
   * the model or the run's record sees them. Under full access a command runs
   * as the gateway's user and could print a secret it found.
   */
  async function* redacted(
    events: AsyncGenerator<DriverEvent, { output: string; isError: boolean }>
  ): AsyncGenerator<DriverEvent, { output: string; isError: boolean }> {
    for (;;) {
      const next = await events.next();
      if (next.done) return { ...next.value, output: redact(next.value.output, input.secrets) };
      const e = next.value;
      if (e.type === 'tool_call') yield { ...e, input: redactValue(e.input) };
      else if (e.type === 'tool_result') yield { ...e, output: redact(e.output, input.secrets) };
      else yield e;
    }
  }

  /** Run one tool call through policy, yielding its call and result events. */
  async function* runTool(
    tc: ToolCall,
    unfinished: boolean
  ): AsyncGenerator<DriverEvent, { output: string; isError: boolean }> {
    const tool = byModelName.get(tc.name);
    const descriptor: ToolDescriptor = !tool
      ? { name: tc.name, risk: 'execute' }
      : tool.name === 'runtime.shell'
        ? shellDescriptor(String((tc.input as { command?: unknown })?.command ?? ''))
        : { name: tool.name, risk: tool.risk };
    yield { type: 'tool_call', id: tc.id, name: descriptor.name, input: tc.input };

    let approval: 'not_required' | 'approved' | 'denied' = 'not_required';
    const onApproval = input.onApproval;
    const result = (output: string, isError: boolean, denied = false) => ({
      type: 'tool_result' as const,
      id: tc.id,
      output,
      isError,
      ...(denied ? { denied: true } : {}),
      approval,
    });

    if (!tool) {
      const out = `There is no tool "${tc.name}". Available: ${[...byModelName.keys()].join(', ')}.`;
      yield result(out, true);
      return { output: out, isError: true };
    }
    if (unfinished) {
      const out =
        `Your reply stopped at the output limit, so this ${tc.name} call may be incomplete. ` +
        'It was not run. Send it again, with less in it.';
      yield result(out, true);
      return { output: out, isError: true };
    }
    if (tc.inputError !== undefined) {
      const out =
        `The input for ${tc.name} was not a valid JSON object: ` +
        `${tc.inputError.slice(0, 500)}. Send the call again.`;
      yield result(out, true);
      return { output: out, isError: true };
    }

    try {
      const outcome = await guard(
        rules,
        descriptor,
        budget,
        () => tool.run((tc.input ?? {}) as Record<string, unknown>, ctx),
        // Without someone to ask, guard refuses the call as needing approval.
        onApproval &&
          (async (verdict) => {
            let stop: (() => void) | undefined;
            const ended = new Promise<boolean>((resolve) => {
              if (signal.aborted) return resolve(false);
              stop = () => resolve(false);
              signal.addEventListener('abort', stop, { once: true });
            });
            const decision = await Promise.race([
              onApproval({
                toolCallId: tc.id,
                tool: descriptor.name,
                risk: descriptor.risk,
                reason: verdict.reason,
                input: redactValue(tc.input),
                // The asker stops waiting when the agent does, and by its deadline.
                signal,
                deadline,
              }),
              ended,
            ]).finally(() => {
              if (stop) signal.removeEventListener('abort', stop);
            });
            approval = decision ? 'approved' : 'denied';
            return decision;
          })
      );
      yield result(outcome.output, outcome.isError);
      return outcome;
    } catch (e) {
      if (e instanceof PolicyViolation) {
        denials.push({ tool: descriptor.name, input: tc.input });
        const out = `Not permitted: ${e.message}`;
        yield result(out, true, true);
        return { output: out, isError: true };
      }
      const known = e instanceof ToolInputError || e instanceof PathContainmentError;
      const code = (e as NodeJS.ErrnoException)?.code;
      const target = String((tc.input as { path?: unknown })?.path ?? '');
      const out =
        code === 'ENOENT'
          ? `No such file or directory: ${target}`
          : code === 'ELOOP'
            ? `${target} became a symbolic link while it was being written; not followed.`
            : code === 'EEXIST'
              ? `${target} appeared while it was being created; not overwritten. Try again.`
              : `${known ? '' : `${tc.name} failed: `}${e instanceof Error ? e.message : String(e)}`;
      yield result(out, true);
      return { output: out, isError: true };
    }
  }
}

export { BUILTIN_TOOLS };
