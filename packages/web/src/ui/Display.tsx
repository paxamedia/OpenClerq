import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, type LucideIcon } from 'lucide-react';
import { IconButton } from './Button';
import { Icon } from './Icon';
import { cx } from './cx';
import './Display.css';

export interface KeyValueItem {
  label: ReactNode;
  /** Empty values show as a dash. */
  value: ReactNode;
  mono?: boolean;
}

/** Facts as label and value pairs, in one or two columns. */
export function KeyValue({
  items,
  columns = 1,
  className,
}: {
  items: KeyValueItem[];
  columns?: 1 | 2;
  className?: string;
}) {
  return (
    <dl className={cx('ui-kv', columns === 2 && 'ui-kv--2', className)}>
      {items.map((item, i) => (
        <div key={i} className="ui-kv-row">
          <dt className="ui-kv-label">{item.label}</dt>
          <dd className={cx('ui-kv-value', item.mono && 'is-mono')}>
            {item.value === null || item.value === undefined || item.value === ''
              ? '—'
              : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface CodeBlockProps {
  code: string;
  title?: ReactNode;
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  /** Scroll beyond this height. */
  maxHeight?: 'sm' | 'md' | 'lg' | 'none';
  /** Show a copy button (default on). */
  copy?: boolean;
  className?: string;
}

/** Code, logs or JSON in monospace, with a copy button. */
export function CodeBlock({
  code,
  title,
  wrap = false,
  maxHeight = 'md',
  copy = true,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <figure className={cx('ui-code', className)}>
      {(title || copy) && (
        <figcaption className="ui-code-head">
          <span className="ui-code-title">{title}</span>
          {copy && (
            <IconButton
              icon={copied ? Check : Copy}
              label={copied ? 'Copied' : 'Copy'}
              size="sm"
              onClick={onCopy}
            />
          )}
        </figcaption>
      )}
      <pre
        className={cx('ui-code-body', wrap && 'is-wrapped', `ui-code--${maxHeight}`)}
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export interface SkeletonProps {
  /** text: lines of a paragraph; row: one table row; tile: a KPI tile; block: a panel. */
  variant?: 'text' | 'row' | 'tile' | 'block';
  /** How many lines (text) or rows (row). */
  count?: number;
  /** Read by screen readers while loading. */
  label?: string;
  className?: string;
}

/** Grey shapes where content is about to appear, instead of "Loading…". */
export function Skeleton({
  variant = 'text',
  count = 3,
  label = 'Loading',
  className,
}: SkeletonProps) {
  const bars = variant === 'text' || variant === 'row' ? count : 1;
  return (
    <div role="status" className={cx('ui-skeleton', `ui-skeleton--${variant}`, className)}>
      <span className="ui-sr-only">{label}</span>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className="ui-skeleton-bar" aria-hidden="true" />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: ReactNode;
  /** One sentence on what will appear here, or how to start. */
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, children, actions, className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', className)}>
      <span className="ui-empty-icon" aria-hidden="true">
        <Icon glyph={icon} size={20} />
      </span>
      <p className="ui-empty-title">{title}</p>
      {children && <p className="ui-empty-text">{children}</p>}
      {actions && <div className="ui-empty-actions">{actions}</div>}
    </div>
  );
}

/** Work in progress with no known end: a segment travelling along a 1px line. */
export function ProgressLine({ label, className }: { label: string; className?: string }) {
  return <div role="progressbar" aria-label={label} className={cx('ui-progress', className)} />;
}
