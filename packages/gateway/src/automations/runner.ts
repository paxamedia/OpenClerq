/**
 * Running an automation: worktree → agent → commit → gates → push → draft PR.
 *
 * Each stage is a state of the run, written before the stage starts. Each
 * action the run takes on the user's behalf — running the agent, a gate,
 * committing, pushing, opening the pull request — is decided by the policy
 * engine first, and pushing waits for a human unless the spec says otherwise.
 * An automation's first push always waits, whatever its spec says.
 */

import {
  DRIVER_CAPABILITIES,
  builtin,
  getDriver,
  redactDeep,
  type Driver,
  type DriverEvent,
  type DriverResult,
  type DriverRunInput,
  type ToolApprovalRequest,
} from '@clerq/drivers';
import {
  guard,
  memoryReadRules,
  RunBudget,
  PolicyViolation,
  type PolicyRules,
  type ToolDescriptor,
} from '@clerq/policy';
import { exec } from '@clerq/sandbox';
import {
  defaultBranch,
  git,
  openWorkspace,
  openPullRequest,
  renderBranchName,
  type Fetcher,
  type Workspace,
} from '@clerq/workspaces';
import { getStore } from '../store.js';
import {
  executeRun,
  recordModelCall,
  currentRunId,
  currentRunSignal,
  setRunStatus,
  setRunStatusIf,
  setRunFields,
  addRunStep,
  completeRunStep,
  addArtifact,
  addToolCall,
  completeToolCall,
  getRun,
  RunCancelled,
} from '../runs.js';
import { requestApproval, waitForDecision, decide, tierFor } from '../approvals.js';
import { agentRegistry } from '../agent/llm-provider.js';
import { emit } from '../events.js';
import { logger } from '../logger.js';
import { watchProcess } from '../agent-processes.js';
import { isAssertion, type AutomationSpec, type GateSpec } from './spec.js';
import { diffFiles, evaluateAssertion, type DiffFile } from './diff-assert.js';
import { retryPlan, transientCause, TransientFailure } from './retry.js';
import { checkModels, isSpecFault, judgeChain, keyAppliesTo, planModels } from './model-chain.js';
import { recordFallback } from '../routing.js';
import { memoryBlock } from '../memory-context.js';
import {
  ensureLocalRepo,
  expandHome,
  getAutomation,
  hasPushedBefore,
  monthSpendUsd,
  setAutomationEnabled,
  type Automation,
} from './store.js';

export interface RunnerDeps {
  /** A secret from the vault, by name. */
  getSecret(name: string): string | undefined;
  /** The PATH for the agent and gates. */
  path(): string;
  driverFor?(id: string): Driver;
  /** For opening pull requests; tests pass a fake. */
  fetcher?: Fetcher;
  /** Where worktrees live. Defaults to ~/.clerq/workspaces. */
  workspaceCacheDir?: string;
  /** Automation runs allowed at once, across all automations. Default 2. */
  maxConcurrent?: number;
  /** How long a run's lease lasts before it must be renewed. Default 60s; tests shorten it. */
  leaseMs?: number;
}

export class AutomationBusy extends Error {
  readonly code = 'busy';
  constructor(message: string) {
    super(message);
    this.name = 'AutomationBusy';
  }
}

const TOOLS = {
  agent: { name: 'runtime.agent', risk: 'execute' },
  gate: { name: 'runtime.gate', risk: 'execute' },
  commit: { name: 'git.commit', risk: 'write' },
  push: { name: 'git.push', risk: 'external' },
  pullRequest: { name: 'forge.pull_request', risk: 'external' },
} satisfies Record<string, ToolDescriptor>;

/**
 * The driver for an id. The builtin agent resolves models in the gateway's
 * registry, with the same endpoint override a chat call gets.
 */
export function defaultDriver(id: string): Driver {
  if (id === 'builtin') {
    return builtin({
      registry: () => agentRegistry().registry,
      keyOptional: (providerId) => agentRegistry().keyOptional(providerId),
    });
  }
  return getDriver(id);
}

/** True when the spec sets a budget in US dollars. */
export function hasBudget(spec: AutomationSpec): boolean {
  return spec.budget.maxUsdPerRun !== undefined || spec.budget.maxUsdPerMonth !== undefined;
}

/** What this run may do, from its spec. Anything else is denied. */
export function policyFor(spec: AutomationSpec, firstPush: boolean): PolicyRules {
  const allow = [TOOLS.agent.name, TOOLS.gate.name, TOOLS.commit.name];
  // The types of memory the spec lets the run read: memory.read.<type>, decided
  // by the same rules as everything else the run does.
  allow.push(...(memoryReadRules(spec.memory.read).allow ?? []));
  if (spec.publish.push) allow.push(TOOLS.push.name);
  if (spec.publish.pullRequest === 'draft') allow.push(TOOLS.pullRequest.name);
  const manual = spec.approvals.push === 'manual' || firstPush;
  const commands = spec.gates.filter((g) => !isAssertion(g)).length;
  return {
    allow,
    approvalRequired: manual ? [TOOLS.push.name] : [],
    // The most actions a run consists of: for each attempt of the agent (one,
    // plus one per escalation) the agent (again for each fallback model a CLI
    // is started with), a commit and the gate commands; then the push and the PR.
    maxCallsPerRun:
      (spec.agent.escalate.length + 1) * (spec.agent.fallback.length + 1 + commands + 1) + 2,
  };
}

