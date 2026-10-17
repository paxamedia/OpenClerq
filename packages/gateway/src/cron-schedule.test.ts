import { describe, it, expect } from 'vitest';
import cron from 'node-cron';

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
});
