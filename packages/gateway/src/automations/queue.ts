/**
 * The automation run queue.
 *
 * A run starts life as a row in `runs` with status `queued`. A gateway takes
 * one by leasing it: status `leased`, `lease_until` a minute ahead, and the
 * gateway's pid and start time as its owner, all written in one statement
 * that only succeeds while the row is still queued. While the run works the
 * gateway renews the lease; a run whose lease has expired and whose owner is
 * gone is reclaimed (retried or failed, see recovery.ts) instead of being left
 * as a zombie. Queued rows survive a restart and are picked up again.
 *
 * Which queued run goes next:
 *   - at most `maxConcurrent` automation runs at once, across all automations;
 *   - one run per automation at a time;
 *   - a run held back by a retry's backoff waits until `not_before`;
 *   - otherwise fairly across repositories: the repository with the fewest
 *     runs going, then the one served longest ago, and within it the oldest
 *     run. One repository with many automations cannot starve the others.
 */

import { getStore, isStoreOpen } from '../store.js';
import { emit, subscribeEvents } from '../events.js';
import { logger } from '../logger.js';
import { gatewayOwner } from '../agent-processes.js';
import { addRunStep, cancelQueuedRun, createRun, failAbandonedRun } from '../runs.js';
import { SpecError } from './spec.js';
import { ensureLocalRepo, getAutomation, type Automation } from './store.js';
import { AutomationBusy, runLeased, type RunnerDeps } from './runner.js';
import { reclaimExpiredLeases } from './recovery.js';

/** States in which a run holds a lease and counts against the limits. */
export const LEASED_STATES = [
  'leased',
  'preparing',
  'executing',
  'verifying',
  'publishing',
  'awaiting_approval',
] as const;
const LEASED_SQL = LEASED_STATES.map((s) => `'${s}'`).join(', ');

export const DEFAULT_LEASE_MS = 60_000;
/** Without anything to wake it sooner, the queue looks again this often. */
const IDLE_PUMP_MS = 30_000;

interface Held {
  automationId: string;
  repoId: string | null;
}

/** Runs this gateway has leased and is working on. */
const held = new Map<string, Held>();
/** Callers waiting for a run to end (`startAutomationRun().done`). */
const waiters = new Map<string, Array<() => void>>();
/** When each repository last had a run started, as a rising counter. */
const served = new Map<string, number>();
let servedSeq = 0;

let deps: RunnerDeps | undefined;
let paused = false;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
let renewTimer: ReturnType<typeof setInterval> | undefined;
let reapTimer: ReturnType<typeof setInterval> | undefined;
let reaping = false;
let unsubscribe: (() => void) | undefined;

export function leaseMsOf(d: RunnerDeps | undefined = deps): number {
  return d?.leaseMs ?? DEFAULT_LEASE_MS;
}

/** The automations this gateway is running a run of now. */
export function runningAutomations(): string[] {
  return [...new Set([...held.values()].map((h) => h.automationId))];
}

/** Runs this gateway holds a lease on. */
export function heldRunIds(): ReadonlySet<string> {
  return new Set(held.keys());
}

/** Start taking runs from the queue. Safe to call again; the latest deps win. */
export function startAutomationQueue(d: RunnerDeps): void {
  stopAutomationQueue();
  deps = d;
  paused = false;
  const lease = leaseMsOf(d);
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(renewLeases, Math.max(50, Math.floor(lease / 3)));
  renewTimer.unref?.();
  reapTimer = setInterval(() => void reapExpired(), Math.max(100, Math.floor(lease / 2)));
  reapTimer.unref?.();
  unsubscribe = subscribeEvents((e) => {
    // A run put back in the queue (a retry, a reclaimed lease): look again
    // once the current work is done, and when its backoff is over.
    if (e.name === 'run.queued') pumpSoon();
    if (e.name === 'run.completed' || e.name === 'run.failed' || e.name === 'run.cancelled') {
      const id = e.context?.runId;
      if (id && waiters.has(id) && !held.has(id)) settle(id);
    }
  });
  pumpQueue();
}

/** Stop taking runs. Runs in flight carry on, and keep their leases renewed until they end. */
export function stopAutomationQueue(): void {
  if (pumpTimer) clearTimeout(pumpTimer);
  if (reapTimer) clearInterval(reapTimer);
  pumpTimer = reapTimer = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  deps = undefined;
  // Leases of runs still going are renewed until the last one ends.
  if (held.size === 0 && renewTimer) {
    clearInterval(renewTimer);
    renewTimer = undefined;
  }
}

