/**
 * Hand-written SVG charts. Square marks, 1px axes, numbers in mono, colour only
 * from the state tokens. Each has a one-sentence summary as its accessible name,
 * and every mark has a tooltip and opens what it stands for.
 */

import type { ReactNode } from 'react';
import type { ComparisonColumn, RunStep, RunSummary } from '@clerq/gateway-client';
import { Check, Circle, Dot, Minus, X } from 'lucide-react';
import { Icon } from '../ui/Icon';
import { runState } from '../ui/Status';
import { cx } from '../ui/cx';
import {
  clockTime,
  duration,
  exactTime,
  money,
  relativeTime,
  shortDate,
  tokens,
} from '../app/format';
import type { DayValue, StageId, StageState } from '../app/stats';
import { STAGES, runSpan } from '../app/stats';
import { markProps, TipBody, toneOf, useTip, useWidth } from './base';
import './charts.css';

// ---------------------------------------------------------------------------
// Sparkline: a column per day.
// ---------------------------------------------------------------------------

export interface SparklineProps {
  days: DayValue[];
  /** One sentence for screen readers, e.g. "Runs per day over 14 days". */
  summary: string;
  format: (v: number) => string;
  onOpenDay?: (day: Date) => void;
  tone?: 'accent' | 'ok' | 'warn' | 'err' | 'muted';
}

export function Sparkline({ days, summary, format, onOpenDay, tone = 'accent' }: SparklineProps) {
  const tip = useTip();
  const width = 112;
  const height = 28;
  const max = Math.max(1e-9, ...days.map((d) => d.value ?? 0));
  const slot = width / Math.max(days.length, 1);
  const bar = Math.max(2, slot - 2);
  return (
    <>
      <svg
        className={cx('chart', 'chart-spark', `tone-${tone}`)}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={summary}
      >
        <line className="chart-axis" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
        {days.map((d, i) => {
          const v = d.value;
          const h = v === null ? 0 : Math.max(v > 0 ? 2 : 0, (v / max) * (height - 2));
          const label = `${shortDate(d.day)}: ${v === null ? 'no data' : format(v)}`;
          return (
            <g
              key={i}
              {...markProps(
                tip,
                label,
                <TipBody title={shortDate(d.day)} lines={[v === null ? 'No runs' : format(v)]} />,
                onOpenDay ? () => onOpenDay(d.day) : undefined
              )}
            >
              <rect className="chart-hit" x={i * slot} y={0} width={slot} height={height} />
              <rect
                className="chart-fill"
                x={i * slot + (slot - bar) / 2}
                y={height - 1 - h}
                width={bar}
                height={h}
              />
            </g>
          );
        })}
      </svg>
      {tip.node}
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity timeline: each run as a bar from start to finish.
// ---------------------------------------------------------------------------

export interface TimelineProps {
  runs: RunSummary[];
  /** Milliseconds shown, ending now. */
  windowMs: number;
  onOpen: (run: RunSummary) => void;
  now?: number;
}

const LANE = 14;

export function ActivityTimeline({ runs, windowMs, onOpen, now = Date.now() }: TimelineProps) {
  const tip = useTip();
  const [ref, width] = useWidth<HTMLDivElement>();
  const start = now - windowMs;
  const inWindow = runs
    .map((r) => ({ run: r, span: runSpan(r, now) }))
    .filter(({ span }) => span[1] >= start)
    .sort((a, b) => a.span[0] - b.span[0]);

  const x = (t: number) => ((Math.max(t, start) - start) / windowMs) * width;
  // Greedy lanes: a run takes the first lane free at its start.
  const laneEnds: number[] = [];
  const placed = inWindow.map((item) => {
    const left = x(item.span[0]);
    const right = Math.max(left + 3, x(item.span[1]));
    let lane = laneEnds.findIndex((end) => end + 2 <= left);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(right);
    } else laneEnds[lane] = right;
    return { ...item, left, right, lane };
  });
  const lanes = Math.max(1, Math.min(laneEnds.length, 8));
  const axisY = lanes * LANE + 4;
  const height = axisY + 20;

  const ticks: number[] = [];
  const day = windowMs > 36 * 3_600_000;
  const step = day ? 86_400_000 : 6 * 3_600_000;
  const first = new Date(start);
  if (day) first.setHours(0, 0, 0, 0);
  else first.setMinutes(0, 0, 0);
  for (let t = first.getTime(); t <= now; t += step) {
    if (!day) {
      const h = new Date(t).getHours();
      if (h % 6 !== 0) {
        t += (6 - (h % 6)) * 3_600_000 - step;
        continue;
      }
    }
    if (t >= start) ticks.push(t);
  }

  const failed = inWindow.filter((r) => r.run.status === 'failed').length;
  const summary = `${inWindow.length} runs in the last ${day ? '7 days' : '24 hours'}${failed ? `, ${failed} failed` : ''}.`;

  return (
    <div ref={ref} className="chart-wrap">
      <svg
        className="chart chart-timeline"
        width={width}
        height={height}
        role="group"
        aria-label={summary}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={x(t)} x2={x(t)} y1={0} y2={axisY} />
            <text className="chart-tick" x={x(t) + 4} y={axisY + 14}>
              {day ? shortDate(t) : clockTime(t)}
            </text>
          </g>
        ))}
        <line className="chart-axis" x1={0} x2={width} y1={axisY + 0.5} y2={axisY + 0.5} />
        {placed
          .filter((p) => p.lane < 8)
          .map(({ run, left, right, lane, span }) => {
            const name =
              run.automationName ?? (run.trigger === 'manual' ? 'Chat or task' : run.trigger);
            const state = runState(run.status).label;
            return (
              <g
                key={run.id}
                {...markProps(
                  tip,
                  `${name}, ${state}, ${exactTime(span[0])}`,
                  <TipBody
                    title={name}
                    lines={[
                      state,
                      `${exactTime(span[0])} · ${duration(span[1] - span[0])}`,
                      money(run.costUsd, { atLeast: !run.costKnown }),
                    ]}
                  />,
                  () => onOpen(run)
                )}
              >
                <rect
                  className={cx('chart-fill', `tone-${toneOf(run.status)}`)}
                  x={left}
                  y={lane * LANE + 2}
                  width={right - left}
                  height={LANE - 4}
                />
              </g>
            );
          })}
      </svg>
      {tip.node}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run strip: the last runs of an automation, one square each.
