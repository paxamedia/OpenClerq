/**
 * How a straggler's start is judged against the run's start. Fake `ps` output
 * only; the real processes are in profiles.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { AGE_GRANULARITY_MS, parseElapsed, parseProcessAges, startedSince } from './stragglers.js';

describe('parseElapsed (ps -o etime)', () => {
  it('reads minutes and seconds, hours, and days', () => {
    expect(parseElapsed('00:00')).toBe(0);
    expect(parseElapsed('05:07')).toBe(5 * 60 + 7);
    expect(parseElapsed('  01:02:03\n')).toBe(3600 + 120 + 3);
    expect(parseElapsed('30-17:11:57')).toBe(((30 * 24 + 17) * 60 + 11) * 60 + 57);
    expect(parseElapsed('2-00:00:09')).toBe(2 * 86_400 + 9);
  });

  it('refuses anything else, so a row it cannot read is never trusted', () => {
    for (const text of ['', '12', '1:2', 'Tue Nov 12 10:00:00 2026', '-', '00:00:00:00', 'abc']) {
      expect(parseElapsed(text)).toBeNull();
    }
  });
});

describe('parseProcessAges', () => {
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);

  it('dates each process from the elapsed time, in the clock it was given', () => {
    const rows = [
      '  4242  4000        00:03',
      '    77     1  12-03:04:05',
      '  900   77 01:00',
    ].join('\n');
    const ages = parseProcessAges(`${rows}\n`, now);
    expect(ages.get(4242)).toEqual({ startMs: now - 3_000, ppid: 4000 });
    expect(ages.get(77)).toEqual({
      startMs: now - ((12 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000,
      ppid: 1,
    });
    expect(ages.get(900)).toEqual({ startMs: now - 60_000, ppid: 77 });
  });

  it('skips rows it cannot read, and an empty answer is an empty map', () => {
    const text = ['garbage', '  12  1  Tue Nov 12 10:00:00 2026', '  13  1  00:09', ''].join('\n');
    expect([...parseProcessAges(text, now).keys()]).toEqual([13]);
    expect(parseProcessAges('', now).size).toBe(0);
  });

  it('does not depend on the wall clock of the machine that wrote the row', () => {
    // The same `ps` row read at two different wall-clock times is the same
    // process, a fixed time before whichever "now" the caller reads it at.
    const row = '  500  1  00:10\n';
    const early = parseProcessAges(row, now).get(500)?.startMs as number;
    const late = parseProcessAges(row, now + 7_000).get(500)?.startMs as number;
    expect(late - early).toBe(7_000);
    expect(now - early).toBe(10_000);
    expect(now + 7_000 - late).toBe(10_000);
  });
});

describe('startedSince', () => {
  const since = Date.UTC(2026, 10, 13, 12, 0, 0);

  it('accepts a process that started with the run or after it', () => {
    expect(startedSince(since, since)).toBe(true);
    expect(startedSince(since + 5, since)).toBe(true);
    expect(startedSince(since + 60_000, since)).toBe(true);
  });

  it('accepts one dated up to a second early, which is the granularity of ps', () => {
    expect(AGE_GRANULARITY_MS).toBe(1_000);
    expect(startedSince(since - 1, since)).toBe(true);
    expect(startedSince(since - AGE_GRANULARITY_MS, since)).toBe(true);
  });

  it('refuses one that was already there', () => {
    expect(startedSince(since - AGE_GRANULARITY_MS - 1, since)).toBe(false);
    expect(startedSince(since - 3_000, since)).toBe(false);
    expect(startedSince(since - 86_400_000, since)).toBe(false);
  });

  it('refuses a process with no date, and every process when the run has no start', () => {
    expect(startedSince(undefined, since)).toBe(false);
    expect(startedSince(since, undefined)).toBe(false);
    expect(startedSince(undefined, undefined)).toBe(false);
  });

  it('judges a process of the run correctly when the boot-time clock has drifted', () => {
    // A run begins at `since`; its process starts 0.2 s later and `ps` is read
    // 4 s after that. Read as elapsed time, it is 4 s old at `now`, so it is
    // dated 0.2 s after the run began however far the wall clock has moved
    // from the boot time `lstart` would have added its ticks to.
    const now = since + 4_200;
    const ages = parseProcessAges('  321  1  00:04\n', now);
    expect(startedSince(ages.get(321)?.startMs, since)).toBe(true);
    // A drifted `lstart` reading, 5 s early, is what used to make it look older than the run.
    expect(startedSince(since + 200 - 5_000, since)).toBe(false);
  });
});
