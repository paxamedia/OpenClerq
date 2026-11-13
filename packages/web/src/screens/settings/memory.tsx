/**
 * Settings → Memory: what chats and tasks remember between conversations.
 * The records (who wrote each, summaries and what they replaced), the policy
 * for what chats and tasks may read, and summarising with a model, with undo.
 */

import { useEffect, useState } from 'react';
import { Database, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react';
import { MEMORY_TYPES, type MemoryRecord, type MemoryType } from '@clerq/gateway-client';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox, Switch } from '../../ui/Choice';
import { EmptyState } from '../../ui/Display';
import { Input, Select } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import type { Tone } from '../../ui/Status';
import { Table } from '../../ui/Table';
import { cx } from '../../ui/cx';
import { useToast } from '../../ui/Toast';
import { useClient } from '../../app/client';
import { errorMessage } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import { Loaded, Section } from '../../shell/layout';
import { When } from '../common';
import { ConfirmDelete, useSaver } from './sections';

/** What each kind of memory is for, for the picker and the Type column. */
export const MEMORY_TYPE_HINTS: Record<MemoryType, string> = {
  fact: 'Something true: a rate, a name, a deadline.',
  preference: 'How you like things done. Read in every managed chat.',
  decision: 'A choice made, and why.',
  procedure: 'How to do something, step by step.',
  note: 'Anything else.',
};

// ---------------------------------------------------------------------------
// Who wrote a record
// ---------------------------------------------------------------------------

/** Who wrote a record, in words, and whether an agent had a hand in it. */
export function originOf(r: Pick<MemoryRecord, 'origin' | 'agentDerived'>): {
  label: string;
  tone: Tone;
  title: string;
} {
  switch (r.origin) {
    case 'user':
      return { label: 'You', tone: 'muted', title: 'Written by a person.' };
    case 'agent':
      return {
        label: 'An agent',
        tone: 'warn',
        title:
          'Written by an agent. It may carry text the agent read, so it is shown to a model as information, not as an instruction.',
      };
    case 'import':
      return { label: 'Imported', tone: 'muted', title: 'Carried over from an earlier version.' };
    case 'consolidation':
      return r.agentDerived
        ? {
            label: 'Summary, includes an agent’s notes',
            tone: 'warn',
            title:
              'A summary a model wrote. At least one of the records folded into it was written by an agent.',
          }
        : { label: 'Summary', tone: 'accent', title: 'A summary a model wrote.' };
    default:
      return { label: String(r.origin), tone: 'muted', title: '' };
  }
}

const groupKey = (r: Pick<MemoryRecord, 'key' | 'type'>) => `${r.type}\u0000${r.key}`;

/** How many records in use share each key and type: summarising needs at least two. */
export function sameKeyCounts(records: MemoryRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.status !== 'active') continue;
    counts.set(groupKey(r), (counts.get(groupKey(r)) ?? 0) + 1);
  }
  return counts;
}

export function canSummarise(r: MemoryRecord, counts: Map<string, number>): boolean {
  return r.status === 'active' && (counts.get(groupKey(r)) ?? 0) >= 2;
}

/**
 * The rows to list: the records in use, and, when asked, those folded into a
 * summary after them. A search lists only records in use.
 */
export function visibleRecords(
  inUse: MemoryRecord[],
  folded: MemoryRecord[] | undefined,
  show: boolean,
  searching: boolean
): MemoryRecord[] {
  return show && !searching ? [...inUse, ...(folded ?? [])] : inUse;
}

/** A record's value on one line. */
export const valueText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

export const POLICY_NOTE =
  'The kinds of memory managed chats and tasks may read into the prompt, which is sent to the model. ' +
  'With none ticked, they read nothing. Raw mode and triggers never read memory, and an automation reads only the kinds its own spec lists.';

export const sameTypes = (a: MemoryType[], b: MemoryType[]) =>
  a.length === b.length && a.every((t) => b.includes(t));

