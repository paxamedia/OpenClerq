/**
 * Persistent run: "N runs per hour, day, week or month" as a gateway cron
 * trigger. The gateway schedules it, so it fires whether or not a desktop
 * window is open, and each firing is recorded as a scheduled run.
 *
 * POST /triggers replaces the whole trigger set. This owns one trigger id and
 * sends every other trigger back exactly as it read them.
 */

export type RunPeriod = 'hour' | 'day' | 'week' | 'month';

export interface CronTrigger {
  id: string;
  schedule: string;
  message: string;
}

export interface TriggersConfig {
  cron?: CronTrigger[];
  file?: Array<{ id: string; path: string; message: string }>;
  webhooks?: Record<string, { message: string }>;
}

/** The subset of the gateway client that reads and replaces triggers. */
export interface TriggersApi {
  triggers(): Promise<TriggersConfig>;
  saveTriggers(config: TriggersConfig): Promise<unknown>;
}

/** The trigger the Persistent run settings own. */
export const PERSISTENT_RUN_TRIGGER_ID = 'desktop-persistent-run';

/** Sent when the task message is left empty, by "Run now" and by the schedule. */
export const DEFAULT_RUN_MESSAGE = 'Check for pending tasks';

/**
 * The most runs a period holds with each run in its own slot of the next
 * smaller unit: minutes of an hour, hours of a day, days of a week, and the 28
 * days every month has. More than that needs a shorter period.
 */
export const MAX_RUNS: Record<RunPeriod, number> = { hour: 60, day: 24, week: 7, month: 28 };

/** Guards values read from config.json, which people also edit by hand. */
export function isRunPeriod(value: unknown): value is RunPeriod {
  return typeof value === 'string' && Object.keys(MAX_RUNS).includes(value);
}

const SHORTER: Record<RunPeriod, RunPeriod | null> = {
  hour: null,
  day: 'hour',
  week: 'day',
  month: 'day',
};

/** Daily and longer schedules start at 09:00 local time, when a desktop is likely awake. */
const FIRST_HOUR = 9;
/** Weekly schedules start on Monday. */
const MONDAY = 1;

/** `count` of the `size` slots, evenly spaced from `first` and wrapping past the end. */
function spread(count: number, size: number, first: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => (first + Math.floor((i * size) / count)) % size
  ).sort((a, b) => a - b);
}

/** A cron field: `*` when it covers the whole unit, a range when consecutive, else a list. */
function field(values: number[], unitSize: number): string {
  if (values.length === unitSize) return '*';
  const lo = values[0];
  const hi = values[values.length - 1];
  if (values.length > 2 && hi - lo === values.length - 1) return `${lo}-${hi}`;
  return values.join(',');
}

/**
 * The cron expression for `count` runs per `period`, spread evenly: hourly runs
 * from minute 0, daily runs from 09:00, weekly runs at 09:00 from Monday, and
 * monthly runs at 09:00 from the 1st.
 *
 * Throws a RangeError, worded for the settings form, when `count` is not a
 * whole number from 1 to MAX_RUNS[period] or `period` is not a period.
 */
export function cronForRuns(count: number, period: RunPeriod): string {
  if (!isRunPeriod(period)) {
    throw new RangeError(`"${String(period)}" is not a period. Choose hour, day, week or month.`);
  }
  const max = MAX_RUNS[period];
  if (!Number.isInteger(count) || count < 1 || count > max) {
    const shorter = SHORTER[period];
    throw new RangeError(
      `Runs per ${period} must be a whole number from 1 to ${max}.` +
        (shorter ? ` For more, choose runs per ${shorter}.` : '')
    );
  }
  switch (period) {
    case 'hour':
      return `${field(spread(count, 60, 0), 60)} * * * *`;
    case 'day':
      return `0 ${field(spread(count, 24, FIRST_HOUR), 24)} * * *`;
    case 'week':
      return `0 ${FIRST_HOUR} * * ${field(spread(count, 7, MONDAY), 7)}`;
    case 'month': {
      const days = spread(count, 28, 0).map((d) => d + 1);
      return `0 ${FIRST_HOUR} ${field(days, 31)} * *`;
    }
  }
}

/**
 * The trigger the settings describe, or null when runs are manual. Throws like
 * cronForRuns when the count does not fit the period.
 */
export function persistentRunTrigger(run: {
  mode: 'manual' | 'auto';
  count: number;
  period: RunPeriod;
  message: string;
}): CronTrigger | null {
  if (run.mode !== 'auto') return null;
  return {
    id: PERSISTENT_RUN_TRIGGER_ID,
    schedule: cronForRuns(run.count, run.period),
    message: run.message.trim() || DEFAULT_RUN_MESSAGE,
  };
}

/**
 * `current` with the persistent-run trigger set to `trigger`, or removed when
 * `trigger` is null. Every other trigger is kept as it is. Returns null when
 * nothing would change, so an unchanged save does not restart the gateway's
 * schedules.
 */
export function withPersistentRun(
  current: TriggersConfig,
  trigger: CronTrigger | null
): TriggersConfig | null {
  const cron = current.cron ?? [];
  const existing = cron.find((t) => t.id === PERSISTENT_RUN_TRIGGER_ID);
  if (!trigger && !existing) return null;
  if (
    trigger &&
    existing &&
    existing.schedule === trigger.schedule &&
    existing.message === trigger.message
  ) {
    return null;
  }
  const others = cron.filter((t) => t.id !== PERSISTENT_RUN_TRIGGER_ID);
  return { ...current, cron: trigger ? [...others, trigger] : others };
}

/**
 * Make the gateway's persistent-run trigger match `trigger`: read the whole
 * set, change that one entry and post the whole set back. Returns whether
 * anything was saved.
 */
export async function syncPersistentRun(
  api: TriggersApi,
  trigger: CronTrigger | null
): Promise<boolean> {
  const next = withPersistentRun(await api.triggers(), trigger);
  if (!next) return false;
  await api.saveTriggers(next);
  return true;
}
