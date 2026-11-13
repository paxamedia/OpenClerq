/**
 * Schedules for enabled automations, and what happens to a slot nobody was
 * awake for.
 *
 * One clock watches every scheduled automation. It checks at the next slot
 * due, and at least every 15 seconds; each check compares the automation's
 * slots since `last_slot_at` (the latest one dealt with, kept in the store)
 * with the time now:
 *
 *   - the latest slot, if it is at most two minutes old, is on time: its run
 *     is queued;
 *   - older slots were missed: the machine slept, or the gateway was down. With
 *     `on.catch_up: true` they are caught up by one run, however many there
 *     were, when they are noticed (on wake or on start). Without it they are
 *     skipped, and that is recorded in the audit log and on the event bus.
 *
 * `last_slot_at` is written before the run is queued, so a slot is dealt with
 * once even across a restart. A sleep is noticed as a jump of the wall clock
 * against the monotonic one, which stops while the machine sleeps; the slots
 * missed are found from `last_slot_at` either way.
 *
 * Slots missed while the kill switch held schedules paused are skipped
 * whatever the spec says: the pause meant "do not run".
 */

import cron, { type ScheduledTask } from 'node-cron';
import { audit } from '@clerq/store';
import { getStore, isStoreOpen } from '../store.js';
import { emit } from '../events.js';
import { logger } from '../logger.js';
import { listAutomations, setNextRunAt, type Automation } from './store.js';
import { nudgeAutomationQueue, queueRunRow } from './queue.js';
import type { RunnerDeps } from './runner.js';

/** A slot noticed later than this was missed rather than run late. */
export const ON_TIME_MS = 2 * 60_000;
/** The longest the clock waits between checks. */
const HEARTBEAT_MS = 15_000;
/** A wall clock this far ahead of the monotonic one means the machine slept. */
const WAKE_JUMP_MS = 30_000;
/** Missed slots are counted up to this many. */
const MAX_COUNTED = 1_000;

interface Matcher {
  getNextMatch(date: Date): Date;
}

/** node-cron exposes only the next run; its matcher, which it uses for that, walks further. */
function matcherOf(task: ScheduledTask): Matcher | null {
  const matcher = (task as unknown as { runner?: { timeMatcher?: Matcher } }).runner?.timeMatcher;
  return typeof matcher?.getNextMatch === 'function' ? matcher : null;
}

/** When a cron expression next fires, in the host's time zone. */
export function nextRunOf(expression: string): Date | null {
  return nextRunsOf(expression, 1)[0] ?? null;
}

/**
 * The next `count` times a cron expression fires after `from`, in the host's
 * time zone. Empty for an invalid expression.
 */
export function nextRunsOf(expression: string, count: number, from = new Date()): Date[] {
  if (!cron.validate(expression) || count < 1) return [];
  const probe = cron.createTask(expression, () => undefined);
  try {
    // Fall back to the one run if node-cron's matcher ever moves.
    const matcher = matcherOf(probe);
    if (!matcher) {
      probe.start();
      const next = probe.getNextRun();
      return next ? [next] : [];
    }
    const out: Date[] = [];
    let at = from;
    while (out.length < count) {
      at = matcher.getNextMatch(at);
      out.push(at);
    }
    return out;
  } finally {
    void probe.destroy();
  }
}

/** Slots after one time and up to another. */
export interface DueSlots {
  /** How many, counted up to 1,000. */
  count: number;
  /** True when there were more than were counted. */
  capped: boolean;
  first: Date;
  latest: Date;
  /** The slot before the latest, or null when there was one slot. */
  previous: Date | null;
}

/**
 * The slots of a cron expression after `after` and at or before `until`, or
 * null when there are none (or the expression cannot be walked).
 */
export function dueSlots(expression: string, after: Date, until: Date): DueSlots | null {
  if (!cron.validate(expression)) return null;
  const probe = cron.createTask(expression, () => undefined);
  try {
    const m = matcherOf(probe);
    if (!m) return null;
    const end = until.getTime();
    const first = m.getNextMatch(after);
    if (first.getTime() > end) return null;
    let latest = first;
    let previous: Date | null = null;
    let count = 1;
    for (;;) {
      const next = m.getNextMatch(latest);
      if (next.getTime() > end) return { count, capped: false, first, latest, previous };
      previous = latest;
      latest = next;
      count += 1;
      if (count >= MAX_COUNTED) break;
    }
    // Too many to walk: find the latest by starting closer to the end.
    for (const window of [3_600_000, 86_400_000, 31 * 86_400_000, 366 * 86_400_000]) {
      let probeAt = m.getNextMatch(new Date(end - window));
      if (probeAt.getTime() > end) continue;
      let before: Date | null = null;
      for (let n = m.getNextMatch(probeAt); n.getTime() <= end; n = m.getNextMatch(probeAt)) {
        before = probeAt;
        probeAt = n;
      }
      if (probeAt.getTime() > latest.getTime()) {
        previous = before ?? latest;
        latest = probeAt;
      }
      break;
    }
    return { count, capped: true, first, latest, previous };
  } finally {
    void probe.destroy();
  }
}