// ---------------------------------------------------------------------------

export function RunStrip({
  runs,
  onOpen,
  slots = 20,
}: {
  /** Newest first, as the gateway lists them. */
  runs: Array<{ id: string; status: string; createdAt: string; costUsd?: number }>;
  onOpen: (id: string) => void;
  slots?: number;
}) {
  const tip = useTip();
  const shown = runs.slice(0, slots).reverse();
  const size = 8;
  const gap = 2;
  const width = slots * (size + gap) - gap;
  const failed = shown.filter((r) => r.status === 'failed').length;
  const summary = shown.length
    ? `Last ${shown.length} runs${failed ? `, ${failed} failed` : ', none failed'}.`
    : 'No runs yet.';
  const offset = (slots - shown.length) * (size + gap);
  return (
    <>
      <svg
        className="chart chart-strip"
        width={width}
        height={size}
        role="group"
        aria-label={summary}
      >
        {Array.from({ length: slots - shown.length }, (_, i) => (
          <rect
            key={`e${i}`}
            className="chart-empty"
            x={i * (size + gap) + 0.5}
            y={0.5}
            width={size - 1}
            height={size - 1}
          />
        ))}
        {shown.map((r, i) => {
          const state = runState(r.status).label;
          return (
            <rect
              key={r.id}
              {...markProps(
                tip,
                `${state}, ${exactTime(r.createdAt)}`,
                <TipBody
                  title={state}
                  lines={[
                    exactTime(r.createdAt),
                    r.costUsd !== undefined ? money(r.costUsd) : null,
                  ]}
                />,
                () => onOpen(r.id)
              )}
              className={cx('chart-mark is-link chart-fill', `tone-${toneOf(r.status)}`)}
              x={offset + i * (size + gap)}
              y={0}
              width={size}
              height={size}
            />
          );
        })}
      </svg>
      {tip.node}
    </>
  );
}

