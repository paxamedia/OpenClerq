/**
 * The frame around every page: the rail (bottom tabs on a phone), the top bar
 * with the page's breadcrumb and actions, and the status bar.
 */

import { useState, type ReactNode } from 'react';
import { ArrowLeft, Command, Ellipsis, LayoutGrid, Pin, PinOff, Search } from 'lucide-react';
import { IconButton } from '../ui/Button';
import { Drawer } from '../ui/Modal';
import { Popover } from '../ui/Popover';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import { cx } from '../ui/cx';
import { useBackTarget } from '../app/history';
import type { ModuleUI, RailEntry } from '../app/modules';
import { isUnder, Link } from '../app/router';
import { COMPACT_QUERY, HeaderSlotContext, PHONE_QUERY, useMedia } from './layout';
import { CompatibilityBanner } from './Compatibility';
import { StatusBar, StatusSummary } from './StatusBar';
import './shell.css';

export interface ShellProps {
  entries: RailEntry[];
  /** Every module, pinned or not, for the switcher. */
  modules: ModuleUI[];
  pins: string[];
  onPin: (id: string, pinned: boolean) => void;
  /** The current route with its query, for the back stack. */
  location: string;
  /** Counts or short labels beside rail entries, by entry id, e.g. the open inbox. */
  badges: Record<string, number | string>;
  path: string;
  onOpenPalette: () => void;
  onAbout: () => void;
  children: ReactNode;
}

