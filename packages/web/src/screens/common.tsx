/** Small pieces several screens share. */

import { useEffect, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../ui/Icon';
import { cx } from '../ui/cx';
import { exactTime, relativeTime } from '../app/format';
import { Link } from '../app/router';
import './screens.css';

/** The current time, ticking every `ms`, for countdowns and running durations. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "2 min ago", with the exact time on hover. */
export function When({ at, now }: { at: string | null | undefined; now?: number }) {
  if (!at) return <span className="page-muted">—</span>;
  return (
    <time dateTime={at} title={exactTime(at)}>
      {relativeTime(at, now)}
    </time>
  );
}

export function Tile({
  label,
  figure,
  sub,
  chart,
  to,
  tone,
}: {
  label: string;
  figure: ReactNode;
  sub?: ReactNode;
  chart?: ReactNode;
  to?: string;
  tone?: 'warn' | 'err';
}) {
  const body = (
    <>
      <span className="tile-label">{label}</span>
      <span className={cx('tile-figure', tone && `is-${tone}`)}>{figure}</span>
      <span className="tile-foot">
        <span className="tile-sub">{sub}</span>
        {chart}
      </span>
    </>
  );
  return (
    <div className="tile">
      {to ? (
        <Link to={to} className="tile-link">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

/** A list row that opens something: icon, text, detail on the right. */
export function ListRow({
  icon,
  tone,
  to,
  title,
  detail,
  aside,
}: {
  icon: LucideIcon;
  tone?: 'ok' | 'warn' | 'err' | 'accent' | 'muted';
  to: string;
  title: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <li className="list-row">
      <Link to={to} className="list-row-link">
        <span className={cx('list-row-icon', tone && `tone-text-${tone}`)}>
          <Icon glyph={icon} />
        </span>
        <span className="list-row-text">
          <span className="list-row-title">{title}</span>
          {detail && <span className="list-row-detail">{detail}</span>}
        </span>
        {aside && <span className="list-row-aside">{aside}</span>}
      </Link>
    </li>
  );
}

export function List({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul className="list" aria-label={label}>
      {children}
    </ul>
  );
}
