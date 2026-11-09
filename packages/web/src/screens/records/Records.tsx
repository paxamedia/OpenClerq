/**
 * Records: the people, organisations and activities every module shares. A
 * record's page hosts other modules' panels as tabs and their actions as buttons.
 */

import { useState } from 'react';
import { Building2, Contact, History, Play, User } from 'lucide-react';
import type { CoreRecord, CoreRecordType, ExtensionItem, RecordLink } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/Choice';
import { CodeBlock, EmptyState, KeyValue } from '../../ui/Display';
import { Input } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import { Table } from '../../ui/Table';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';
import { useClient } from '../../app/client';
import { fillRef, forRecord, moduleRoute, refId, useExtensions } from '../../app/extensions';
import { errorMessage } from '../../app/format';
import { useResource } from '../../app/live';
import { navigate, useQueryParam } from '../../app/router';
import { ErrorState, Loaded, Page, PageHeader, PageSkeleton, Section } from '../../shell/layout';
import { ModuleFrame } from '../../shell/ModuleFrame';
import { List, ListRow, When } from '../common';
import './records.css';

const TYPES: Array<{ value: '' | CoreRecordType; label: string }> = [
  { value: '', label: 'All' },
  { value: 'person', label: 'People' },
  { value: 'organisation', label: 'Organisations' },
  { value: 'activity', label: 'Activities' },
];

const TYPE_WORD: Record<string, string> = {
  person: 'Person',
  organisation: 'Organisation',
  activity: 'Activity',
};

export const recordIcon = (type: string) =>
  type === 'organisation' ? Building2 : type === 'activity' ? History : User;

export function recordPath(id: string, tab?: string): string {
  return `/records/${encodeURIComponent(id)}${tab ? `/${encodeURIComponent(tab)}` : ''}`;
}

function RecordList() {
  const client = useClient();
  const [type, setType] = useQueryParam('type');
  const [q, setQ] = useState('');
  const records = useResource(
    `records:${type ?? ''}:${q.trim()}`,
    async () =>
      (
        await client.records({
          type: (type || undefined) as CoreRecordType | undefined,
          q: q.trim() || undefined,
          limit: 200,
        })
      ).records,
    { on: ['records'] }
  );
  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Records' }]} />
      <div className="records-filters">
        <SegmentedControl
          label="Type"
          value={(type ?? '') as '' | CoreRecordType}
          onChange={(v) => setType(v || null)}
          options={TYPES}
        />
        <Input
          aria-label="Find a record"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, email, phone or domain"
        />
      </div>
      <Loaded resource={records} what="records" skeleton="rows">
        {(list) => (
          <Table
            label="Records"
            rows={list}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(recordPath(r.id))}
            columns={[
              {
                key: 'name',
                header: 'Name',
                cell: (r) => r.name ?? <span className="page-muted">No name</span>,
                sortValue: (r) => r.name ?? '',
              },
              {
                key: 'type',
                header: 'Type',
                cell: (r) => TYPE_WORD[r.type] ?? r.type,
                sortValue: (r) => r.type,
                width: 'sm',
              },
              {
                key: 'contact',
                header: 'Contact',
                cell: (r) => [...r.emails, ...r.phones, ...r.domains][0] ?? '',
                mono: true,
              },
              {
                key: 'updated',
                header: 'Changed',
                cell: (r) => <When at={r.updatedAt} />,
                sortValue: (r) => Date.parse(r.updatedAt),
                width: 'sm',
              },
            ]}
            empty={
              <EmptyState icon={Contact} title={q ? 'No records match' : 'No records yet'}>
                {q
                  ? 'Try a name, an email address, a phone number or a domain.'
                  : 'Modules add people and organisations here as they work.'}
              </EmptyState>
            }
          />
        )}
      </Loaded>
    </Page>
  );
}

function linkLabel(link: RecordLink, self: string): { ref: string; text: string } {
  const other = link.from === self ? link.to : link.from;
  return { ref: other, text: `${link.kind.replace(/_/g, ' ')}: ${other}` };
}

function Overview({ record, links }: { record: CoreRecord; links: RecordLink[] }) {
  const hasData = Object.keys(record.data ?? {}).length > 0;
  return (
    <div className="records-overview">
      <Section title="Details">
        <KeyValue
          items={[
            { label: 'Type', value: TYPE_WORD[record.type] ?? record.type },
            { label: 'Email', value: record.emails.join(', '), mono: true },
            { label: 'Phone', value: record.phones.join(', '), mono: true },
            { label: 'Domain', value: record.domains.join(', '), mono: true },
            { label: 'Added by', value: record.createdBy ?? '' },
            { label: 'Added', value: <When at={record.createdAt} /> },
            { label: 'Changed', value: <When at={record.updatedAt} /> },
            { label: 'Reference', value: record.ref, mono: true },
          ]}
        />
        {hasData && (
          <CodeBlock title="Data" code={JSON.stringify(record.data, null, 2)} maxHeight="md" />
        )}
      </Section>
      <Section title="Linked">
        {links.length ? (
          <List label="Linked records">
            {links.map((l, i) => {
              const { ref, text } = linkLabel(l, record.ref);
              return (
                <ListRow
                  key={i}
                  icon={recordIcon(ref.split(':')[1] ?? '')}
                  to={
                    ref.startsWith('core:')
                      ? recordPath(refId(ref))
                      : moduleRoute(ref.split(':')[0])
                  }
                  title={text}
                  aside={<When at={l.createdAt} />}
                />
              );
            })}
          </List>
        ) : (
          <p className="page-hint">Nothing is linked to this record yet.</p>
        )}
      </Section>
    </div>
  );
}