// ---------------------------------------------------------------------------
// Budget meter: month spend against the monthly cap.
// ---------------------------------------------------------------------------

export function BudgetMeter({
  spent,
  cap,
  atLeast = false,
  width = 96,
  onOpen,
}: {
  spent: number;
  cap: number | null;
  atLeast?: boolean;
  width?: number;
  onOpen?: () => void;
}) {
  const tip = useTip();
  const ratio = cap ? spent / cap : 0;
  const tone = !cap ? 'muted' : ratio >= 1 ? 'err' : ratio >= 0.8 ? 'warn' : 'accent';
  const label = cap
    ? `${money(spent, { atLeast })} of ${money(cap)} this month`
    : `${money(spent, { atLeast })} this month, no monthly cap`;
  const height = 6;
  return (
    <>
      <svg
        className={cx('chart chart-meter', `tone-${tone}`)}
        width={width}
        height={height}
        role="group"
        aria-label={label}
      >
        <g {...markProps(tip, label, <TipBody title="This month" lines={[label]} />, onOpen)}>
          <rect className="chart-track" x={0.5} y={0.5} width={width - 1} height={height - 1} />
          {cap ? (
            <rect
              className="chart-fill"
              x={0}
              y={0}
              width={Math.min(1, ratio) * width}
              height={height}
            />
          ) : null}
        </g>
      </svg>
      {tip.node}
    </>
  );
}

// ---------------------------------------------------------------------------
// Schedule heatmap: firings over the next four weeks.
// ---------------------------------------------------------------------------

export function ScheduleHeatmap({ firings, now = new Date() }: { firings: Date[]; now?: Date }) {
  const tip = useTip();
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Weeks start on Monday.
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 28 }, (_, i) => {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const times = firings.filter((f) => f >= day && f < next);
    return { day, times, past: next <= now };
  });
  const max = Math.max(1, ...cells.map((c) => c.times.length));
  const size = 22;
  const gap = 3;
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const total = cells.reduce((n, c) => n + c.times.length, 0);
  const labelW = 0;
  return (
    <>
      <svg
        className="chart chart-heat"
        width={labelW + 7 * (size + gap)}
        height={16 + 4 * (size + gap)}
        role="group"
        aria-label={`${total} runs scheduled over the next four weeks.`}
      >
        {names.map((n, i) => (
          <text key={n} className="chart-tick" x={labelW + i * (size + gap)} y={11}>
            {n.slice(0, 1)}
          </text>
        ))}
        {cells.map((c, i) => {
          const level = c.times.length ? Math.ceil((c.times.length / max) * 3) : 0;
          const list = c.times.slice(0, 6).map((t) => clockTime(t));
          return (
            <rect
              key={i}
              {...markProps(
                tip,
                `${shortDate(c.day)}: ${c.times.length} runs`,
                <TipBody
                  title={c.day.toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short',
                  })}
                  lines={
                    c.times.length
                      ? [
                          list.join(', ') +
                            (c.times.length > 6 ? ` and ${c.times.length - 6} more` : ''),
                        ]
                      : ['No runs']
                  }
                />
              )}
              className={cx('chart-mark chart-heat-cell', `level-${level}`, c.past && 'is-past')}
              x={labelW + (i % 7) * (size + gap) + 0.5}
              y={16 + Math.floor(i / 7) * (size + gap) + 0.5}
              width={size - 1}
              height={size - 1}
            />
          );
        })}
      </svg>
      {tip.node}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cost bars: cost per run.
// ---------------------------------------------------------------------------

