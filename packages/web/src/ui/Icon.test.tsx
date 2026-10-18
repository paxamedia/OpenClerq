import { renderToStaticMarkup } from 'react-dom/server';
import { Play } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';

describe('Icon', () => {
  it('draws at 16 px with a 1.5 stroke, square caps and mitred joins', () => {
    const svg = renderToStaticMarkup(<Icon glyph={Play} />);
    expect(svg).toContain('width="16"');
    expect(svg).toContain('height="16"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain('stroke-linecap="square"');
    expect(svg).toContain('stroke-linejoin="miter"');
    expect(svg).not.toContain('round');
  });

  it('is hidden from screen readers unless labelled', () => {
    expect(renderToStaticMarkup(<Icon glyph={Play} />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(<Icon glyph={Play} aria-label="Run now" />);
    expect(labelled).toContain('aria-label="Run now"');
    expect(labelled).not.toContain('aria-hidden');
  });
});
