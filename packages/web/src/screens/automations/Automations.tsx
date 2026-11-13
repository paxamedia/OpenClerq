/**
 * Automations: the table, one automation in detail, and the editor.
 * Routes under the module's base: "", "new", ":id", ":id/spec", ":id/runs", ":id/edit".
 */

import { useState } from 'react';
import { Cpu, Ellipsis, Pencil, Play, Plus, Trash2, Workflow } from 'lucide-react';
import type { RunSummary } from '@clerq/gateway-client';
import { Button, IconButton } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { CodeBlock, KeyValue } from '../../ui/Display';
import { Dialog } from '../../ui/Modal';
import { Menu } from '../../ui/Popover';
import { QUEUED_NOTE, RunStatus, StatusTag } from '../../ui/Status';
import { Table, type Column } from '../../ui/Table';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';
import { BudgetMeter, CostBars, RunStrip, ScheduleHeatmap } from '../../charts/charts';
import { useClient, type AutomationInfo } from '../../app/client';
import { describeCron } from '../../app/cron';
import { useAutomations } from '../../app/data';
import { duration, errorMessage, money } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import type { ModuleProps } from '../../app/modules';
import { navigate } from '../../app/router';
import { runSpan } from '../../app/stats';
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
import { AutomationEditor } from './Editor';
import { RunWithModel } from './RunWithModel';
import { gatesOf } from './spec';
import { catchUpWords, missedSince, missedWords, runNow } from './words';
import './automations.css';

const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;

/** The latest runs, for the strips and the detail page; one read shared by both. */
function useLatestRuns() {
  const client = useClient();
  return useResource('runs:latest', async () => (await client.runs(500)).runs, { on: ['runs'] });
}

function scheduleWords(a: AutomationInfo): string {
  if (a.problem) return 'Needs editing';
  return a.schedule ? describeCron(a.schedule) : 'When you start it';
}

/** Turn on or off at once; roll back with an error if the gateway refuses. */
function useToggle() {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  return async (a: AutomationInfo, enabled: boolean) => {
    const flip = (on: boolean) =>
      live.write<AutomationInfo[]>('automations', (cur) =>
        (cur ?? []).map((x) => (x.id === a.id ? { ...x, enabled: on } : x))
      );
    flip(enabled);
    try {
      await client.setAutomationEnabled(a.id, enabled);
    } catch (e) {
      flip(!enabled);
      toast({
        message: `Couldn’t turn ${a.name} ${enabled ? 'on' : 'off'}. ${errorMessage(e)}`,
        tone: 'err',
      });
    } finally {
      live.invalidate(['automations']);
    }
  };
}