/** The entry a path belongs to: the longest matching path wins. */
export function activeEntry(entries: RailEntry[], path: string): RailEntry | undefined {
  return [...entries]
    .filter((e) => isUnder(path, e.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function sortEntries(entries: RailEntry[]): RailEntry[] {
  return [...entries].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

function Badge({ n }: { n: number | string | undefined }) {
  if (!n) return null;
  return (
    <span className="shell-badge" aria-label={typeof n === 'number' ? `${n} waiting` : n}>
      {typeof n === 'number' && n > 99 ? '99+' : n}
    </span>
  );
}

function RailLink({
  entry,
  active,
  badge,
  compact,
}: {
  entry: RailEntry;
  active: boolean;
  badge?: number | string;
  compact: boolean;
}) {
  const link = (
    <Link
      to={entry.path}
      className={cx('shell-rail-link', active && 'is-active')}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? `${entry.label}${badge ? `, ${badge} waiting` : ''}` : undefined}
    >
      <Icon glyph={entry.icon} />
      <span className="shell-rail-label">{entry.label}</span>
      <Badge n={badge} />
    </Link>
  );
  return (
    <li>
      {compact ? (
        <Tooltip label={entry.label} placement="bottom-start" describe={false}>
          {link}
        </Tooltip>
      ) : (
        link
      )}
    </li>
  );
}

/** Every module, with a pin to keep it in the rail and a link to open it. */
function ModuleList({
  modules,
  pins,
  onPin,
  onOpen,
}: {
  modules: ModuleUI[];
  pins: string[];
  onPin: (id: string, pinned: boolean) => void;
  onOpen?: () => void;
}) {
  if (!modules.length) return <p className="shell-switcher-empty">No modules are installed.</p>;
  return (
    <ul className="shell-switcher-list">
      {modules.map((m) => {
        const pinned = pins.includes(m.id);
        return (
          <li key={m.id}>
            <Link
              to={m.rail[0]?.path ?? `/m/${m.id}`}
              className="shell-switcher-link"
              onClick={onOpen}
            >
              <Icon glyph={m.icon} />
              <span className="shell-switcher-text">
                <span className="shell-switcher-name">{m.name}</span>
                {m.description && <span className="shell-switcher-desc">{m.description}</span>}
              </span>
            </Link>
            <IconButton
              icon={pinned ? PinOff : Pin}
              label={pinned ? `Unpin ${m.name}` : `Pin ${m.name} to the rail`}
              size="sm"
              onClick={() => onPin(m.id, !pinned)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function Rail({
  entries,
  badges,
  path,
  switcher,
}: {
  entries: RailEntry[];
  badges: Record<string, number | string>;
  path: string;
  switcher: ReactNode;
}) {
  const compact = useMedia(COMPACT_QUERY);
  const active = activeEntry(entries, path);
  const main = entries.filter((e) => e.group !== 'end');
  const end = entries.filter((e) => e.group === 'end');
  const list = (items: RailEntry[]) =>
    items.map((e) => (
      <RailLink
        key={e.id}
        entry={e}
        active={active?.id === e.id}
        badge={badges[e.id]}
        compact={compact}
      />
    ));
  return (
    <nav className="shell-rail" aria-label="Pages">
      <Link to="/" className="shell-brand" aria-label="OpenClerq home">
        <span className="shell-brand-mark" aria-hidden="true" />
        <span className="shell-brand-name">OpenClerq</span>
      </Link>
      <ul className="shell-rail-list">{list(main)}</ul>
      <div className="shell-rail-switcher">{switcher}</div>
      <ul className="shell-rail-list shell-rail-end">{list(end)}</ul>
    </nav>
  );
}

/** At most this many tabs along the bottom on a phone; the rest go under More. */
const TABS = 4;

function BottomTabs({
  entries,
  badges,
  path,
  onAbout,
  moduleList,
}: {
  entries: RailEntry[];
  badges: Record<string, number | string>;
  path: string;
  onAbout: () => void;
  moduleList: (close: () => void) => ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const active = activeEntry(entries, path);
  const primary = entries.filter((e) => !e.secondary && e.group !== 'end').slice(0, TABS);
  const rest = entries.filter((e) => !primary.includes(e));
  const moreActive = Boolean(active && rest.includes(active));
  const moreBadge = rest.reduce(
    (n, e) =>
      n + (typeof badges[e.id] === 'number' ? (badges[e.id] as number) : badges[e.id] ? 1 : 0),
    0
  );

  return (
    <>
      <nav className="shell-tabs" aria-label="Pages">
        {primary.map((e) => (
          <Link
            key={e.id}
            to={e.path}
            className={cx('shell-tab', active?.id === e.id && 'is-active')}
            aria-current={active?.id === e.id ? 'page' : undefined}
          >
            <span className="shell-tab-icon">
              <Icon glyph={e.icon} size={20} />
              <Badge n={badges[e.id]} />
            </span>
            <span className="shell-tab-label">{e.label}</span>
          </Link>
        ))}
        <button
          type="button"
          className={cx('shell-tab', moreActive && 'is-active')}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <span className="shell-tab-icon">
            <Icon glyph={Ellipsis} size={20} />
            <Badge n={moreBadge} />
          </span>
          <span className="shell-tab-label">More</span>
        </button>
      </nav>
      <Drawer open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <ul className="shell-more-list">
          {rest.map((e) => (
            <li key={e.id}>
              <Link
                to={e.path}
                className={cx('shell-more-link', active?.id === e.id && 'is-active')}
                onClick={() => setMoreOpen(false)}
              >
                <Icon glyph={e.icon} />
                <span>{e.label}</span>
                <Badge n={badges[e.id]} />
              </Link>
            </li>
          ))}
        </ul>
        <h3 className="shell-more-title">Modules</h3>
        {moduleList(() => setMoreOpen(false))}
        <StatusSummary
          onAbout={() => {
            setMoreOpen(false);
            onAbout();
          }}
        />
      </Drawer>
    </>
  );
}

export function Shell({
  entries,
  modules,
  pins,
  onPin,
  location,
  badges,
  path,
  onOpenPalette,
  onAbout,
  children,
}: ShellProps) {
  const phone = useMedia(PHONE_QUERY);
  const compact = useMedia(COMPACT_QUERY);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const back = useBackTarget(location);
  // Core pages always show; a module's entries show while it is pinned, or while it is open.
  const open = activeEntry(entries, path);
  const sorted = sortEntries(
    entries.filter((e) => !e.module || pins.includes(e.module) || e.id === open?.id)
  );
  const switcher = (
    <Popover
      label="Modules"
      placement="bottom-start"
      trigger={(p) => (
        <button type="button" className="shell-rail-link shell-switcher-button" {...p}>
          <Icon glyph={LayoutGrid} />
          <span className="shell-rail-label">Modules</span>
        </button>
      )}
    >
      {(close) => <ModuleList modules={modules} pins={pins} onPin={onPin} onOpen={close} />}
    </Popover>
  );

  return (
    <div className="shell">
      <a className="shell-skip" href="#page-content">
        Skip to content
      </a>
      {!phone && (
        <Rail
          entries={sorted}
          badges={badges}
          path={path}
          switcher={
            compact ? (
              <Tooltip label="Modules" describe={false}>
                {switcher}
              </Tooltip>
            ) : (
              switcher
            )
          }
        />
      )}
      <div className="shell-main">
        <header className="shell-topbar">
          {back && (
            <button
              type="button"
              className="shell-back"
              onClick={() => window.history.back()}
              aria-label={`Back to ${back.title}`}
            >
              <Icon glyph={ArrowLeft} size={14} />
              <span className="shell-back-label">{back.title}</span>
            </button>
          )}
          <div className="shell-topbar-slot" ref={setSlot} />
          <button
            type="button"
            className="shell-palette-button"
            onClick={onOpenPalette}
            aria-label="Search and commands"
            aria-keyshortcuts="Meta+K Control+K"
          >
            <Icon glyph={phone ? Search : Command} size={14} />
            {!phone && <kbd>K</kbd>}
          </button>
        </header>
        <CompatibilityBanner />
        <main className="shell-page" id="page-content" tabIndex={-1}>
          <HeaderSlotContext.Provider value={slot}>{children}</HeaderSlotContext.Provider>
        </main>
      </div>
      {phone ? (
        <BottomTabs
          entries={sorted}
          badges={badges}
          path={path}
          onAbout={onAbout}
          moduleList={(close) => (
            <ModuleList modules={modules} pins={pins} onPin={onPin} onOpen={close} />
          )}
        />
      ) : (
        <StatusBar onAbout={onAbout} />
      )}
    </div>
  );
}
