import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { cx } from './cx';
import './Split.css';

export interface SplitProps {
  /** Remembers the size under this name on this device. */
  storageKey: string;
  /** The first pane's starting width in pixels. */
  initial: number;
  min?: number;
  max?: number;
  /** Names the divider for screen readers, e.g. "Resize the step list". */
  label: string;
  children: [ReactNode, ReactNode];
  className?: string;
}

function readSize(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(`clerq-pane:${key}`));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Two panes side by side with a divider that drags, or moves with the arrow
 * keys, and keeps its place. At phone width the panes stack.
 */
export function Split({
  storageKey,
  initial,
  min = 200,
  max = 900,
  label,
  children,
  className,
}: SplitProps) {
  const root = useRef<HTMLDivElement>(null);
  const size = useRef(readSize(storageKey, initial));

  const apply = useCallback(
    (px: number, persist: boolean) => {
      const clamped = Math.round(Math.min(max, Math.max(min, px)));
      size.current = clamped;
      root.current?.style.setProperty('--split-size', `${clamped}px`);
      root.current
        ?.querySelector('.ui-split-handle')
        ?.setAttribute('aria-valuenow', String(clamped));
      if (persist) {
        try {
          localStorage.setItem(`clerq-pane:${storageKey}`, String(clamped));
        } catch {
          /* kept for this window only */
        }
      }
    },
    [min, max, storageKey]
  );

  useEffect(() => apply(size.current, false), [apply]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const left = root.current?.getBoundingClientRect().left ?? 0;
    const move = (ev: globalThis.PointerEvent) => apply(ev.clientX - left, false);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      apply(size.current, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') apply(size.current - step, true);
    else if (e.key === 'ArrowRight') apply(size.current + step, true);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={root} className={cx('ui-split', className)}>
      <div className="ui-split-pane">{children[0]}</div>
      <div
        className="ui-split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="ui-split-pane">{children[1]}</div>
    </div>
  );
}