/** Hold queued runs where they are (the kill switch). Running ones are not touched. */
export function pauseAutomationQueue(): void {
  paused = true;
}

export function resumeAutomationQueue(): void {
  paused = false;
  pumpQueue();
}

/** Cancel every queued automation run. Returns how many. */
export function cancelQueuedRuns(reason: string): number {
  if (!isStoreOpen()) return 0;
  const ids = getStore()
    .prepare("SELECT id FROM runs WHERE status = 'queued'")
    .all()
    .map((r) => String(r.id));
  const now = new Date().toISOString();
  const mark = getStore().prepare(
    `UPDATE runs SET status = 'cancelled', exit_reason = ?, finished_at = ? WHERE id = ? AND status = 'queued'`
  );
  let n = 0;
  for (const id of ids) {
    if (Number(mark.run(reason, now, id).changes) === 0) continue;
    n += 1;
    emit('run.cancelled', { reason }, { runId: id });
  }
  return n;
}

function settle(runId: string): void {
  const list = waiters.get(runId);
  waiters.delete(runId);
  for (const resolve of list ?? []) resolve();
}

function statusOf(runId: string): string | null {
  const row = getStore().prepare('SELECT status FROM runs WHERE id = ?').get(runId);
  return row ? String(row.status) : null;
}

/** An automation's run that is queued, or one that holds a lease (going). */
function runsOf(automationId: string): { queued: string | null; going: string | null } {
  const db = getStore();
  const queued = db
    .prepare("SELECT id FROM runs WHERE automation_id = ? AND status = 'queued' LIMIT 1")
    .get(automationId);
  const going = db
    .prepare(`SELECT id FROM runs WHERE automation_id = ? AND status IN (${LEASED_SQL}) LIMIT 1`)
    .get(automationId);
  return {
    queued: queued ? String(queued.id) : null,
    going: going ? String(going.id) : null,
  };
}

/** Whether an automation has a run waiting in the queue. */
export function hasQueuedRun(automationId: string): boolean {
  return runsOf(automationId).queued !== null;
}

export interface EnqueueOptions {
  /**
   * What to do when the automation already has a run queued or going.
   * `refuse` (a run started by hand): AutomationBusy. `once` (a schedule):
   * queue behind a run that is going, but never a second queued one; returns
   * null when one is already waiting.
   */
  ifBusy: 'refuse' | 'once';
  /** A step to record on the run as it is queued, e.g. that it catches up a missed slot. */
  note?: { name: string; [key: string]: unknown };
  /**
   * A model a person named for this run. It is used as chosen, in place of the
   * spec's primary model, and the run never falls back to another.
   */
  model?: string;
}

/**
 * Queue a run of `automation` and start it at once if the limits allow.
 * Returns as soon as the run record exists; `done` settles when it has ended
 * (after any retries) in this gateway.
 */
export function enqueueAutomationRun(
  automation: Automation,
  trigger: 'schedule' | 'manual',
  d: RunnerDeps,
  opts: EnqueueOptions
): { runId: string; queued: boolean; done: Promise<void> } | null {
  if (!deps) startAutomationQueue(d);
  const runId = queueRunRow(automation, trigger, opts);
  if (!runId) return null;
  const done = new Promise<void>((resolve) => {
    const list = waiters.get(runId) ?? [];
    list.push(resolve);
    waiters.set(runId, list);
  });
  pumpQueue();
  return { runId, queued: statusOf(runId) === 'queued', done };
}

/** Start the queue with these deps if it is not running, else look at it again. */
export function nudgeAutomationQueue(d: RunnerDeps): void {
  if (!deps) startAutomationQueue(d);
  else pumpQueue();
}

/**
 * The store writes of queueing a run, and nothing else: no run is started, so
 * a caller can make them part of its own transaction (the scheduler claims
 * its slot in the same one) and nudge the queue after it commits. Returns the
 * run's id, or null when `ifBusy: 'once'` finds one already waiting.
 */
