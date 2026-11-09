/**
 * Home: what happened, what is next, what needs you.
 */

import { useState } from 'react';
import {
  CalendarClock,
  Check,
  CircleAlert,
  Inbox as InboxIcon,
  KeyRound,
  Play,
  Plus,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import type { RunSummary } from '@clerq/gateway-client';
import { SegmentedControl } from '../../ui/Choice';
import { Icon } from '../../ui/Icon';
import { cx } from '../../ui/cx';
import { ActivityTimeline, Sparkline } from '../../charts/charts';
import { useAutomations, useProviders, useRecentRuns, DAY_MS, daysAgo } from '../../app/data';
import { moduleRoute, useExtensions } from '../../app/extensions';
import { count, money, percent } from '../../app/format';
import { Link, navigate, withQuery } from '../../app/router';
import { daily, monthSpend, sinceDay, spend, successRate, today } from '../../app/stats';
import {
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  PageSkeleton,
  Section,
} from '../../shell/layout';
import { ModuleFrame } from '../../shell/ModuleFrame';
import { useStatus } from '../../shell/StatusBar';
import { useInbox } from '../inbox/Inbox';
import { List, ListRow, Tile, useNow, When } from '../common';

const AUTOMATIONS = '/m/automations';

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function openDay(day: Date) {
  navigate(withQuery('/runs', { date: isoDay(day) }));
}

function Tiles({ runs }: { runs: RunSummary[] }) {
  const inbox = useInbox();
  const { budget } = useStatus();
  const days14 = 14;
  const runsToday = today(runs).length;
  const week = sinceDay(runs, daysAgo(6));
  const rate = successRate(week);
  const month = monthSpend(runs);
  const waiting = inbox.data ?? [];
  const waitingDays = daily(
    waiting.map((a) => ({ createdAt: a.createdAt }) as RunSummary),
    days14,
    (b) => b.length
  );
  return (
    <div className="tiles">
      <Tile
        label="Runs today"
        figure={runsToday}
        sub={`${count(sinceDay(runs, daysAgo(13)).length, 'run')} in 14 days`}
        to={withQuery('/runs', { date: isoDay(new Date()) })}
        chart={
          <Sparkline
            days={daily(runs, days14, (b) => b.length)}
            summary="Runs per day over the last 14 days."
            format={(v) => count(v, 'run')}
            onOpenDay={openDay}
          />
        }
      />
      <Tile
        label="Success, 7 days"
        figure={percent(rate)}
        sub={
          rate === null
            ? 'No finished runs'
            : `${week.filter((r) => r.status === 'failed').length} failed`
        }
        tone={rate !== null && rate < 0.8 ? 'warn' : undefined}
        to={withQuery('/runs', { status: 'failed' })}
        chart={
          <Sparkline
            days={daily(runs, days14, successRate)}
            summary="Share of finished runs that succeeded, per day over 14 days."
            format={(v) => percent(v)}
            onOpenDay={openDay}
            tone="ok"
          />
        }
      />
      <Tile
        label="Spend this month"
        figure={money(month.spent, { atLeast: month.atLeast })}
        sub={budget === null ? 'No monthly budgets' : `of ${money(budget)} budgeted`}
        tone={budget !== null && month.spent >= budget ? 'err' : undefined}
        chart={
          <Sparkline
            days={daily(runs, days14, spend)}
            summary="Spend per day over the last 14 days."
            format={(v) => money(v)}
            onOpenDay={openDay}
          />
        }
      />
      <Tile
        label="Waiting for you"
        figure={waiting.length}
        sub={
          waiting.length
            ? `${count(waiting.filter((w) => w.kind === 'approval').length, 'approval')}`
            : 'Nothing waiting'
        }
        tone={waiting.length ? 'warn' : undefined}
        to="/inbox"
        chart={
          <Sparkline
            days={waitingDays}
            summary="Open inbox items by the day they arrived, over 14 days."
            format={(v) => count(v, 'item')}
            tone="warn"
          />
        }
      />
    </div>
  );
}

function Activity({ runs }: { runs: RunSummary[] }) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const now = useNow(60_000);
  const windowMs = range === '24h' ? DAY_MS : 7 * DAY_MS;
  return (
    <Section
      title="Activity"
      actions={
        <SegmentedControl
          size="sm"
          label="Time range"
          value={range}
          onChange={setRange}
          options={[
            { value: '24h', label: '24 h' },
            { value: '7d', label: '7 days' },
          ]}
        />
      }
    >
      <div className="page-panel page-panel-body">
        {runs.some((r) => Date.parse(r.createdAt) >= now - windowMs) ? (
          <ActivityTimeline
            runs={runs}
            windowMs={windowMs}
            now={now}
            onOpen={(r) => navigate(`/runs/${encodeURIComponent(r.id)}`)}
          />
        ) : (
          <p className="page-hint">No runs in this period.</p>
        )}
      </div>
    </Section>
  );
}