function Activity({ id }: { id: string }) {
  const client = useClient();
  const activities = useResource(
    `activities:${id}`,
    async () => (await client.activities(id)).activities,
    { on: ['records'] }
  );
  return (
    <Loaded resource={activities} what="activity" skeleton="rows">
      {(list) =>
        list.length ? (
          <List label="Activity">
            {list.map((a) => (
              <ListRow
                key={a.id}
                icon={History}
                to={recordPath(a.id)}
                title={a.name ?? String((a.data as { summary?: string }).summary ?? 'Activity')}
                detail={String((a.data as { kind?: string }).kind ?? '')}
                aside={<When at={String((a.data as { at?: string }).at ?? a.createdAt)} />}
              />
            ))}
          </List>
        ) : (
          <EmptyState icon={History} title="No activity yet">
            Emails, calls, runs and notes that modules record about this record appear here.
          </EmptyState>
        )
      }
    </Loaded>
  );
}

function Actions({ record, actions }: { record: CoreRecord; actions: ExtensionItem[] }) {
  const client = useClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<ExtensionItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fire = async (a: ExtensionItem) => {
    if (!a.trigger) return;
    setBusy(a.id);
    try {
      const { runId } = await client.fireModuleTrigger(a.moduleId, a.trigger, { ref: record.ref });
      toast({
        message: `${a.title ?? a.trigger} started.`,
        tone: 'ok',
        action: {
          label: 'Open run',
          onClick: () => navigate(`/runs/${encodeURIComponent(runId)}`),
        },
      });
    } catch (e) {
      toast({ message: `Couldn’t start ${a.title ?? a.trigger}. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  const choose = (a: ExtensionItem) => {
    if (a.path) navigate(moduleRoute(a.moduleId, fillRef(a.path, record.ref)));
    else if (a.confirm) setConfirm(a);
    else void fire(a);
  };

  return (
    <>
      {actions.map((a) => (
        <Button
          key={`${a.moduleId}:${a.id}`}
          size="sm"
          icon={a.trigger ? Play : undefined}
          busy={busy === a.id}
          onClick={() => choose(a)}
        >
          {a.title ?? a.id}
        </Button>
      ))}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={`${confirm?.title ?? 'Run this'}?`}
        description={`This runs ${confirm?.moduleId ?? 'the module'}’s ${confirm?.trigger ?? ''} for ${record.name ?? record.ref}.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={Play}
              onClick={() => {
                const a = confirm;
                setConfirm(null);
                if (a) void fire(a);
              }}
            >
              {confirm?.title ?? 'Run'}
            </Button>
          </>
        }
      />
    </>
  );
}

function RecordView({ id, tab }: { id: string; tab: string | null }) {
  const client = useClient();
  const record = useResource(`record:${id}`, () => client.record(id), { on: ['records'] });
  const extensions = useExtensions();
  if (!record.data) {
    return (
      <Page>
        <PageHeader crumbs={[{ label: 'Records', to: '/records' }, { label: 'Record' }]} />
        {record.error ? (
          <ErrorState error={record.error} onRetry={record.reload} what="this record" />
        ) : (
          <PageSkeleton />
        )}
      </Page>
    );
  }
  const r = record.data;
  const panels = forRecord(extensions.data?.['record.panel'] ?? [], r.type);
  const actions = forRecord(extensions.data?.['record.action'] ?? [], r.type);
  const items = [
    { value: 'overview', label: 'Overview' },
    { value: 'activity', label: 'Activity' },
    ...panels.map((p) => ({ value: `${p.moduleId}.${p.id}`, label: p.title ?? p.moduleId })),
  ];
  const current = items.some((i) => i.value === tab) ? (tab as string) : 'overview';
  const panel = panels.find((p) => `${p.moduleId}.${p.id}` === current);
  const name = r.name ?? r.emails[0] ?? r.domains[0] ?? r.phones[0] ?? 'No name';

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Records', to: '/records' }, { label: name }]}
        actions={<Actions record={r} actions={actions} />}
      />
      <Tabs
        label="Record"
        value={current}
        onChange={(t) =>
          navigate(recordPath(r.id, t === 'overview' ? undefined : t), { replace: true })
        }
        items={items}
      >
        <div className="records-tab">
          {current === 'overview' ? (
            <Overview record={r} links={r.links} />
          ) : current === 'activity' ? (
            <Activity id={r.id} />
          ) : panel ? (
            <ModuleFrame
              key={current}
              moduleId={panel.moduleId}
              path={fillRef(panel.path ?? '/', r.ref)}
              title={panel.title ?? panel.moduleId}
            />
          ) : null}
        </div>
      </Tabs>
    </Page>
  );
}

export function Records({ id, tab }: { id: string | null; tab: string | null }) {
  return id ? <RecordView id={id} tab={tab} /> : <RecordList />;
}
