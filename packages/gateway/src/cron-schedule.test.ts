import { describe, it, expect } from 'vitest';
import cron from 'node-cron';
import { nextRunsOf } from './automations/scheduler.js';

/**
 * node-cron 4.2.1 put the next "0 8 * * 1" in January 2029. Its scheduler
 * sleeps until the next match, so a weekday or monthly trigger could go on
 * never firing. These pin the version that gets it right.
 */
function nextRun(expression: string): Date {
  const task = cron.schedule(expression, () => undefined);
  try {
    return task.getNextRun() as Date;
  } finally {
    void task.destroy();
  }
}

describe('cron schedules', () => {
  it('wake for the coming Monday, not some later year', () => {
    const next = nextRun('0 8 * * 1');
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(8);
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 3_600_000);
  });

  it('wake on the first of the coming month', () => {
    const next = nextRun('30 2 1 * *');
    expect(next.getDate()).toBe(1);
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(32 * 24 * 3_600_000);
  });

  it('lists the next firings in order', () => {
    const from = new Date(2026, 10, 9, 8, 0);
    const runs = nextRunsOf('*/15 9-10 * * 1-5', 10, from);
    expect(runs).toHaveLength(10);
    expect(runs[0]).toEqual(new Date(2026, 10, 9, 9, 0));
    expect(runs[8]).toEqual(new Date(2026, 10, 10, 9, 0)); // the next weekday
    expect(nextRunsOf('not cron', 3)).toEqual([]);
  });
});
