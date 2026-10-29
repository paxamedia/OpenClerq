import { useEffect, useLayoutEffect, type RefObject } from 'react';

export type Placement = 'top' | 'bottom' | 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Distance kept from the window's edges. */
const MARGIN = 8;

/**
 * Where a floating element goes beside its anchor: on the requested side unless
 * it would leave the window and the other side has room, and shifted sideways
 * to stay inside it.
 */
export function place(
  anchor: Box,
  floating: Size,
  placement: Placement,
  viewport: Size,
  gap = 4
): { x: number; y: number; side: 'top' | 'bottom' } {
  const [wanted, align] = placement.split('-') as ['top' | 'bottom', 'start' | 'end' | undefined];
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - floating.height;
  const fitsBelow = below + floating.height <= viewport.height - MARGIN;
  const fitsAbove = above >= MARGIN;
  const side =
    wanted === 'bottom'
      ? !fitsBelow && fitsAbove
        ? 'top'
        : 'bottom'
      : !fitsAbove && fitsBelow
        ? 'bottom'
        : 'top';
  const start =
    align === 'start'
      ? anchor.x
      : align === 'end'
        ? anchor.x + anchor.width - floating.width
        : anchor.x + (anchor.width - floating.width) / 2;
  const x = Math.min(
    Math.max(start, MARGIN),
    Math.max(MARGIN, viewport.width - MARGIN - floating.width)
  );
  return { x: Math.round(x), y: Math.round(side === 'bottom' ? below : above), side };
}

/** useLayoutEffect in the browser; useEffect where there is no DOM, so server rendering stays quiet. */
export const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Keeps an open `.ui-floating` element beside its anchor as the window scrolls
 * or resizes. The position is written to --float-x and --float-y on the element:
 * it changes at run time, so it cannot live in a stylesheet.
 */
export function useFloating(
  open: boolean,
  anchor: RefObject<HTMLElement>,
  floating: RefObject<HTMLElement>,
  placement: Placement
) {
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const a = anchor.current;
      const f = floating.current;
      if (!a || !f) return;
      const r = a.getBoundingClientRect();
      const { x, y, side } = place(
        { x: r.left, y: r.top, width: r.width, height: r.height },
        { width: f.offsetWidth, height: f.offsetHeight },
        placement,
        { width: window.innerWidth, height: window.innerHeight }
      );
      f.style.setProperty('--float-x', `${x}px`);
      f.style.setProperty('--float-y', `${y}px`);
      f.dataset.side = side;
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchor, floating, placement]);
}

/**
 * Closes an open overlay on Escape (reason 'escape') or on a press outside both
 * the anchor and the overlay (reason 'outside').
 */
export function useDismiss(
  open: boolean,
  anchor: RefObject<HTMLElement>,
  floating: RefObject<HTMLElement>,
  onDismiss: (reason: 'escape' | 'outside') => void
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || floating.current?.contains(target)) return;
      onDismiss('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Also keeps an enclosing modal dialog from closing on the same key.
      e.preventDefault();
      onDismiss('escape');
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, anchor, floating, onDismiss]);
}
