import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { Icon } from './Icon';
import { cx } from './cx';
import { useDismiss, useFloating, type Placement } from './floating';
import { nextIndex } from './roving';
import './Popover.css';

/** Spread onto the button that opens a Popover or Menu: `trigger={(p) => <Button {...p}>…</Button>}`. */
export interface TriggerProps {
  ref: RefObject<HTMLButtonElement>;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  'aria-haspopup': 'dialog' | 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
}

/** Open state shared by Popover and Menu: Escape returns focus to the trigger, a click outside does not. */
function useOverlay(placement: Placement) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) anchor.current?.focus();
  }, []);
  const dismiss = useCallback(
    (reason: 'escape' | 'outside') => close(reason === 'escape'),
    [close]
  );

  useFloating(open, anchor, panel, placement);
  useDismiss(open, anchor, panel, dismiss);

  return { open, setOpen, anchor, panel, id, close };
}

export interface PopoverProps {
  trigger: (props: TriggerProps) => ReactNode;
  /** The content, or a function given `close` for content that closes itself. */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Names the popover for screen readers. */
  label: string;
  placement?: Placement;
  className?: string;
}

/** Details or a small form beside the button that opened it. */
export function Popover({
  trigger,
  children,
  label,
  placement = 'bottom-start',
  className,
}: PopoverProps) {
  const { open, setOpen, anchor, panel, id, close } = useOverlay(placement);

  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open, panel]);

  return (
    <>
      {trigger({
        ref: anchor,
        onClick: () => setOpen((o) => !o),
        onKeyDown: () => {},
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
      })}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className={cx('ui-popover', 'ui-floating', className)}
          >
            {typeof children === 'function' ? children(() => close(true)) : children}
          </div>,
          document.body
        )}
    </>
  );
}

export interface MenuItem {
  label: ReactNode;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Drawn in the error colour, for deletes. */
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  trigger: (props: TriggerProps) => ReactNode;
  items: MenuItem[];
  /** Names the menu for screen readers. */
  label: string;
  placement?: Placement;
}

/**
 * A list of actions. Arrow keys, Home and End move; Enter chooses; Escape or Tab
 * closes. Down arrow on the trigger opens it.
 */
export function Menu({ trigger, items, label, placement = 'bottom-end' }: MenuProps) {
  const { open, setOpen, anchor, panel, id, close } = useOverlay(placement);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const disabled = items.map((i) => Boolean(i.disabled));

  useEffect(() => {
    if (!open) return;
    const first = nextIndex(-1, 'Home', disabled, 'vertical');
    if (first !== null) buttons.current[first]?.focus();
    // Only on opening: a change to the items must not pull focus back to the top.
  }, [open]);

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      close(false);
      return;
    }
    const current = buttons.current.findIndex((b) => b === document.activeElement);
    const to = nextIndex(current, e.key, disabled, 'vertical');
    if (to === null) return;
    e.preventDefault();
    buttons.current[to]?.focus();
  };

  const choose = (item: MenuItem) => {
    close(true);
    item.onSelect();
  };

  return (
    <>
      {trigger({
        ref: anchor,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
      })}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="menu"
            aria-label={label}
            className="ui-menu ui-floating"
            onKeyDown={onMenuKey}
          >
            {items.map((item, i) => (
              <button
                key={i}
                ref={(el) => {
                  buttons.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={cx('ui-menu-item', item.danger && 'is-danger')}
                onClick={() => choose(item)}
              >
                {item.icon ? <Icon glyph={item.icon} /> : <span className="ui-menu-spacer" />}
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
