import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useFloating, type Placement } from './floating';
import './Tooltip.css';

export interface TooltipProps {
  label: ReactNode;
  /** One focusable element: the tooltip describes it. */
  children: ReactElement;
  placement?: Placement;
  /**
   * Link the tooltip to the element with aria-describedby. Off when the label
   * already names the element, as on an IconButton, so it is not read twice.
   */
  describe?: boolean;
}

/** Focus from the keyboard, not from a click (which would flash the tooltip). */
function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** A short label shown after a moment's hover, or at once on keyboard focus. */
export function Tooltip({ label, children, placement = 'top', describe = true }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();

  useFloating(open, anchor, tip, placement);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  const child =
    describe && open && isValidElement(children)
      ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
          'aria-describedby': id,
        })
      : children;

  return (
    <span
      ref={anchor}
      className="ui-tooltip-anchor"
      onPointerEnter={() => show(400)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => isKeyboardFocus(e.target) && show(0)}
      onBlur={hide}
    >
      {child}
      {open &&
        createPortal(
          <div ref={tip} id={id} role="tooltip" className="ui-tooltip ui-floating">
            {label}
          </div>,
          document.body
        )}
    </span>
  );
}
