import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button, IconButton } from './Button';
import { cx } from './cx';
import './Toast.css';

export interface ToastOptions {
  message: ReactNode;
  tone?: 'neutral' | 'ok' | 'err';
  /** One follow-up, such as Undo or Retry. Choosing it dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it goes. Default 5000; errors stay until dismissed. */
  duration?: number;
}

type ShowToast = (toast: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

interface ActiveToast extends ToastOptions {
  id: number;
}

/** At most three toasts show at once; the oldest goes first. */
const LIMIT = 3;

/** Holds the toasts for everything inside it. Put one near the root of the app. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const [mounted, setMounted] = useState(false);
  const next = useRef(0);

  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ShowToast>((toast) => {
    next.current += 1;
    const id = next.current;
    setToasts((all) => [...all.slice(-(LIMIT - 1)), { ...toast, id }]);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {mounted &&
        createPortal(
          <div className="ui-toasts" role="region" aria-label="Notifications" aria-live="polite">
            {toasts.map((t) => (
              <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ActiveToast; onDismiss: (id: number) => void }) {
  const { id, message, tone = 'neutral', action } = toast;
  const duration = toast.duration ?? (tone === 'err' ? 0 : 5000);

  useEffect(() => {
    if (duration <= 0) return;
    const timer = window.setTimeout(() => onDismiss(id), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration, onDismiss]);

  return (
    <div
      className={cx('ui-toast', `ui-toast--${tone}`)}
      role={tone === 'err' ? 'alert' : undefined}
    >
      <p className="ui-toast-message">{message}</p>
      {action && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            action.onClick();
            onDismiss(id);
          }}
        >
          {action.label}
        </Button>
      )}
      <IconButton icon={X} label="Dismiss" size="sm" onClick={() => onDismiss(id)} />
    </div>
  );
}

/** Returns `toast(options)`, which shows a short message in the corner. */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast needs a <ToastProvider> above it.');
  return show;
}
