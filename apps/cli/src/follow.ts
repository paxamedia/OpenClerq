/**
 * Reading a run: what its steps and tool calls say, what is new since the last
 * look, and watching it until it finishes.
 *
 * The words come from `@clerq/gateway-client` (`describeStep`, `toolLabel`),
 * the same ones the desktop app's run page uses. Following listens to the
 * gateway's event stream, filtered to the run and the sub-agents it started, and
 * looks at the run again whenever something happens; a slow poll covers an event
 * that was missed, so a dropped stream never leaves a finished run unseen.
 */

import {
  GatewayError,
  describeStep,
  gateway,
  toolLabel,
  type Approval,
  type ClerqEvent,
  type RunDetail,
  type RunStep,
  type ToolCallRecord,
} from '@clerq/gateway-client';
import type { Context } from './context.js';
import { EXIT } from './errors.js';
import { FINISHED, clock, dateTime, duration, money, oneLine, statusWords } from './format.js';

/** What a person is told about a run, one line each. */
export type Item =
  | {
      type: 'step';
      at: string;
      seq: number;
      kind: string;
      label: string;
      status?: string;
      note?: string;
      /** A model call's tokens and cost. */
      detail?: string;
    }
  | {
      type: 'tool';
      at: string;
      id: number;
      tool: string;
      label: string;
      input: string;
      status: ToolCallRecord['status'];
      decision: string;
      durationMs?: number;
      output: string;
    }
  | { type: 'subagent'; id: string; status: string; task: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'finished'; status: string; exitReason?: string };

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

/** A tool call's input on one short line. */
export function inputSummary(input: unknown, max = 100): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return oneLine(input, max);
  if (typeof input === 'object' && !Array.isArray(input)) {
    for (const k of SUMMARY_KEYS) {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) return oneLine(v, max);
    }
  }
  return oneLine(JSON.stringify(input) ?? '', max);
}

/** Whether a person was asked, in words. A CLI agent does not say. */
export function decisionWords(call: ToolCallRecord): string {
  if (call.status === 'denied')
    return call.approvalState === 'denied' ? 'you denied it' : 'refused by policy';
  switch (call.approvalState) {
    case 'approved':
      return 'you approved it';
    case 'denied':
      return 'you denied it';
    case 'not_required':
      return 'allowed without asking';
    default:
      return '';
  }
}

const TOOL_STATUS: Record<ToolCallRecord['status'], string> = {
  ok: 'done',
  error: 'failed',
  denied: 'denied',
  running: 'still running',
};

