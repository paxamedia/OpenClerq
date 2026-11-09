/**
 * Page chrome shared by every screen: the header that fills the top bar, the
 * page frame, and the loading, empty and error states.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, CloudOff, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { EmptyState, Skeleton } from '../ui/Display';
import { Icon } from '../ui/Icon';
import { cx } from '../ui/cx';
import { errorMessage, isOffline } from '../app/format';
import { nameCurrent } from '../app/history';
import { Link } from '../app/router';

/** Phone layout below this width; the collapsed rail below the next. */
export const PHONE_QUERY = '(max-width: 640px)';
export const COMPACT_QUERY = '(max-width: 1099px)';

export function useMedia(query: string): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** The element in the top bar that a page's header is drawn into. */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

export interface Crumb {
  label: ReactNode;
  to?: string;
}

export interface PageHeaderProps {
  /** Where the page sits, the page itself last: Automations › weekly-deps. */
  crumbs: Crumb[];
  /** The page's actions, primary last. */
  actions?: ReactNode;
  /** The window title; defaults to the last crumb when it is text. */
  title?: string;
}

/** Fills the top bar with the page's breadcrumb and actions. */
export function PageHeader({ crumbs, actions, title }: PageHeaderProps) {
  const slot = useContext(HeaderSlotContext);
  const last = crumbs[crumbs.length - 1]?.label;
  const windowTitle = title ?? (typeof last === 'string' ? last : undefined);

  useEffect(() => {
    if (!windowTitle) return;
    document.title = `${windowTitle} · OpenClerq`;
    nameCurrent(window.location.hash.replace(/^#/, '') || '/', windowTitle);
  }, [windowTitle]);

  if (!slot) return null;
  return createPortal(
    <>
      <nav className="shell-crumbs" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li key={i} className={cx(isLast && 'is-current')}>
                {i > 0 && <Icon glyph={ChevronRight} size={14} className="shell-crumb-sep" />}
                {c.to && !isLast ? (
                  <Link to={c.to}>{c.label}</Link>
                ) : (
                  <span aria-current={isLast ? 'page' : undefined}>{c.label}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {actions && <div className="shell-actions">{actions}</div>}
    </>,
    slot
  );
}

export function Page({
  children,
  className,
  width = 'full',
}: {
  children: ReactNode;
  className?: string;
  /** narrow: forms and settings; full: tables and dashboards. */
  width?: 'narrow' | 'full';
}) {
  return <div className={cx('page', `page--${width}`, className)}>{children}</div>;
}

export function Section({
  title,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      className={cx('page-section', className)}
      id={id}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      {(title || actions) && (
        <header className="page-section-head">
          {title && <h2 className="page-section-title">{title}</h2>}
          {actions && <div className="page-section-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** What failed, in the user's terms, with Retry. */
export function ErrorState({
  error,
  onRetry,
  what,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  /** What could not be loaded, e.g. "automations". */
  what?: string;
  compact?: boolean;
}) {
  const offline = isOffline(error);
  const message = offline
    ? "OpenClerq's background service isn't responding."
    : what
      ? `Couldn't load ${what}. ${errorMessage(error)}`
      : errorMessage(error);
  return (
    <div className={cx('page-error', compact && 'is-compact')} role="alert">
      <Icon glyph={offline ? CloudOff : TriangleAlert} className="page-error-icon" />
      <p className="page-error-text">{message}</p>
      {onRetry && (
        <Button size="sm" icon={RotateCw} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * The three states every page has: a skeleton while loading, an inline error
 * with Retry, and the content.
 */
export function Loaded<T>({
  resource,
  what,
  skeleton = 'block',
  children,
}: {
  resource: { data: T | undefined; error: unknown; loading: boolean; reload: () => void };
  what?: string;
  skeleton?: 'block' | 'rows' | 'tiles' | 'text';
  children: (data: T) => ReactNode;
}) {
  if (resource.data !== undefined) {
    return (
      <>
        {resource.error ? (
          <ErrorState error={resource.error} onRetry={resource.reload} what={what} compact />
        ) : null}
        {children(resource.data)}
      </>
    );
  }
  if (resource.error) {
    return <ErrorState error={resource.error} onRetry={resource.reload} what={what} />;
  }
  return <PageSkeleton kind={skeleton} label={what ? `Loading ${what}` : undefined} />;
}

export function PageSkeleton({
  kind = 'block',
  label,
}: {
  kind?: 'block' | 'rows' | 'tiles' | 'text';
  label?: string;
}) {
  if (kind === 'tiles') {
    return (
      <div className="page-skeleton-tiles">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} variant="tile" label={label} />
        ))}
      </div>
    );
  }
  if (kind === 'rows') return <Skeleton variant="row" count={6} label={label} />;
  if (kind === 'text') return <Skeleton variant="text" count={4} label={label} />;
  return <Skeleton variant="block" label={label} />;
}

export { EmptyState };