function useRunNow() {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (a: AutomationInfo) => {
    setBusy(a.id);
    try {
      const { runId, queued } = await client.runAutomation(a.id);
      live.invalidate(['runs', 'automations']);
      if (queued) toast({ message: `${a.name} is queued. ${QUEUED_NOTE}`, tone: 'neutral' });
      navigate(runPath(runId));
    } catch (e) {
      toast({ message: `Couldn’t start ${a.name}. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

function AutomationList({ base }: { base: string }) {
  const automations = useAutomations();
  const latest = useLatestRuns();
  const toggle = useToggle();
  const now = useNow();
  const byAutomation = new Map<string, RunSummary[]>();
  for (const r of latest.data ?? []) {
    if (!r.automationId) continue;
    const list = byAutomation.get(r.automationId) ?? [];
    list.push(r);
    byAutomation.set(r.automationId, list);
  }
  const open = (a: AutomationInfo) => navigate(`${base}/${encodeURIComponent(a.id)}`);

  const columns: Column<AutomationInfo>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (a) => a.name,
      cell: (a) => (
        <span className="aut-name">
          <span className="aut-name-line">
            <span className="aut-name-title">{a.name}</span>
            {a.authoredBy && (
              <StatusTag tone="warn" className="aut-from-chat">
                From a chat
              </StatusTag>
            )}
          </span>
          {a.problem ? (
            <span className="aut-name-sub tone-text-warn">{a.problem}</span>
          ) : a.description ? (
            <span className="aut-name-sub">{a.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'schedule',
      hideOnPhone: true,
      header: 'Schedule',
      cell: (a) => (
        <span className="aut-name">
          <span>{scheduleWords(a)}</span>
          {a.schedule && a.catchUp && !a.problem ? (
            <span className="aut-name-sub" title={catchUpWords(a) ?? undefined}>
              Catches up when it wakes
            </span>
          ) : null}
          {a.missedSlots ? (
            <span
              className="aut-name-sub tone-text-warn"
              title={`${missedWords(a.missedSlots)} ${missedSince(a.missedSlots)}`}
            >
              Missed {a.missedSlots.count}
              {a.missedSlots.capped ? '+' : ''} {a.missedSlots.count === 1 ? 'time' : 'times'}
            </span>
          ) : null}
        </span>
      ),
      sortValue: scheduleWords,
      width: 'md',
    },
    {
      key: 'next',
      header: 'Next run',
      width: 'md',
      sortValue: (a) => (a.enabled && a.nextFirings[0] ? Date.parse(a.nextFirings[0]) : null),
      cell: (a) =>
        a.running || a.queued ? (
          <span className="aut-state">
            {a.running && <StatusTag tone="accent">Running</StatusTag>}
            {a.queued && (
              <StatusTag tone="muted" className="aut-queued">
                {a.running ? 'Next one queued' : 'Queued'}
              </StatusTag>
            )}
          </span>
        ) : a.enabled && !a.problem && a.nextFirings[0] ? (
          <When at={a.nextFirings[0]} now={now} />
        ) : (
          <span className="page-muted">{a.enabled ? '—' : 'Off'}</span>
        ),
    },
    {
      key: 'runs',
      hideOnPhone: true,
      header: 'Last 20 runs',
      width: 'md',
      cell: (a) => (
        <span onClick={(e) => e.stopPropagation()} className="aut-cell-chart">
          <RunStrip runs={byAutomation.get(a.id) ?? []} onOpen={(id) => navigate(runPath(id))} />
        </span>
      ),
    },
    {
      key: 'budget',
      hideOnPhone: true,
      header: 'This month',
      width: 'md',
      sortValue: (a) => a.monthSpendUsd,
      cell: (a) => (
        <span className="aut-budget">
          <BudgetMeter spent={a.monthSpendUsd} cap={a.monthBudgetUsd} width={64} />
          <span className="page-mono">{money(a.monthSpendUsd)}</span>
        </span>
      ),
    },
    {
      key: 'on',
      header: 'On',
      width: 'xs',
      cell: (a) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Switch
            checked={a.enabled}
            onChange={(on) => toggle(a, on)}
            label={`${a.name} on`}
            hideLabel
          />
        </span>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Automations' }]}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => navigate(`${base}/new`)}>
            New automation
          </Button>
        }
      />
      <Loaded resource={automations} what="automations" skeleton="rows">
        {(list) => (
          <Table
            label="Automations"
            columns={columns}
            rows={list}
            rowKey={(a) => a.id}
            onRowClick={open}
            initialSort={{ key: 'name', direction: 'asc' }}
            empty={
              <EmptyState
                icon={Workflow}
                title="No automations yet"
                actions={
                  <Button variant="primary" icon={Plus} onClick={() => navigate(`${base}/new`)}>
                    New automation
                  </Button>
                }
              >
                An automation runs a coding agent on a schedule, checks the result with your gates
                and opens a draft pull request.
              </EmptyState>
            }
          />
        )}
      </Loaded>
    </Page>
  );
}

type Tab = 'overview' | 'spec' | 'runs';

function AutomationDetail({ id, tab, base }: { id: string; tab: Tab; base: string }) {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const automations = useAutomations();
  const detail = useResource(`automation:${id}`, () => client.automation(id), {
    on: ['automations'],
  });
  const latest = useLatestRuns();
  const toggle = useToggle();
  const { run, busy } = useRunNow();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const now = useNow();

  const a = automations.data?.find((x) => x.id === id);
  const runs = (latest.data ?? []).filter((r) => r.automationId === id);
  const path = `${base}/${encodeURIComponent(id)}`;

  if (!a) {
    return (
      <Page>
        <PageHeader crumbs={[{ label: 'Automations', to: base }, { label: 'Automation' }]} />
        {automations.error ? (
          <ErrorState error={automations.error} onRetry={automations.reload} what="automations" />
        ) : automations.data ? (
          <EmptyState icon={Workflow} title="This automation no longer exists">
            It may have been deleted. Its runs are still listed under Runs.
          </EmptyState>
        ) : (
          <PageSkeleton />
        )}
      </Page>
    );
  }

  const remove = async () => {
    setDeleting(true);
    try {
      await client.deleteAutomation(id);
      live.invalidate(['automations']);
      navigate(base);
    } catch (e) {
      toast({ message: `Couldn’t delete ${a.name}. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const gates = detail.data ? gatesOf(detail.data.source) : [];
  const firings = a.nextFirings.map((f) => new Date(f));

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Automations', to: base }, { label: a.name }]}
        actions={
          <>
            <AuthoredBy by={a.authoredBy} />
            <Switch
              checked={a.enabled}
              onChange={(on) => toggle(a, on)}
              label={a.enabled ? 'On' : 'Off'}
            />
            <Button icon={Pencil} onClick={() => navigate(`${path}/edit`)}>
              Edit
            </Button>
            <Button
              variant="primary"
              icon={Play}
              busy={busy === a.id || a.running}
              disabled={runNow(a).disabled}
              onClick={() => run(a)}
            >
              {runNow(a).label}
            </Button>
            <Menu
              label="More actions"
              items={[
                {
                  label: 'Run with a chosen model…',
                  icon: Cpu,
                  disabled: Boolean(a.problem) || a.running || a.queued,
                  onSelect: () => setChoosing(true),
                },
                {
                  label: 'Delete',
                  icon: Trash2,
                  danger: true,
                  onSelect: () => setConfirmDelete(true),
                },
              ]}
              trigger={(p) => <IconButton icon={Ellipsis} label="More actions" {...p} />}
            />
          </>
        }
      />
      {a.problem && <ErrorState error={new Error(a.problem)} />}
      <Tabs<Tab>
        label="Automation"
        value={tab}
        onChange={(t) => navigate(t === 'overview' ? path : `${path}/${t}`, { replace: true })}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'spec', label: 'Spec' },
          { value: 'runs', label: 'Runs', count: runs.length },
        ]}
      >
        {tab === 'overview' ? (
          <div className="aut-overview">
            <Section title="Schedule">
              <p className="aut-schedule-words">{scheduleWords(a)}</p>
              {a.schedule && !a.problem ? (
                <>
                  <ScheduleHeatmap firings={firings} />
                  <p className="page-hint">
                    {a.enabled ? (
                      <>
                        Next run <When at={a.nextFirings[0]} now={now} />.
                      </>
                    ) : (
                      'Off: these times are when it would run.'
                    )}
                  </p>
                  <p className="page-hint">{catchUpWords(a)}</p>
                </>
              ) : null}
              {a.missedSlots ? (
                <div className="aut-missed" role="status">
                  <StatusTag tone="warn">Missed times</StatusTag>
                  <p>
                    {missedWords(a.missedSlots)} {missedSince(a.missedSlots)} Noticed{' '}
                    <When at={a.missedSlots.at} now={now} />.
                  </p>
                </div>
              ) : null}
              {a.queued ? (
                <p className="page-hint">
                  A run is waiting{a.running ? ' behind the one going now' : ''}. {QUEUED_NOTE}
                </p>
              ) : null}
            </Section>
            <Section title="Cost per run">
              {runs.length ? (
                <CostBars runs={runs} onOpen={(rid) => navigate(runPath(rid))} />
              ) : (
                <p className="page-hint">No runs yet.</p>
              )}
              <KeyValue
                items={[
                  { label: 'This month', value: money(a.monthSpendUsd), mono: true },
                  {
                    label: 'Monthly cap',
                    value: a.monthBudgetUsd === null ? 'None' : money(a.monthBudgetUsd),
                    mono: true,
                  },
                ]}
              />
            </Section>
            <Section title="Gates">
              {!detail.data ? (
                <PageSkeleton kind="text" />
              ) : gates.length ? (
                <ol className="aut-gates">
                  {gates.map((g) => (
                    <li key={g}>
                      <code>{g}</code>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="page-hint">
                  No gates: nothing checks the result before it is published.
                </p>
              )}
            </Section>
            <Section title="Details">
              <KeyValue
                items={[
                  { label: 'Repository', value: a.repo, mono: true },
                  { label: 'Agent', value: a.driver },
                  {
                    label: 'Last run',
                    value: a.lastRun ? <RunStatus state={a.lastRun.status} /> : 'Never',
                  },
                  { label: 'Changed', value: <When at={a.updatedAt} /> },
                ]}
              />
            </Section>
          </div>
        ) : tab === 'spec' ? (
          <Loaded resource={detail} what="the spec" skeleton="text">
            {(d) => <CodeBlock code={d.source} title="Spec" maxHeight="none" />}
          </Loaded>
        ) : (
          <Table
            label={`Runs of ${a.name}`}
            rows={runs}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(runPath(r.id))}
            columns={[
              {
                key: 'status',
                header: 'Status',
                cell: (r) => <RunStatus state={r.status} />,
                width: 'sm',
              },
              {
                key: 'started',
                header: 'Started',
                cell: (r) => <When at={r.startedAt ?? r.createdAt} now={now} />,
                sortValue: (r) => Date.parse(r.createdAt),
              },
              {
                key: 'duration',
                header: 'Duration',
                align: 'end',
                mono: true,
                cell: (r) => {
                  const [s, e] = runSpan(r, now);
                  return r.startedAt ? duration(e - s) : '—';
                },
              },
              {
                key: 'cost',
                header: 'Cost',
                align: 'end',
                mono: true,
                cell: (r) => money(r.costUsd),
                sortValue: (r) => r.costUsd,
              },
              { key: 'outcome', header: 'Outcome', cell: (r) => r.exitReason ?? '' },
            ]}
            empty={
              <EmptyState icon={Play} title="No runs yet">
                Run it now, or turn it on to run on its schedule.
              </EmptyState>
            }
          />
        )}
      </Tabs>
      <RunWithModel automation={a} open={choosing} onClose={() => setChoosing(false)} />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${a.name}?`}
        description="The automation and its schedule go. Its runs stay in the history."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" icon={Trash2} busy={deleting} onClick={remove}>
              Delete automation
            </Button>
          </>
        }
      />
    </Page>
  );
}

export function AutomationsScreen({ parts, base }: ModuleProps) {
  const [first, second] = parts;
  if (!first) return <AutomationList base={base} />;
  if (first === 'new') return <AutomationEditor id={null} base={base} />;
  if (second === 'edit') return <AutomationEditor id={first} base={base} />;
  const tab: Tab = second === 'spec' || second === 'runs' ? second : 'overview';
  return <AutomationDetail id={first} tab={tab} base={base} />;
}

/**
 * A spec a chat's model wrote says so beside the switch that turns it on,
 * and links to the conversation. Read it before switching it on.
 */
export function AuthoredBy({ by }: { by?: string | null }) {
  const session = by?.startsWith('chat ') ? by.slice(5) : null;
  if (!session) return null;
  return (
    <a
      className="aut-authored"
      href={`#/m/chat/${encodeURIComponent(session)}`}
      title="A model drafted this spec in a chat. Read it before you turn it on."
    >
      <StatusTag tone="warn">Written by a chat</StatusTag>
    </a>
  );
}
