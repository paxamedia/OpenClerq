/**
 * ⌘K: go to any page, run or open an automation, open a run, switch theme.
 * Type to filter; arrows move; Enter runs; Escape closes.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { Icon } from '../ui/Icon';
import { cx } from '../ui/cx';
import type { PaletteCommand } from '../app/modules';
import './palette.css';

/** Every query word must start a word of the label, hint or keywords. Earlier label hits rank first. */
export function matchCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  const scored: Array<{ c: PaletteCommand; score: number }> = [];
  for (const c of commands) {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.hint ?? ''} ${c.keywords ?? ''}`.toLowerCase();
    const ok = words.every((w) => hay.includes(w));
    if (!ok) continue;
    const at = label.indexOf(words[0]);
    scored.push({ c, score: at < 0 ? 1000 : at });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.c);
}

export function Palette({
  open,
  onClose,
  commands,
  search,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  /** Records and actions across modules for a query of two characters or more. */
  search?: (query: string) => Promise<PaletteCommand[]>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listId = useId();
  const [found, setFound] = useState<{ query: string; items: PaletteCommand[] }>({
    query: '',
    items: [],
  });
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!search || q.length < 2) {
      setFound({ query: q, items: [] });
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      search(q)
        .then((items) => !cancelled && setFound({ query: q, items }))
        .catch(() => !cancelled && setFound({ query: q, items: [] }))
        .finally(() => !cancelled && setSearching(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, search]);

  const shown = useMemo(() => {
    const local = matchCommands(commands, query);
    const ids = new Set(local.map((c) => c.id));
    const remote = found.query === query.trim() ? found.items.filter((c) => !ids.has(c.id)) : [];
    return [...local, ...remote].slice(0, 60);
  }, [commands, query, found]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      setQuery('');
      setIndex(0);
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) {
      d.close();
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, listId]);

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    // After the dialog closes, so focus moves where the command sends it.
    setTimeout(() => c.run(), 0);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (shown.length ? (i + 1) % shown.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[index]);
    }
  };

  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Search and commands"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="palette-panel">
          <div className="palette-search">
            <Icon glyph={Search} />
            <input
              ref={input}
              className="palette-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Go to a page, an automation or a run"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={shown.length ? `${listId}-${index}` : undefined}
              aria-label="Search"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <ul id={listId} role="listbox" className="palette-list" aria-label="Results">
            {shown.length === 0 && (
              <li className="palette-empty">{searching ? 'Searching' : 'Nothing matches.'}</li>
            )}
            {shown.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === index}
                className={cx('palette-item', i === index && 'is-active')}
                onPointerMove={() => setIndex(i)}
                onClick={() => run(c)}
              >
                {c.icon ? <Icon glyph={c.icon} /> : <span className="palette-icon-space" />}
                <span className="palette-label">{c.label}</span>
                {c.hint && <span className="palette-hint">{c.hint}</span>}
                {i === index && <Icon glyph={CornerDownLeft} size={14} className="palette-enter" />}
              </li>
            ))}
          </ul>
          {searching && (
            <div
              className="ui-progress palette-progress"
              role="progressbar"
              aria-label="Searching"
            />
          )}
        </div>
      )}
    </dialog>
  );
}
