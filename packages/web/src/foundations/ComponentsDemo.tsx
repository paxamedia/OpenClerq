/**
 * Every component in the kit, wired together the way the screens will use them:
 * the table opens a run in a drawer, the menu's Delete asks in a dialog, and
 * actions report back with toasts.
 */

import { useState } from 'react';
import { CopyPlus, Ellipsis, Inbox, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, SegmentedControl, Switch } from '../ui/Choice';
import { CodeBlock, EmptyState, KeyValue, ProgressLine, Skeleton } from '../ui/Display';
import { Input, Select, Textarea } from '../ui/Field';
import { Dialog, Drawer } from '../ui/Modal';
import { Menu, Popover } from '../ui/Popover';
import { RUN_STATES, RunStatus, StatusTag } from '../ui/Status';
import { Table, type Column } from '../ui/Table';
import { Tabs } from '../ui/Tabs';
import { useToast } from '../ui/Toast';
import { Tooltip } from '../ui/Tooltip';

interface DemoRun {
  id: string;
  automation: string;
  state: string;
  /** Minutes ago it started. */
  ago: number;
  /** Seconds; null while running. */
  duration: number | null;
  cost: number;
  branch: string | null;
}

const RUNS: DemoRun[] = [
  {
    id: 'r_8f2a1c',
    automation: 'weekly-dependency-bumps',
    state: 'executing',
    ago: 2,
    duration: null,
    cost: 0.42,
    branch: 'auto/weekly-dependency-bumps/2026-10-28',
  },
  {
    id: 'r_7d19e0',
    automation: 'nightly-ci-triage',
    state: 'awaiting_approval',
    ago: 310,
    duration: 412,
    cost: 1.08,
    branch: 'auto/nightly-ci-triage/2026-10-28',
  },
  {
    id: 'r_6c03b4',
    automation: 'weekly-dependency-bumps',
    state: 'done',
    ago: 2880,
    duration: 655,
    cost: 0.87,
    branch: 'auto/weekly-dependency-bumps/2026-10-26',
  },
  {
    id: 'r_5b77f9',
    automation: 'docs-link-check',
    state: 'failed',
    ago: 3000,
    duration: 98,
    cost: 0.12,
    branch: null,
  },
  {
    id: 'r_4a50d2',
    automation: 'nightly-ci-triage',
    state: 'cancelled',
    ago: 4300,
    duration: 31,
    cost: 0.03,
    branch: null,
  },
];

const SPEC = `name: weekly-dependency-bumps
on:
  schedule: '0 8 * * 1'   # Mondays at 08:00
targets:
  repos: [local:~/code/my-app]
agent:
  driver: claude-code
gates:
  - run: pnpm test
budget:
  max_usd_per_run: 2`;

function ago(minutes: number): string {
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  return m ? `${m} min ${seconds % 60} s` : `${seconds} s`;
}

const money = (n: number) => `$${n.toFixed(2)}`;

const COLUMNS: Column<DemoRun>[] = [
  { key: 'state', header: 'Status', cell: (r) => <RunStatus state={r.state} />, width: 'md' },
  {
    key: 'automation',
    header: 'Automation',
    cell: (r) => r.automation,
    sortValue: (r) => r.automation,
  },
  {
    key: 'started',
    header: 'Started',
    cell: (r) => ago(r.ago),
    sortValue: (r) => -r.ago,
    width: 'sm',
  },
  {
    key: 'duration',
    header: 'Took',
    cell: (r) => duration(r.duration),
    sortValue: (r) => r.duration,
    align: 'end',
    mono: true,
    width: 'sm',
  },
  {
    key: 'cost',
    header: 'Cost',
    cell: (r) => money(r.cost),
    sortValue: (r) => r.cost,
    align: 'end',
    mono: true,
    width: 'xs',
  },
];

type Range = '24h' | '7d' | '30d';
type DetailTab = 'overview' | 'spec' | 'runs';

