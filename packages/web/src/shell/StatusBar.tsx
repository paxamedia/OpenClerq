/**
 * The status bar: connection, what is running, this month's spend against the
 * budgets, and the version. Each item opens its page or a popover with details.
 */

import { Info } from 'lucide-react';
import { Button } from '../ui/Button';
import { KeyValue } from '../ui/Display';
import { Popover } from '../ui/Popover';
import { StatusTag, type Tone } from '../ui/Status';
import { BudgetMeter } from '../charts/charts';
import { useClient, useHost } from '../app/client';
import { useAutomations, useHealth, useRecentRuns } from '../app/data';
import { money } from '../app/format';
import { useStreamState } from '../app/live';
import { Link, withQuery } from '../app/router';
import { ACTIVE, monthSpend } from '../app/stats';

export function useStatus() {
  const health = useHealth();
  const runs = useRecentRuns();
  const automations = useAutomations();
  const stream = useStreamState();

  const connection: { tone: Tone; label: string } = health.error
    ? { tone: 'err', label: 'Not responding' }
    : health.data
      ? { tone: 'ok', label: 'Connected' }
      : { tone: 'muted', label: 'Connecting' };
  const running = (runs.data ?? []).filter((r) => ACTIVE.has(r.status)).length;
  const month = monthSpend(runs.data ?? []);
  const caps = (automations.data ?? [])
    .map((a) => a.monthBudgetUsd)
    .filter((c): c is number => c !== null);
  const budget = caps.length ? caps.reduce((a, b) => a + b, 0) : null;
  return {
    health,
    connection,
    running,
    month,
    budget,
    automations: automations.data ?? [],
    stream,
  };
}

function ConnectionDetails() {
  const client = useClient();
  const { health, stream } = useStatus();
  const h = health.data;
  return (
    <KeyValue
      items={[
        {
          label: 'Background service',
          value: health.error ? 'Not responding' : h ? `Running, ${h.version}` : 'Checking',
        },
        {
          label: 'Model',
          value: h?.llm
            ? `${h.llm.provider} · ${h.llm.model}${h.llm.available ? '' : ' (no key)'}`
            : '',
        },
        {
          label: 'Updates',
          value: stream === 'live' ? 'Live' : stream === 'polling' ? 'Every 5 s' : 'Connecting',
        },
        { label: 'Address', value: client.getUrl(), mono: true },
      ]}
    />
  );
}

function SpendDetails() {
  const { month, budget, automations } = useStatus();
  const withSpend = automations.filter((a) => a.monthSpendUsd > 0 || a.monthBudgetUsd);
  return (
    <div className="shell-spend">
      <KeyValue
        items={[
          {
            label: 'Spent this month',
            value: money(month.spent, { atLeast: month.atLeast }),
            mono: true,
          },
          {
            label: 'Monthly budgets',
            value: budget === null ? 'None set' : money(budget),
            mono: true,
          },
        ]}
      />
      {withSpend.length > 0 && (
        <ul className="shell-spend-list">
          {withSpend.map((a) => (
            <li key={a.id}>
              <Link to={`/automations/${encodeURIComponent(a.id)}`}>{a.name}</Link>
              <BudgetMeter spent={a.monthSpendUsd} cap={a.monthBudgetUsd} width={72} />
              <span className="shell-spend-figure">{money(a.monthSpendUsd)}</span>
            </li>
          ))}
        </ul>
      )}
      {month.atLeast && (
        <p className="shell-note">
          Some runs used a model with no known price, so the real figure is higher.
        </p>
      )}
    </div>
  );
}

export function StatusBar({ onAbout }: { onAbout: () => void }) {
  const host = useHost();
  const { connection, running, month, budget } = useStatus();
  return (
    <footer className="shell-status" aria-label="Status">
      <Popover
        label="Connection"
        placement="top-start"
        trigger={(p) => (
          <button type="button" className="shell-status-item" {...p}>
            <StatusTag tone={connection.tone}>{connection.label}</StatusTag>
          </button>
        )}
      >
        <ConnectionDetails />
      </Popover>
      <Link className="shell-status-item" to={withQuery('/runs', { status: 'running' })}>
        {running ? `${running} running` : 'Nothing running'}
      </Link>
      <Popover
        label="Spend this month"
        placement="top-start"
        trigger={(p) => (
          <button type="button" className="shell-status-item" {...p}>
            <span className="shell-status-figure">
              {money(month.spent, { atLeast: month.atLeast })}
              {budget !== null ? ` of ${money(budget)}` : ''} this month
            </span>
            {budget !== null && <BudgetMeter spent={month.spent} cap={budget} width={48} />}
          </button>
        )}
      >
        <SpendDetails />
      </Popover>
      <span className="shell-status-spacer" />
      <button
        type="button"
        className="shell-status-item"
        onClick={onAbout}
        aria-label={`About OpenClerq ${host.version}`}
      >
        {host.version}
      </button>
    </footer>
  );
}

/** The status bar's facts, for the phone's More sheet. */
export function StatusSummary({ onAbout }: { onAbout: () => void }) {
  const host = useHost();
  const { connection, running, month, budget } = useStatus();
  return (
    <div className="shell-status-summary">
      <KeyValue
        items={[
          {
            label: 'Connection',
            value: <StatusTag tone={connection.tone}>{connection.label}</StatusTag>,
          },
          { label: 'Running', value: running ? String(running) : 'Nothing' },
          {
            label: 'This month',
            value: `${money(month.spent, { atLeast: month.atLeast })}${budget !== null ? ` of ${money(budget)}` : ''}`,
            mono: true,
          },
          { label: 'Version', value: host.version, mono: true },
        ]}
      />
      <Button variant="ghost" icon={Info} onClick={onAbout}>
        About OpenClerq
      </Button>
    </div>
  );
}
