/**
 * A unified diff as a file list and the changes, unified or side by side.
 */

import { useMemo, useState } from 'react';
import { FileDiff } from 'lucide-react';
import { SegmentedControl } from '../../ui/Choice';
import { EmptyState } from '../../ui/Display';
import { Icon } from '../../ui/Icon';
import { cx } from '../../ui/cx';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  binary: boolean;
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      file = { path: m?.[1] ?? line.slice(11), added: 0, removed: 0, lines: [], binary: false };
      files.push(file);
      continue;
    }
    if (!file) {
      // A diff without git headers: start a file at the first ---/+++ pair.
      if (!line.startsWith('--- ')) continue;
      file = {
        path: line.slice(4).replace(/^a\//, ''),
        added: 0,
        removed: 0,
        lines: [],
        binary: false,
      };
      files.push(file);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (p !== '/dev/null') file.path = p;
      continue;
    }
    if (
      line.startsWith('--- ') ||
      line.startsWith('index ') ||
      /^(new|deleted) file mode|^similarity|^rename /.test(line)
    ) {
      continue;
    }
    if (line.startsWith('Binary files')) {
      file.binary = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
      file.added++;
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
      file.removed++;
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

type Row = { left?: DiffLine; right?: DiffLine; hunk?: string };

/** Removed and added lines paired up, for the side-by-side view. */
export function splitRows(lines: DiffLine[]): Row[] {
  const rows: Row[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l);
    else if (l.kind === 'add') adds.push(l);
    else {
      flush();
      if (l.kind === 'hunk') rows.push({ hunk: l.text });
      else rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

const SIGN = { add: '+', del: '−', ctx: ' ', hunk: '' };

function Cell({ line, side }: { line?: DiffLine; side: 'old' | 'new' }) {
  if (!line) return <td className="diff-cell is-blank" colSpan={2} />;
  const no = side === 'old' ? line.oldNo : line.newNo;
  return (
    <>
      <td className="diff-no">{no}</td>
      <td className={cx('diff-cell', `is-${line.kind}`)}>
        <span className="diff-sign" aria-hidden="true">
          {SIGN[line.kind]}
        </span>
        {line.text}
      </td>
    </>
  );
}

export function DiffViewer({ diff, name }: { diff: string; name?: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const [selected, setSelected] = useState(0);
  const file = files[Math.min(selected, files.length - 1)];
  if (!files.length) {
    return <EmptyState icon={FileDiff} title="No changes in this diff" />;
  }
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-summary">
          {name && <span className="page-mono">{name}</span>}
          <span>
            {files.length} {files.length === 1 ? 'file' : 'files'},{' '}
            <span className="tone-text-ok">+{added}</span>{' '}
            <span className="tone-text-err">−{removed}</span>
          </span>
        </span>
        <SegmentedControl
          size="sm"
          label="Diff layout"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
        />
      </div>
      <div className="diff-body">
        <ul className="diff-files" aria-label="Changed files">
          {files.map((f, i) => (
            <li key={`${f.path}-${i}`}>
              <button
                type="button"
                className={cx('diff-file', i === selected && 'is-active')}
                aria-current={i === selected ? 'true' : undefined}
                onClick={() => setSelected(i)}
              >
                <Icon glyph={FileDiff} size={14} />
                <span className="diff-file-path">{f.path}</span>
                <span className="diff-file-count">
                  <span className="tone-text-ok">+{f.added}</span>{' '}
                  <span className="tone-text-err">−{f.removed}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="diff-table-wrap" tabIndex={0} aria-label={`Changes in ${file.path}`}>
          {file.binary ? (
            <p className="page-hint diff-binary">Binary file changed.</p>
          ) : mode === 'unified' ? (
            <table className="diff-table">
              <tbody>
                {file.lines.map((l, i) =>
                  l.kind === 'hunk' ? (
                    <tr key={i}>
                      <td className="diff-hunk" colSpan={3}>
                        {l.text}
                      </td>
                    </tr>
                  ) : (
                    <tr key={i}>
                      <td className="diff-no">{l.oldNo}</td>
                      <td className="diff-no">{l.newNo}</td>
                      <td className={cx('diff-cell', `is-${l.kind}`)}>
                        <span className="diff-sign" aria-hidden="true">
                          {SIGN[l.kind]}
                        </span>
                        {l.text}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          ) : (
            <table className="diff-table is-split">
              <tbody>
                {splitRows(file.lines).map((r, i) =>
                  r.hunk ? (
                    <tr key={i}>
                      <td className="diff-hunk" colSpan={4}>
                        {r.hunk}
                      </td>
                    </tr>
                  ) : (
                    <tr key={i}>
                      <Cell line={r.left} side="old" />
                      <Cell line={r.right} side="new" />
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
