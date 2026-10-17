/**
 * Running an automation: worktree → agent → commit → gates → push → draft PR.
 *
 * Each stage is a state of the run, written before the stage starts. Each
 * action the run takes on the user's behalf — running the agent, a gate,
 * committing, pushing, opening the pull request — is decided by the policy
 * engine first, and pushing waits for a human unless the spec says otherwise.
 * An automation's first push always waits, whatever its spec says.
 */

import { getDriver, type Driver, type DriverResult } from '@clerq/drivers';
import {
  guard,
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
import {
  recordRun,
  recordModelCall,
  currentRunId,
  currentRunSignal,
  setRunStatus,
  setRunFields,
  addRunStep,
  completeRunStep,
  addArtifact,
  RunCancelled,
} from '../runs.js';
import { requestApproval, waitForDecision, decide } from '../approvals.js';
import { emit } from '../events.js';
import { logger } from '../logger.js';
import { SpecError, type AutomationSpec } from './spec.js';
import {
  ensureLocalRepo,
  expandHome,
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

/** What this run may do, from its spec. Anything else is denied. */
export function policyFor(spec: AutomationSpec, firstPush: boolean): PolicyRules {
  const allow = [TOOLS.agent.name, TOOLS.gate.name, TOOLS.commit.name];
  if (spec.publish.push) allow.push(TOOLS.push.name);
  if (spec.publish.pullRequest === 'draft') allow.push(TOOLS.pullRequest.name);
  const manual = spec.approvals.push === 'manual' || firstPush;
  return {
    allow,
    approvalRequired: manual ? [TOOLS.push.name] : [],
    // Exactly the actions a run consists of: agent, gates, commit, push, PR.
    maxCallsPerRun: spec.gates.length + 4,
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

const inFlight = new Set<string>();

export function runningAutomations(): string[] {
  return [...inFlight];
}

/**
 * Start a run of `automation`. Returns as soon as the run record exists; the
 * run carries on in the background and `done` settles when it ends.
 */
export function startAutomationRun(
  automation: Automation,
  trigger: 'schedule' | 'manual',
  deps: RunnerDeps
): { runId: string; done: Promise<void> } {
  const spec = automation.spec;
  if (!spec) throw new SpecError(`Fix the spec before running it: ${automation.problem}`);
  if (inFlight.has(automation.id)) {
    throw new AutomationBusy(`"${automation.name}" is already running.`);
  }
  const limit = deps.maxConcurrent ?? 2;
  if (inFlight.size >= limit) {
    throw new AutomationBusy(`${limit} automation runs are already in progress; try again later.`);
  }
  inFlight.add(automation.id);

  let runId = '';
  const done = recordRun(
    {
      trigger,
      automationId: automation.id,
      message: spec.prompt,
      status: 'preparing',
      onCreated: (id) => (runId = id),
    },
    () => execute(automation, spec, deps)
  )
    .catch((e: unknown) => {
      // Recorded on the run already; a scheduled run has nobody else to tell.
      logger.info('Automation run ended without publishing', {
        automation: automation.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => {
      inFlight.delete(automation.id);
      enforceMonthlyBudget(automation, spec);
    });

  if (!runId) throw new Error('The run could not be recorded.');
  return { runId, done };
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

  const cap = spec.budget.maxUsdPerMonth;
  if (cap !== undefined) {
    const spent = monthSpendUsd(automation.id);
    if (spent >= cap) {
      throw new Error(
        `The monthly budget of $${cap} is spent ($${spent.toFixed(2)} so far); the automation is paused.`
      );
    }
  }

  const firstPush = spec.publish.push && !hasPushedBefore(automation.id);
  const rules = policyFor(spec, firstPush);
  const budget = new RunBudget(rules);

  const driver = (deps.driverFor ?? getDriver)(spec.agent.driver);
  const availability = await driver.detect();
  addRunStep(runId, {
    kind: 'tool',
    input: { name: 'driver.detect', driver: driver.id },
    output: availability,
    status: availability.available ? 'ok' : 'error',
  });
  if (!availability.available)
    throw new Error(availability.reason ?? `${driver.id} is unavailable.`);

  let apiKey: Record<string, string> | undefined;
  if (spec.agent.apiKeySecret) {
    const value = deps.getSecret(spec.agent.apiKeySecret);
    if (!value) throw new Error(`The secret ${spec.agent.apiKeySecret} is not in the vault.`);
    apiKey = { ANTHROPIC_API_KEY: value };
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

    setRunStatus(runId, 'executing');
    const result = await guard(rules, TOOLS.agent, budget, () =>
      runAgent(driver, spec, ws, runId, signal, deps, apiKey)
    );
    if (!result.ok) throw new Error(result.summary);

    if (!(await ws.hasChanges())) {
      setRunFields(runId, { exitReason: 'No changes: the agent left the repository as it was.' });
      return;
    }

    const title = `${spec.name}: ${firstLine(result.summary) || 'automated changes'}`;
    const sha = await guard(rules, TOOLS.commit, budget, () =>
      ws.commitAll(title, { trailer: `Generated-by: OpenClerq\nOpenClerq-Run: ${runId}` })
    );
    const stat = await ws.diffStat();
    addRunStep(runId, {
      kind: 'git',
      input: { action: 'commit' },
      output: { sha, ...stat },
      status: 'ok',
    });
    addArtifact(runId, 'diff', await ws.diff(), `${branch}.diff`);

    if (spec.gates.length > 0) {
      setRunStatus(runId, 'verifying');
      for (const gate of spec.gates) {
        await guard(rules, TOOLS.gate, budget, () => runGate(gate, ws, runId, signal, deps));
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
            body: pullRequestBody(spec, runId, result, stat),
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
  ws: Workspace,
  runId: string,
  signal: AbortSignal,
  deps: RunnerDeps,
  secrets: Record<string, string> | undefined
): Promise<DriverResult> {
  const pending = new Map<string, { seq: number; started: number }>();
  const log: string[] = [];
  let model: string | undefined;
  let result: DriverResult | undefined;

  for await (const event of driver.run({
    prompt: spec.prompt,
    cwd: ws.path,
    model: spec.agent.model,
    permissionMode: spec.agent.permissionMode,
    allowedTools: spec.agent.allowedTools,
    maxBudgetUsd: spec.budget.maxUsdPerRun,
    timeoutMs: spec.sandbox.timeoutMs,
    sandbox: { profile: spec.sandbox.profile },
    env: { PATH: deps.path() },
    secrets,
    signal,
  })) {
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
        pending.set(event.id, { seq, started: Date.now() });
        emit('tool.started', { name: event.name }, { runId, toolCallId: event.id });
        break;
      }
      case 'tool_result': {
        const call = pending.get(event.id);
        if (call) {
          completeRunStep(runId, call.seq, {
            output: { text: tail(event.output, 16_000) },
            status: event.isError ? 'error' : 'ok',
            durationMs: Date.now() - call.started,
          });
          pending.delete(event.id);
        }
        emit(event.isError ? 'tool.failed' : 'tool.completed', {}, { runId, toolCallId: event.id });
        break;
      }
      case 'log':
        log.push(`[${event.stream}] ${event.line}`);
        if (log.length > 500) log.shift();
        break;
      case 'finished':
        result = event.result;
        break;
    }
  }
  if (!result) throw new Error(`${driver.id} ended without reporting a result.`);

  // The CLI's own account of what the run cost. On a subscription it is the
  // API-equivalent price, which is still the right measure for a budget.
  recordModelCall({
    provider: driver.id,
    model: model ?? spec.agent.model ?? 'default',
    prompt: spec.prompt,
    status: result.ok ? 'ok' : 'error',
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
  return result;
}

async function runGate(
  gate: AutomationSpec['gates'][number],
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
  const r = await exec(
    {
      profile: 'native',
      cwd: ws.path,
      env: { PATH: deps.path() },
      limits: { wallMs: gate.timeoutMs },
    },
    command,
    args,
    { signal }
  );
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
    throw new Error(
      r.timedOut ? `Gate timed out: ${gate.run}` : `Gate failed: ${gate.run} (exit ${r.code})`
    );
  }
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
  stat: { filesChanged: number; insertions: number; deletions: number }
): string {
  const summary =
    result.summary.length > 4_000 ? `${result.summary.slice(0, 4_000)}…` : result.summary;
  const gates = spec.gates.length ? spec.gates.map((g) => `\`${g.run}\``).join(', ') : 'none';
  const cost = result.costUsd === null ? 'unknown' : `$${result.costUsd.toFixed(2)}`;
  return [
    summary,
    '',
    '---',
    `Automation \`${spec.name}\` · run \`${runId}\``,
    `${stat.filesChanged} files changed (+${stat.insertions} −${stat.deletions}) · gates passed: ${gates} · agent cost: ${cost}`,
    '',
    'Opened by OpenClerq as a draft. Nothing is merged automatically.',
  ].join('\n');
}