/** The tick boxes, without the gateway. */
export function PolicyEditor({
  saved,
  draft,
  busy,
  onChange,
  onSave,
}: {
  saved: MemoryType[];
  draft: MemoryType[];
  busy: boolean;
  onChange: (next: MemoryType[]) => void;
  onSave: () => void;
}) {
  return (
    <>
      <p className="page-hint">{POLICY_NOTE}</p>
      <div className="settings-policy" role="group" aria-label="Kinds of memory chats may read">
        {MEMORY_TYPES.map((t) => (
          <Checkbox
            key={t}
            label={t}
            hint={MEMORY_TYPE_HINTS[t]}
            checked={draft.includes(t)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? MEMORY_TYPES.filter((x) => draft.includes(x) || x === t)
                  : draft.filter((x) => x !== t)
              )
            }
          />
        ))}
      </div>
      {draft.length === 0 && (
        <p className="settings-chain-empty">Chats and tasks will read no saved notes.</p>
      )}
      <div className="page-row">
        <Button
          variant="primary"
          icon={Save}
          busy={busy}
          disabled={sameTypes(saved, draft)}
          onClick={onSave}
        >
          Save what chats may read
        </Button>
      </div>
    </>
  );
}

function PolicySection() {
  const client = useClient();
  const policy = useResource('memory:policy', () => client.memoryPolicy(), { on: ['memory'] });
  const [draft, setDraft] = useState<MemoryType[] | null>(null);
  const { save, busy } = useSaver();
  const saved = policy.data?.readTypes;
  useEffect(() => {
    setDraft((d) => (d === null || (saved && sameTypes(d, saved)) ? null : d));
  }, [saved]);
  return (
    <Section title="What chats and tasks may read">
      <Loaded resource={policy} what="the memory policy" skeleton="rows">
        {(p) => (
          <PolicyEditor
            saved={p.readTypes}
            draft={draft ?? p.readTypes}
            busy={busy}
            onChange={setDraft}
            onSave={() =>
              void save(
                'what chats may read',
                () => client.setMemoryPolicy(draft ?? p.readTypes),
                'Saved.'
              ).then((ok) => {
                if (ok) {
                  setDraft(null);
                  void policy.reload();
                }
              })
            }
          />
        )}
      </Loaded>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Summarising
// ---------------------------------------------------------------------------

export const SUMMARISE_NOTE =
  'A model reads these records and writes one that stands in for them. The originals are kept, out of use, and Undo brings them back. ' +
  'Their text is sent to the model.';

export function SummariseDialog({
  record,
  count,
  onClose,
  onDone,
}: {
  record: MemoryRecord | null;
  count: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const toast = useToast();
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.consolidateMemory(record.key, {
        type: record.type,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      toast({
        message: `Summarised ${out.superseded.length} records under ${record.key}.`,
        tone: 'ok',
      });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={record !== null}
      onClose={onClose}
      title={record ? `Summarise ${count} records under “${record.key}”?` : 'Summarise'}
      description={SUMMARISE_NOTE}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Sparkles} busy={busy} onClick={run}>
            Summarise
          </Button>
        </>
      }
    >
      <Input
        label="Model (optional)"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder="provider/model"
        hint="A model you name is used as named, with no fallback. Without one the default model writes it, and may fall back along your list in Models & keys."
        error={error}
        mono
        autoComplete="off"
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

export function MemorySection() {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const q = query.trim();
  const [folded, setFolded] = useState(false);
  // A search is its own resource, so the list comes back the moment it is cleared.
  const memory = useResource(
    q ? `memory:search:${q}` : 'memory',
    async (): Promise<MemoryRecord[]> =>
      q ? (await client.searchMemory(q)).results : (await client.memory()).entries,
    { on: ['memory'] }
  );
  // Records folded into a summary are not in use; they are fetched only when asked for.
  const superseded = useResource(
    folded && !q ? 'memory:superseded' : null,
    async () => (await client.memoryRecords({ status: 'superseded' })).records,
    { on: ['memory'] }
  );
  const { save, busy } = useSaver();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [type, setType] = useState<MemoryType>('fact');
  const [deleting, setDeleting] = useState<MemoryRecord | null>(null);
  const [summarising, setSummarising] = useState<MemoryRecord | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  const add = async () => {
    let v: unknown = value;
    try {
      v = JSON.parse(value);
    } catch {
      /* plain text is stored as it is */
    }
    if (
      await save(
        'the entry',
        () => client.addMemoryRecord({ key: key.trim(), value: v, type }),
        'Added.'
      )
    ) {
      setKey('');
      setValue('');
      void memory.reload();
    }
  };

  const undo = async (r: MemoryRecord) => {
    setUndoing(r.id);
    try {
      const out = await client.unconsolidateMemory(r.id);
      toast({
        message: `Undone. ${out.restored.length} ${out.restored.length === 1 ? 'record is' : 'records are'} in use again.`,
        tone: 'ok',
      });
      live.invalidate(['memory']);
      void memory.reload();
    } catch (e) {
      toast({ message: `Couldn’t undo the summary. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setUndoing(null);
    }
  };

  const refresh = () => {
    live.invalidate(['memory']);
    void memory.reload();
  };

  return (
    <>
      <PolicySection />
      <Section title="Memory">
        <p className="page-hint">What managed chats and tasks remember between conversations.</p>
        <div className="settings-inline">
          <Input label="Key" value={key} onChange={(e) => setKey(e.target.value)} mono />
          <Input
            label="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            hint="Text or JSON."
          />
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as MemoryType)}
            hint={MEMORY_TYPE_HINTS[type]}
          >
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Button variant="primary" icon={Plus} busy={busy} disabled={!key.trim()} onClick={add}>
            Add entry
          </Button>
        </div>
        <Input
          label="Search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          hint="Finds entries by the words in their key or value."
        />
        <Switch
          checked={folded && !q}
          onChange={setFolded}
          disabled={Boolean(q)}
          label="Show records folded into a summary"
        />
        <Loaded resource={memory} what="memory" skeleton="rows">
          {(entries) => {
            const counts = sameKeyCounts(entries);
            const rows = visibleRecords(entries, superseded.data, folded, Boolean(q));
            return (
              <Table
                label="Memory entries"
                rows={rows}
                rowKey={(e) => e.id}
                columns={[
                  {
                    key: 'key',
                    header: 'Key',
                    cell: (e) => {
                      const o = originOf(e);
                      return (
                        <span className="settings-keycell">
                          <code
                            className={e.status === 'superseded' ? 'settings-folded' : undefined}
                          >
                            {e.key}
                          </code>
                          <span
                            className={cx('settings-origin', o.tone === 'warn' && 'tone-text-warn')}
                            title={o.title}
                          >
                            {o.label} · <When at={e.createdAt} />
                          </span>
                        </span>
                      );
                    },
                    sortValue: (e) => e.key,
                    width: 'md',
                  },
                  {
                    key: 'type',
                    header: 'Type',
                    cell: (e) => e.type,
                    sortValue: (e) => e.type,
                    width: 'sm',
                  },
                  {
                    key: 'value',
                    header: 'Value',
                    cell: (e) => (
                      <span
                        className={
                          e.status === 'superseded'
                            ? 'settings-value settings-folded'
                            : 'settings-value'
                        }
                      >
                        {valueText(e.value)}
                      </span>
                    ),
                  },
                  {
                    key: 'actions',
                    header: <span className="ui-sr-only">Actions</span>,
                    width: 'md',
                    cell: (e) =>
                      e.status === 'superseded' ? (
                        <span className="page-muted">Folded into a summary</span>
                      ) : (
                        <span className="settings-row-actions">
                          {canSummarise(e, counts) && (
                            <Button
                              size="sm"
                              icon={Sparkles}
                              onClick={() => setSummarising(e)}
                              aria-label={`Summarise ${counts.get(groupKey(e))} records under ${e.key}`}
                            >
                              Summarise
                            </Button>
                          )}
                          {e.origin === 'consolidation' && (
                            <Button
                              size="sm"
                              icon={RotateCcw}
                              busy={undoing === e.id}
                              onClick={() => void undo(e)}
                              aria-label={`Undo the summary ${e.key}`}
                            >
                              Undo
                            </Button>
                          )}
                          <IconButton
                            icon={Trash2}
                            label={`Delete ${e.key}`}
                            size="sm"
                            onClick={() => setDeleting(e)}
                          />
                        </span>
                      ),
                  },
                ]}
                empty={
                  <EmptyState
                    icon={Database}
                    title={q ? 'Nothing matches' : 'Nothing remembered yet'}
                  />
                }
              />
            );
          }}
        </Loaded>
        {folded && !q && superseded.data && superseded.data.length === 0 && (
          <p className="page-hint">No record is folded into a summary.</p>
        )}
        <SummariseDialog
          record={summarising}
          count={
            summarising ? (sameKeyCounts(memory.data ?? []).get(groupKey(summarising)) ?? 0) : 0
          }
          onClose={() => setSummarising(null)}
          onDone={refresh}
        />
        <ConfirmDelete
          what={deleting?.key ?? ''}
          detail={
            deleting?.origin === 'consolidation'
              ? 'The summary and the records folded into it go. To keep them, use Undo instead.'
              : 'Managed chats and tasks will no longer see it.'
          }
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            deleting &&
            void save(
              deleting.key,
              () => client.deleteMemoryRecord(deleting.id),
              `Deleted ${deleting.key}.`
            ).then(() => memory.reload())
          }
        />
      </Section>
    </>
  );
}
