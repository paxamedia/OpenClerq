/**
 * Runs nothing is working on any more: those a stopped gateway left behind,
 * found at startup, and those whose lease expired while their owner is gone,
 * found while running.
 *
 * Each such run is either tried again (its spec has retries left, and it
 * stopped while preparing, working or checking) or marked failed. Either way
 * the processes it left are stopped first and its worktree and branch are
 * removed, so a retry starts clean. A run whose gateway is still running is
 * never touched: its gateway renews its lease (see queue.ts), and
 * agent-processes.ts says which gateways are alive.
 */

import fs from 'node:fs';
import { git, pruneWorktrees } from '@clerq/workspaces';
import { logger } from '../logger.js';
import { getStore } from '../store.js';
import { listPending, decide } from '../approvals.js';
import {
  activeRunIds,
  addRunStep,
  claimAbandonedRun,
  failAbandonedRun,
  getRun,
  interruptedRuns,
  requeueRun,
  unfinishedOf,
  INTERRUPTED,
  type UnfinishedRun,
} from '../runs.js';
import {
  killLeftoverProcesses,
  readProcessTable,
  runsOfLiveGateways,
  warmGatewayIdentity,
} from '../agent-processes.js';
import { getAutomation } from './store.js';
import { retryPlan, RETRYABLE_STAGES } from './retry.js';

/** Remove what an interrupted run left behind: its worktree and its branch. */
export async function cleanUpRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.repoId) return;
  const repo = getStore().prepare('SELECT local_path FROM repos WHERE id = ?').get(run.repoId);
  const repoPath = repo?.local_path ? String(repo.local_path) : null;
  // The latest attempt's worktree: an earlier one was removed when it ended.
  const step = [
    ...(run.steps as Array<{
      kind: string;
      input?: { action?: string };
      output?: { path?: string };
    }>),
  ]
    .reverse()
    .find((s) => s.kind === 'git' && s.input?.action === 'worktree');
  const worktree = step?.output?.path;
  if (worktree && fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
  if (repoPath && fs.existsSync(repoPath)) {
    await pruneWorktrees(repoPath);
    if (run.branch) await git(['branch', '-D', run.branch], { cwd: repoPath, allowFailure: true });
  }
}

/**
 * Stop the agent and gate processes a gateway that is gone left running, and
 * say so on the run each belonged to. They lead their own process groups, so
 * they outlive a gateway that crashed, and would keep writing into a worktree
 * that is about to be removed. Only a process still matching what was
 * recorded is stopped; see agent-processes.ts.
 */
