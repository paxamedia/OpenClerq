import { describe, it, expect, vi, beforeEach } from 'vitest';

const callLLM = vi.fn();
vi.mock('./llm-provider.js', () => ({ callLLM: (...args: unknown[]) => callLLM(...args) }));

import { buildContextPreview, getExplanation, SKILL_INSTRUCTIONS_MAX_CHARS } from './explain.js';

const instructions = '# VAT\n\nQuote the rate table before explaining a rate.';

describe('buildContextPreview', () => {
  it('returns systemPrompt and userContent', () => {
    const preview = buildContextPreview({ question: 'What is 2+2?' });
    expect(preview.systemPrompt).toBeDefined();
    expect(preview.systemPrompt.length).toBeGreaterThan(0);
    expect(preview.userContent).toBe('What is 2+2?');
    expect(preview.estimatedInputTokens).toBeDefined();
    expect(preview.estimatedInputTokens).toBeGreaterThan(0);
  });

  it('appends context when provided', () => {
    const preview = buildContextPreview({
      question: 'Explain this',
      context: { document: 'sample text' },
    });
    expect(preview.userContent).toContain('Context:');
    expect(preview.userContent).toContain('document');
    expect(preview.userContent).toContain('sample text');
  });

  it('names the selected skill in the system prompt', () => {
    const preview = buildContextPreview({
      question: 'Help',
      skillSlug: 'vat',
      skillName: 'VAT rules',
    });
    expect(preview.systemPrompt).toContain('"VAT rules" skill');
    expect(preview.systemPrompt).not.toContain('<skill_instructions>');
    expect(preview.userContent).toBe('Help');
  });

  it("adds the skill's instructions to the system prompt in a delimited block", () => {
    const base = buildContextPreview({ question: 'Help' });
    const preview = buildContextPreview({
      question: 'Help',
      skillSlug: 'vat',
      skillName: 'VAT rules',
      skillInstructions: instructions,
    });
    expect(preview.systemPrompt.startsWith(base.systemPrompt)).toBe(true);
    expect(preview.systemPrompt).toContain(
      `<skill_instructions>\n${instructions}\n</skill_instructions>`
    );
    expect(preview.userContent).toBe('Help');
    expect(preview.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens!);
  });

  it('caps long instructions and says they were cut', () => {
    const preview = buildContextPreview({
      question: 'Help',
      skillSlug: 'big',
      skillInstructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX_CHARS) + 'TAIL',
    });
    expect(preview.systemPrompt).not.toContain('TAIL');
    expect(preview.systemPrompt).toContain(
      `[Skill instructions truncated at ${SKILL_INSTRUCTIONS_MAX_CHARS} characters.]`
    );
  });

  it('does not split a surrogate pair at the cap', () => {
    const preview = buildContextPreview({
      question: 'Help',
      skillSlug: 'emoji',
      skillInstructions: 'x'.repeat(SKILL_INSTRUCTIONS_MAX_CHARS - 1) + '😀',
    });
    expect(preview.systemPrompt).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('getExplanation', () => {
  beforeEach(() => {
    callLLM.mockReset();
    callLLM.mockResolvedValue({ text: 'ok', model: 'm', provider: 'p', costUsd: 0 });
  });

  it("sends the skill's instructions to the model, exactly as previewed", async () => {
    const req = {
      question: 'What rate applies?',
      context: { amount: 100 },
      skillSlug: 'vat',
      skillName: 'VAT rules',
      skillInstructions: instructions,
    };
    await getExplanation(req);

    const [system, user] = callLLM.mock.calls[0] as [string, string];
    expect(system).toContain(instructions);
    const preview = buildContextPreview(req);
    expect(system).toBe(preview.systemPrompt);
    expect(user).toBe(preview.userContent);
  });
});
