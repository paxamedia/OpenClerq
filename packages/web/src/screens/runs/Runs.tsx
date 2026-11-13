/**
 * Runs: every run, filterable, newest first and live; and one run in detail,
 * with its pipeline, steps, diff, cost and tokens.
 */

import { useMemo, useState } from 'react';
import { ArrowUpRight, FileText, History, Square } from 'lucide-react';
import type { RunDetail, RunStep, RunSummary } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { CodeBlock, KeyValue } from '../../ui/Display';
import { Input, Select } from '../../ui/Field';
import { QUEUED_NOTE, RunStatus } from '../../ui/Status';
import { Split } from '../../ui/Split';
import { Table, type Column } from '../../ui/Table';
import { useToast } from '../../ui/Toast';
import { PipelineStepper, StepWaterfall, stepWindow, type WaterfallRow } from '../../charts/charts';
import { useClient, useHost } from '../../app/client';
import { loadRunsSince, useAutomations, useRun } from '../../app/data';
import { duration, errorMessage, money, tokens } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import { navigate, useQueryParam } from '../../app/router';
import { ACTIVE, isFinished, pipeline, runSpan } from '../../app/stats';
import {
  EmptyState,
  ErrorState,
  Loaded,
  Page,
  PageHeader,
  PageSkeleton,
  Section,
} from '../../shell/layout';
import { useNow, When } from '../common';
import { DiffViewer } from './Diff';
import './runs.css';

const TRIGGERS: Record<string, string> = {
  schedule: 'Schedule',
  manual: 'By hand',
  event: 'Event',
  webhook: 'Webhook',
};

const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'awaiting_approval', label: 'Needs approval' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function runName(r: RunSummary): string {
  if (r.automationName) return r.automationName;
  if (r.input) return r.input.length > 60 ? `${r.input.slice(0, 60)}…` : r.input;
  return TRIGGERS[r.trigger] ?? 'Run';
}

function matchesStatus(r: RunSummary, status: string | null): boolean {
  if (!status) return true;
  if (status === 'running') return ACTIVE.has(r.status) || r.status === 'queued';
  // Waiting for a place, a retry's backoff, or a gateway to pick it up.
  if (status === 'queued') return r.status === 'queued' || r.status === 'leased';
  return r.status === status;
}