/** "owner/repo" for a GitHub remote URL, or null. */
export function githubProject(url: string | null): string | null {
  if (!url) return null;
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

function tail(text: string, max: number): string {
  return text.length > max ? `[…]${text.slice(-max)}` : text;
}

function firstLine(text: string, max = 72): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A gate did not pass: a command failed, or an assertion about the diff. */
export class GateFailed extends Error {
  constructor(
    message: string,
    /** The gate, as the spec has it. */
    readonly gate: string,
    /** What it printed or found, for the next model to read. */
    readonly output: string
  ) {
    super(message);
    this.name = 'GateFailed';
  }
}

/** The attempt a run is on, from 1. */
function attemptOf(runId: string): number {
  const row = getStore().prepare('SELECT attempt FROM runs WHERE id = ?').get(runId);
  return Number(row?.attempt ?? 1);
}

/** What the run has cost so far, across its attempts. */
function runCostUsd(runId: string): number {
  const row = getStore().prepare('SELECT cost_usd FROM runs WHERE id = ?').get(runId);
  return Number(row?.cost_usd ?? 0);
}

/**
 * Work on a run a gateway has leased (queue.ts), to its end. A failure worth
 * retrying (retry.ts) puts the run back in the queue when the spec allows,
 * after its backoff; anything else ends it. Resolves either way.
 */
export function runLeased(runId: string, automation: Automation, deps: RunnerDeps): Promise<void> {
  const spec = automation.spec as AutomationSpec;
  const trigger = getStore().prepare('SELECT trigger FROM runs WHERE id = ?').get(runId)?.trigger;
  return executeRun(
    runId,
    {
      trigger: trigger === 'manual' ? 'manual' : 'schedule',
      automationId: automation.id,
      retry: (e) => {
        if (!(e instanceof TransientFailure)) return null;
        const attempt = attemptOf(runId);
        const plan = retryPlan(spec, attempt);
        if (!plan) return null;
        // Switched off since it started (or run by hand while off): it ends here.
        if (!getAutomation(automation.id)?.enabled) {
          return { failure: `${e.message} Not retried: the automation is switched off.` };
        }
        addRunStep(runId, {
          kind: 'tool',
          input: { name: 'run.retry', attempt: attempt + 1 },
          output: { after: e.message, cause: e.kind, notBefore: plan.notBefore.toISOString() },
          status: 'warning',
        });
        return {
          notBefore: plan.notBefore,
          reason: `Retry ${plan.retry} of ${plan.of} after: ${e.message}`,
        };
      },
    },
    async () => {
      // Written before the stage starts, like every state after it.
      setRunStatus(runId, 'preparing');
      await execute(automation, spec, deps);
    }
  )
    .catch((e: unknown) => {
      // Recorded on the run already; a scheduled run has nobody else to tell.
      logger.info('Automation run ended without publishing', {
        automation: automation.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => enforceMonthlyBudget(automation, spec));
}

/** Pause an automation whose runs have used up its monthly budget. */
function enforceMonthlyBudget(automation: Automation, spec: AutomationSpec): void {
  const cap = spec.budget.maxUsdPerMonth;
  if (cap === undefined) return;
  try {
    const spent = monthSpendUsd(automation.id);
    if (spent < cap) return;
    setAutomationEnabled(automation.id, false, 'budget', `Monthly budget of $${cap} reached`);
    emit('budget.exceeded', { automationId: automation.id, spentUsd: spent, capUsd: cap });
    logger.warn('Automation paused: monthly budget reached', {
      automation: automation.name,
      spent,
      cap,
    });
  } catch (e) {
    logger.warn('Could not check the monthly budget', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

async function execute(
  automation: Automation,
  spec: AutomationSpec,
  deps: RunnerDeps
): Promise<void> {
  const runId = currentRunId() as string;
  const signal = currentRunSignal() as AbortSignal;

  checkBudgets(automation, spec, runId);

  const firstPush = spec.publish.push && !hasPushedBefore(automation.id);
  const rules = policyFor(spec, firstPush);
  const budget = new RunBudget(rules);
  // Saved notes the spec lets this run read, found once against the task and added to
  // the prompt of every attempt. Read under the run's own policy.
  const notes = readNotes(runId, spec, rules);

  const driver = (deps.driverFor ?? defaultDriver)(spec.agent.driver);
  // The models of this run: the spec's, or the one a person named for it (which
  // is used as chosen, never replaced by a fallback).
  const chosen = modelChosenFor(runId);
  const plan = planModels(spec, chosen);
  // Every model is checked before the run does any work, so it does not spend
  // on the first model and then find it cannot go on. A key from the vault
  // stands in for the CLI's own sign-in, so it is not checked.
  const checks = await checkModels(driver, spec, plan, hasBudget(spec), (check) =>
    addRunStep(runId, {
      kind: 'tool',
      input: {
        name: 'driver.detect',
        driver: driver.id,
        ...(check.role === 'primary' && !chosen
          ? {}
          : { model: check.model, for: check.role === 'primary' ? 'chosen' : check.role }),
      },
      output: check.availability,
      // A fallback model that cannot be used now is skipped when its turn comes.
      status: check.availability.available
        ? 'ok'
        : check.role === 'fallback' && !isSpecFault(check.availability)
          ? 'warning'
          : 'error',
    })
  );
  const verdict = judgeChain(plan, checks);
  if (verdict.errors.length > 0) throw new Error(verdict.errors[0]);
  const unavailable = new Set<string>();
  if (verdict.movedOff) {
    // The primary cannot be used (no key, say): the run starts with a fallback.
    const { from, to, reason } = verdict.movedOff;
    if (from) unavailable.add(from);
    recordFallback({ from, to, reason, scope: 'automation' }, { runId });
  }

  let apiKey: Record<string, string> | undefined;
  if (spec.agent.apiKeySecret) {
    const value = deps.getSecret(spec.agent.apiKeySecret);
    if (!value) throw new Error(`The secret ${spec.agent.apiKeySecret} is not in the vault.`);
    apiKey = { [DRIVER_CAPABILITIES[spec.agent.driver].apiKeyEnv]: value };
  }

  // Checked before any work, so a run does not spend money and then fail to publish.
  const repoPath = expandHome(spec.repo.path);
  const token = spec.publish.push ? deps.getSecret(spec.publish.tokenSecret) : undefined;
  if (spec.publish.pullRequest === 'draft' && !token) {
    throw new Error(
      `Opening a pull request needs a forge token: store one in the vault as ${spec.publish.tokenSecret}, or set publish.pull_request: none.`
    );
  }
  // The URL as configured: `git remote get-url` would apply url.insteadOf
  // rewrites, and a rewritten URL no longer names the GitHub project.
  const origin = await git(['config', '--get', 'remote.origin.url'], {
    cwd: repoPath,
    allowFailure: true,
  });
  const remoteUrl = origin.code === 0 ? origin.stdout.trim() : null;
  const project = githubProject(remoteUrl);
  if (spec.publish.pullRequest === 'draft' && !project) {
    throw new Error(
      `The repository's origin (${remoteUrl ?? 'none'}) is not on GitHub, so no pull request can be opened. Set publish.pull_request: none.`
    );
  }
  if (spec.publish.push && !remoteUrl) {
    throw new Error('The repository has no origin remote to push to. Set publish.push: false.');
  }

  setRunFields(runId, { repoId: ensureLocalRepo(spec.repo.path) });

  // Start from the remote's copy of the base branch: a local branch the user
  // has not pulled in weeks would give the agent stale code and the PR conflicts.
  const baseBranch = spec.repo.ref ?? (await defaultBranch(repoPath));
  let startRef = baseBranch;
  if (remoteUrl) {
    const fetched = await git(
      ['fetch', '--quiet', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      {
        cwd: repoPath,
        allowFailure: true,
        timeoutMs: 120_000,
        env: project && token ? githubAuthEnv(token) : undefined,
      }
    );
    if (fetched.code === 0) startRef = `origin/${baseBranch}`;
    addRunStep(runId, {
      kind: 'git',
      input: { action: 'fetch', ref: baseBranch },
      output:
        fetched.code === 0
          ? { startRef }
          : {
              startRef,
              error: tail(fetched.stderr.trim(), 2_000),
              note: 'Starting from the local branch.',
            },
      status: fetched.code === 0 ? 'ok' : 'warning',
    });
  }

  const branch = renderBranchName(spec.publish.branch, {
    automation: spec.name,
    run: runId.slice(4, 12),
  });
  const ws = await openWorkspace(
    { kind: 'local', location: repoPath, ref: startRef },
    { branch, cacheDir: deps.workspaceCacheDir }
  );
  let keepBranch = false;
  try {
    setRunFields(runId, { branch });
    addRunStep(runId, {
      kind: 'git',
      input: { action: 'worktree', repo: repoPath, ref: startRef },
      output: { branch, baseSha: ws.baseSha, remote: remoteUrl, path: ws.path },
      status: 'ok',
    });

    // The agent, then the gates; when they fail and the spec lists models to
    // escalate to, the agent again with the next one, in the same worktree.
    // When the model in use is unavailable the agent moves to the next fallback
    // model: the builtin agent in the middle of its run, a CLI by starting
    // again with the next model.
    const models: Array<string | undefined> = [verdict.start, ...plan.escalate];
    const inUse = { ...apiKey, ...(token ? { FORGE_TOKEN: token } : {}) };
    const switchesModels = DRIVER_CAPABILITIES[spec.agent.driver].midRunModelSwitch;
    // The models whose attempt ended at the gates: not used as a fallback later.
    const tried = new Set<string>();
    const used: { model?: string } = {};
    let level = 0;
    let prompt = spec.prompt;
    let result: DriverResult;
    let title: string;
    let stat: Awaited<ReturnType<Workspace['diffStat']>>;
    for (;;) {
      const candidates = fallbackCandidates(models[level], plan.fallback, tried, unavailable);
      let at = 0;
      let attemptPrompt = prompt;
      for (;;) {
        const maxBudgetUsd = checkBudgets(automation, spec, runId);
        setRunStatus(runId, 'executing');
        // The agent leads its own process group, so it would outlive a gateway that
        // crashes. Recording it lets the next gateway find it and stop it.
        const agentProcess = watchProcess(runId, 'agent');
        const model = candidates[at];
        used.model = model;
        const after = candidates.slice(at + 1).filter((m): m is string => m !== undefined);
        const attempt = {
          model,
          prompt: notes ? `${attemptPrompt}\n\n${notes}` : attemptPrompt,
          maxBudgetUsd,
          ...(switchesModels && after.length > 0 ? { fallbackModels: after } : {}),
        };
        // A key from the vault is for the provider of the model it was given for.
        const secrets = keyAppliesTo(spec, model) ? apiKey : undefined;
        try {
          result = await guard(rules, TOOLS.agent, budget, () =>
            runAgent(
              driver,
              spec,
              attempt,
              ws,
              runId,
              signal,
              deps,
              secrets,
              agentProcess.onSpawn,
              inUse,
              used
            ).finally(agentProcess.done)
          );
          break;
        } catch (e) {
          // Only the model being unavailable moves a CLI run on to the next
          // model; the builtin agent moves itself, and has run out by now.
          const next = candidates[at + 1];
          if (
            switchesModels ||
            at + 1 >= candidates.length ||
            !(e instanceof TransientFailure) ||
            e.kind !== 'provider_unavailable' ||
            signal.aborted
          ) {
            throw e;
          }
          if (model) unavailable.add(model);
          recordFallback(
            { from: model, to: next as string, reason: e.message, scope: 'automation' },
            { runId }
          );
          at += 1;
          // What the interrupted attempt got done is in the worktree for the next to build on.
          attemptPrompt = (await ws.hasChanges()) ? interruptedPrompt(prompt) : prompt;
        }
      }

      // One commit for the run: an escalated attempt's changes join the earlier
      // ones. Measured against the base, an attempt may also have undone them.
      if (level > 0) await git(['reset', '--soft', ws.baseSha], { cwd: ws.path });
      if (!(await ws.hasChanges())) {
        setRunFields(runId, { exitReason: 'No changes: the agent left the repository as it was.' });
        return;
      }

      title = `${spec.name}: ${firstLine(result.summary) || 'automated changes'}`;
      const sha = await guard(rules, TOOLS.commit, budget, () =>
        ws.commitAll(title, { trailer: `Generated-by: OpenClerq\nOpenClerq-Run: ${runId}` })
      );
      stat = await ws.diffStat();
      addRunStep(runId, {
        kind: 'git',
        input: { action: 'commit' },
        output: { sha, ...stat },
        status: 'ok',
      });
      addArtifact(runId, 'diff', await ws.diff(), `${branch}.diff`);

      try {
        await verify(spec, ws, runId, signal, deps, rules, budget);
        break;
      } catch (e) {
        if (!(e instanceof GateFailed) || level + 1 >= models.length) throw e;
        // The model that did this attempt's work is the one that failed the gates.
        const from = used.model ?? models[level];
        if (from) tried.add(from);
        level += 1;
        addRunStep(runId, {
          kind: 'tool',
          input: { name: 'agent.escalate', escalation: level, model: models[level] },
          output: { from: from ?? 'default', after: e.message },
          status: 'warning',
        });
        emit(
          'model.escalated',
          { from: from ?? null, to: models[level], reason: e.message },
          { runId }
        );
        // Back to the agent's commit: whatever the gates wrote is not its work.
        await git(['reset', '--hard', 'HEAD'], { cwd: ws.path });
        await git(['clean', '-fd'], { cwd: ws.path });
        prompt = escalationPrompt(spec.prompt, e);
      }
    }

    if (!spec.publish.push) {
      keepBranch = true;
      setRunFields(runId, { exitReason: `Committed to the local branch ${branch}; not pushed.` });
      return;
    }

    setRunStatus(runId, 'publishing');
    const describe = `${branch} (${stat.filesChanged} files, +${stat.insertions} −${stat.deletions})`;
    try {
      await guard(
        rules,
        TOOLS.push,
        budget,
        () => pushBranch(ws, branch, project, token),
        async (verdict) => {
          setRunStatus(runId, 'awaiting_approval');
          const request = requestApproval({
            runId,
            tool: TOOLS.push.name,
            tier: 'high',
            reason:
              `Push ${describe} to ${remoteUrl}` +
              (spec.publish.pullRequest === 'draft' ? ' and open a draft pull request.' : '.') +
              (firstPush && spec.approvals.push === 'auto'
                ? " This automation's first push waits for approval."
                : ''),
            arguments: { automation: spec.name, branch, verdict: verdict.reason, ...stat },
          });
          const approved = await Promise.race([
            waitForDecision(request.id, spec.approvals.timeoutMs),
            new Promise<boolean>((resolve) => {
              if (signal.aborted) resolve(false);
              else signal.addEventListener('abort', () => resolve(false), { once: true });
            }),
          ]);
          if (approved) {
            setRunStatus(runId, 'publishing');
          } else {
            // Settle it, so a request nobody answered does not linger in the inbox.
            decide(request.id, {
              decision: 'denied',
              decidedBy: signal.aborted ? 'cancelled' : 'timeout',
            });
          }
          return approved;
        }
      );
    } catch (e) {
      if (e instanceof PolicyViolation && !signal.aborted) {
        throw new RunCancelled('The push was not approved.');
      }
      throw e;
    }
    addRunStep(runId, {
      kind: 'git',
      input: { action: 'push', branch },
      output: { remote: remoteUrl },
      status: 'ok',
    });

    let prUrl: string | undefined;
    if (spec.publish.pullRequest === 'draft') {
      const pr = await guard(rules, TOOLS.pullRequest, budget, () =>
        openPullRequest(
          {
            forge: 'github',
            project: project as string,
            title,
            body: pullRequestBody(spec, runId, result, stat, {
              escalatedTo: level > 0 ? models[level] : undefined,
              usedModel: used.model !== models[level] ? used.model : undefined,
            }),
            head: branch,
            base: baseBranch,
            draft: true,
            token: token as string,
          },
          deps.fetcher
        )
      );
      prUrl = pr.url;
      addRunStep(runId, {
        kind: 'git',
        input: { action: 'pull_request' },
        output: pr,
        status: 'ok',
      });
    }
    setRunFields(runId, { prUrl, exitReason: `Published: ${prUrl ?? branch}` });
  } finally {
    await ws.dispose();
    if (!keepBranch) {
      // Pushed, or not worth keeping: the diff is stored with the run either way.
      await git(['branch', '-D', branch], { cwd: ws.repoRoot, allowFailure: true });
    }
  }
}

async function runAgent(
  driver: Driver,
  spec: AutomationSpec,
  attempt: { model?: string; prompt: string; maxBudgetUsd?: number; fallbackModels?: string[] },
  ws: Workspace,
  runId: string,
  signal: AbortSignal,
  deps: RunnerDeps,
  secrets: Record<string, string> | undefined,
  onSpawn: DriverRunInput['onSpawn'],
  /** Vault values this run uses, taken out of everything it stores. */
  inUse: Record<string, string>,
  /** The model doing the work, kept current as the driver moves between models. */
  used: { model?: string }
): Promise<DriverResult> {
  const pending = new Map<string, { seq: number; row: number; started: number }>();
  const log: string[] = [];
  let model: string | undefined;
  let result: DriverResult | undefined;
  // A driver that reports its model calls one by one has them recorded as they
  // happen; for one that does not, its own total is recorded at the end.
  let modelCalls = 0;
  let lastModelError: string | undefined;

  for await (const raw of driver.run({
    prompt: attempt.prompt,
    cwd: ws.path,
    model: attempt.model,
    ...(attempt.fallbackModels?.length ? { fallbackModels: attempt.fallbackModels } : {}),
    permissionMode: spec.agent.permissionMode,
    allowedTools: spec.agent.allowedTools,
    maxBudgetUsd: attempt.maxBudgetUsd,
    timeoutMs: spec.sandbox.timeoutMs,
    sandbox: { profile: spec.sandbox.profile },
    env: { PATH: deps.path() },
    secrets,
    signal,
    onSpawn,
    // A command the builtin agent ran is a shell, like a gate.
    onToolProcess: (spawned) => {
      const watch = watchProcess(runId, 'gate');
      watch.onSpawn(spawned);
      return watch.done;
    },
    onApproval: (request) => approveToolCall(request, spec, runId, signal),
  })) {
    const event = scrub(raw, inUse);
    switch (event.type) {
      case 'started':
        model = event.model;
        emit('agent.turn.started', { driver: driver.id, model }, { runId });
        break;
      case 'text':
        // Narration, not a model call: status "text" keeps it out of cost accounting.
        addRunStep(runId, { kind: 'llm', output: { text: event.text }, status: 'text' });
        break;
      case 'tool_call': {
        const seq = addRunStep(runId, {
          kind: 'tool',
          input: { name: event.name, input: event.input },
          status: 'running',
        });
        const row = addToolCall(runId, {
          stepSeq: seq,
          callId: event.id,
          name: event.name,
          input: event.input,
        });
        pending.set(event.id, { seq, row, started: Date.now() });
        emit('tool.started', { name: event.name }, { runId, toolCallId: event.id });
        break;
      }
      case 'tool_result': {
        const call = pending.get(event.id);
        if (call) {
          const status = event.denied ? 'denied' : event.isError ? 'error' : 'ok';
          const durationMs = Date.now() - call.started;
          const output = tail(event.output, 16_000);
          completeRunStep(runId, call.seq, { output: { text: output }, status, durationMs });
          completeToolCall(call.row, { output, status, durationMs, approval: event.approval });
          pending.delete(event.id);
        }
        emit(event.isError ? 'tool.failed' : 'tool.completed', {}, { runId, toolCallId: event.id });
        break;
      }
      case 'log':
        log.push(`[${event.stream}] ${event.line}`);
        if (log.length > 500) log.shift();
        break;
      case 'model_call': {
        modelCalls += 1;
        const c = event.call;
        lastModelError = c.ok ? undefined : c.error;
        recordModelCall({
          provider: c.provider,
          model: c.model,
          prompt:
            c.purpose === 'turn'
              ? `Agent turn ${c.turn}`
              : `Summary of earlier context, before turn ${c.turn + 1}`,
          status: c.ok ? 'ok' : 'error',
          text:
            c.text ||
            (c.toolCalls ? `${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'}` : ''),
          error: c.error,
          tokensIn: c.tokensIn,
          tokensOut: c.tokensOut,
          costUsd: c.costUsd,
          latencyMs: c.latencyMs,
        });
        break;
      }
      case 'model_fallback':
        // The call that failed is the model_call before this; here the move.
        used.model = event.to;
        recordFallback(
          {
            from: event.from,
            to: event.to,
            reason: event.reason,
            scope: 'automation',
            skipped: event.skipped,
          },
          { runId }
        );
        break;
      case 'context': {
        const { type: _type, action: _action, ...record } = event;
        addRunStep(runId, {
          kind: 'tool',
          input: { name: 'context.compact', method: event.method },
          output: record,
          status: event.method === 'summary' ? 'ok' : 'warning',
        });
        break;
      }
      case 'finished':
        result = event.result;
        break;
    }
  }
  if (!result) {
    // Nothing was reported, but the attempt may still have spent: say so on
    // the run, whose cost then reads as a lower bound.
    if (modelCalls === 0)
      recordModelCall({
        provider: driver.id,
        model: model ?? attempt.model ?? 'default',
        prompt: attempt.prompt,
        status: 'unaccounted',
        error: `${driver.id} ended without reporting a result.`,
        costUsd: null,
        latencyMs: 0,
      });
    throw new TransientFailure(`${driver.id} ended without reporting a result.`, 'driver_crash');
  }

  // The CLI's own account of what the run cost. On a subscription it is the
  // API-equivalent price, which is still the right measure for a budget.
  if (modelCalls === 0)
    recordModelCall({
      provider: driver.id,
      model: model ?? attempt.model ?? 'default',
      prompt: attempt.prompt,
      // A crashed attempt that reported no cost may still have spent.
      status: result.ok
        ? 'ok'
        : result.crashed && result.costUsd === null
          ? 'unaccounted'
          : 'error',
      text: result.summary,
      error: result.ok ? undefined : result.summary,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: result.durationMs,
    });
  if (result.permissionDenials.length > 0 || result.warnings.length > 0) {
    addRunStep(runId, {
      kind: 'tool',
      input: { name: 'agent.limits' },
      output: { permissionDenials: result.permissionDenials, warnings: result.warnings },
      status: result.permissionDenials.length > 0 ? 'denied' : 'ok',
    });
  }
  if (log.length > 0) addArtifact(runId, 'log', log.join('\n'), 'agent.log');
  emit('agent.turn.completed', { ok: result.ok }, { runId });
  if (!result.ok) {
    const cause = transientCause(result, lastModelError);
    throw cause ? new TransientFailure(result.summary, cause) : new Error(result.summary);
  }
  return result;
}

/** An event with the run's secret values taken out, before any of it is stored. */
function scrub(event: DriverEvent, inUse: Record<string, string>): DriverEvent {
  if (Object.keys(inUse).length === 0) return event;
  return redactDeep(event, inUse) as DriverEvent;
}

/**
 * A tool call the agent wants to make that policy says a person must approve:
 * it waits in the approvals inbox like a push does, and the run shows as
 * awaiting approval meanwhile. Unanswered by the spec's approval timeout, or
 * cancelled, it is refused.
 */
async function approveToolCall(
  request: ToolApprovalRequest,
  spec: AutomationSpec,
  runId: string,
  signal: AbortSignal
): Promise<boolean> {
  // The run's signal (cancel, kill switch) and the agent's own (its time limit).
  const stopped = AbortSignal.any([signal, request.signal]);
  if (stopped.aborted) return false;
  setRunStatus(runId, 'awaiting_approval');
  emit('tool.approval_required', { name: request.tool }, { runId, toolCallId: request.toolCallId });
  const pending = requestApproval({
    runId,
    tool: request.tool,
    tier: tierFor(request.risk),
    reason: `The agent wants to run ${request.tool}. ${request.reason}`,
    arguments: { automation: spec.name, toolCallId: request.toolCallId, input: request.input },
  });
  // Nobody can approve a call after the agent has run out of time.
  const waitMs = Math.max(0, Math.min(spec.approvals.timeoutMs, request.deadline - Date.now()));
  let onStop: (() => void) | undefined;
  const approved = await Promise.race([
    waitForDecision(pending.id, waitMs),
    new Promise<boolean>((resolve) => {
      onStop = () => resolve(false);
      stopped.addEventListener('abort', onStop, { once: true });
    }),
  ]).finally(() => {
    if (onStop) stopped.removeEventListener('abort', onStop);
  });
  if (!approved) {
    // Settle it, so a request nobody answered does not linger in the inbox.
    decide(pending.id, {
      decision: 'denied',
      decidedBy: signal.aborted
        ? 'cancelled'
        : // The wait may end on its timer a moment before the agent's own signal does.
          request.signal.aborted || Date.now() >= request.deadline
          ? 'agent-stopped'
          : 'timeout',
    });
  }
  // Only a run still waiting goes back to work; a finished one keeps its state.
  setRunStatusIf(runId, 'awaiting_approval', 'executing');
  return approved;
}

/** Run the spec's gates in order; the first that does not pass throws GateFailed. */
async function verify(
  spec: AutomationSpec,
  ws: Workspace,
  runId: string,
  signal: AbortSignal,
  deps: RunnerDeps,
  rules: PolicyRules,
  budget: RunBudget
): Promise<void> {
  if (spec.gates.length === 0) return;
  setRunStatus(runId, 'verifying');
  let files: DiffFile[] | undefined;
  for (const gate of spec.gates) {
    if (isAssertion(gate)) {
      files ??= await diffFiles(ws.path, ws.baseSha);
      checkAssertion(gate, files, runId);
    } else {
      await guard(rules, TOOLS.gate, budget, () => runGate(gate, ws, runId, signal, deps));
    }
  }
}

/** Check one diff assertion, recorded as a gate step. */
function checkAssertion(
  gate: Extract<GateSpec, { assert: string }>,
  files: DiffFile[],
  runId: string
): void {
  emit('gate.started', { assert: gate.assert }, { runId });
  const r = evaluateAssertion(gate.check, files);
  addRunStep(runId, {
    kind: 'gate',
    input: { assert: gate.assert },
    output: {
      detail: r.detail,
      ...(r.actual === undefined ? {} : { actual: r.actual }),
      ...(r.offending ? { offending: r.offending.slice(0, 200) } : {}),
    },
    status: r.passed ? 'passed' : 'failed',
    durationMs: 0,
  });
  emit(r.passed ? 'gate.passed' : 'gate.failed', { assert: gate.assert }, { runId });
  if (!r.passed)
    throw new GateFailed(`Assertion failed: ${gate.assert} (${r.detail})`, gate.assert, r.detail);
}

async function runGate(
  gate: Extract<GateSpec, { run: string }>,
  ws: Workspace,
  runId: string,
  signal: AbortSignal,
  deps: RunnerDeps
): Promise<void> {
  emit('gate.started', { run: gate.run }, { runId });
  const seq = addRunStep(runId, { kind: 'gate', input: { run: gate.run }, status: 'running' });
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', gate.run]]
      : ['/bin/sh', ['-c', gate.run]];
  const watch = watchProcess(runId, 'gate');
  const r = await exec(
    {
      profile: 'native',
      cwd: ws.path,
      env: { PATH: deps.path() },
      limits: { wallMs: gate.timeoutMs },
    },
    command,
    args,
    {
      signal,
      onSpawn: (spawned) => watch.onSpawn({ ...spawned, command }),
      // A daemon a gate forked would otherwise outlive the run, unseen.
      reapGroup: true,
    }
  ).finally(watch.done);
  const passed = r.code === 0 && !r.timedOut && !r.cancelled;
  completeRunStep(runId, seq, {
    output: {
      exitCode: r.code,
      timedOut: r.timedOut,
      stdout: tail(r.stdout, 8_000),
      stderr: tail(r.stderr, 8_000),
    },
    status: passed ? 'passed' : 'failed',
    durationMs: r.durationMs,
  });
  emit(passed ? 'gate.passed' : 'gate.failed', { run: gate.run, exitCode: r.code }, { runId });
  if (r.cancelled) throw new RunCancelled('Cancelled.');
  if (!passed) {
    throw new GateFailed(
      r.timedOut ? `Gate timed out: ${gate.run}` : `Gate failed: ${gate.run} (exit ${r.code})`,
      gate.run,
      tail([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n'), 4_000)
    );
  }
}

/**
 * The saved notes this run may read, as the block added to its prompt, or
 * undefined. Which types is decided by the run's policy rules; with none
 * allowed nothing is read. What was read is a step on the run. Memory that
 * cannot be read is left out, never a failed run.
 */
function readNotes(runId: string, spec: AutomationSpec, rules: PolicyRules): string | undefined {
  if (spec.memory.read.length === 0) return undefined;
  try {
    const block = memoryBlock(spec.prompt, rules);
    addRunStep(runId, {
      kind: 'tool',
      input: { name: 'memory.read', types: spec.memory.read },
      output: { notes: block?.count ?? 0 },
      status: 'ok',
    });
    return block?.text;
  } catch (e) {
    logger.warn('Could not read memory for a run', {
      runId,
      err: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/**
 * A model a person named for this run, or null. Read from the run row, which a
 * retry reuses, so every attempt of a run is held to the same choice.
 */
function modelChosenFor(runId: string): string | null {
  const row = getStore().prepare('SELECT model_override FROM runs WHERE id = ?').get(runId);
  return row?.model_override ? String(row.model_override) : null;
}

/**
 * The models to try for one attempt of the agent, in order: the one it is
 * meant to use, then the fallback models that are neither known to be
 * unavailable in this run nor already tried and failed at the gates (a
 * fallback is not a way back to a model an escalation left behind).
 */
export function fallbackCandidates(
  model: string | undefined,
  fallback: readonly string[],
  tried: ReadonlySet<string>,
  unavailable: ReadonlySet<string>
): Array<string | undefined> {
  return [model, ...fallback.filter((m) => m !== model && !tried.has(m) && !unavailable.has(m))];
}

/** The prompt for an attempt that follows one cut short when its model became unavailable. */
export function interruptedPrompt(task: string): string {
  return [
    task,
    '',
    '---',
    'An earlier attempt at this task was interrupted when its model became unavailable. ' +
      'What it had changed so far is in this working tree. Carry on from there, keeping to the task above.',
  ].join('\n');
}

/** The prompt for an escalated attempt: the task, and the check the last one failed. */
export function escalationPrompt(task: string, failure: GateFailed): string {
  return [
    task,
    '',
    '---',
    'An earlier attempt at this task left the changes that are now in this working tree, ' +
      'and they did not pass this check:',
    '',
    failure.gate,
    '',
    failure.output ? `It reported:\n${failure.output}` : 'It reported nothing.',
    '',
    'Change what is needed so the check passes, keeping to the task above.',
  ].join('\n');
}

/**
 * Stop before an attempt the budgets cannot cover: the automation's month is
 * spent, or this run's own budget is. Returns what is left of the run's
 * budget, for the agent to be held to.
 */
function checkBudgets(
  automation: Automation,
  spec: AutomationSpec,
  runId: string
): number | undefined {
  const cap = spec.budget.maxUsdPerMonth;
  if (cap !== undefined) {
    const spent = monthSpendUsd(automation.id);
    if (spent >= cap) {
      throw new Error(
        `The monthly budget of $${cap} is spent ($${spent.toFixed(2)} so far); the automation is paused.`
      );
    }
  }
  return remainingRunBudget(spec, runId);
}

/** What is left of the run's budget across its attempts, or undefined when it has none. */
function remainingRunBudget(spec: AutomationSpec, runId: string): number | undefined {
  const max = spec.budget.maxUsdPerRun;
  if (max === undefined) return undefined;
  const spent = runCostUsd(runId);
  if (spent >= max) {
    throw new Error(
      `The run's budget of $${max.toFixed(2)} is spent ($${spent.toFixed(2)} across its attempts).`
    );
  }
  return Math.round((max - spent) * 1e6) / 1e6;
}

/** git configuration, through the environment, that authenticates to github.com with `token`. */
function githubAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * Push the run's branch. With a token, over HTTPS with the token in an
 * environment-supplied header, so it never reaches the argv or the remote URL;
 * without one, to origin with the user's own git credentials.
 */
async function pushBranch(
  ws: Workspace,
  branch: string,
  project: string | null,
  token: string | undefined
): Promise<void> {
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  if (project && token) {
    await git(['push', `https://github.com/${project}.git`, refspec], {
      cwd: ws.path,
      timeoutMs: 300_000,
      env: githubAuthEnv(token),
    });
    return;
  }
  await git(['push', 'origin', refspec], { cwd: ws.path, timeoutMs: 300_000 });
}

function pullRequestBody(
  spec: AutomationSpec,
  runId: string,
  result: DriverResult,
  stat: { filesChanged: number; insertions: number; deletions: number },
  route: {
    /** The model an escalation moved to, when the run escalated. */
    escalatedTo?: string;
    /** The model that did the work, when it was not the one meant to (a fallback). */
    usedModel?: string;
  }
): string {
  // Every attempt's spend, and unknown when any model call had no price.
  const run = getRun(runId);
  const summary =
    result.summary.length > 4_000 ? `${result.summary.slice(0, 4_000)}…` : result.summary;
  const gates = spec.gates.length
    ? spec.gates.map((g) => `\`${isAssertion(g) ? g.assert : g.run}\``).join(', ')
    : 'none';
  const via =
    (route.escalatedTo ? ` · escalated to \`${route.escalatedTo}\`` : '') +
    (route.usedModel ? ` · fell back to \`${route.usedModel}\`` : '');
  const cost = !run || !run.costKnown ? 'unknown' : `$${run.costUsd.toFixed(2)}`;
  return [
    summary,
    '',
    '---',
    `Automation \`${spec.name}\` · run \`${runId}\``,
    `${stat.filesChanged} files changed (+${stat.insertions} −${stat.deletions}) · gates passed: ${gates} · agent cost: ${cost}${via}`,
    '',
    'Opened by OpenClerq as a draft. Nothing is merged automatically.',
  ].join('\n');
}