/** The line a tool call is shown as, after its time. */
export function toolLine(item: Extract<Item, { type: 'tool' }>): string {
  const name = item.label !== item.tool ? `${item.label} (${item.tool})` : item.tool;
  const result = [
    TOOL_STATUS[item.status],
    item.decision,
    // Sub-second times are noise; a long command is worth knowing about.
    item.durationMs !== undefined && item.durationMs >= 1000 ? duration(item.durationMs) : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${name}${item.input ? `  ${item.input}` : ''}  [${result}]`;
}

/** `1000 tokens in, 200 out, $0.25`, for a model call. */
function modelCallDetail(s: RunStep): string {
  const cost = s.costUsd === null || s.costUsd === undefined ? 'no price' : money(s.costUsd);
  return `${s.tokensIn ?? 0} tokens in, ${s.tokensOut ?? 0} out, ${cost}`;
}

/** Steps with these statuses say why in a second line. */
const SAYS_WHY = new Set(['error', 'failed', 'denied']);

/** Remembers what has been shown, and turns each new look at a run into what is new. */
export class RunReader {
  private steps = new Set<number>();
  private calls = new Set<number>();
  private children = new Map<string, string>();
  private approvals = new Set<number>();

  news(run: RunDetail, pending: Approval[], final = false): Item[] {
    const items: Item[] = [];
    // A tool call is its own line; the step that records it would say the same again.
    const covered = new Set(
      (run.toolCalls ?? []).map((c) => c.stepSeq).filter((s) => s !== undefined)
    );
    for (const s of run.steps) {
      if (this.steps.has(s.seq) || covered.has(s.seq)) continue;
      this.steps.add(s.seq);
      const words = describeStep(s);
      // A step the model only talked in carries its first line as the label; skip empty ones.
      if (!words.label.trim()) continue;
      items.push({
        type: 'step',
        at: s.createdAt,
        seq: s.seq,
        kind: s.kind,
        label: words.label,
        ...(s.status ? { status: s.status } : {}),
        ...(words.note && SAYS_WHY.has(s.status ?? '') ? { note: words.note } : {}),
        ...(s.kind === 'llm' && s.status !== 'text' && (s.tokensIn || s.tokensOut)
          ? { detail: modelCallDetail(s) }
          : {}),
      });
    }
    for (const c of run.toolCalls ?? []) {
      if (this.calls.has(c.id)) continue;
      // Shown once it has an outcome; a call still going is shown when the run ends.
      if (c.status === 'running' && !final) continue;
      this.calls.add(c.id);
      items.push({
        type: 'tool',
        at: c.createdAt,
        id: c.id,
        tool: c.name,
        label: toolLabel(c.name),
        input: inputSummary(c.input),
        status: c.status,
        decision: decisionWords(c),
        ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
        output: oneLine((c.output ?? '').split('\n').find((l) => l.trim()) ?? '', 100),
      });
    }
    items.sort((a, b) => {
      const x = 'at' in a ? a.at : '';
      const y = 'at' in b ? b.at : '';
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const child of run.children ?? []) {
      if (this.children.get(child.id) === child.status) continue;
      this.children.set(child.id, child.status);
      items.push({
        type: 'subagent',
        id: child.id,
        status: child.status,
        task: oneLine(child.input, 80),
      });
    }
    for (const a of pending) {
      if (this.approvals.has(a.id)) continue;
      this.approvals.add(a.id);
      items.push({ type: 'approval', approval: a });
    }
    if (FINISHED.has(run.status)) {
      items.push({
        type: 'finished',
        status: run.status,
        ...(run.exitReason ? { exitReason: run.exitReason } : {}),
      });
    }
    return items;
  }
}

/** The line(s) an item is printed as for a person. */
export function itemLines(item: Item): string[] {
  const at = (iso: string) => `${clock(iso)}  `;
  const blank = '          ';
  switch (item.type) {
    case 'step': {
      const flag =
        item.status && ['warning', 'error', 'failed', 'denied'].includes(item.status)
          ? `  [${item.status}]`
          : '';
      return [
        `${at(item.at)}${item.label}${item.detail ? `  (${item.detail})` : ''}${flag}`,
        ...(item.note ? [`${blank}${item.note}`] : []),
      ];
    }
    case 'tool':
      return [
        `${at(item.at)}${toolLine(item)}`,
        ...(item.output ? [`${blank}${item.output}`] : []),
      ];
    case 'subagent':
      return [
        `${blank}Sub-agent ${item.id}: ${statusWords(item.status)}${item.task ? `, ${item.task}` : ''}`,
      ];
    case 'approval': {
      const a = item.approval;
      return [
        `${blank}Waiting for approval ${a.id}: ${toolLabel(a.tool)}${toolLabel(a.tool) !== a.tool ? ` (${a.tool})` : ''}${a.reason ? `. ${oneLine(a.reason, 160)}` : ''}`,
        `${blank}  Approve: clerq approve ${a.id}    Deny: clerq deny ${a.id}`,
      ];
    }
    case 'finished':
      return [
        `${blank}Run ${statusWords(item.status)}.${item.exitReason ? ` ${item.exitReason}` : ''}`,
      ];
  }
}

/** The header `clerq logs` opens with. */
export function runHeader(run: RunDetail): string[] {
  const cost = run.costUsd > 0 ? money(run.costUsd, run.costKnown) : '';
  const children = run.childCostUsd
    ? ` + ${money(run.childCostUsd, run.childCostKnown !== false)} sub-agents`
    : '';
  const rows: Array<[string, string]> = [
    [
      'Started',
      `${dateTime(run.startedAt ?? run.createdAt)} (${run.trigger === 'manual' ? 'by hand' : run.trigger})`,
    ],
    ...(run.finishedAt && run.startedAt
      ? ([['Took', duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))]] as Array<
          [string, string]
        >)
      : []),
    ...(run.parentRunId ? ([['Sub-agent of', run.parentRunId]] as Array<[string, string]>) : []),
    ...(run.modelOverride
      ? ([
          ['Model', `${run.modelOverride}, chosen for this run: used as chosen, with no fallback`],
        ] as Array<[string, string]>)
      : []),
    ...(run.branch ? ([['Branch', run.branch]] as Array<[string, string]>) : []),
    ...(run.prUrl ? ([['Pull request', run.prUrl]] as Array<[string, string]>) : []),
    ...(cost
      ? ([
          [
            'Cost',
            `${cost}${children}${run.tokensIn || run.tokensOut ? ` (${run.tokensIn} tokens in, ${run.tokensOut} out)` : ''}`,
          ],
        ] as Array<[string, string]>)
      : []),
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return [
    `Run ${run.id}${run.automationName ? ` of ${run.automationName}` : ''}: ${statusWords(run.status)}`,
    ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
  ];
}

export function exitFor(status: string): number {
  return status === 'done' ? EXIT.ok : EXIT.failed;
}

/** Print what is new, in the form the mode asks for. */
export function emit(ctx: Context, runId: string, items: Item[]): void {
  for (const item of items) {
    if (ctx.out.json) ctx.out.data({ runId, ...item });
    else for (const line of itemLines(item)) ctx.out.say(line);
  }
}

class Waker {
  private woken = false;
  private resolve: (() => void) | null = null;
  poke(): void {
    this.woken = true;
    this.resolve?.();
  }
  /** Until poked or `ms` passes or aborted; a poke that came earlier counts. */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.woken || signal.aborted) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        this.resolve = null;
        this.woken = false;
        done();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      this.resolve = finish;
    });
  }
}

/** The shortest gap between two looks at a run, so a burst of events is one request. */
const MIN_GAP_MS = 250;

/** A gateway that is restarting or behind a proxy that is: worth a few more tries. */
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 6;

const WATCHED = ['run.', 'approval.', 'tool.', 'gate.', 'model.', 'agent.'];

export interface WatchResult {
  run: RunDetail;
  exit: number;
}

/**
 * Watch a run until it finishes, printing what happens. Keeps waiting through an
 * approval unless `stopAtApproval`, which ends with exit 2 as soon as one is open.
 * Ctrl-C ends the watching, never the run.
 */
export async function watch(
  ctx: Context,
  runId: string,
  opts: { stopAtApproval: boolean; reader?: RunReader }
): Promise<WatchResult> {
  const reader = opts.reader ?? new RunReader();
  const stop = new AbortController();
  const waker = new Waker();
  const onInterrupt = () => stop.abort();
  if (ctx.signal.aborted) stop.abort();
  else ctx.signal.addEventListener('abort', onInterrupt, { once: true });

  const mine = (e: ClerqEvent) => e.context.runId === runId || e.context.parentRunId === runId;
  // Listening starts before the first look, so nothing between them is missed.
  const stream = gateway
    .streamEvents((e) => (mine(e) ? waker.poke() : undefined), {
      names: WATCHED,
      signal: stop.signal,
      onOpen: () => waker.poke(),
      onReset: () => waker.poke(),
      retryMs: 1000,
    })
    // A refused token or version will say so on the next look.
    .catch(() => undefined);

  // A lost connection or a gateway that is restarting is not the end of a long watch.
  let told = false;
  const persistently = async <T>(look: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await look();
        told = false;
        return result;
      } catch (e) {
        const transient = !(e instanceof GatewayError) || TRANSIENT_STATUS.has(e.status);
        if (!transient || attempt >= MAX_ATTEMPTS || stop.signal.aborted) throw e;
        if (!told) {
          ctx.out.note('Lost contact with the gateway; trying again.');
          told = true;
        }
        await new Promise((r) => setTimeout(r, ctx.retryMs * attempt));
      }
    }
  };

  let last: RunDetail | null = null;
  try {
    for (;;) {
      const run = await persistently(() => gateway.run(runId));
      last = run;
      const pending =
        run.status === 'awaiting_approval'
          ? (await persistently(() => gateway.approvals())).approvals.filter(
              (a) => a.runId === runId || a.parentRunId === runId
            )
          : [];
      emit(ctx, runId, reader.news(run, pending, FINISHED.has(run.status)));
      if (FINISHED.has(run.status)) return { run, exit: exitFor(run.status) };
      if (opts.stopAtApproval && run.status === 'awaiting_approval' && pending.length > 0) {
        return { run, exit: EXIT.approval };
      }
      await new Promise((r) => setTimeout(r, MIN_GAP_MS));
      await waker.wait(ctx.pollMs, stop.signal);
      if (stop.signal.aborted) return { run: last, exit: EXIT.interrupted };
    }
  } finally {
    ctx.signal.removeEventListener('abort', onInterrupt);
    stop.abort();
    await stream;
  }
}
