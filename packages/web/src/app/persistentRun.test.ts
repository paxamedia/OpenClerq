import { describe, it, expect, vi } from 'vitest';
// The validator the gateway runs on POST /triggers.
import { validate } from 'node-cron';
import {
  cronForRuns,
  isRunPeriod,
  persistentRunTrigger,
  withPersistentRun,
  syncPersistentRun,
  MAX_RUNS,
  PERSISTENT_RUN_TRIGGER_ID,
  DEFAULT_RUN_MESSAGE,
  type RunPeriod,
  type TriggersConfig,
} from './persistentRun';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The values a cron field allows, for the `*`, `a-b` and `a,b,c` forms cronForRuns writes. */
function values(spec: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [a, b] = part === '*' ? [lo, hi] : part.split('-').map(Number);
    for (let v = a; v <= (b ?? a); v++) out.add(v);
  }
  return out;
}

/** Every minute in [from, from + span) that `expr` fires on, reading the clock as UTC. */
function firings(expr: string, from: string, span: number): number[] {
  const [min, hour, dom, mon, dow] = expr.split(' ');
  const m = values(min, 0, 59);
  const h = values(hour, 0, 23);
  const d = values(dom, 1, 31);
  const mo = values(mon, 1, 12);
  const w = values(dow, 0, 6);
  const start = Date.parse(from);
  const out: number[] = [];
  for (let t = start; t < start + span; t += MINUTE) {
    const x = new Date(t);
    if (
      m.has(x.getUTCMinutes()) &&
      h.has(x.getUTCHours()) &&
      d.has(x.getUTCDate()) &&
      mo.has(x.getUTCMonth() + 1) &&
      w.has(x.getUTCDay())
    ) {
      out.push(t);
    }
  }
  return out;
}

const counts = (period: RunPeriod) => Array.from({ length: MAX_RUNS[period] }, (_, i) => i + 1);