export function queueRunRow(
  automation: Automation,
  trigger: 'schedule' | 'manual',
  opts: EnqueueOptions
): string | null {
  const spec = automation.spec;
  if (!spec) throw new SpecError(`Fix the spec before running it: ${automation.problem}`);
  const { queued, going } = runsOf(automation.id);
  if (opts.ifBusy === 'refuse' && (queued || going)) {
    throw new AutomationBusy(
      queued
        ? `"${automation.name}" already has a run waiting.`
        : `"${automation.name}" is already running.`
    );
  }
  if (queued) return null;

  const runId = createRun({
    trigger,
    automationId: automation.id,
    input: spec.prompt,
    status: 'queued',
    repoId: ensureLocalRepo(spec.repo.path),
    modelOverride: opts.model,
  });
  if (opts.note) {
    const { name, ...rest } = opts.note;
    addRunStep(runId, { kind: 'tool', input: { name }, output: rest, status: 'ok' });
  }
  emit('run.queued', { automationId: automation.id, trigger }, { runId });
  return runId;
}

/**
 * Start a run of `automation` by hand: queued, and started at once unless the
 * limit on runs at once is reached. Refused while the automation has a run
 * queued or going.
 */
export function startAutomationRun(
  automation: Automation,
  trigger: 'schedule' | 'manual',
  d: RunnerDeps,
  opts: { model?: string } = {}
): { runId: string; queued: boolean; done: Promise<void> } {
  return enqueueAutomationRun(automation, trigger, d, { ifBusy: 'refuse', ...opts }) as {
    runId: string;
    queued: boolean;
    done: Promise<void>;
  };
}

/** A queued run, as the fair pick sees it. */
export interface Candidate {
  id: string;
  automationId: string;
  repoId: string | null;
  createdAt: string;
}

/**
 * The next run to start, fairly across repositories: the repository with the
 * fewest runs going, then the one served longest ago (never served first),
 * then the one whose oldest run has waited longest; within the repository,
 * its oldest run. Candidates must already exclude automations that are busy.
 */
export function pickFair(
  candidates: Candidate[],
  goingByRepo: ReadonlyMap<string, number>,
  lastServed: ReadonlyMap<string, number>
): Candidate | undefined {
  const oldest = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = c.repoId ?? '';
    const seen = oldest.get(key);
    if (!seen || c.createdAt < seen.createdAt || (c.createdAt === seen.createdAt && c.id < seen.id))
      oldest.set(key, c);
  }
  let best: { key: string; c: Candidate } | undefined;
  for (const [key, c] of oldest) {
    if (!best) {
      best = { key, c };
      continue;
    }
    const a = [goingByRepo.get(key) ?? 0, lastServed.get(key) ?? -1, c.createdAt] as const;
    const b = [
      goingByRepo.get(best.key) ?? 0,
      lastServed.get(best.key) ?? -1,
      best.c.createdAt,
    ] as const;
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
      best = { key, c };
    }
  }
  return best?.c;
}

/** Lease the next run the limits allow, or null. The lease is written before the run starts. */
function claimNext(d: RunnerDeps): Candidate | null {
  const db = getStore();
  const now = new Date();
  const nowIso = now.toISOString();
  return db.transaction(() => {
    // Going: a live lease in the store (any gateway), and whatever this one holds.
    const going = new Map<string, Held>(held);
    for (const r of db
      .prepare(
        `SELECT id, automation_id, repo_id FROM runs
         WHERE status IN (${LEASED_SQL}) AND automation_id IS NOT NULL
           AND (lease_until IS NULL OR lease_until > ?)`
      )
      .all(nowIso)) {
      going.set(String(r.id), {
        automationId: String(r.automation_id),
        repoId: r.repo_id ? String(r.repo_id) : null,
      });
    }
    const limit = d.maxConcurrent ?? 2;
    if (going.size >= limit) return null;

    const busy = new Set([...going.values()].map((g) => g.automationId));
    const byRepo = new Map<string, number>();
    for (const g of going.values())
      byRepo.set(g.repoId ?? '', (byRepo.get(g.repoId ?? '') ?? 0) + 1);

    const candidates: Candidate[] = db
      .prepare(
        `SELECT id, automation_id, repo_id, created_at FROM runs
         WHERE status = 'queued' AND automation_id IS NOT NULL
           AND (not_before IS NULL OR not_before <= ?)
         ORDER BY created_at, id`
      )
      .all(nowIso)
      .map((r) => ({
        id: String(r.id),
        automationId: String(r.automation_id),
        repoId: r.repo_id ? String(r.repo_id) : null,
        createdAt: String(r.created_at),
      }))
      .filter((c) => !busy.has(c.automationId));
    const pick = pickFair(candidates, byRepo, served);
    if (!pick) return null;

    const owner = gatewayOwner();
    const res = db
      .prepare(
        `UPDATE runs SET status = 'leased', lease_until = ?, owner_pid = ?, owner_start = ?,
           started_at = COALESCE(started_at, ?), not_before = NULL, exit_reason = NULL
         WHERE id = ? AND status = 'queued'`
      )
      .run(
        new Date(now.getTime() + leaseMsOf(d)).toISOString(),
        owner.pid,
        owner.start,
        nowIso,
        pick.id
      );
    if (Number(res.changes) === 0) return null;
    served.set(pick.repoId ?? '', ++servedSeq);
    return pick;
  });
}

