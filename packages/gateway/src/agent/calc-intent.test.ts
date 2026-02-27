import { describe, it, expect } from 'vitest';
import { parseCalculationIntent } from './calc-intent.js';

describe('parseCalculationIntent', () => {
  it('parses "Calculate 25% on 100"', () => {
    const r = parseCalculationIntent('Calculate 25% on 100');
    expect(r).not.toBeNull();
    expect(r!.expression).toMatch(/100.*1.*0\.25/);
    expect(r!.inputs).toEqual({});
  });

  it('parses "25% of 200"', () => {
    const r = parseCalculationIntent('25% of 200');
    expect(r).not.toBeNull();
    expect(r!.expression).toMatch(/200.*0\.25/);
    expect(r!.inputs).toEqual({});
  });

  it('parses "What is 10 * 20"', () => {
    const r = parseCalculationIntent('What is 10 * 20');
    expect(r).not.toBeNull();
    expect(r!.expression).toBe('10*20');
  });

  it('parses "100 + 200"', () => {
    const r = parseCalculationIntent('100 + 200');
    expect(r).not.toBeNull();
    expect(r!.expression).toBe('100+200');
  });

  it('returns null for non-calculation', () => {
    expect(parseCalculationIntent('What is the capital of France?')).toBeNull();
    expect(parseCalculationIntent('Hello')).toBeNull();
  });
});
