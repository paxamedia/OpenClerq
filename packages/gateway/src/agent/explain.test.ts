import { describe, it, expect } from 'vitest';
import { buildContextPreview } from './explain.js';

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

  it('appends skill hint when provided', () => {
    const preview = buildContextPreview({
      question: 'Help',
      skillSlug: 'vat',
      skillName: 'VAT rules',
    });
    expect(preview.userContent).toContain('VAT rules');
    expect(preview.userContent).toContain('skill');
  });
});
