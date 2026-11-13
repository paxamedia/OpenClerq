/**
 * Sub-agents of an automation run's builtin agent (`sessions.spawn`).
 *
 * A sub-agent is a run of its own, with a session for its transcript, linked
 * to the run whose agent started it (`parent_run_id`). It is recorded like any
 * builtin run (steps, tool calls, cost) and emits the usual run events, which
 * carry the parent's id. What it may do is cut from the parent's rules and can
 * never be wider: read-only unless the spawn call asks for more and the parent
 * has it, and never `sessions.spawn` (one level deep, enforced here and in the
 * policy, not by the prompt). It reads at most the memory the parent may read.
 *
 * Limits, all per parent run:
 *  - at most four sub-agents at once; a fifth waits for one to end
 *  - every sub-agent spends from what is left of the run's budget, shared with
 *    the parent (checked before each model call, with calls in flight held), and
 *    counts against the automation's month
 *  - the parent stopping (cancelled, out of time, kill switch) stops them
 *  - a call that needs approval waits in the same inbox, naming the parent run
 */

import {
  subagentPolicy,
  SUBAGENT_SYSTEM_PROMPT,
  type Driver,
  type DriverResult,
  type SandboxOptions,
  type SharedBudget,
  type SubagentOutcome,
  type SubagentRequest,
} from '@clerq/drivers';
import { SUBAGENT_MAX_CONCURRENT, SUBAGENT_MAX_DEPTH, type PolicyRules } from '@clerq/policy';
import type { Workspace } from '@clerq/workspaces';
import { getStore } from '../store.js';
import {
  addRunStep,
  createRun,
  currentRunSignal,
  executeRun,
  getRun,
  listToolCalls,
  RunCancelled,
} from '../runs.js';
import { addMessage, createSubagentSession } from '../chat/sessions.js';
import type { AutomationSpec } from './spec.js';
import { keyAppliesTo } from './model-chain.js';
import { monthSpendUsd, type Automation } from './store.js';
import {
  approveToolCall,
  hasBudget,
  readNotes,
  runAgent,
  type ModelInUse,
  type RunnerDeps,
} from './runner.js';

/**
 * One budget in US dollars spent by a run's agent and its sub-agents at once.
 * Each member's spend is what its own model calls cost; a call in flight holds
 * the most it may cost until its cost is known. Checks are synchronous, so two
 * agents cannot both take the last of it.
 */
export class SpendPool {
  private readonly spent = new Map<string, number>();
  private readonly held = new Map<string, number>();

  /** `capUsd`: what is left of the run's budget when the attempt starts; none for no budget. */
  constructor(readonly capUsd?: number) {}

  private sum(map: Map<string, number>, except?: string): number {
    let total = 0;
    for (const [k, v] of map) if (k !== except) total += v;
    return total;
  }

  /** Spent and held by everyone. */
  totalUsd(): number {
    return this.sum(this.spent) + this.sum(this.held);
  }

  /** What is left to start new work with, or undefined without a budget. */
  leftUsd(): number | undefined {
    return this.capUsd === undefined ? undefined : Math.max(0, this.capUsd - this.totalUsd());
  }

  /** The view of the pool one agent gets. */
  member(id: string): SharedBudget {
    return {
      othersUsd: () => this.sum(this.spent, id) + this.sum(this.held, id),
      hold: (usd) => {
        const amount = Math.max(0, usd);
        this.held.set(id, (this.held.get(id) ?? 0) + amount);
        let released = false;
        return (cost) => {
          if (released) return;
          released = true;
          this.held.set(id, Math.max(0, (this.held.get(id) ?? 0) - amount));
          this.spent.set(id, (this.spent.get(id) ?? 0) + Math.max(0, cost));
        };
      },
    };
  }
}

/** A count of places, taken in turn. */
class Slots {
  private used = 0;
  private readonly queue: Array<() => void> = [];
  most = 0;

  constructor(private readonly size: number) {}

  /** Wait for a place; rejects when `signal` aborts first. */
  async take(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new RunCancelled('The run stopped before the sub-agent started.');
    if (this.used < this.size) {
      this.used += 1;
      this.most = Math.max(this.most, this.used);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(go);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new RunCancelled('The run stopped before the sub-agent started.'));
      };
      const go = () => {
        signal.removeEventListener('abort', onAbort);
        // The place is handed over by give(): `used` stays as it is.
        this.most = Math.max(this.most, this.used);
        resolve();
      };
      this.queue.push(go);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  give(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.used -= 1;
  }
}

/**
 * Why `runId` may not start a sub-agent, or undefined when it may. A
 * sub-agent's own run never can: agents nest one level deep.
 */