/** Start as many queued runs as the limits allow, then look again when one is due. */
export function pumpQueue(): void {
  const d = deps;
  if (!d || paused || !isStoreOpen()) return;
  try {
    // A queued run whose automation was deleted has nothing to run.
    for (const r of getStore()
      .prepare("SELECT id FROM runs WHERE status = 'queued' AND automation_id IS NULL")
      .all()) {
      failAbandonedRun(String(r.id), 'The automation was deleted before this run started.');
    }
    // A scheduled run of an automation switched off since it was queued (a
    // retry, say) does not start.
    for (const r of getStore()
      .prepare(
        `SELECT r.id FROM runs r JOIN automations a ON a.id = r.automation_id
         WHERE r.status = 'queued' AND r.trigger = 'schedule' AND a.enabled = 0`
      )
      .all()) {
      cancelQueuedRun(String(r.id), 'The automation was switched off before this run started.');
    }
    for (let pick = claimNext(d); pick; pick = claimNext(d)) launch(pick, d);
  } catch (e) {
    logger.error('Could not start queued automation runs', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  armPump();
}

let soon: ReturnType<typeof setImmediate> | undefined;
function pumpSoon(): void {
  soon ??= setImmediate(() => {
    soon = undefined;
    pumpQueue();
  });
}

function armPump(): void {
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = undefined;
  if (!deps || paused || !isStoreOpen()) return;
  const row = getStore()
    .prepare(
      "SELECT MIN(not_before) AS at FROM runs WHERE status = 'queued' AND not_before IS NOT NULL"
    )
    .get();
  const due = row?.at ? Date.parse(String(row.at)) - Date.now() : Infinity;
  pumpTimer = setTimeout(pumpQueue, Math.max(10, Math.min(due, IDLE_PUMP_MS)));
  pumpTimer.unref?.();
}

function launch(pick: Candidate, d: RunnerDeps): void {
  emit('run.status', { status: 'leased' }, { runId: pick.id });
  const automation = getAutomation(pick.automationId);
  if (!automation?.spec) {
    failAbandonedRun(
      pick.id,
      automation
        ? `Fix the spec before running it: ${automation.problem}`
        : 'The automation was deleted before this run started.'
    );
    settle(pick.id);
    return;
  }
  held.set(pick.id, { automationId: pick.automationId, repoId: pick.repoId });
  if (!renewTimer) {
    renewTimer = setInterval(renewLeases, Math.max(50, Math.floor(leaseMsOf(d) / 3)));
    renewTimer.unref?.();
  }
  void runLeased(pick.id, automation, d).finally(() => {
    held.delete(pick.id);
    if (statusOf(pick.id) !== 'queued') settle(pick.id);
    if (!deps && held.size === 0 && renewTimer) {
      clearInterval(renewTimer);
      renewTimer = undefined;
    }
    pumpQueue();
  });
}

/** Push the leases of the runs this gateway is working on a lease period ahead. */
export function renewLeases(): void {
  if (held.size === 0 || !isStoreOpen()) return;
  try {
    const until = new Date(Date.now() + leaseMsOf()).toISOString();
    const owner = gatewayOwner();
    const ids = [...held.keys()];
    getStore()
      .prepare(
        `UPDATE runs SET lease_until = ?
         WHERE id IN (${ids.map(() => '?').join(', ')}) AND owner_pid = ? AND status IN (${LEASED_SQL})`
      )
      .run(until, ...ids, owner.pid);
  } catch (e) {
    logger.warn('Could not renew automation run leases', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

async function reapExpired(): Promise<void> {
  if (reaping || !deps || !isStoreOpen()) return;
  reaping = true;
  try {
    const reclaimed = await reclaimExpiredLeases({ held: heldRunIds() });
    if (reclaimed.length > 0) pumpQueue();
  } catch (e) {
    logger.warn('Could not check automation run leases', {
      err: e instanceof Error ? e.message : String(e),
    });
  } finally {
    reaping = false;
  }
}