/** Wall-clock and monotonic time, so tests can move them. */
export interface ScheduleClock {
  now(): number;
  mono(): number;
}

const systemClock: ScheduleClock = {
  now: () => Date.now(),
  mono: () => performance.now(),
};

export type CheckReason = 'start' | 'resume' | 'tick' | 'wake';

let state:
  | {
      deps: RunnerDeps;
      clock: ScheduleClock;
      timer?: ReturnType<typeof setTimeout>;
      lastWall: number;
      lastMono: number;
      ids: string[];
    }
  | undefined;

export function stopAutomationSchedules(): void {
  if (state?.timer) clearTimeout(state.timer);
  state = undefined;
}

/**
 * (Re)start the schedules of every enabled automation that has one, and deal
 * at once with any slot missed since each was last checked. `resume` is set
 * when the kill switch is released: slots missed while it held schedules
 * paused are skipped, never caught up.
 */
export function startAutomationSchedules(
  deps: RunnerDeps,
  opts: { clock?: ScheduleClock; resume?: boolean; timers?: boolean } = {}
): void {
  stopAutomationSchedules();
  const clock = opts.clock ?? systemClock;
  state = { deps, clock, lastWall: clock.now(), lastMono: clock.mono(), ids: [] };
  for (const automation of listAutomations()) {
    const schedule = automation.spec?.schedule;
    if (!automation.enabled || !schedule) {
      // Not scheduled, so it has no next run, whatever an earlier start recorded.
      if (automation.nextRunAt) setNextRunAt(automation.id, null);
      continue;
    }
    state.ids.push(automation.id);
    setNextRunAt(automation.id, nextRunOf(schedule));
  }
  checkSchedules(opts.resume ? 'resume' : 'start');
  if (opts.timers !== false) arm();
}

export function scheduledAutomationIds(): string[] {
  return [...(state?.ids ?? [])];
}

function arm(): void {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  const now = state.clock.now();
  let wait = HEARTBEAT_MS;
  for (const a of listAutomations()) {
    if (!a.enabled || !a.spec?.schedule || !a.nextRunAt) continue;
    wait = Math.min(wait, Date.parse(a.nextRunAt) - now);
  }
  state.timer = setTimeout(
    () => {
      checkSchedules('tick');
      arm();
    },
    Math.max(50, wait + 20)
  );
  state.timer.unref?.();
}

/**
 * Look at every scheduled automation now: queue the run of a slot that is
 * due, and catch up or record the slots that were missed. Called by the
 * clock; tests call it directly.
 */
