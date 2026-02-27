import { describe, it, expect } from 'vitest';
import { runTask } from './task.js';

describe('runTask', () => {
  it('dryRun returns trace without calling LLM', async () => {
    const result = await runTask({
      message: 'Calculate 25% of 100',
      dryRun: true,
    });
    expect(result.intent).toBe('explain');
    expect(result.explanation).toContain('Dry run');
    expect(result.trace).toBeDefined();
    expect(result.trace?.map((s) => s.step)).toContain('skill_select');
    expect(result.trace?.map((s) => s.step)).toContain('calculation');
    expect(result.trace?.map((s) => s.step)).toContain('explain');
    expect(result.trace?.find((s) => s.step === 'calculation')?.detail).toContain('would run');
    expect(result.trace?.find((s) => s.step === 'explain')?.detail).toContain('skipped');
  });

  it('dryRun without calc intent skips calculation step', async () => {
    const result = await runTask({
      message: 'What is VAT?',
      skillSlug: 'vat',
      dryRun: true,
    });
    expect(result.trace?.map((s) => s.step)).not.toContain('calculation');
    expect(result.trace?.find((s) => s.step === 'skill_select')?.detail).toBe('vat');
  });
});
