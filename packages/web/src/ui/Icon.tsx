import type { LucideIcon, LucideProps } from 'lucide-react';

export interface IconProps extends Omit<LucideProps, 'ref' | 'strokeLinecap' | 'strokeLinejoin'> {
  /** The glyph to draw, e.g. `Play` from lucide-react. */
  glyph: LucideIcon;
}

/**
 * A lucide glyph drawn to the interface's rules: 16 px, stroke 1.5, square caps
 * and mitred joins. Caps and joins cannot be overridden. Without an aria-label
 * the icon is hidden from screen readers, so the text beside it carries the meaning.
 */
export function Icon({ glyph: Glyph, size = 16, strokeWidth = 1.5, ...rest }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      {...rest}
      strokeLinecap="square"
      strokeLinejoin="miter"
    />
  );
}
