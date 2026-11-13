/**
 * HTTP endpoints for automations and agent drivers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { DRIVER_IDS } from '@clerq/drivers';
import { git, isRepo, defaultBranch, pruneWorktrees } from '@clerq/workspaces';
import { logger } from '../logger.js';
import { getStore } from '../store.js';
import { listPending, decide } from '../approvals.js';
import { addRunStep, reapInterruptedRuns, getArtifact, getRun } from '../runs.js';
import {
  killLeftoverProcesses,
  readProcessTable,
  runsOfLiveGateways,
  warmGatewayIdentity,
} from '../agent-processes.js';
import { parseSpec, SpecError, type AutomationSpec } from './spec.js';
import {
  AutomationError,
  createAutomation,
  deleteAutomation,
  expandHome,
  getAutomation,
  hasPushedBefore,
  listAutomations,
  monthSpendUsd,
  setAutomationEnabled,
  updateAutomation,
  type Automation,
} from './store.js';
import {
  AutomationBusy,
  defaultDriver,
  githubProject,
  hasBudget,
  policyFor,
  runningAutomations,
  startAutomationRun,
  type RunnerDeps,
} from './runner.js';
import {
  nextRunOf,
  nextRunsOf,
  startAutomationSchedules,
  stopAutomationSchedules,
} from './scheduler.js';

/** How many upcoming firings a summary lists. */
const NEXT_FIRINGS = 10;