function RunList() {
  const client = useClient();
  const automations = useAutomations();
  const [status, setStatus] = useQueryParam('status');
  const [automation, setAutomation] = useQueryParam('automation');
  const [trigger, setTrigger] = useQueryParam('trigger');
  const [date, setDate] = useQueryParam('date');
  const now = useNow(15_000);

  const runs = useResource(
    `runs:list:${date ?? ''}`,
    async () => {
      if (!date) return (await client.runs(200)).runs;
      const [y, m, d] = date.split('-').map(Number);
      const start = new Date(y, m - 1, d);
      const end = new Date(y, m - 1, d + 1);
      return (await loadRunsSince(client, start, 5000)).filter(
        (r) => Date.parse(r.createdAt) < end.getTime()
      );
    },
    { on: ['runs'] }
  );

  const rows = (runs.data ?? []).filter(
    (r) =>
      matchesStatus(r, status) &&
      (!automation || r.automationId === automation) &&
      (!trigger || r.trigger === trigger)
  );

  const columns: Column<RunSummary>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <RunStatus state={r.status} />,
      sortValue: (r) => r.status,
      width: 'sm',
    },
    {
      key: 'name',
      header: 'Run',
      cell: (r) => <span className="runs-name">{runName(r)}</span>,
      sortValue: runName,
    },
    {
      key: 'trigger',
      hideOnPhone: true,
      header: 'Trigger',
      cell: (r) => TRIGGERS[r.trigger] ?? r.trigger,
      sortValue: (r) => r.trigger,
      width: 'sm',
    },
    {
      key: 'started',
      header: 'Started',
      cell: (r) => <When at={r.startedAt ?? r.createdAt} now={now} />,
      sortValue: (r) => Date.parse(r.createdAt),
      width: 'sm',
    },
    {
      key: 'duration',
      hideOnPhone: true,
      header: 'Duration',
      cell: (r) => {
        const [a, b] = runSpan(r, now);
        return r.startedAt ? duration(b - a) : '—';
      },
      sortValue: (r) => {
        const [a, b] = runSpan(r, now);
        return b - a;
      },
      align: 'end',
      mono: true,
      width: 'sm',
    },
    {
      key: 'cost',
      hideOnPhone: true,
      header: 'Cost',
      cell: (r) => money(r.costUsd, { atLeast: !r.costKnown && r.costUsd > 0 }),
      sortValue: (r) => r.costUsd,
      align: 'end',
      mono: true,
      width: 'sm',
    },
  ];

  const filtered = Boolean(status || automation || trigger || date);

  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Runs' }]} />
      <div className="runs-filters" role="search" aria-label="Filter runs">
        <Select
          label="Status"
          value={status ?? ''}
          onChange={(e) => setStatus(e.target.value || null)}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select
          label="Automation"
          value={automation ?? ''}
          onChange={(e) => setAutomation(e.target.value || null)}
        >
          <option value="">Any automation</option>
          {(automations.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select
          label="Trigger"
          value={trigger ?? ''}
          onChange={(e) => setTrigger(e.target.value || null)}
        >
          <option value="">Any trigger</option>
          {Object.entries(TRIGGERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Input
          label="Day"
          type="date"
          value={date ?? ''}
          onChange={(e) => setDate(e.target.value || null)}
        />
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            className="runs-clear"
            onClick={() => navigate('/runs', { replace: true })}
          >
            Clear filters
          </Button>
        )}
      </div>
      <Loaded resource={runs} what="runs" skeleton="rows">
        {() => (
          <Table
            label="Runs"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/runs/${encodeURIComponent(r.id)}`)}
            empty={
              <EmptyState icon={History} title={filtered ? 'No runs match' : 'No runs yet'}>
                {filtered ? 'Change or clear the filters.' : 'Runs appear here as they start.'}
              </EmptyState>
            }
          />
        )}
      </Loaded>
    </Page>
  );
}

/** One line saying what a step was. */
export function stepLabel(step: RunStep): string {
  const input = (step.input ?? {}) as Record<string, unknown>;
  const output = (step.output ?? {}) as Record<string, unknown>;
  switch (step.kind) {
    case 'gate':
      return `Gate: ${String(input.run ?? input.assert ?? '')}`;
    case 'git': {
      const action = String(input.action ?? '');
      const words: Record<string, string> = {
        fetch: 'Fetched the base branch',
        worktree: `Opened a worktree${output.branch ? ` on ${String(output.branch)}` : ''}`,
        commit: `Committed${output.sha ? ` ${String(output.sha).slice(0, 7)}` : ''}`,
        push: `Pushed ${String(input.branch ?? '')}`.trim(),
        pull_request: 'Opened a draft pull request',
      };
      return words[action] ?? `git ${action}`;
    }
    case 'tool':
      return `Tool: ${String(input.name ?? '')}`;
    case 'llm':
      return step.status === 'text' ? String(output.text ?? '').split('\n')[0] : 'Model call';
    case 'shell':
      return `Shell: ${String(input.command ?? input.run ?? '')}`;
    default:
      return step.kind;
  }
}

function Artifacts({ run }: { run: RunDetail }) {
  const client = useClient();
  const diffs = run.artifacts.filter((a) => a.kind === 'diff');
  const others = run.artifacts.filter((a) => a.kind !== 'diff');
  const [openId, setOpenId] = useState<number | null>(null);
  const diff = useResource(diffs[0] ? `artifact:${run.id}:${diffs[0].id}` : null, () =>
    client.artifact(run.id, diffs[0].id)
  );
  const other = useResource(openId !== null ? `artifact:${run.id}:${openId}` : null, () =>
    client.artifact(run.id, openId as number)
  );
  if (!run.artifacts.length) return null;
  return (
    <>
      {diffs[0] && (
        <Section title="Changes">
          <Loaded resource={diff} what="the diff">
            {(a) => <DiffViewer diff={a.content} name={a.name} />}
          </Loaded>
        </Section>
      )}
      {others.length > 0 && (
        <Section title="Files">
          <div className="page-row">
            {others.map((a) => (
              <Button
                key={a.id}
                size="sm"
                icon={FileText}
                onClick={() => setOpenId(openId === a.id ? null : a.id)}
              >
                {a.name ?? a.kind}
              </Button>
            ))}
          </div>
          {openId !== null && (
            <Loaded resource={other} what="the file">
              {(a) => <CodeBlock code={a.content} title={a.name ?? a.kind} maxHeight="lg" />}
            </Loaded>
          )}
        </Section>
      )}
    </>
  );
}

function stepDetail(step: RunStep): string {
  const parts: Record<string, unknown> = {};
  if (step.input !== undefined) parts.input = step.input;
  if (step.output !== undefined) parts.output = step.output;
  if (step.tokensIn !== undefined) parts.tokens = { in: step.tokensIn, out: step.tokensOut };
  if (step.costUsd !== undefined) parts.costUsd = step.costUsd;
  return JSON.stringify(parts, null, 2);
}

function RunView({ id }: { id: string }) {
  const client = useClient();
  const host = useHost();
  const live = useLive();
  const toast = useToast();
  const run = useRun(id);
  const now = useNow(1000);
  const [open, setOpen] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const cancel = async () => {
    setCancelling(true);
    try {
      await client.cancelRun(id);
      live.invalidate(['runs']);
    } catch (e) {
      toast({ message: `Couldn’t cancel the run. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setCancelling(false);
    }
  };

  const rows: WaterfallRow[] = useMemo(
    () =>
      (run.data?.steps ?? []).map((s) => ({ key: String(s.seq), label: stepLabel(s), step: s })),
    [run.data]
  );

  if (!run.data) {
    return (
      <Page>
        <PageHeader crumbs={[{ label: 'Runs', to: '/runs' }, { label: 'Run' }]} />
        {run.error ? (
          <ErrorState error={run.error} onRetry={run.reload} what="this run" />
        ) : (
          <PageSkeleton />
        )}
      </Page>
    );
  }
  const r = run.data;
  const [start, end] = runSpan(r, now);
  const stepsStart = rows.length
    ? Math.min(start, ...rows.map((x) => stepWindow(x.step)[0]))
    : start;
  const stepsEnd = rows.length ? Math.max(end, ...rows.map((x) => stepWindow(x.step)[1])) : end;
  const finished = isFinished(r.status);

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Runs', to: '/runs' }, { label: runName(r) }]}
        actions={
          <>
            {r.prUrl && (
              <Button icon={ArrowUpRight} onClick={() => host.openUrl(r.prUrl as string)}>
                Open pull request
              </Button>
            )}
            {!finished && (
              <Button variant="danger" icon={Square} busy={cancelling} onClick={cancel}>
                Cancel run
              </Button>
            )}
          </>
        }
      />
      {r.automationId && <PipelineStepper states={pipeline(r)} />}
      {run.error ? <ErrorState error={run.error} onRetry={run.reload} compact /> : null}
      <Split storageKey="run-detail" initial={360} min={260} max={640} label="Resize the run facts">
        <Section title="Run">
          <KeyValue
            items={[
              { label: 'Status', value: <RunStatus state={r.status} /> },
              {
                label: 'Outcome',
                value:
                  r.exitReason ??
                  (r.status === 'queued' || r.status === 'leased' ? QUEUED_NOTE : undefined),
              },
              { label: 'Started', value: <When at={r.startedAt ?? r.createdAt} /> },
              { label: 'Duration', value: r.startedAt ? duration(end - start) : '', mono: true },
              { label: 'Trigger', value: TRIGGERS[r.trigger] ?? r.trigger },
              {
                label: 'Automation',
                value: r.automationId ? (
                  <a
                    className="page-link"
                    href={`#/m/automations/${encodeURIComponent(r.automationId)}`}
                  >
                    {r.automationName ?? r.automationId}
                  </a>
                ) : (
                  ''
                ),
              },
              { label: 'Branch', value: r.branch, mono: true },
              {
                label: 'Cost',
                value: `${money(r.costUsd, { atLeast: !r.costKnown && r.costUsd > 0 })}${r.costKnown ? '' : ' (some calls unpriced)'}`,
                mono: true,
              },
              {
                label: 'Tokens',
                value: `${tokens(r.tokensIn, false)} in · ${tokens(r.tokensOut, false)} out`,
                mono: true,
              },
              { label: 'Run ID', value: r.id, mono: true },
            ]}
          />
        </Section>
        <Section title="Steps">
          {rows.length ? (
            <StepWaterfall
              rows={rows}
              runStart={stepsStart}
              runEnd={stepsEnd}
              open={open}
              onToggle={(k) => setOpen(open === k ? null : k)}
              renderDetail={(row) => <CodeBlock code={stepDetail(row.step)} wrap maxHeight="md" />}
            />
          ) : (
            <p className="page-hint">
              {finished ? 'This run recorded no steps.' : 'Steps appear as the run makes them.'}
            </p>
          )}
        </Section>
      </Split>
      <Artifacts run={r} />
      {r.input && !r.automationId && (
        <Section title="Message">
          <CodeBlock code={r.input} wrap maxHeight="sm" />
        </Section>
      )}
    </Page>
  );
}

export function Runs({ id }: { id: string | null }) {
  return id ? <RunView id={id} /> : <RunList />;
}