export function ComponentsDemo() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [range, setRange] = useState<Range>('7d');
  const [tab, setTab] = useState<DetailTab>('overview');
  const [schedule, setSchedule] = useState('0 8 * * 1 *');
  const [openRun, setOpenRun] = useState<DemoRun | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    setSaving(true);
    window.setTimeout(() => {
      setSaving(false);
      toast({ message: 'Saved.', tone: 'ok' });
    }, 1500);
  };

  const scheduleError =
    schedule.trim().split(/\s+/).length === 5 ? undefined : 'Use five fields, like 0 8 * * 1.';

  return (
    <>
      <section className="fdn-section">
        <h2 className="fdn-label">Buttons</h2>
        <div className="fdn-row">
          <Button variant="primary" icon={Play}>
            Run now
          </Button>
          <Button icon={Plus}>New automation</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon={Trash2}>
            Delete
          </Button>
          <Button variant="primary" busy={saving} onClick={save}>
            {saving ? 'Saving' : 'Save'}
          </Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="fdn-row">
          <Button size="sm" variant="primary">
            Approve push
          </Button>
          <Button size="sm">Deny</Button>
          <IconButton icon={Pencil} label="Edit" />
          <IconButton icon={CopyPlus} label="Duplicate" variant="secondary" />
          <Tooltip label="Runs every Monday at 08:00">
            <Button size="sm" variant="ghost">
              Next run in 3 d
            </Button>
          </Tooltip>
        </div>
      </section>

      <section className="fdn-section">
        <h2 className="fdn-label">Fields and choices</h2>
        <div className="fdn-grid">
          <Input
            label="Name"
            defaultValue="weekly-dependency-bumps"
            hint="Shown in lists and branch names."
          />
          <Input
            label="Schedule"
            mono
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            error={scheduleError}
            hint="Mondays at 08:00, this computer's time."
          />
          <Select label="Agent" defaultValue="claude-code">
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="cursor-agent">Cursor</option>
          </Select>
          <Input label="Repository" disabled defaultValue="~/code/my-app" />
          <Textarea
            label="Instructions"
            className="fdn-span"
            defaultValue="Update dependencies with patch and minor releases only. Do not change source files."
          />
        </div>
        <div className="fdn-row">
          <Switch checked={enabled} onChange={setEnabled} label={enabled ? 'On' : 'Off'} />
          <Checkbox label="Wait for my approval before pushing" defaultChecked />
          <Checkbox label="Skip when nothing changed" hint="No pull request is opened." />
          <SegmentedControl
            label="Time range"
            size="sm"
            value={range}
            onChange={setRange}
            options={[
              { value: '24h', label: '24 h' },
              { value: '7d', label: '7 d' },
              { value: '30d', label: '30 d' },
            ]}
          />
        </div>
      </section>

      <section className="fdn-section">
        <h2 className="fdn-label">Tabs</h2>
        <Tabs
          label="Automation"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'spec', label: 'Spec' },
            { value: 'runs', label: 'Runs', count: RUNS.length },
          ]}
        >
          {tab === 'overview' && (
            <KeyValue
              columns={2}
              items={[
                { label: 'Schedule', value: 'Mondays at 08:00' },
                { label: 'Next run', value: 'in 3 d' },
                { label: 'Agent', value: 'Claude Code' },
                { label: 'This month', value: '$4.20 of $20.00', mono: true },
              ]}
            />
          )}
          {tab === 'spec' && (
            <CodeBlock title="weekly-dependency-bumps.yaml" code={SPEC} maxHeight="sm" />
          )}
          {tab === 'runs' && <p className="fdn-meta">The runs table goes here.</p>}
        </Tabs>
      </section>

      <section className="fdn-section">
        <h2 className="fdn-label">Table · click a row</h2>
        <Table
          label="Recent runs"
          columns={COLUMNS}
          rows={RUNS}
          rowKey={(r) => r.id}
          initialSort={{ key: 'started', direction: 'desc' }}
          selectedKey={openRun?.id}
          onRowClick={setOpenRun}
        />
        <ul className="fdn-row fdn-states">
          {Object.entries(RUN_STATES)
            .filter(([state]) => state !== 'leased')
            .map(([state]) => (
              <li key={state}>
                <RunStatus state={state} />
              </li>
            ))}
        </ul>
      </section>

      <section className="fdn-section">
        <h2 className="fdn-label">Loading and empty</h2>
        <div className="fdn-grid">
          <Skeleton count={3} />
          <Skeleton variant="tile" />
          <Skeleton variant="row" count={3} className="fdn-span" />
        </div>
        <ProgressLine label="Loading runs" className="fdn-gap" />
        <EmptyState
          icon={Inbox}
          title="No automations yet"
          actions={
            <Button variant="primary" icon={Plus}>
              New automation
            </Button>
          }
        >
          An automation runs a coding agent on a schedule and opens a draft pull request.
        </EmptyState>
      </section>

      <section className="fdn-section">
        <h2 className="fdn-label">Overlays</h2>
        <div className="fdn-row">
          <Popover
            label="Connection"
            trigger={(p) => (
              <Button {...p} size="sm" variant="ghost">
                <StatusTag tone="ok">Connected</StatusTag>
              </Button>
            )}
          >
            <KeyValue
              items={[
                { label: 'Background service', value: 'Running' },
                { label: 'Address', value: '127.0.0.1:18790', mono: true },
                { label: 'Version', value: '0.6.0', mono: true },
                { label: 'Up for', value: '3 h 12 min' },
              ]}
            />
          </Popover>
          <Menu
            label="weekly-dependency-bumps"
            trigger={(p) => (
              <IconButton {...p} icon={Ellipsis} label="More actions" variant="secondary" />
            )}
            items={[
              {
                label: 'Run now',
                icon: Play,
                onSelect: () => toast({ message: 'Started weekly-dependency-bumps.' }),
              },
              { label: 'Edit', icon: Pencil, onSelect: () => setTab('spec') },
              {
                label: 'Duplicate',
                icon: CopyPlus,
                onSelect: () => toast({ message: 'Duplicated.', tone: 'ok' }),
              },
              {
                label: 'Delete',
                icon: Trash2,
                danger: true,
                onSelect: () => setConfirmDelete(true),
              },
            ]}
          />
          <Button size="sm" onClick={() => toast({ message: 'Started nightly-ci-triage.' })}>
            Show a notice
          </Button>
          <Button
            size="sm"
            icon={RotateCcw}
            onClick={() =>
              toast({
                message: "OpenClerq's background service isn't responding.",
                tone: 'err',
                action: {
                  label: 'Retry',
                  onClick: () => toast({ message: 'Connected.', tone: 'ok' }),
                },
              })
            }
          >
            Show an error
          </Button>
        </div>
      </section>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete weekly-dependency-bumps?"
        description="Its run history is kept."
        actions={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={Trash2}
              onClick={() => {
                setConfirmDelete(false);
                toast({
                  message: 'Deleted weekly-dependency-bumps.',
                  action: {
                    label: 'Undo',
                    onClick: () => toast({ message: 'Restored.', tone: 'ok' }),
                  },
                });
              }}
            >
              Delete
            </Button>
          </>
        }
      />

      <Drawer
        open={openRun !== null}
        onClose={() => setOpenRun(null)}
        title={openRun?.automation}
        actions={
          openRun?.state === 'awaiting_approval' ? (
            <>
              <Button>Deny</Button>
              <Button variant="primary">Approve push</Button>
            </>
          ) : undefined
        }
      >
        {openRun && (
          <div className="fdn-stack">
            <RunStatus state={openRun.state} />
            <KeyValue
              items={[
                { label: 'Run', value: openRun.id, mono: true },
                { label: 'Started', value: ago(openRun.ago) },
                { label: 'Took', value: duration(openRun.duration), mono: true },
                { label: 'Cost', value: money(openRun.cost), mono: true },
                { label: 'Branch', value: openRun.branch, mono: true },
              ]}
            />
            <CodeBlock
              title="Agent output"
              wrap
              code={
                'Updated 4 packages (patch and minor).\npnpm install --frozen-lockfile  ok\npnpm test  ok  (212 tests)'
              }
            />
          </div>
        )}
      </Drawer>
    </>
  );
}