describe('cronForRuns', () => {
  it.each([
    [1, 'hour', '0 * * * *'],
    [2, 'hour', '0,30 * * * *'],
    [4, 'hour', '0,15,30,45 * * * *'],
    [60, 'hour', '* * * * *'],
    [1, 'day', '0 9 * * *'],
    [2, 'day', '0 9,21 * * *'],
    [3, 'day', '0 1,9,17 * * *'],
    [24, 'day', '0 * * * *'],
    [1, 'week', '0 9 * * 1'],
    [2, 'week', '0 9 * * 1,4'],
    [3, 'week', '0 9 * * 1,3,5'],
    [6, 'week', '0 9 * * 1-6'],
    [7, 'week', '0 9 * * *'],
    [1, 'month', '0 9 1 * *'],
    [2, 'month', '0 9 1,15 * *'],
    [4, 'month', '0 9 1,8,15,22 * *'],
    [28, 'month', '0 9 1-28 * *'],
  ] as const)('%i per %s is %s', (count, period, expected) => {
    expect(cronForRuns(count, period)).toBe(expected);
  });

  it.each(['hour', 'day', 'week', 'month'] as const)(
    'writes a schedule the gateway accepts for every count per %s',
    (period) => {
      for (const count of counts(period)) {
        const expr = cronForRuns(count, period);
        expect(validate(expr), expr).toBe(true);
        const [, , dom, , dow] = expr.split(' ');
        // Cron ORs day-of-month and day-of-week when both are set, so never set both.
        expect(dom === '*' || dow === '*', expr).toBe(true);
      }
    }
  );

  it.each([
    ['hour', '2026-03-02T10:00:00Z', HOUR],
    ['day', '2026-03-02T00:00:00Z', DAY],
    ['week', '2026-03-02T00:00:00Z', 7 * DAY], // a Monday
    ['month', '2026-02-01T00:00:00Z', 28 * DAY],
    ['month', '2026-03-01T00:00:00Z', 31 * DAY],
  ] as const)('fires exactly count times in a %s from %s', (period, from, span) => {
    for (const count of counts(period)) {
      expect(
        firings(cronForRuns(count, period), from, span),
        `${count} per ${period}`
      ).toHaveLength(count);
    }
  });

  it.each([
    ['hour', MINUTE, 60],
    ['day', HOUR, 24],
    ['week', DAY, 7],
  ] as const)('spaces runs per %s evenly, across the period boundary too', (period, unit, size) => {
    for (const count of counts(period)) {
      const expr = cronForRuns(count, period);
      const runs = firings(expr, '2026-03-02T00:00:00Z', 2 * size * unit).slice(0, count + 1);
      for (let i = 1; i < runs.length; i++) {
        const gap = (runs[i] - runs[i - 1]) / unit;
        expect([Math.floor(size / count), Math.ceil(size / count)], expr).toContain(gap);
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s runs', (count) => {
    expect(() => cronForRuns(count, 'day')).toThrow(RangeError);
  });

  it('rejects a period that is not one, as a hand-edited config.json can hold', () => {
    expect(() => cronForRuns(1, 'year' as RunPeriod)).toThrow('"year" is not a period.');
  });

  it('rejects more runs than the period holds and points at a shorter period', () => {
    expect(() => cronForRuns(61, 'hour')).toThrow(
      'Runs per hour must be a whole number from 1 to 60.'
    );
    expect(() => cronForRuns(25, 'day')).toThrow('from 1 to 24. For more, choose runs per hour.');
    expect(() => cronForRuns(8, 'week')).toThrow('from 1 to 7. For more, choose runs per day.');
    expect(() => cronForRuns(29, 'month')).toThrow('from 1 to 28. For more, choose runs per day.');
  });
});

describe('isRunPeriod', () => {
  it.each(['hour', 'day', 'week', 'month'])('accepts %s', (value) => {
    expect(isRunPeriod(value)).toBe(true);
  });

  it.each(['year', 'Day', '', 'toString', 1, null, undefined])('rejects %s', (value) => {
    expect(isRunPeriod(value)).toBe(false);
  });
});

describe('persistentRunTrigger', () => {
  const run = { mode: 'auto', count: 2, period: 'day', message: '  Tidy the inbox  ' } as const;

  it('is null for manual runs, whatever the count', () => {
    expect(persistentRunTrigger({ ...run, mode: 'manual', count: 0 })).toBeNull();
  });

  it('schedules the trimmed message under the persistent-run id', () => {
    expect(persistentRunTrigger(run)).toEqual({
      id: PERSISTENT_RUN_TRIGGER_ID,
      schedule: '0 9,21 * * *',
      message: 'Tidy the inbox',
    });
  });

  it('falls back to the default message, as Run now does', () => {
    expect(persistentRunTrigger({ ...run, message: '   ' })?.message).toBe(DEFAULT_RUN_MESSAGE);
  });

  it('throws when the count does not fit the period', () => {
    expect(() => persistentRunTrigger({ ...run, count: 30 })).toThrow(RangeError);
  });
});

describe('withPersistentRun', () => {
  const mine = { id: PERSISTENT_RUN_TRIGGER_ID, schedule: '0 9 * * *', message: 'Check' };
  const others: TriggersConfig = {
    cron: [{ id: 'nightly', schedule: '0 2 * * *', message: 'Back up' }],
    file: [{ id: 'inbox', path: '/tmp/inbox', message: 'File changed' }],
    webhooks: { deploy: { message: 'Deployed' } },
  };

  it('adds the trigger and keeps every other trigger', () => {
    expect(withPersistentRun(others, mine)).toEqual({ ...others, cron: [...others.cron!, mine] });
  });

  it('replaces the trigger without duplicating it', () => {
    const current = { ...others, cron: [mine, ...others.cron!] };
    const changed = { ...mine, schedule: '0 9,21 * * *' };
    expect(withPersistentRun(current, changed)).toEqual({
      ...others,
      cron: [...others.cron!, changed],
    });
  });

  it('removes the trigger when runs go back to manual', () => {
    expect(withPersistentRun({ ...others, cron: [...others.cron!, mine] }, null)).toEqual(others);
  });

  it('changes nothing when the trigger is already as wanted', () => {
    expect(withPersistentRun({ ...others, cron: [...others.cron!, mine] }, { ...mine })).toBeNull();
    expect(withPersistentRun(others, null)).toBeNull();
    expect(withPersistentRun({}, null)).toBeNull();
  });

  it('copes with a config that has no cron list', () => {
    expect(withPersistentRun({ webhooks: others.webhooks }, mine)).toEqual({
      webhooks: others.webhooks,
      cron: [mine],
    });
  });
});

describe('syncPersistentRun', () => {
  const nightly = { id: 'nightly', schedule: '0 2 * * *', message: 'Back up' };
  const mine = { id: PERSISTENT_RUN_TRIGGER_ID, schedule: '0 9 * * *', message: 'Check' };

  function api(current: TriggersConfig) {
    return {
      triggers: vi.fn(async () => current),
      saveTriggers: vi.fn(async (_config: TriggersConfig) => ({ ok: true })),
    };
  }

  it('posts the whole set back, not just its own trigger', async () => {
    const gateway = api({ cron: [nightly], file: [], webhooks: {} });
    await expect(syncPersistentRun(gateway, mine)).resolves.toBe(true);
    expect(gateway.saveTriggers).toHaveBeenCalledWith({
      cron: [nightly, mine],
      file: [],
      webhooks: {},
    });
  });

  it('does not post when nothing changes', async () => {
    const gateway = api({ cron: [nightly, mine] });
    await expect(syncPersistentRun(gateway, { ...mine })).resolves.toBe(false);
    expect(gateway.saveTriggers).not.toHaveBeenCalled();
  });

  it('never posts when the current set could not be read', async () => {
    const gateway = api({});
    gateway.triggers.mockRejectedValue(new Error('Gateway 401: unauthorized'));
    await expect(syncPersistentRun(gateway, null)).rejects.toThrow('Gateway 401');
    expect(gateway.saveTriggers).not.toHaveBeenCalled();
  });
});