function NextRuns() {
  const automations = useAutomations();
  const now = useNow(30_000);
  const upcoming = (automations.data ?? [])
    .filter((a) => a.enabled && !a.problem)
    .flatMap((a) => a.nextFirings.map((at) => ({ a, at })))
    .filter(({ at }) => Date.parse(at) > now)
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at))
    .slice(0, 10);
  return (
    <Section title="Next runs">
      {automations.error && !automations.data ? (
        <ErrorState error={automations.error} onRetry={automations.reload} what="automations" />
      ) : !automations.data ? (
        <PageSkeleton kind="rows" />
      ) : upcoming.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing scheduled">
          Turn on an automation with a schedule and its runs appear here.
        </EmptyState>
      ) : (
        <List label="Next runs">
          {upcoming.map(({ a, at }) => (
            <ListRow
              key={`${a.id}-${at}`}
              icon={CalendarClock}
              to={`${AUTOMATIONS}/${encodeURIComponent(a.id)}`}
              title={a.name}
              aside={<When at={at} now={now} />}
            />
          ))}
        </List>
      )}
    </Section>
  );
}

function NeedsAttention({ runs }: { runs: RunSummary[] }) {
  const inbox = useInbox();
  const automations = useAutomations();
  const failed = sinceDay(runs, daysAgo(6))
    .filter((r) => r.status === 'failed')
    .slice(0, 5);
  const problems = (automations.data ?? []).filter((a) => a.problem);
  const waiting = (inbox.data ?? []).slice(0, 6);
  const empty = !failed.length && !problems.length && !waiting.length;
  return (
    <Section title="Needs attention">
      {empty ? (
        <EmptyState icon={Check} title="All clear">
          Failed runs, waiting approvals and automations that need editing show up here.
        </EmptyState>
      ) : (
        <List label="Needs attention">
          {waiting.map((p) => (
            <ListRow
              key={`a${p.id}`}
              icon={p.kind === 'approval' ? ShieldCheck : InboxIcon}
              tone="warn"
              to={`/inbox/${encodeURIComponent(p.id)}`}
              title={p.title}
              detail={p.body}
              aside={<When at={p.createdAt} />}
            />
          ))}
          {problems.map((a) => (
            <ListRow
              key={`p${a.id}`}
              icon={TriangleAlert}
              tone="warn"
              to={`${AUTOMATIONS}/${encodeURIComponent(a.id)}/edit`}
              title={`${a.name} needs editing`}
              detail={a.problem}
            />
          ))}
          {failed.map((r) => (
            <ListRow
              key={`f${r.id}`}
              icon={CircleAlert}
              tone="err"
              to={`/runs/${encodeURIComponent(r.id)}`}
              title={`${r.automationName ?? 'Run'} failed`}
              detail={r.exitReason}
              aside={<When at={r.createdAt} />}
            />
          ))}
        </List>
      )}
    </Section>
  );
}

/** Cards from modules' `home.tile` extensions, each drawn by its module. */
function ModuleTiles() {
  const extensions = useExtensions();
  const tiles = [...(extensions.data?.['home.tile'] ?? [])].sort(
    (a, b) => (a.order ?? 50) - (b.order ?? 50)
  );
  if (!tiles.length) return null;
  return (
    <Section title="From your modules">
      <div className="module-tiles">
        {tiles.map((t) => (
          <article
            key={`${t.moduleId}:${t.id}`}
            className={cx('module-tile', `size-${t.size ?? 'm'}`)}
          >
            <header className="module-tile-head">
              <Link className="module-tile-title" to={moduleRoute(t.moduleId, t.path ?? '/')}>
                {t.title ?? t.moduleId}
              </Link>
            </header>
            <ModuleFrame
              moduleId={t.moduleId}
              path={t.path ?? '/'}
              title={t.title ?? t.moduleId}
              layout="fit"
            />
          </article>
        ))}
      </div>
    </Section>
  );
}

function FirstRun({ runs }: { runs: RunSummary[] }) {
  const providers = useProviders();
  const automations = useAutomations();
  if (!providers.data || !automations.data) return null;
  const steps = [
    {
      done: providers.data.providers.some((p) => p.ready && !p.local),
      label: 'Add a model key',
      to: '/settings/models',
      icon: KeyRound,
    },
    {
      done: automations.data.length > 0,
      label: 'Create an automation',
      to: `${AUTOMATIONS}/new`,
      icon: Plus,
    },
    {
      done: runs.some((r) => r.automationId) || automations.data.some((a) => a.lastRun),
      label: 'Run it',
      to: AUTOMATIONS,
      icon: Play,
    },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <Section title="Get started">
      <ol className="checklist">
        {steps.map((s, i) => (
          <li key={s.label} className={cx('checklist-item', s.done && 'is-done')}>
            <span className="checklist-mark" aria-hidden="true">
              {s.done ? <Icon glyph={Check} size={12} strokeWidth={2} /> : i + 1}
            </span>
            <a className="checklist-link" href={`#${s.to}`}>
              {s.label}
            </a>
            <span className="ui-sr-only">{s.done ? ', done' : ', to do'}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function Home() {
  const runs = useRecentRuns();
  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Home' }]} />
      {runs.error && !runs.data ? (
        <ErrorState error={runs.error} onRetry={runs.reload} what="runs" />
      ) : !runs.data ? (
        <PageSkeleton kind="tiles" label="Loading" />
      ) : (
        <>
          <FirstRun runs={runs.data} />
          <Tiles runs={runs.data} />
          <ModuleTiles />
          <Activity runs={runs.data} />
          <div className="page-grid-2">
            <NextRuns />
            <NeedsAttention runs={runs.data} />
          </div>
          {runs.data.length === 0 && (
            <EmptyState icon={Workflow} title="No runs yet">
              Runs from automations and chats appear here as they start.
            </EmptyState>
          )}
        </>
      )}
    </Page>
  );
}