export function spawnRefusal(runId: string): string | undefined {
  // How deep `runId` is: 0 for a run nothing started, 1 for a sub-agent's.
  let depth = 0;
  let id: string | null = runId;
  for (;;) {
    const row = getStore().prepare('SELECT parent_run_id FROM runs WHERE id = ?').get(id);
    if (!row) {
      if (depth === 0) return `There is no run ${runId}.`;
      break;
    }
    if (!row.parent_run_id || depth > SUBAGENT_MAX_DEPTH) break;
    depth += 1;
    id = String(row.parent_run_id);
  }
  if (depth >= SUBAGENT_MAX_DEPTH) {
    return 'A sub-agent cannot start sub-agents of its own: sub-agents are one level deep.';
  }
  return undefined;
}

export interface SpawnerContext {
  parentRunId: string;
  automation: Automation;
  spec: AutomationSpec;
  /** The builtin driver the parent runs on. */
  driver: Driver;
  ws: Workspace;
  /** The run's isolation, which a sub-agent's commands run under as well. */
  sandbox?: SandboxOptions;
  deps: RunnerDeps;
  pool: SpendPool;
  /** The model key from the vault, as the parent has it. */
  apiKey?: Record<string, string>;
  /** Vault values the parent uses, taken out of everything stored. */
  inUse: Record<string, string>;
  /** The rules the parent's memory is read under; a sub-agent reads no more. */
  memoryRules: PolicyRules;
  /** The model a sub-agent that names none starts on, and its fallbacks. */
  inherited: () => { model?: string; fallbackModels: string[] };
  /** Models found unavailable in the parent's run, shared both ways. */
  unavailable: Set<string>;
  /** Sub-agents at once (`agent.subagents.max_concurrent`, at most 4). */
  maxConcurrent?: number;
  /** The models a spawn call may name; anything else is refused. */
  allowedModels: readonly string[];
}

/** How long after the parent's deadline a sub-agent's own time limit runs out. */
const BACKSTOP_MS = 5_000;

/** Characters of a sub-agent's task used as its session's title. */
const TITLE_CHARS = 80;

function title(task: string): string {
  const line = task.trim().split('\n')[0]?.trim() ?? '';
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line || 'Sub-agent';
}

/** A line on what a sub-agent did, for the parent to read beside its answer. */
function traceOf(
  runId: string,
  result: DriverResult | undefined,
  run: ReturnType<typeof getRun>
): string {
  const calls = listToolCalls(runId);
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const tools =
    calls.length === 0
      ? 'no tool calls'
      : `${calls.length} tool call${calls.length === 1 ? '' : 's'} (${[...counts]
          .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
          .join(', ')})`;
  const turns = result?.turns;
  const cost = !run ? 'cost unknown' : `$${run.costUsd.toFixed(4)}${run.costKnown ? '' : '+'}`;
  return [
    `Sub-agent run ${runId}`,
    `${run?.status ?? 'unknown'}`,
    tools,
    ...(turns !== undefined ? [`${turns} model turn${turns === 1 ? '' : 's'}`] : []),
    cost,
  ].join(' · ');
}

/**
 * The handler a parent run's builtin agent calls for `sessions.spawn`: starts
 * the sub-agent as a run of its own and resolves with its answer. Throws (the
 * parent sees a failed tool call) when it cannot start one.
 */
