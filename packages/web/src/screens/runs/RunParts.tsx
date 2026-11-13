/**
 * Pieces of a run's page that carry their own logic: the tool calls its agent
 * made, and the tree of sub-agents under the run that started them.
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChildRunSummary, ToolCallRecord } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { CodeBlock } from '../../ui/Display';
import { Icon } from '../../ui/Icon';
import { RunStatus, StatusTag, type Tone } from '../../ui/Status';
import { cx } from '../../ui/cx';
import { duration, money } from '../../app/format';
import { Link } from '../../app/router';
import { toolLabel } from '../../app/tools';

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const STATUS: Record<ToolCallRecord['status'], { tone: Tone; label: string }> = {
  running: { tone: 'accent', label: 'Working' },
  ok: { tone: 'ok', label: 'Done' },
  error: { tone: 'err', label: 'Failed' },
  denied: { tone: 'warn', label: 'Refused' },
};

export interface Decision {
  tone: Tone;
  label: string;
}

/**
 * Whether the call was allowed, and by whom: a person who was asked, the
 * policy that needed no one, or nobody the agent told us about (a CLI agent
 * does not say).
 */
export function decisionWords(call: Pick<ToolCallRecord, 'approvalState' | 'status'>): Decision {
  switch (call.approvalState) {
    case 'approved':
      return { tone: 'ok', label: 'You approved it' };
    case 'denied':
      return { tone: 'warn', label: 'Denied' };
    case 'not_required':
      return call.status === 'denied'
        ? { tone: 'warn', label: 'Refused by policy' }
        : { tone: 'muted', label: 'Allowed without asking' };
    default:
      return call.status === 'denied'
        ? { tone: 'warn', label: 'Refused' }
        : { tone: 'muted', label: 'Not reported' };
  }
}

/** The fields that say most about what a call did, in the order to look for them. */
const SUMMARY_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'file',
  'pattern',
  'query',
  'url',
  'key',
];

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A call's input on one short line. */
export function inputSummary(input: unknown, max = 100): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return cut(input.replace(/\s+/g, ' ').trim(), max);
  if (typeof input === 'object' && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    for (const k of SUMMARY_KEYS) {
      const v = fields[k];
      if (typeof v === 'string' && v.trim()) return cut(v.replace(/\s+/g, ' ').trim(), max);
    }
  }
  return cut(JSON.stringify(input) ?? '', max);
}

/** Output is shown whole up to this many lines or characters; longer is folded. */
export const OUTPUT_LINES = 8;
export const OUTPUT_CHARS = 800;

export interface OutputView {
  /** What to show while folded. */
  preview: string;
  /** True when the whole output is longer than the preview. */
  folded: boolean;
  lines: number;
  chars: number;
}

export function outputPreview(output: string): OutputView {
  const lines = output.split('\n');
  const long = lines.length > OUTPUT_LINES || output.length > OUTPUT_CHARS;
  return {
    preview: long ? cut(lines.slice(0, OUTPUT_LINES).join('\n'), OUTPUT_CHARS) : output,
    folded: long,
    lines: lines.length,
    chars: output.length,
  };
}

