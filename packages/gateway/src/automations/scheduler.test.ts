import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dueSlots } from './scheduler.js';

// Schedules are in the host's time zone; pin one with daylight saving time.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

describe('dueSlots', () => {
  it('counts the slots after one time and up to another, the end included', () => {
    const due = dueSlots(
      '0 * * * *',
      new Date('2026-06-01T08:15:00Z'),
      new Date('2026-06-01T11:00:00Z')
    );
    expect(due).toMatchObject({ count: 3, capped: false });
    expect([iso(due?.first), iso(due?.previous), iso(due?.latest)]).toEqual([
      '2026-06-01T09:00:00.000Z',
      '2026-06-01T10:00:00.000Z',
      '2026-06-01T11:00:00.000Z',
    ]);
    expect(
      dueSlots('0 * * * *', new Date('2026-06-01T08:15:00Z'), new Date('2026-06-01T08:59:00Z'))
    ).toBeNull();
    expect(dueSlots('not cron', new Date(0), new Date())).toBeNull();
  });

  it('stops counting at a thousand and still finds the latest slot from closer to the end', () => {
    // Every minute for four days: 5,760 slots.
    const due = dueSlots(
      '* * * * *',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-05T00:00:30Z')
    );
    expect(due).toMatchObject({ count: 1_000, capped: true });
    expect(iso(due?.first)).toBe('2026-01-01T00:01:00.000Z');
    expect(iso(due?.latest)).toBe('2026-01-05T00:00:00.000Z');
    expect(iso(due?.previous)).toBe('2026-01-04T23:59:00.000Z');

    // Weekly over twenty years: the latest is found in the widest window.
    const weekly = dueSlots(
      '0 3 * * 1',
      new Date('2006-01-01T00:00:00Z'),
      new Date('2026-11-13T12:00:00Z')
    );
    expect(weekly).toMatchObject({ count: 1_000, capped: true });
    expect(iso(weekly?.latest)).toBe('2026-11-09T08:00:00.000Z');
  });

  it('skips a slot that does not exist when the clocks go forward', () => {
    // 02:30 does not exist on 8 March 2026 in New York.
    const due = dueSlots(
      '30 2 * * *',
      new Date('2026-03-07T17:00:00Z'),
      new Date('2026-03-09T16:00:00Z')
    );
    expect(due?.count).toBe(1);
    expect(iso(due?.latest)).toBe('2026-03-09T06:30:00.000Z');
    // Hourly across the change: 01:00 EST, then 03:00 and 04:00 EDT.
    const hourly = dueSlots(
      '0 * * * *',
      new Date('2026-03-08T05:30:00Z'),
      new Date('2026-03-08T08:30:00Z')
    );
    expect(hourly?.count).toBe(3);
  });

  it('runs a repeated hour once when the clocks go back', () => {
    // 01:30 happens twice on 1 November 2026 in New York: once is counted.
    const due = dueSlots(
      '30 1 * * *',
      new Date('2026-10-31T16:00:00Z'),
      new Date('2026-11-02T17:00:00Z')
    );
    expect(due?.count).toBe(2);
    expect([iso(due?.first), iso(due?.latest)]).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ]);
    const hourly = dueSlots(
      '0 * * * *',
      new Date('2026-11-01T04:30:00Z'),
      new Date('2026-11-01T08:30:00Z')
    );
    // 01:00 EDT, 02:00 and 03:00 EST: the second 01:00 is not run again.
    expect(hourly?.count).toBe(3);
  });
});
