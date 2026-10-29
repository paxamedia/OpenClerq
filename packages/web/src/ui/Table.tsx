import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Icon } from './Icon';
import { cx } from './cx';
import './Table.css';

export interface Column<R> {
  key: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  /** Makes the column sortable by this value. Empty values sort last. */
  sortValue?: (row: R) => string | number | null | undefined;
  align?: 'start' | 'end';
  /** Monospace with tabular figures, for numbers, IDs and times. */
  mono?: boolean;
  width?: 'xs' | 'sm' | 'md' | 'lg';
}

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface TableProps<R> {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  /** Names the table for screen readers. */
  label: string;
  initialSort?: SortState;
  onRowClick?: (row: R) => void;
  selectedKey?: string;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  className?: string;
}

/** Rows ordered by a column's sort value; the input is not changed. */
export function sortRows<R>(rows: R[], columns: Column<R>[], sort: SortState | null): R[] {
  const column = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !column?.sortValue) return rows;
  const value = column.sortValue;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || x === '') return y == null || y === '' ? 0 : 1;
    if (y == null || y === '') return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
  });
}

/**
 * A table with a sticky header. Sortable columns sort on click: text A to Z
 * first, numbers largest first. Rows open on click or Enter when onRowClick is set.
 */
export function Table<R>({
  columns,
  rows,
  rowKey,
  label,
  initialSort,
  onRowClick,
  selectedKey,
  empty,
  className,
}: TableProps<R>) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  const toggle = (column: Column<R>) => {
    if (sort?.key === column.key) {
      setSort({ key: column.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
      return;
    }
    const sample = rows.map((r) => column.sortValue?.(r)).find((v) => v != null);
    setSort({ key: column.key, direction: typeof sample === 'number' ? 'desc' : 'asc' });
  };

  const onRowKey = (e: KeyboardEvent, row: R) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onRowClick?.(row);
  };

  return (
    <div className={cx('ui-table-wrap', className)}>
      <table className="ui-table">
        <caption className="ui-sr-only">{label}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key ? sort.direction : null;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(c.align === 'end' && 'is-end', c.width && `ui-col--${c.width}`)}
                  aria-sort={
                    c.sortValue
                      ? active === 'asc'
                        ? 'ascending'
                        : active === 'desc'
                          ? 'descending'
                          : 'none'
                      : undefined
                  }
                >
                  {c.sortValue ? (
                    <button type="button" className="ui-th-sort" onClick={() => toggle(c)}>
                      {c.header}
                      <Icon
                        glyph={
                          active === 'asc'
                            ? ArrowUp
                            : active === 'desc'
                              ? ArrowDown
                              : ChevronsUpDown
                        }
                        size={12}
                        className={cx('ui-th-icon', active && 'is-active')}
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && empty !== undefined ? (
            <tr>
              <td colSpan={columns.length} className="ui-table-empty">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  className={cx(onRowClick && 'is-clickable', key === selectedKey && 'is-selected')}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
                  aria-current={key === selectedKey ? 'true' : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx(c.align === 'end' && 'is-end', c.mono && 'is-mono')}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