/** Output, folded to its first lines when it is long. */
export function ToolOutput({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  const view = outputPreview(output);
  return (
    <div className="toolcall-output">
      <CodeBlock
        code={open || !view.folded ? output : view.preview}
        title="Output"
        wrap
        maxHeight={open ? 'lg' : 'sm'}
      />
      {view.folded && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : `Show all ${view.lines} lines`}
        </Button>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCallRecord }) {
  const status = STATUS[call.status];
  const decision = decisionWords(call);
  const label = toolLabel(call.name);
  const summary = inputSummary(call.input);
  const input =
    call.input === undefined
      ? null
      : typeof call.input === 'string'
        ? call.input
        : JSON.stringify(call.input, null, 2);
  return (
    <li className="toolcall">
      <details>
        <summary className="toolcall-row">
          <Icon glyph={ChevronRight} size={14} className="toolcall-chevron" />
          <StatusTag tone={status.tone}>{status.label}</StatusTag>
          <span className="toolcall-name">
            {label}
            {label !== call.name && <code className="toolcall-raw">{call.name}</code>}
          </span>
          <span className="toolcall-input" title={summary}>
            {summary}
          </span>
          <span className={cx('toolcall-decision', `tone-text-${decision.tone}`)}>
            {decision.label}
          </span>
          <span className="toolcall-time">
            {call.durationMs !== undefined
              ? duration(call.durationMs)
              : call.status === 'running'
                ? 'running'
                : ''}
          </span>
        </summary>
        <div className="toolcall-body">
          {input && <CodeBlock code={input} title="Input" wrap maxHeight="sm" />}
          {call.output !== undefined ? (
            <ToolOutput output={call.output} />
          ) : (
            <p className="page-hint">
              {call.status === 'running' ? 'No output yet.' : 'It recorded no output.'}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

/** The tool calls a run's agent made, in order; each opens to its input and output. */
export function ToolCalls({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <ol className="toolcalls" aria-label={`${calls.length} tool calls`}>
      {calls.map((c) => (
        <ToolCallRow key={c.id} call={c} />
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

export interface TreeNode {
  id: string;
  /** What it is called: an automation, a task. */
  title: string;
  status: string;
  costUsd: number;
  costKnown: boolean;
}

/** A sub-agent as a node: its task is its name. */
export function childNode(c: ChildRunSummary): TreeNode {
  return {
    id: c.id,
    title: c.input ? cut(c.input.replace(/\s+/g, ' ').trim(), 90) : c.id,
    status: c.status,
    costUsd: c.costUsd,
    costKnown: c.costKnown,
  };
}

/** What the children cost together. */
export function childTotal(children: TreeNode[]): number {
  return Math.round(children.reduce((sum, c) => sum + c.costUsd, 0) * 1e6) / 1e6;
}

function NodeRow({
  node,
  current,
  note,
}: {
  node: TreeNode;
  current: boolean;
  /** Under the cost: what it is made of. */
  note?: string;
}) {
  return (
    <div className="runtree-row" aria-current={current ? 'page' : undefined}>
      <RunStatus state={node.status} />
      {current ? (
        <span className="runtree-title is-current">{node.title}</span>
      ) : (
        <Link className="page-link runtree-title" to={`/runs/${encodeURIComponent(node.id)}`}>
          {node.title}
        </Link>
      )}
      {current && <span className="runtree-here">This run</span>}
      <span className="runtree-cost">
        <span className="page-mono">
          {money(node.costUsd, { atLeast: !node.costKnown && node.costUsd > 0 })}
        </span>
        {note && <span className="runtree-note">{note}</span>}
      </span>
    </div>
  );
}

/**
 * The run that started sub-agents, and each of them under it with its status
 * and cost. `currentId` marks the run being looked at, whichever level it is.
 */
export function RunTree({
  parent,
  children,
  currentId,
}: {
  parent: TreeNode;
  children: TreeNode[];
  currentId: string;
}) {
  const total = childTotal(children);
  return (
    <>
      <ul className="runtree" aria-label="Run and its sub-agents">
        <li className="runtree-node">
          <NodeRow
            node={parent}
            current={parent.id === currentId}
            note={total > 0 ? `+ ${money(total)} sub-agents` : undefined}
          />
          <ul className="runtree-children">
            {children.map((c) => (
              <li key={c.id} className="runtree-node">
                <NodeRow node={c} current={c.id === currentId} />
              </li>
            ))}
          </ul>
        </li>
      </ul>
      {total > 0 && (
        <p className="page-hint">
          The sub-agents cost {money(total)} on top of the run’s own {money(parent.costUsd)}:{' '}
          {money(parent.costUsd + total)} in all.
        </p>
      )}
    </>
  );
}