export function CostBars({ runs, onOpen }: { runs: RunSummary[]; onOpen: (id: string) => void }) {
  const tip = useTip();
  const [ref, width] = useWidth<HTMLDivElement>();
  const shown = runs.slice(0, 30).reverse();
  const height = 96;
  const max = Math.max(0.01, ...shown.map((r) => r.costUsd));
  const slot = shown.length ? width / shown.length : width;
  const bar = Math.max(3, Math.min(24, slot - 3));
  const total = shown.reduce((s, r) => s + r.costUsd, 0);
  return (
    <div ref={ref} className="chart-wrap">
      <svg
        className="chart chart-cost"
        width={width}
        height={height + 16}
        role="group"
        aria-label={`Cost of the last ${shown.length} runs, ${money(total)} in all.`}
      >
        <line className="chart-grid" x1={0} x2={width} y1={0.5} y2={0.5} />
        <text className="chart-tick" x={0} y={12}>
          {money(max)}
        </text>
        <line className="chart-axis" x1={0} x2={width} y1={height + 0.5} y2={height + 0.5} />
        {shown.map((r, i) => {
          const h = Math.max(r.costUsd > 0 ? 2 : 0, (r.costUsd / max) * (height - 16));
          return (
            <g
              key={r.id}
              {...markProps(
                tip,
                `${exactTime(r.createdAt)}: ${money(r.costUsd)}`,
                <TipBody
                  title={money(r.costUsd, { atLeast: !r.costKnown })}
                  lines={[exactTime(r.createdAt), runState(r.status).label]}
                />,
                () => onOpen(r.id)
              )}
            >
              <rect className="chart-hit" x={i * slot} y={0} width={slot} height={height} />
              <rect
                className={cx('chart-fill', r.status === 'failed' ? 'tone-err' : 'tone-accent')}
                x={i * slot + (slot - bar) / 2}
                y={height - h}
                width={bar}
                height={h}
              />
            </g>
          );
        })}
        {shown.length > 0 && (
          <text className="chart-tick" x={0} y={height + 14}>
            {relativeTime(shown[0].createdAt)}
          </text>
        )}
      </svg>
      {tip.node}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline stepper: where an automation run is.
// ---------------------------------------------------------------------------

const STAGE_ICON = {
  done: Check,
  failed: X,
  skipped: Minus,
  current: Dot,
  waiting: Dot,
  pending: Circle,
};
const STAGE_WORD: Record<StageState, string> = {
  done: 'done',
  current: 'in progress',
  failed: 'failed',
  waiting: 'waiting for you',
  skipped: 'skipped',
  pending: 'not yet',
};

export function PipelineStepper({
  states,
  onSelect,
}: {
  states: Record<StageId, StageState>;
  onSelect?: (stage: StageId) => void;
}) {
  const current = STAGES.find((s) => ['current', 'waiting', 'failed'].includes(states[s.id]));
  return (
    <ol
      className="chart-stepper"
      aria-label={current ? `${current.label}: ${STAGE_WORD[states[current.id]]}` : 'Pipeline'}
    >
      {STAGES.map((s) => {
        const state = states[s.id];
        const body = (
          <>
            <span className="chart-step-mark" aria-hidden="true">
              <Icon glyph={STAGE_ICON[state]} size={12} strokeWidth={2} />
            </span>
            <span className="chart-step-label">{s.label}</span>
            <span className="ui-sr-only">, {STAGE_WORD[state]}</span>
          </>
        );
        return (
          <li
            key={s.id}
            className={cx('chart-step', `is-${state}`)}
            aria-current={state === 'current' || state === 'waiting' ? 'step' : undefined}
          >
            {onSelect && state !== 'pending' && state !== 'skipped' ? (
              <button type="button" className="chart-step-button" onClick={() => onSelect(s.id)}>
                {body}
              </button>
            ) : (
              <span className="chart-step-button">{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step waterfall: when each step ran and for how long.
// ---------------------------------------------------------------------------

export interface WaterfallRow {
  key: string;
  label: string;
  step: RunStep;
}

export function stepWindow(step: RunStep): [number, number] {
  const end = Date.parse(step.createdAt);
  const d = step.durationMs ?? 0;
  return [end - d, end];
}

export function StepWaterfall({
  rows,
  runStart,
  runEnd,
  open,
  onToggle,
  renderDetail,
}: {
  rows: WaterfallRow[];
  runStart: number;
  runEnd: number;
  open: string | null;
  onToggle: (key: string) => void;
  renderDetail: (row: WaterfallRow) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(240);
  const span = Math.max(1, runEnd - runStart);
  const x = (t: number) => ((Math.min(Math.max(t, runStart), runEnd) - runStart) / span) * width;
  return (
    <ol className="chart-waterfall" aria-label={`${rows.length} steps over ${duration(span)}.`}>
      {rows.map((r) => {
        const [a, b] = stepWindow(r.step);
        const left = x(a);
        const w = Math.max(2, x(b) - left);
        const status = r.step.status ?? '';
        const tone = /fail|error|denied/.test(status)
          ? 'err'
          : status === 'running'
            ? 'accent'
            : status === 'warning'
              ? 'warn'
              : 'muted';
        const isOpen = open === r.key;
        return (
          <li key={r.key} className={cx('chart-waterfall-item', isOpen && 'is-open')}>
            <button
              type="button"
              className="chart-waterfall-row"
              aria-expanded={isOpen}
              onClick={() => onToggle(r.key)}
              title={`${exactTime(a)} · ${duration(r.step.durationMs)}`}
            >
              <span className="chart-waterfall-kind">{r.step.kind}</span>
              <span className="chart-waterfall-label">{r.label}</span>
              <span
                ref={r === rows[0] ? ref : undefined}
                className="chart-waterfall-track"
                aria-hidden="true"
              >
                <svg className="chart" width={width} height={8}>
                  <rect
                    className={cx('chart-fill', `tone-${tone}`)}
                    x={left}
                    y={1}
                    width={w}
                    height={6}
                  />
                </svg>
              </span>
              <span className="chart-waterfall-time">
                {r.step.durationMs !== undefined
                  ? duration(r.step.durationMs)
                  : status === 'running'
                    ? 'running'
                    : ''}
              </span>
            </button>
            {isOpen && <div className="chart-waterfall-detail">{renderDetail(r)}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Compare bars: latency, tokens and cost per model.
// ---------------------------------------------------------------------------

type Metric = 'latency' | 'tokens' | 'cost';

function metricValue(c: ComparisonColumn, m: Metric): number | null {
  if (m === 'latency') return c.latencyMs ?? null;
  if (m === 'tokens')
    return c.tokensIn !== undefined ? (c.tokensIn ?? 0) + (c.tokensOut ?? 0) : null;
  return c.costUsd ?? null;
}

function metricText(v: number | null, m: Metric): string {
  if (v === null) return '—';
  return m === 'latency' ? duration(v) : m === 'tokens' ? tokens(v) : money(v);
}

export function CompareBars({ columns }: { columns: ComparisonColumn[] }) {
  const tip = useTip();
  const metrics: Array<{ id: Metric; label: string }> = [
    { id: 'latency', label: 'Latency' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'cost', label: 'Cost' },
  ];
  const width = 160;
  const bar = 8;
  return (
    <div className="chart-compare">
      {metrics.map((m) => {
        const values = columns.map((c) => metricValue(c, m.id));
        const max = Math.max(1e-9, ...values.map((v) => v ?? 0));
        const best = Math.min(...values.filter((v): v is number => v !== null));
        return (
          <figure key={m.id} className="chart-compare-group">
            <figcaption className="chart-compare-title">{m.label}</figcaption>
            <svg
              className="chart"
              width={width}
              height={columns.length * (bar + 6)}
              role="group"
              aria-label={`${m.label}: ${columns.map((c, i) => `${c.model} ${metricText(values[i], m.id)}`).join(', ')}.`}
            >
              {columns.map((c, i) => {
                const v = values[i];
                const w = v === null ? 0 : Math.max(2, (v / max) * width);
                return (
                  <rect
                    key={i}
                    {...markProps(
                      tip,
                      `${c.model}: ${metricText(v, m.id)}`,
                      <TipBody title={c.model} lines={[metricText(v, m.id)]} />
                    )}
                    className={cx(
                      'chart-mark chart-fill',
                      v !== null && v === best ? 'tone-ok' : 'tone-muted'
                    )}
                    x={0}
                    y={i * (bar + 6)}
                    width={w}
                    height={bar}
                  />
                );
              })}
            </svg>
          </figure>
        );
      })}
      {tip.node}
    </div>
  );
}

export { metricText, metricValue };
