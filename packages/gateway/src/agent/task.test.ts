import { describe, it, expect, vi } from 'vitest';

const callLLM = vi.fn();
vi.mock('./llm-provider.js', () => ({ callLLM: (...args: unknown[]) => callLLM(...args) }));

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

  it("sends the selected skill's instructions with the model call", async () => {
    callLLM.mockResolvedValue({ text: 'answer', model: 'm', provider: 'p', costUsd: 0 });
    const result = await runTask({
      message: 'What is VAT?',
      skillSlug: 'vat',
      skillName: 'VAT rules',
      skillInstructions: 'Quote the rate table before explaining a rate.',
    });
    expect(result.explanation).toBe('answer');
    const [system, user] = callLLM.mock.calls[0] as [string, string];
    expect(system).toMatch(
      /<skill_instructions fence="([0-9a-f]{32})">\n\{"name":"VAT rules","slug":"vat"\}\n\nQuote the rate table before explaining a rate\.\n<\/skill_instructions fence="\1">/
    );
    expect(user).toBe('What is VAT?');
  });

  it('puts what the skill choice left to say in the trace, after the skill step, in a dry run and a real one', async () => {
    const skillTrace = [
      { step: 'skill_skipped', detail: 'The skill "old" (modified) matched but was not used.' },
      { step: 'skill_trust', detail: 'vat is untrusted.' },
    ];
    const dry = await runTask({
      message: 'What is VAT?',
      skillSlug: 'vat',
      skillTrace,
      dryRun: true,
    });
    expect(dry.trace?.map((s) => s.step)).toEqual([
      'skill_select',
      'skill_skipped',
      'skill_trust',
      'explain',
    ]);
    callLLM.mockResolvedValue({ text: 'answer', model: 'm', provider: 'p', costUsd: 0 });
    const real = await runTask({
      message: 'What is VAT?',
      skillSlug: 'vat',
      skillName: 'VAT rules',
      skillInstructions: 'Be exact.',
      skillTrust: 'untrusted',
      skillTrace,
    });
    expect(real.trace?.map((s) => s.step)).toEqual([
      'skill_select',
      'skill_skipped',
      'skill_trust',
      'explain',
    ]);
    expect(callLLM.mock.calls.at(-1)?.[0]).toContain('(trust state: untrusted)');
  });
});
