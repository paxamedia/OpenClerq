import { describe, expect, it } from 'vitest';
import { clock, dateTime, duration, money, oneLine, statusWords, table } from './format.js';

describe('format', () => {
  it('writes durations in the units a person says', () => {
    expect(duration(0)).toBe('0 ms');
    expect(duration(850)).toBe('850 ms');
    expect(duration(12_400)).toBe('12 s');
    expect(duration(192_000)).toBe('3 min 12 s');
    expect(duration(180_000)).toBe('3 min');
    expect(duration(3_840_000)).toBe('1 h 4 min');
    expect(duration(Number.NaN)).toBe('');
  });

  it('writes money, and says "at least" when a price was missing', () => {
    expect(money(0.25)).toBe('$0.25');
    expect(money(0)).toBe('$0.00');
    expect(money(0.0042)).toBe('$0.0042');
    expect(money(1.5, false)).toBe('at least $1.50');
  });

  it('writes times in the local zone, and blanks for none', () => {
    const iso = new Date(2026, 10, 13, 9, 5, 7).toISOString();
    expect(clock(iso)).toBe('09:05:07');
    expect(dateTime(iso)).toBe('2026-11-13 09:05');
    expect(clock(undefined)).toBe('        ');
    expect(dateTime(undefined)).toBe('');
  });

  it('puts text on one line and cuts it', () => {
    expect(oneLine('a\n  b\tc')).toBe('a b c');
    expect(oneLine('abcdef', 4)).toBe('abc…');
    expect(oneLine(undefined)).toBe('');
  });

  it('aligns columns and leaves the last one unpadded', () => {
    expect(
      table(
        ['A', 'LONGER'],
        [
          ['xx', '1'],
          ['y', '22'],
        ]
      )
    ).toEqual(['A   LONGER', 'xx  1', 'y   22']);
  });

  it('says a run’s state in words', () => {
    expect(statusWords('done')).toBe('succeeded');
    expect(statusWords('leased')).toBe('queued');
    expect(statusWords('awaiting_approval')).toBe('waiting for approval');
    expect(statusWords('odd')).toBe('odd');
  });
});