export function checkSchedules(reason: CheckReason = 'tick'): void {
  if (!state || !isStoreOpen()) return;
  const wall = state.clock.now();
  const mono = state.clock.mono();
  const jump = wall - state.lastWall - (mono - state.lastMono);
  state.lastWall = wall;
  state.lastMono = mono;
  if (reason === 'tick' && jump > WAKE_JUMP_MS) {
    reason = 'wake';
    logger.info('The machine woke from sleep; checking for missed automation slots', {
      sleptMs: Math.round(jump),
    });
    emit('schedule.woke', { sleptMs: Math.round(jump) });
  }
  const now = new Date(wall);
  for (const automation of listAutomations()) {
    try {
      checkOne(automation, now, reason);
    } catch (e) {
      logger.error('Could not check an automation schedule', {
        automation: automation.name,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function checkOne(automation: Automation, now: Date, reason: CheckReason): void {
  const spec = automation.spec;
  if (!automation.enabled || !spec?.schedule || !state) return;
  const last = rawLastSlotAt(automation.id);
  if (!last) {
    // A schedule counts from when it is first seen, never from before.
    claimSlot(automation.id, null, now);
    return;
  }
  takeDueSlots(automation, last, now, reason);
}

/** The stored `last_slot_at`, exactly as written, for a compare-and-set. */
function rawLastSlotAt(id: string): string | null {
  const row = getStore().prepare('SELECT last_slot_at FROM automations WHERE id = ?').get(id);
  return row?.last_slot_at ? String(row.last_slot_at) : null;
}

/** Move `last_slot_at` from `expected` to `to`, only if it is still `expected`. */
function claimSlot(id: string, expected: string | null, to: Date): boolean {
  const res = getStore()
    .prepare('UPDATE automations SET last_slot_at = ? WHERE id = ? AND last_slot_at IS ?')
    .run(to.toISOString(), id, expected);
  return Number(res.changes) === 1;
}

/**
 * Deal with the slots after `expectedLast` (the `last_slot_at` this gateway
 * read): claim them by moving `last_slot_at` on, and queue their run, in one
 * transaction. When another gateway sharing the store moved it first, they
 * are its, and nothing happens here. A run that cannot be queued (one is
 * already waiting, or the write failed) still uses up its slots, which are
 * recorded as missed, so no slot is ever silently lost or run twice.
 */
export function takeDueSlots(
  automation: Automation,
  expectedLast: string,
  now: Date,
  reason: CheckReason
): void {
  const spec = automation.spec;
  if (!spec?.schedule || !state) return;
  const due = dueSlots(spec.schedule, new Date(expectedLast), now);
  if (!due) return;

  const onTime = now.getTime() - due.latest.getTime() <= ON_TIME_MS;
  const missed = onTime ? due.count - 1 : due.count;
  const catchUp = spec.catchUp && reason !== 'resume';
  const runIt = onTime || (catchUp && missed > 0);
  const caughtUp = runIt && catchUp && missed > 0;

  let claimed = false;
  let runId: string | null = null;
  let failure: string | undefined;
  const queue = () =>
    queueRunRow(automation, 'schedule', {
      ifBusy: 'once',
      note: caughtUp
        ? {
            name: 'schedule.catch_up',
            missedSlots: due.count,
            countCapped: due.capped,
            firstMissed: due.first.toISOString(),
            slot: due.latest.toISOString(),
            noticed: reason,
          }
        : undefined,
    });
  try {
    getStore().transaction(() => {
      if (!claimSlot(automation.id, expectedLast, due.latest)) return;
      claimed = true;
      if (runIt) runId = queue();
    });
  } catch (e) {
    // The run could not be written, so nothing was: claim the slots alone.
    failure = e instanceof Error ? e.message : String(e);
    claimed = claimSlot(automation.id, expectedLast, due.latest);
  }
  if (!claimed) return;
  setNextRunAt(automation.id, nextRunOf(spec.schedule));

  if (runId) {
    nudgeAutomationQueue(state.deps);
    logger.info(
      caughtUp ? 'Missed automation slots caught up' : 'Scheduled automation run queued',
      {
        automation: automation.name,
        runId,
        slot: due.latest.toISOString(),
        ...(caughtUp ? { missedSlots: due.count } : {}),
      }
    );
  } else if (runIt) {
    // The slots this run was for: all of them when catching up, else the latest.
    recordMissed(automation, {
      count: caughtUp ? due.count : 1,
      capped: caughtUp && due.capped,
      first: caughtUp ? due.first : due.latest,
      last: due.latest,
      reason: failure ? 'enqueue_failed' : 'already_queued',
      noticed: reason,
      ...(failure ? { error: failure } : {}),
    });
  }
  if (missed > 0 && !catchUp) {
    recordMissed(automation, {
      count: missed,
      capped: due.capped,
      first: due.first,
      // The on-time slot runs; the one before it is the last missed.
      last: onTime ? due.previous : due.latest,
      reason: reason === 'resume' ? 'paused' : 'catch_up_off',
      noticed: reason,
    });
  }
}

/** What a skipped run of slots is recorded as. */
export interface MissedSlots {
  count: number;
  capped: boolean;
  first: string;
  last: string | null;
  /**
   * `catch_up_off`: the spec does not catch up. `paused`: the kill switch held
   * schedules. `already_queued`: a run of the automation was still waiting.
   * `enqueue_failed`: the run could not be written (`error` says why).
   */
  reason: 'catch_up_off' | 'paused' | 'already_queued' | 'enqueue_failed';
  error?: string;
  noticed: CheckReason;
  at: string;
}

function recordMissed(
  automation: Automation,
  m: {
    count: number;
    capped: boolean;
    first: Date;
    last: Date | null;
    reason: MissedSlots['reason'];
    noticed: CheckReason;
    error?: string;
  }
): void {
  const detail = {
    count: m.count,
    capped: m.capped,
    first: m.first.toISOString(),
    last: m.last ? m.last.toISOString() : null,
    reason: m.reason,
    noticed: m.noticed,
    ...(m.error ? { error: m.error.slice(0, 500) } : {}),
  };
  audit(getStore(), {
    actor: 'scheduler',
    action: 'automation.slots_missed',
    subject: automation.id,
    detail,
  });
  emit('schedule.missed', { automationId: automation.id, ...detail });
  logger.warn('Automation slots missed and skipped', { automation: automation.name, ...detail });
}

/** The latest record of slots an automation skipped, or null. */
export function lastMissedSlots(automationId: string): MissedSlots | null {
  const row = getStore()
    .prepare(
      `SELECT at, detail FROM audit_log WHERE action = 'automation.slots_missed' AND subject = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(automationId);
  if (!row?.detail) return null;
  try {
    return { ...(JSON.parse(String(row.detail)) as Omit<MissedSlots, 'at'>), at: String(row.at) };
  } catch {
    return null;
  }
}
