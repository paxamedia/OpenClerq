import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { cx } from './cx';
import './Modal.css';

/**
 * Opens and closes a native <dialog> as a modal: the browser traps focus and
 * keeps it in the top layer. Focus goes back to whatever opened it on close.
 */
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  return ref;
}

interface ModalBaseProps {
  open: boolean;
  /** Called on Escape, a click on the dimmed page, or the close button. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons along the bottom edge, primary last. */
  actions?: ReactNode;
}

function ModalPanel({
  kind,
  open,
  onClose,
  title,
  description,
  children,
  actions,
  size,
}: ModalBaseProps & { kind: 'dialog' | 'drawer'; size: string }) {
  const ref = useModal(open);
  const titleId = useId();
  const descId = useId();

  return (
    <dialog
      ref={ref}
      className={cx(`ui-${kind}`, `ui-${kind}--${size}`)}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="ui-modal-panel">
          <header className="ui-modal-head">
            <h2 id={titleId} className="ui-modal-title">
              {title}
            </h2>
            <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
          </header>
          {description && (
            <p id={descId} className="ui-modal-desc">
              {description}
            </p>
          )}
          {children && <div className="ui-modal-body">{children}</div>}
          {actions && <footer className="ui-modal-actions">{actions}</footer>}
        </div>
      )}
    </dialog>
  );
}

export interface DialogProps extends ModalBaseProps {
  size?: 'sm' | 'md' | 'lg';
}

/** A modal question or form in the middle of the window. */
export function Dialog({ size = 'sm', ...props }: DialogProps) {
  return <ModalPanel kind="dialog" size={size} {...props} />;
}

export interface DrawerProps extends ModalBaseProps {
  size?: 'md' | 'lg';
}

/** A modal panel along the right edge, for details that need room. */
export function Drawer({ size = 'md', ...props }: DrawerProps) {
  return <ModalPanel kind="drawer" size={size} {...props} />;
}