async function stopLeftoverProcesses(): Promise<void> {
  try {
    for (const p of await killLeftoverProcesses()) {
      if (p.container) {
        addRunStep(p.runId, {
          kind: 'tool',
          input: { name: 'process.cleanup', container: p.container, kind: p.kind },
          output: {
            note: `Removed the container ${p.container} that the previous gateway's ${p.kind} left behind.`,
          },
          status: 'ok',
        });
      }
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

/** Runs being settled now, so two checks never settle one twice. */
const settling = new Set<string>();

/** How long a claim on an abandoned run lasts: long enough to clean it up. */
const CLAIM_MS = 60_000;
/** How often a run that never got past `leased` is put back before it fails. */
export const MAX_RELAUNCHES = 3;

function stepsNamed(runId: string, name: string): number {
  const row = getStore()
    .prepare(
      `SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'tool'
         AND json_extract(input, '$.name') = ?`
    )
    .get(runId, name);
  return Number(row?.n ?? 0);
}

/**
 * Retry or fail one run nothing is working on. It is claimed first, in one
 * conditional write (see claimAbandonedRun): a run another gateway got to,
 * or that changed since it was read, is skipped, and nothing is removed.
 *
 * A run that was only leased never started any work, so it goes back to the
 * queue as the same attempt, up to MAX_RELAUNCHES times. Neither that nor a
 * retry happens once its automation is switched off.
 */
async function settleAbandoned(
  run: UnfinishedRun,
  reason: string,
  opts: { leaseBefore?: string; denyApprovals?: string } = {}
): Promise<'requeued' | 'failed' | 'skipped'> {
  if (!claimAbandonedRun(run, { leaseMs: CLAIM_MS, leaseBefore: opts.leaseBefore })) {
    return 'skipped';
  }
  const me = process.pid;
  if (opts.denyApprovals) {
    for (const p of listPending()) {
      if (p.runId === run.id) {
        decide(p.id, {
          decision: 'denied',
          decidedBy: opts.denyApprovals,
          reason: 'The run is no longer being worked on.',
        });
      }
    }
  }
  const automation = run.automationId ? getAutomation(run.automationId) : null;
  const spec = automation?.spec ?? null;
  const off = Boolean(automation && !automation.enabled);
  const fail = async (why: string): Promise<'failed'> => {
    failAbandonedRun(run.id, why, { from: run.status, ownerPid: me });
    await cleanUpRun(run.id);
    return 'failed';
  };

  try {
    if (spec && run.status === 'leased') {
      if (off) return await fail(`${reason} Not started again: the automation is switched off.`);
      const relaunches = stepsNamed(run.id, 'run.requeue');
      if (relaunches >= MAX_RELAUNCHES) {
        return await fail(
          `${reason} Its gateway stopped ${relaunches + 1} times before the run could start; it is not put back again.`
        );
      }
      addRunStep(run.id, {
        kind: 'tool',
        input: { name: 'run.requeue', relaunch: relaunches + 1 },
        output: { after: reason, of: MAX_RELAUNCHES },
        status: 'warning',
      });
      requeueRun(run.id, {
        reason: 'Back in the queue: its gateway stopped before it started.',
        sameAttempt: true,
        from: 'leased',
        ownerPid: me,
      });
      return 'requeued';
    }
    const plan = spec && RETRYABLE_STAGES.has(run.status) ? retryPlan(spec, run.attempt) : null;
    if (plan && off) {
      return await fail(`${reason} Not retried: the automation is switched off.`);
    }
    if (plan) {
      addRunStep(run.id, {
        kind: 'tool',
        input: { name: 'run.retry', attempt: run.attempt + 1 },
        output: {
          after: reason,
          cause: 'lease_expired',
          stage: run.status,
          notBefore: plan.notBefore.toISOString(),
        },
        status: 'warning',
      });
      // Clean first: the retry makes a worktree and a branch of the same name.
      await cleanUpRun(run.id);
      requeueRun(run.id, {
        notBefore: plan.notBefore,
        reason: `Retry ${plan.retry} of ${plan.of} after: ${reason}`,
        from: run.status,
        ownerPid: me,
      });
      return 'requeued';
    }
    return await fail(reason);
  } catch (e) {
    logger.warn('Could not clean up an interrupted run', {
      runId: run.id,
      err: e instanceof Error ? e.message : String(e),
    });
    // Whatever was left behind, the run must not stay unfinished.
    failAbandonedRun(run.id, reason, { ownerPid: me });
    return 'failed';
  }
}

/**
 * After a restart: runs that were in flight died with the old process, and
 * their approvals can never be acted on. Stop what they left running, retry
 * or fail them, and remove their worktrees. Queued runs stay queued.
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
  const runs = interruptedRuns({ except: theirs });
  for (const p of listPending()) {
    if (theirs.has(p.runId)) continue;
    decide(p.id, { decision: 'denied', decidedBy: 'restart', reason: 'The gateway restarted.' });
  }
  const outcome = { requeued: 0, failed: 0, skipped: 0 };
  for (const run of runs) {
    if (settling.has(run.id)) continue;
    settling.add(run.id);
    try {
      outcome[await settleAbandoned(run, INTERRUPTED)] += 1;
    } finally {
      settling.delete(run.id);
    }
  }
  if (runs.length > 0) {
    logger.warn('Settled runs interrupted by a restart', outcome);
  }
}

/**
 * Reclaim automation runs whose lease has expired: their gateway has stopped
 * (or, for one of this gateway's own, the run is no longer being worked on).
 * A run whose owner is still running is left alone, as at startup. Returns
 * the ids reclaimed.
 */
export async function reclaimExpiredLeases(
  opts: { held?: ReadonlySet<string>; now?: Date } = {}
): Promise<string[]> {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const expired = getStore()
    .prepare(
      `SELECT id, status, automation_id, attempt, owner_pid, owner_start FROM runs
       WHERE status IN ('leased','preparing','executing','verifying','publishing','awaiting_approval')
         AND lease_until IS NOT NULL AND lease_until < ?`
    )
    .all(nowIso)
    .map(unfinishedOf);
  if (expired.length === 0) return [];

  const active = new Set(activeRunIds());
  const mine = (id: string) => opts.held?.has(id) || active.has(id);
  const table = await readProcessTable();
  const live = table ? runsOfLiveGateways(table) : null;

  const out: string[] = [];
  let stopped = false;
  for (const run of expired) {
    if (mine(run.id) || settling.has(run.id)) continue;
    const ownPid = run.ownerPid === process.pid;
    // Another gateway's run counts as abandoned only when the process table
    // says its gateway is gone; one of this gateway's own when it is not
    // being worked on here.
    if (!ownPid && (!live || live.has(run.id))) continue;
    if (!stopped && !ownPid) {
      await stopLeftoverProcesses();
      stopped = true;
    }
    settling.add(run.id);
    try {
      // The claim in settleAbandoned checks the run is still as read above,
      // lease expired and owner unchanged, before anything is done to it.
      const outcome = await settleAbandoned(
        run,
        'Lease expired: the gateway working on this run stopped renewing it.',
        { leaseBefore: nowIso, denyApprovals: 'lease-expired' }
      );
      if (outcome === 'skipped') continue;
      logger.warn('Reclaimed an automation run whose lease expired', { runId: run.id, outcome });
      out.push(run.id);
    } finally {
      settling.delete(run.id);
    }
  }
  return out;
}
