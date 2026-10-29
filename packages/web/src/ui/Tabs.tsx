import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';
import { nextIndex } from './roving';
import './Tabs.css';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown beside the label, e.g. waiting approvals. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the tab list for screen readers. */
  label: string;
  /** The selected tab's panel. */
  children?: ReactNode;
  className?: string;
}

/** Tabs over one panel. Arrow keys, Home and End move between tabs and open them. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  children,
  className,
}: TabsProps<T>) {
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = items.findIndex((t) => t.value === value);
  const focusable = selected >= 0 ? selected : items.findIndex((t) => !t.disabled);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const to = nextIndex(
      index,
      e.key,
      items.map((t) => Boolean(t.disabled)),
      'horizontal'
    );
    if (to === null) return;
    e.preventDefault();
    tabs.current[to]?.focus();
    onChange(items[to].value);
  };

  return (
    <div className={cx('ui-tabs', className)}>
      <div role="tablist" aria-label={label} className="ui-tablist">
        {items.map((t, i) => (
          <button
            key={t.value}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === selected}
            aria-controls={`${id}-panel`}
            tabIndex={i === focusable ? 0 : -1}
            disabled={t.disabled}
            className="ui-tab"
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {t.count !== undefined && <span className="ui-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {children !== undefined && (
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${selected}`}
          tabIndex={0}
          className="ui-tabpanel"
        >
          {children}
        </div>
      )}
    </div>
  );
}
