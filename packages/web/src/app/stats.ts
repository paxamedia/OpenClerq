/**
 * Figures the screens draw, computed from the gateway's records: daily
 * counts, success rates and spend. Nothing here is estimated.
 */

import type { RunDetail, RunStep, RunSummary } from '@clerq/gateway-client';
import { DAY_MS, daysAgo, monthStart } from './data';

export const FINISHED = new Set(['done', 'failed', 'cancelled']);
export const ACTIVE = new Set(['preparing', 'executing', 'verifying', 'publishing', 'leased']);

export function isFinished(status: string): boolean {
  return FINISHED.has(status);
}

export interface DayValue {
  /** Midnight, local time. */
  day: Date;
  value: number | null;
}

function dayIndex(at: string, first: Date): number {
  const d = new Date(at);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((midnight.getTime() - first.getTime()) / DAY_MS);
}

/** One value per day for the last `days` days, today last. */
export function daily(
  runs: RunSummary[],
  days: number,
  reduce: (runs: RunSummary[]) => number | null,
  now = new Date()
): DayValue[] {
  const first = daysAgo(days - 1, now);
  const buckets: RunSummary[][] = Array.from({ length: days }, () => []);
  for (const r of runs) {
    const i = dayIndex(r.createdAt, first);
    if (i >= 0 && i < days) buckets[i].push(r);
  }
  return buckets.map((b, i) => {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    return { day, value: reduce(b) };
  });
}

/** Done out of done and failed; null with neither. Cancelled runs do not count. */
export function successRate(runs: RunSummary[]): number | null {
  const done = runs.filter((r) => r.status === 'done').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  return done + failed ? done / (done + failed) : null;
}

export function spend(runs: RunSummary[]): number {
  return runs.reduce((sum, r) => sum + (r.costUsd || 0), 0);
}

export function sinceDay(runs: RunSummary[], since: Date): RunSummary[] {
  return runs.filter((r) => Date.parse(r.createdAt) >= since.getTime());
}

export interface MonthSpend {
  spent: number;
  /** Some runs used a model with no known price, so the real figure is higher. */
  atLeast: boolean;
}

export function monthSpend(runs: RunSummary[], now = new Date()): MonthSpend {
  const month = sinceDay(runs, monthStart(now));
  return { spent: spend(month), atLeast: month.some((r) => !r.costKnown) };
}

/** Runs today, so far. */
export function today(runs: RunSummary[], now = new Date()): RunSummary[] {
  return sinceDay(runs, daysAgo(0, now));
}

/** Start and end of a run in milliseconds; a running run ends now. */
export function runSpan(r: RunSummary, now = Date.now()): [number, number] {
  const start = Date.parse(r.startedAt ?? r.createdAt);
  const end = r.finishedAt ? Date.parse(r.finishedAt) : isFinished(r.status) ? start : now;
  return [start, Math.max(end, start)];
}

// ---------------------------------------------------------------------------
// The pipeline of an automation run.
// ---------------------------------------------------------------------------

export type StageId = 'worktree' | 'agent' | 'commit' | 'gates' | 'approval' | 'push' | 'pr';

export const STAGES: Array<{ id: StageId; label: string }> = [
  { id: 'worktree', label: 'Worktree' },
  { id: 'agent', label: 'Agent' },
  { id: 'commit', label: 'Commit' },
  { id: 'gates', label: 'Gates' },
  { id: 'approval', label: 'Approval' },
  { id: 'push', label: 'Push' },
  { id: 'pr', label: 'Pull request' },
];

export type StageState = 'done' | 'current' | 'failed' | 'waiting' | 'skipped' | 'pending';

function gitAction(s: RunStep): string | undefined {
  if (s.kind !== 'git') return undefined;
  return String((s.input as { action?: unknown } | undefined)?.action ?? '');
}

/** Each stage's state, read from the run's steps and status. */
export function pipeline(run: RunDetail): Record<StageId, StageState> {
  const steps = run.steps;
  const has = (action: string) => steps.some((s) => gitAction(s) === action);
  const reached: Record<StageId, boolean> = {
    worktree: has('worktree'),
    agent: steps.some((s) => s.kind === 'llm' || s.kind === 'tool'),
    commit: has('commit'),
    gates: steps.some((s) => s.kind === 'gate'),
    approval: run.status === 'awaiting_approval' || has('push'),
    push: has('push'),
    pr: has('pull_request'),
  };
  const gateFailed = steps.some((s) => s.kind === 'gate' && /fail/.test(s.status ?? ''));

  const out = {} as Record<StageId, StageState>;
  const order = STAGES.map((s) => s.id);
  // The furthest stage the run got to.
  let last = -1;
  order.forEach((id, i) => {
    if (reached[id]) last = i;
  });
  const statusStage: Partial<Record<string, StageId>> = {
    preparing: 'worktree',
    leased: 'worktree',
    executing: 'agent',
    verifying: 'gates',
    awaiting_approval: 'approval',
    publishing: has('push') ? 'pr' : 'push',
  };
  const current = statusStage[run.status];
  const currentIndex = current ? order.indexOf(current) : -1;

  // Where a failed or cancelled run stopped. Single-step stages that were
  // recorded finished; the agent and the gates can fail part-way through.
  const lastId = last >= 0 ? order[last] : null;
  const stoppedAt = gateFailed
    ? order.indexOf('gates')
    : lastId === null
      ? 0
      : lastId === 'agent' || lastId === 'gates'
        ? last
        : Math.min(last + 1, order.length - 1);

  order.forEach((id, i) => {
    if (run.status === 'done') {
      out[id] = reached[id] ? 'done' : 'skipped';
    } else if (current) {
      if (i < currentIndex) out[id] = reached[id] || id === 'approval' ? 'done' : 'skipped';
      else if (i === currentIndex) out[id] = id === 'approval' ? 'waiting' : 'current';
      else out[id] = 'pending';
    } else if (run.status === 'failed' || run.status === 'cancelled') {
      if (i < stoppedAt) out[id] = reached[id] ? 'done' : 'skipped';
      else if (i === stoppedAt) out[id] = run.status === 'failed' ? 'failed' : 'skipped';
      else out[id] = 'pending';
    } else {
      out[id] = 'pending';
    }
  });
  return out;
}
