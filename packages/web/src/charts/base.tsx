/**
 * What every chart shares: its measured width, a tooltip for the mark under
 * the pointer or focus, and marks that open what they stand for.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useFloating } from '../ui/floating';
import type { Tone } from '../ui/Status';
import { runState } from '../ui/Status';

/** The width of an element, kept current as it resizes. */
export function useWidth<T extends HTMLElement>(fallback = 600): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface Tip {
  show: (el: Element, content: ReactNode) => void;
  hide: () => void;
  node: ReactNode;
}

/** One tooltip per chart, beside whichever mark is hovered or focused. */
export function useTip(): Tip {
  const [tip, setTip] = useState<{ el: Element; content: ReactNode } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const floating = useRef<HTMLDivElement>(null);
  anchor.current = (tip?.el as HTMLElement | undefined) ?? null;
  useFloating(Boolean(tip), anchor as RefObject<HTMLElement>, floating, 'top');
  const show = useCallback((el: Element, content: ReactNode) => setTip({ el, content }), []);
  const hide = useCallback(() => setTip(null), []);
  const node =
    tip && typeof document !== 'undefined'
      ? createPortal(
          <div ref={floating} role="tooltip" className="ui-tooltip ui-floating chart-tip">
            {tip.content}
          </div>,
          document.body
        )
      : null;
  return { show, hide, node };
}

/**
 * Props for one mark: it shows its tooltip on hover and focus, and opens what
 * it stands for on click or Enter when `onOpen` is given.
 */
export function markProps(
  tip: Tip,
  label: string,
  content: ReactNode,
  onOpen?: () => void
): {
  tabIndex: number;
  role: string;
  'aria-label': string;
  onPointerEnter: (e: { currentTarget: Element }) => void;
  onPointerLeave: () => void;
  onFocus: (e: { currentTarget: Element }) => void;
  onBlur: () => void;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  className: string;
} {
  return {
    tabIndex: 0,
    role: onOpen ? 'link' : 'img',
    'aria-label': label,
    onPointerEnter: (e) => tip.show(e.currentTarget, content),
    onPointerLeave: tip.hide,
    onFocus: (e) => tip.show(e.currentTarget, content),
    onBlur: tip.hide,
    onClick: onOpen
      ? () => {
          tip.hide();
          onOpen();
        }
      : undefined,
    onKeyDown: onOpen
      ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }
      : undefined,
    className: onOpen ? 'chart-mark is-link' : 'chart-mark',
  };
}

/** The colour class of a run state. */
export function toneOf(status: string): Tone {
  return runState(status).tone;
}

/** Tooltip body: a title line and a few facts. */
export function TipBody({ title, lines }: { title: ReactNode; lines: ReactNode[] }) {
  return (
    <span className="chart-tip-body">
      <strong className="chart-tip-title">{title}</strong>
      {lines.filter(Boolean).map((l, i) => (
        <span key={i} className="chart-tip-line">
          {l}
        </span>
      ))}
    </span>
  );
}