export function subagentSpawner(
  ctx: SpawnerContext
): (request: SubagentRequest) => Promise<SubagentOutcome> {
  const slots = new Slots(
    Math.min(SUBAGENT_MAX_CONCURRENT, Math.max(1, ctx.maxConcurrent ?? SUBAGENT_MAX_CONCURRENT))
  );

  return async (request) => {
    const refusal = spawnRefusal(ctx.parentRunId);
    if (refusal) throw new Error(refusal);

    // A fifth sub-agent waits for one of the four to end (or the parent to stop).
    await slots.take(request.signal);
    try {
      return await start(request);
    } finally {
      slots.give();
    }
  };

  async function start(request: SubagentRequest): Promise<SubagentOutcome> {
    const { spec, automation, pool } = ctx;

    // Budgets: the automation's month, and what is left of this run's.
    const monthCap = spec.budget.maxUsdPerMonth;
    if (monthCap !== undefined) {
      const spent = monthSpendUsd(automation.id);
      if (spent >= monthCap) {
        throw new Error(
          `No sub-agent started: the monthly budget of $${monthCap} is spent ($${spent.toFixed(2)}).`
        );
      }
    }
    const left = pool.leftUsd();
    if (left !== undefined && left <= 0) {
      throw new Error(
        `No sub-agent started: the run's budget is spent ($${pool.totalUsd().toFixed(4)} of $${(pool.capUsd as number).toFixed(2)}).`
      );
    }

    // The model: one the spawn call names is used as named (no fallback); with
    // none, the parent's, which may fall back along the parent's chain.
    let model: string | undefined;
    let fallbackModels: string[] = [];
    const strict = Boolean(request.model);
    if (request.model) {
      model = request.model;
      if (!ctx.allowedModels.includes(model)) {
        throw new Error(
          `No sub-agent started: ${model} is not one of the models this automation may use ` +
            `(${ctx.allowedModels.join(', ') || 'none'}). Name one of them, or none to use this run's model; ` +
            'the spec can list more in agent.subagents.models.'
        );
      }
      const availability = await ctx.driver.detect({
        model,
        budget: hasBudget(spec),
        apiKey: Boolean(ctx.apiKey) && keyAppliesTo(spec, model),
      });
      if (!availability.available) {
        throw new Error(
          `No sub-agent started: ${model} cannot be used. ${availability.reason ?? ''}`.trim()
        );
      }
    } else {
      ({ model, fallbackModels } = ctx.inherited());
    }

    // What it may do: the parent's rules cut down to what it asks for.
    const rules = subagentPolicy(request.parentRules, request.tools);

    const parentRow = getStore()
      .prepare('SELECT repo_id, session_id FROM runs WHERE id = ?')
      .get(ctx.parentRunId);
    const sessionId = createSubagentSession({
      title: title(request.task),
      model,
      parentRunId: ctx.parentRunId,
      ...(parentRow?.session_id ? { parentSessionId: String(parentRow.session_id) } : {}),
    });
    addMessage(sessionId, { role: 'user', content: request.task });
    const runId = createRun({
      trigger: 'subagent',
      parentRunId: ctx.parentRunId,
      sessionId,
      input: request.task,
      ...(parentRow?.repo_id ? { repoId: String(parentRow.repo_id) } : {}),
    });

    let result: DriverResult | undefined;
    let failure: string | undefined;
    try {
      result = await executeRun(
        runId,
        {
          trigger: 'subagent',
          parentRunId: ctx.parentRunId,
          sessionId,
          // The parent stopping, for whatever reason, stops the sub-agent.
          signal: request.signal,
          cancelReason: 'The run that started this sub-agent stopped.',
        },
        async () => {
          const signal = currentRunSignal() as AbortSignal;
          addRunStep(runId, {
            kind: 'tool',
            input: {
              name: 'subagent.start',
              parentRunId: ctx.parentRunId,
              toolCallId: request.toolCallId,
              tools: request.tools ?? 'read-only',
              model: model ?? null,
              strict,
            },
            output: {
              allow: rules.allow,
              approvalRequired: rules.approvalRequired,
              deny: rules.deny,
              ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
            },
            status: 'ok',
          });
          const notes = readNotes(runId, spec, ctx.memoryRules, request.task);
          const used: ModelInUse = { model, unavailable: ctx.unavailable };
          return runAgent(
            ctx.driver,
            spec,
            {
              model,
              prompt: notes ? `${request.task}\n\n${notes}` : request.task,
              maxBudgetUsd: pool.capUsd,
              ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
            },
            ctx.ws,
            runId,
            signal,
            ctx.deps,
            model && keyAppliesTo(spec, model) ? ctx.apiKey : undefined,
            undefined,
            ctx.inUse,
            used,
            {
              ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
              policy: rules,
              system: SUBAGENT_SYSTEM_PROMPT,
              sharedBudget: pool.member(runId),
              // The parent's deadline stops it (through the parent's signal, as
              // cancelled); its own limit, a little later, is only a backstop, so
              // the two timers do not race.
              timeoutMs: Math.max(1_000, request.deadline - Date.now()) + BACKSTOP_MS,
              approve: (r) => approveToolCall(r, spec, runId, signal, ctx.parentRunId),
              // No onSubagent: a sub-agent cannot start its own.
            }
          );
        }
      );
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }

    const run = getRun(runId);
    const ok = Boolean(result?.ok) && run?.status === 'done';
    const answer = ok
      ? (result as DriverResult).summary
      : (failure ?? run?.exitReason ?? 'The sub-agent stopped without an answer.');
    addMessage(sessionId, {
      role: 'assistant',
      content: answer,
      meta: { runId, ok, ...(model ? { model } : {}) },
    });
    return {
      ok,
      answer,
      trace: traceOf(runId, result, run),
      runId,
      sessionId,
      costUsd: run && run.costKnown ? run.costUsd : null,
    };
  }
}