function fail(res: Response, e: unknown, code: string): Response {
  if (e instanceof SpecError) {
    return res
      .status(400)
      .json({ error: 'invalid_spec', message: e.message, line: e.line, column: e.column });
  }
  if (e instanceof AutomationError) {
    return res
      .status(e.code === 'not_found' ? 404 : 409)
      .json({ error: e.code, message: e.message });
  }
  if (e instanceof AutomationBusy) {
    return res.status(409).json({ error: 'busy', message: e.message });
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.error(code, { err: message });
  return res.status(500).json({ error: code, message });
}

function specText(req: Request): string {
  const body = (req.body ?? {}) as { spec?: unknown };
  if (typeof body.spec !== 'string') throw new SpecError('Send the YAML as "spec", a string.');
  return body.spec;
}

function lastRun(automationId: string) {
  const r = getStore()
    .prepare(
      `SELECT id, status, exit_reason, pr_url, created_at FROM runs
       WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(automationId);
  if (!r) return null;
  return {
    id: String(r.id),
    status: String(r.status),
    exitReason: r.exit_reason ? String(r.exit_reason) : undefined,
    prUrl: r.pr_url ? String(r.pr_url) : undefined,
    createdAt: String(r.created_at),
  };
}

function summary(a: Automation) {
  return {
    id: a.id,
    name: a.name,
    description: a.spec?.description,
    enabled: a.enabled,
    schedule: a.spec?.schedule ?? null,
    nextRunAt: a.nextRunAt ?? null,
    // From the schedule alone: `enabled` says whether they will happen.
    nextFirings: a.spec?.schedule
      ? nextRunsOf(a.spec.schedule, NEXT_FIRINGS).map((d) => d.toISOString())
      : [],
    driver: a.spec?.agent.driver ?? null,
    repo: a.spec?.repo.path ?? null,
    problem: a.problem ?? null,
    running: runningAutomations().includes(a.id),
    monthSpendUsd: monthSpendUsd(a.id),
    monthBudgetUsd: a.spec?.budget.maxUsdPerMonth ?? null,
    lastRun: lastRun(a.id),
    updatedAt: a.updatedAt,
  };
}

/**
 * What a spec would do, checked against this machine, without doing it: the
 * repository, the driver, the next scheduled time, and what will need a token
 * or an approval.
 */
async function preview(spec: AutomationSpec, deps: RunnerDeps, automationId?: string) {
  const checks: Array<{ level: 'ok' | 'warning' | 'error'; message: string }> = [];
  const repoPath = expandHome(spec.repo.path);
  const repo: Record<string, unknown> = { path: repoPath };

  if (!fs.existsSync(repoPath)) {
    checks.push({ level: 'error', message: `${repoPath} does not exist.` });
  } else if (!(await isRepo(repoPath))) {
    checks.push({ level: 'error', message: `${repoPath} is not a git repository.` });
  } else {
    const origin = await git(['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      allowFailure: true,
    });
    repo.origin = origin.code === 0 ? origin.stdout.trim() : null;
    repo.project = githubProject(repo.origin as string | null);
    repo.base = spec.repo.ref ?? (await defaultBranch(repoPath));
    if (spec.publish.push && !repo.origin) {
      checks.push({ level: 'error', message: 'The repository has no origin remote to push to.' });
    }
    if (spec.publish.pullRequest === 'draft' && !repo.project) {
      checks.push({
        level: 'error',
        message: 'origin is not a GitHub repository, so no pull request can be opened.',
      });
    }
  }

  const driver = await (deps.driverFor ?? defaultDriver)(spec.agent.driver).detect({
    apiKey: Boolean(spec.agent.apiKeySecret),
    permissionMode: spec.agent.permissionMode,
    model: spec.agent.model,
    budget: hasBudget(spec),
  });
  if (!driver.available)
    checks.push({ level: 'error', message: driver.reason ?? 'The driver is unavailable.' });

  if (
    spec.publish.push &&
    spec.publish.pullRequest === 'draft' &&
    !deps.getSecret(spec.publish.tokenSecret)
  ) {
    checks.push({
      level: 'error',
      message: `No ${spec.publish.tokenSecret} in the vault; opening a pull request needs one.`,
    });
  }
  if (spec.agent.apiKeySecret && !deps.getSecret(spec.agent.apiKeySecret)) {
    checks.push({ level: 'error', message: `No ${spec.agent.apiKeySecret} in the vault.` });
  }
  checks.push({
    level: 'warning',
    message:
      'The agent and the gates run without isolation (profile "native"), with your account\'s access to files and the network.',
  });
  const firstPush = spec.publish.push && !(automationId && hasPushedBefore(automationId));
  if (spec.publish.push) {
    checks.push({
      level: 'ok',
      message:
        spec.approvals.push === 'manual' || firstPush
          ? 'Pushing waits for your approval in the Approvals inbox.'
          : 'Pushing proceeds without approval once the gates pass.',
    });
  }
  if (!spec.schedule)
    checks.push({ level: 'ok', message: 'No schedule: it runs only when started by hand.' });

  return {
    spec,
    nextRunAt: spec.schedule ? (nextRunOf(spec.schedule)?.toISOString() ?? null) : null,
    nextFirings: spec.schedule
      ? nextRunsOf(spec.schedule, NEXT_FIRINGS).map((d) => d.toISOString())
      : [],
    repo,
    driver,
    policy: policyFor(spec, firstPush),
    checks,
    ready: !checks.some((c) => c.level === 'error'),
  };
}

/** Remove what an interrupted run left behind: its worktree and its branch. */
async function cleanUpRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.repoId) return;
  const repo = getStore().prepare('SELECT local_path FROM repos WHERE id = ?').get(run.repoId);
  const repoPath = repo?.local_path ? String(repo.local_path) : null;
  const step = (
    run.steps as Array<{ kind: string; input?: { action?: string }; output?: { path?: string } }>
  ).find((s) => s.kind === 'git' && s.input?.action === 'worktree');
  const worktree = step?.output?.path;
  if (worktree && fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  if (repoPath && fs.existsSync(repoPath)) {
    await pruneWorktrees(repoPath);
    if (run.branch) await git(['branch', '-D', run.branch], { cwd: repoPath, allowFailure: true });
  }
}

/**
 * Stop the agent and gate processes the previous gateway left running, and say
 * so on the run each belonged to. They lead their own process groups, so they
 * outlive a gateway that crashed, and would keep writing into a worktree that
 * is about to be removed. Only a process still matching what was recorded is
 * stopped; see agent-processes.ts.
 */
async function stopLeftoverProcesses(): Promise<void> {
  try {
    for (const p of await killLeftoverProcesses()) {
      if (p.outcome === 'killed') {
        addRunStep(p.runId, {
          kind: 'tool',
          input: { name: 'process.cleanup', pid: p.pid, command: p.command, kind: p.kind },
          output: {
            note: `Stopped the ${p.kind} process (pid ${p.pid}) that the previous gateway left running.`,
            forced: p.forced === true,
          },
          status: 'ok',
        });
        logger.warn('Stopped a process left running by the previous gateway', {
          runId: p.runId,
          pid: p.pid,
          kind: p.kind,
          forced: p.forced === true,
        });
      } else if (p.outcome === 'reused' || p.outcome === 'unverified') {
        addRunStep(p.runId, {
          kind: 'tool',
          input: { name: 'process.cleanup', pid: p.pid, command: p.command, kind: p.kind },
          output: {
            note: `Left pid ${p.pid} alone: it could not be confirmed as the ${p.kind} process this run started.`,
          },
          status: 'warning',
        });
      }
    }
  } catch (e) {
    // Never stop the gateway starting over this.
    logger.warn('Could not check for processes left by the previous gateway', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * After a restart: runs that were in flight died with the old process, and
 * their approvals can never be acted on. Stop what they left running, mark
 * them, and remove their worktrees.
 */
export async function recoverAfterRestart(): Promise<void> {
  // Learn when this process started, so what it records can be recognised later.
  await warmGatewayIdentity();
  // Runs of a gateway that is still running (another instance on the same
  // store, or this process) are not interrupted: their processes are left
  // alone below, and so are their runs, approvals and worktrees.
  const table = await readProcessTable();
  const theirs = table ? runsOfLiveGateways(table) : new Set<string>();
  // First, so nothing is still writing into a worktree when it is removed.
  await stopLeftoverProcesses();
  const reaped = reapInterruptedRuns({ except: theirs });
  for (const p of listPending()) {
    if (theirs.has(p.runId)) continue;
    decide(p.id, { decision: 'denied', decidedBy: 'restart', reason: 'The gateway restarted.' });
  }
  for (const id of reaped) {
    try {
      await cleanUpRun(id);
    } catch (e) {
      logger.warn('Could not clean up an interrupted run', {
        runId: id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (reaped.length > 0) {
    logger.warn('Marked runs interrupted by a restart as failed', { count: reaped.length });
  }
}

export function mountAutomationRoutes(
  app: Express,
  deps: RunnerDeps,
  schedulesActive: () => boolean
): void {
  const reschedule = () => {
    if (schedulesActive()) startAutomationSchedules(deps);
    else stopAutomationSchedules();
  };

  app.get('/drivers', async (_req, res) => {
    try {
      const drivers = await Promise.all(
        DRIVER_IDS.map((id) => (deps.driverFor ?? defaultDriver)(id).detect())
      );
      res.json({ drivers });
    } catch (e) {
      fail(res, e, 'drivers_failed');
    }
  });

  app.get('/automations', (_req, res) => {
    try {
      res.json({ automations: listAutomations().map(summary) });
    } catch (e) {
      fail(res, e, 'automations_list_failed');
    }
  });

  app.post('/automations/preview', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { id?: unknown };
      res.json(
        await preview(
          parseSpec(specText(req)),
          deps,
          typeof body.id === 'string' ? body.id : undefined
        )
      );
    } catch (e) {
      fail(res, e, 'automation_preview_failed');
    }
  });

  app.post('/automations', (req: Request, res: Response) => {
    try {
      const created = createAutomation(specText(req));
      res.status(201).json({ ...summary(created), source: created.source });
    } catch (e) {
      fail(res, e, 'automation_create_failed');
    }
  });

  app.get('/automations/:id', (req: Request, res: Response) => {
    const a = getAutomation(String(req.params.id));
    if (!a) return res.status(404).json({ error: 'not_found' });
    res.json({ ...summary(a), source: a.source, spec: a.spec });
  });

  app.put('/automations/:id', (req: Request, res: Response) => {
    try {
      const updated = updateAutomation(String(req.params.id), specText(req));
      reschedule();
      res.json({ ...summary(updated), source: updated.source });
    } catch (e) {
      fail(res, e, 'automation_update_failed');
    }
  });

  app.delete('/automations/:id', (req: Request, res: Response) => {
    try {
      deleteAutomation(String(req.params.id));
      reschedule();
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, 'automation_delete_failed');
    }
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/automations/:id/${action}`, (req: Request, res: Response) => {
      try {
        const a = setAutomationEnabled(String(req.params.id), action === 'enable');
        reschedule();
        res.json(summary(getAutomation(a.id) as Automation));
      } catch (e) {
        fail(res, e, `automation_${action}_failed`);
      }
    });
  }

  /** Start a run now. Answers once the run exists; follow it at GET /runs/:id. */
  app.post('/automations/:id/run', (req: Request, res: Response) => {
    try {
      const a = getAutomation(String(req.params.id));
      if (!a) return res.status(404).json({ error: 'not_found' });
      const { runId } = startAutomationRun(a, 'manual', deps);
      res.status(202).json({ runId });
    } catch (e) {
      fail(res, e, 'automation_run_failed');
    }
  });

  app.get('/runs/:id/artifacts/:artifactId', (req: Request, res: Response) => {
    const artifact = getArtifact(String(req.params.id), Number(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: 'artifact_not_found' });
    res.json(artifact);
  });
}
