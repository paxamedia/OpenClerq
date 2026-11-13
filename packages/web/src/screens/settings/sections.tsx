/** Settings sections that edit what the background service stores. */

import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Database, KeyRound, Play, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  MEMORY_TYPES,
  type MemoryRecord,
  type MemoryType,
  type SkillMeta,
} from '@clerq/gateway-client';
import { Button, IconButton } from '../../ui/Button';
import { SegmentedControl, Switch } from '../../ui/Choice';
import { CodeBlock, EmptyState } from '../../ui/Display';
import { Input, Select, Textarea } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import { Table } from '../../ui/Table';
import { useToast } from '../../ui/Toast';
import { useClient, useHost, type AppConfig } from '../../app/client';
import { describeCron } from '../../app/cron';
import { errorMessage } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import type { ModuleUI } from '../../app/modules';
import {
  cronForRuns,
  DEFAULT_RUN_MESSAGE,
  isRunPeriod,
  MAX_RUNS,
  persistentRunTrigger,
  syncPersistentRun,
  PERSISTENT_RUN_TRIGGER_ID,
  type RunPeriod,
  type TriggersConfig,
} from '../../app/persistentRun';
import { Loaded, Section } from '../../shell/layout';
import { When } from '../common';

/** Saves a section: shows success or the reason as a toast, and keeps a busy flag. */
function useSaver() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (what: string, fn: () => Promise<unknown>, done = 'Saved.') => {
    setBusy(true);
    try {
      await fn();
      toast({ message: done, tone: 'ok' });
      return true;
    } catch (e) {
      toast({ message: `Couldn’t save ${what}. ${errorMessage(e)}`, tone: 'err' });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { save, busy };
}

/** A delete that names what goes, in an in-app dialog. */
function ConfirmDelete({
  what,
  detail,
  open,
  onClose,
  onConfirm,
}: {
  what: string;
  detail: string;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Delete ${what}?`}
      description={detail}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Delete
          </Button>
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------

export function SecretsSection() {
  const client = useClient();
  const secrets = useResource('secrets', () => client.secrets());
  const { save, busy } = useSaver();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_-]+$/.test(name.trim());

  const add = async () => {
    if (!valid) return;
    const ok = await save(
      'the secret',
      () => client.setSecret(name.trim(), value),
      'Saved and encrypted.'
    );
    if (ok) {
      setName('');
      setValue('');
      void secrets.reload();
    }
  };
  const remove = (n: string) =>
    save(n, () => client.deleteSecret(n), `Deleted ${n}.`).then(() => secrets.reload());

  return (
    <Section title="Secrets">
      <p className="page-hint">
        Keys and tokens, encrypted on this computer. Values are never shown again.
      </p>
      <Loaded resource={secrets} what="secrets" skeleton="rows">
        {(d) =>
          'error' in d ? (
            <EmptyState icon={KeyRound} title="Secrets are unavailable">
              {d.error}
            </EmptyState>
          ) : (
            <>
              <div className="settings-inline">
                <Input
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="GITHUB_TOKEN"
                  mono
                  error={name && !valid ? 'Letters, digits, _ and - only.' : undefined}
                />
                <Input
                  label="Value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  icon={Plus}
                  busy={busy}
                  disabled={!valid || !value}
                  onClick={add}
                >
                  Add secret
                </Button>
              </div>
              {d.secrets.length ? (
                <ul className="settings-list">
                  {d.secrets.map((n) => (
                    <li key={n}>
                      <code>{n}</code>
                      <IconButton
                        icon={Trash2}
                        label={`Delete ${n}`}
                        size="sm"
                        onClick={() => setDeleting(n)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="page-hint">No secrets yet.</p>
              )}
              <p className="page-hint">
                Kept in{' '}
                {d.keySource === 'keychain'
                  ? 'the system keychain'
                  : d.keySource === 'file'
                    ? 'a key file'
                    : d.keySource === 'env'
                      ? 'a key from the environment'
                      : 'no key store'}
                .
              </p>
            </>
          )
        }
      </Loaded>
      <ConfirmDelete
        what={deleting ?? ''}
        detail="Automations and tools that use it will stop working until you add it again."
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------

function SkillEditor({
  slug,
  all,
  onClose,
}: {
  slug: string;
  all: SkillMeta[];
  onClose: () => void;
}) {
  const client = useClient();
  const detail = useResource(`skill:${slug}`, () => client.skill(slug));
  const { save, busy } = useSaver();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [deps, setDeps] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const m = detail.data?.meta;
    if (!m) return;
    setInput(m.inputSchema ? JSON.stringify(m.inputSchema, null, 2) : '');
    setOutput(m.outputSchema ? JSON.stringify(m.outputSchema, null, 2) : '');
    setDeps(m.dependsOn?.join(', ') ?? '');
  }, [detail.data]);

  const parse = (text: string, which: string): Record<string, unknown> | null | undefined => {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      setProblem(`The ${which} schema isn’t valid JSON.`);
      return undefined;
    }
  };

  const submit = async () => {
    setProblem(null);
    const inputSchema = parse(input, 'input');
    const outputSchema = parse(output, 'output');
    if (inputSchema === undefined || outputSchema === undefined) return;
    const list = deps
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await save(slug, () =>
      client.updateSkill(slug, { inputSchema, outputSchema, dependsOn: list.length ? list : null })
    );
  };

  const unknown = deps
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !all.some((k) => k.slug === s));

  return (
    <Dialog
      open
      onClose={onClose}
      title={detail.data?.meta.name ?? slug}
      size="lg"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={Save} busy={busy} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Loaded resource={detail} what="the skill" skeleton="text">
        {(d) => (
          <div className="settings-form">
            {d.meta.description && <p className="page-hint">{d.meta.description}</p>}
            <Textarea
              label="Input schema"
              mono
              rows={6}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              hint="JSON Schema. Leave empty for none."
            />
            <Textarea
              label="Output schema"
              mono
              rows={6}
              value={output}
              onChange={(e) => setOutput(e.target.value)}
            />
            <Input
              label="Depends on"
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
              placeholder="vat-core, payroll-base"
              hint={unknown.length ? undefined : 'Other skills, by slug, separated by commas.'}
              error={
                unknown.length ? `Not a skill here: ${unknown.join(', ')}.` : (problem ?? undefined)
              }
            />
            <CodeBlock title="Instructions" code={d.body} wrap maxHeight="md" />
          </div>
        )}
      </Loaded>
    </Dialog>
  );
}

export function SkillsSection() {
  const client = useClient();
  const skills = useResource('skills', () => client.skills());
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Section title="Skills">
      <Loaded resource={skills} what="skills" skeleton="rows">
        {(d) => (
          <>
            <p className="page-hint">
              From <code>{d.source}</code>.
            </p>
            <Table
              label="Skills"
              rows={d.skills}
              rowKey={(s) => s.slug}
              onRowClick={(s) => setEditing(s.slug)}
              columns={[
                { key: 'name', header: 'Skill', cell: (s) => s.name, sortValue: (s) => s.name },
                {
                  key: 'desc',
                  header: 'What it does',
                  cell: (s) => <span className="page-muted">{s.description ?? ''}</span>,
                },
                {
                  key: 'version',
                  header: 'Version',
                  cell: (s) => s.version ?? '',
                  mono: true,
                  width: 'sm',
                },
              ]}
              empty={
                <EmptyState icon={BookOpen} title="No skills here">
                  Add skill folders to the skills directory under Advanced.
                </EmptyState>
              }
            />
            {editing && (
              <SkillEditor slug={editing} all={d.skills} onClose={() => setEditing(null)} />
            )}
          </>
        )}
      </Loaded>
    </Section>
  );
}

// ---------------------------------------------------------------------------

/** What each kind of memory is for, for the picker and the Type column. */
const MEMORY_TYPE_HINTS: Record<MemoryType, string> = {
  fact: 'Something true: a rate, a name, a deadline.',
  preference: 'How you like things done. Read in every managed chat.',
  decision: 'A choice made, and why.',
  procedure: 'How to do something, step by step.',
  note: 'Anything else.',
};

export function MemorySection() {
  const client = useClient();
  const [query, setQuery] = useState('');
  const q = query.trim();
  // A search is its own resource, so the list comes back the moment it is cleared.
  const memory = useResource(
    q ? `memory:search:${q}` : 'memory',
    async (): Promise<MemoryRecord[]> =>
      q ? (await client.searchMemory(q)).results : (await client.memory()).entries,
    { on: ['memory'] }
  );
  const { save, busy } = useSaver();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [type, setType] = useState<MemoryType>('fact');
  const [deleting, setDeleting] = useState<MemoryRecord | null>(null);

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

  return (
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
      <Loaded resource={memory} what="memory" skeleton="rows">
        {(entries) => (
          <Table
            label="Memory entries"
            rows={entries}
            rowKey={(e) => e.id}
            columns={[
              {
                key: 'key',
                header: 'Key',
                cell: (e) => <code>{e.key}</code>,
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
                  <span className="settings-value">
                    {typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}
                  </span>
                ),
              },
              {
                key: 'at',
                header: 'Added',
                cell: (e) => <When at={e.createdAt} />,
                sortValue: (e) => e.createdAt,
                width: 'sm',
              },
              {
                key: 'del',
                header: <span className="ui-sr-only">Delete</span>,
                width: 'xs',
                cell: (e) => (
                  <IconButton
                    icon={Trash2}
                    label={`Delete ${e.key}`}
                    size="sm"
                    onClick={() => setDeleting(e)}
                  />
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
        )}
      </Loaded>
      <ConfirmDelete
        what={deleting?.key ?? ''}
        detail="Managed chats and tasks will no longer see it."
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
  );
}

// ---------------------------------------------------------------------------

type CronRow = { id: string; schedule: string; message: string };
type FileRow = { id: string; path: string; message: string };

function ScheduledTask({
  config,
  saveConfig,
  onSynced,
}: {
  config: AppConfig | null;
  saveConfig: (c: AppConfig) => Promise<void>;
  onSynced: () => void;
}) {
  const client = useClient();
  const host = useHost();
  const toast = useToast();
  const saved = config?.settings;
  const [mode, setMode] = useState<'manual' | 'auto'>(
    saved?.runMode === 'auto' ? 'auto' : 'manual'
  );
  const [countText, setCountText] = useState(String(saved?.runFrequencyCount ?? 1));
  const [period, setPeriod] = useState<RunPeriod>(
    isRunPeriod(saved?.runFrequencyPeriod) ? saved.runFrequencyPeriod : 'day'
  );
  const [message, setMessage] = useState(
    typeof saved?.runTaskMessage === 'string' ? saved.runTaskMessage : ''
  );
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const count = countText.trim() ? Number(countText) : 1;

  let preview: string | null = null;
  let problem: string | null = null;
  if (mode === 'auto') {
    try {
      preview = describeCron(cronForRuns(count, period));
    } catch (e) {
      problem = errorMessage(e);
    }
  }

  const submit = async () => {
    setBusy(true);
    try {
      const trigger = persistentRunTrigger({ mode, count, period, message });
      if (host.writeConfig) {
        await saveConfig({
          ...config,
          settings: {
            ...config?.settings,
            runMode: mode,
            runFrequencyCount: count,
            runFrequencyPeriod: period,
            runTaskMessage: message.trim() || undefined,
          },
        });
      }
      const changed = await syncPersistentRun(client, trigger);
      if (changed) onSynced();
      toast({
        message: trigger
          ? `Scheduled: ${describeCron(trigger.schedule)}.`
          : changed
            ? 'Automatic runs stopped.'
            : 'Saved.',
        tone: 'ok',
      });
    } catch (e) {
      toast({ message: `Couldn’t save the schedule. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      await client.task(message.trim() || DEFAULT_RUN_MESSAGE);
      toast({ message: 'The task ran. Its run is under Runs.', tone: 'ok' });
    } catch (e) {
      toast({ message: `The task failed. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section title="Scheduled task">
      <p className="page-hint">
        A message the assistant works on now, or on a schedule. Each run is recorded under Runs.
      </p>
      <SegmentedControl
        label="When"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'manual', label: 'When I run it' },
          { value: 'auto', label: 'On a schedule' },
        ]}
      />
      {mode === 'auto' && (
        <div className="settings-inline">
          <Input
            label="Runs"
            type="number"
            min={1}
            max={MAX_RUNS[period]}
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            error={problem ?? undefined}
          />
          <Select
            label="Every"
            value={period}
            onChange={(e) => setPeriod(e.target.value as RunPeriod)}
          >
            <option value="hour">hour</option>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </Select>
          {preview && <p className="page-hint settings-preview">{preview}</p>}
        </div>
      )}
      <Input
        label="Message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={DEFAULT_RUN_MESSAGE}
      />
      <div className="page-row">
        <Button icon={Play} busy={running} onClick={runNow}>
          Run now
        </Button>
        <Button
          variant="primary"
          icon={Save}
          busy={busy}
          disabled={Boolean(problem)}
          onClick={submit}
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

export function TriggersSection({
  config,
  saveConfig,
}: {
  config: AppConfig | null;
  saveConfig: (c: AppConfig) => Promise<void>;
}) {
  const client = useClient();
  const triggers = useResource('triggers', () => client.triggers() as Promise<TriggersConfig>);
  const { save, busy } = useSaver();
  const [draft, setDraft] = useState<TriggersConfig | null>(null);
  const [deleting, setDeleting] = useState<{
    kind: 'cron' | 'file' | 'webhook';
    id: string;
  } | null>(null);

  useEffect(() => {
    if (triggers.data) setDraft(triggers.data);
  }, [triggers.data]);

  const cron = (draft?.cron ?? []).filter((t) => t.id !== PERSISTENT_RUN_TRIGGER_ID);
  const own = (draft?.cron ?? []).filter((t) => t.id === PERSISTENT_RUN_TRIGGER_ID);
  const files = draft?.file ?? [];
  const hooks = Object.entries(draft?.webhooks ?? {});
  const dirty = JSON.stringify(draft) !== JSON.stringify(triggers.data);

  const setCron = (rows: CronRow[]) => setDraft((d) => ({ ...d, cron: [...rows, ...own] }));
  const setFiles = (rows: FileRow[]) => setDraft((d) => ({ ...d, file: rows }));
  const setHooks = (entries: Array<[string, { message: string }]>) =>
    setDraft((d) => ({ ...d, webhooks: Object.fromEntries(entries) }));

  const submit = () =>
    save('the triggers', () => client.saveTriggers(draft ?? {})).then((ok) => {
      if (ok) void triggers.reload();
    });

  const row = (fields: ReactNode, onDelete: () => void, label: string) => (
    <li className="settings-trigger">
      {fields}
      <IconButton icon={Trash2} label={`Delete ${label}`} size="sm" onClick={onDelete} />
    </li>
  );

  return (
    <>
      <ScheduledTask
        config={config}
        saveConfig={saveConfig}
        onSynced={() => void triggers.reload()}
      />
      <Section
        title="Triggers"
        actions={
          <Button variant="primary" icon={Save} busy={busy} disabled={!dirty} onClick={submit}>
            Save triggers
          </Button>
        }
      >
        <p className="page-hint">
          Start a task on a schedule, when a file changes, or when another app calls a webhook.
        </p>
        <Loaded resource={triggers} what="triggers" skeleton="rows">
          {() => (
            <div className="settings-triggers">
              <div>
                <div className="page-section-head">
                  <h3 className="settings-subtitle">Schedules</h3>
                  <Button
                    size="sm"
                    icon={Plus}
                    onClick={() =>
                      setCron([
                        ...cron,
                        {
                          id: `cron-${Date.now()}`,
                          schedule: '0 9 * * *',
                          message: DEFAULT_RUN_MESSAGE,
                        },
                      ])
                    }
                  >
                    Add schedule
                  </Button>
                </div>
                <ul className="settings-list">
                  {cron.map((t, i) =>
                    row(
                      <>
                        <Input
                          aria-label="Cron line"
                          mono
                          value={t.schedule}
                          onChange={(e) =>
                            setCron(
                              cron.map((x, j) => (j === i ? { ...x, schedule: e.target.value } : x))
                            )
                          }
                          hint={describeCron(t.schedule)}
                        />
                        <Input
                          aria-label="Message"
                          value={t.message}
                          onChange={(e) =>
                            setCron(
                              cron.map((x, j) => (j === i ? { ...x, message: e.target.value } : x))
                            )
                          }
                        />
                      </>,
                      () => setDeleting({ kind: 'cron', id: t.id }),
                      'schedule'
                    )
                  )}
                  {!cron.length && <li className="page-hint">None.</li>}
                </ul>
              </div>
              <div>
                <div className="page-section-head">
                  <h3 className="settings-subtitle">File changes</h3>
                  <Button
                    size="sm"
                    icon={Plus}
                    onClick={() =>
                      setFiles([
                        ...files,
                        { id: `file-${Date.now()}`, path: '', message: 'File changed' },
                      ])
                    }
                  >
                    Add file watch
                  </Button>
                </div>
                <ul className="settings-list">
                  {files.map((t, i) =>
                    row(
                      <>
                        <Input
                          aria-label="Path"
                          mono
                          value={t.path}
                          placeholder="/path/to/watch"
                          onChange={(e) =>
                            setFiles(
                              files.map((x, j) => (j === i ? { ...x, path: e.target.value } : x))
                            )
                          }
                        />
                        <Input
                          aria-label="Message"
                          value={t.message}
                          onChange={(e) =>
                            setFiles(
                              files.map((x, j) => (j === i ? { ...x, message: e.target.value } : x))
                            )
                          }
                        />
                      </>,
                      () => setDeleting({ kind: 'file', id: t.id }),
                      'file watch'
                    )
                  )}
                  {!files.length && <li className="page-hint">None.</li>}
                </ul>
              </div>
              <div>
                <div className="page-section-head">
                  <h3 className="settings-subtitle">Webhooks</h3>
                  <Button
                    size="sm"
                    icon={Plus}
                    onClick={() =>
                      setHooks([...hooks, [`webhook-${Date.now()}`, { message: 'Webhook called' }]])
                    }
                  >
                    Add webhook
                  </Button>
                </div>
                <ul className="settings-list">
                  {hooks.map(([id, v], i) =>
                    row(
                      <>
                        <span className="settings-hook">
                          <code>
                            POST {client.getUrl()}/webhook/{id}
                          </code>
                        </span>
                        <Input
                          aria-label="Message"
                          value={v.message}
                          onChange={(e) =>
                            setHooks(
                              hooks.map((x, j) =>
                                j === i ? [x[0], { message: e.target.value }] : x
                              )
                            )
                          }
                        />
                      </>,
                      () => setDeleting({ kind: 'webhook', id }),
                      'webhook'
                    )
                  )}
                  {!hooks.length && <li className="page-hint">None.</li>}
                </ul>
              </div>
              {dirty && <p className="page-hint tone-text-warn">Unsaved changes.</p>}
            </div>
          )}
        </Loaded>
        <ConfirmDelete
          what={
            deleting?.kind === 'cron'
              ? 'this schedule'
              : deleting?.kind === 'file'
                ? 'this file watch'
                : 'this webhook'
          }
          detail="It stops starting tasks once you save the triggers."
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            if (!deleting) return;
            if (deleting.kind === 'cron') setCron(cron.filter((t) => t.id !== deleting.id));
            else if (deleting.kind === 'file') setFiles(files.filter((t) => t.id !== deleting.id));
            else setHooks(hooks.filter(([id]) => id !== deleting.id));
          }}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------

function SystemPrompt() {
  const client = useClient();
  const prompt = useResource('system-prompt', () => client.systemPrompt());
  const { save, busy } = useSaver();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (prompt.data && text === null) setText(prompt.data.prompt);
  }, [prompt.data, text]);
  return (
    <Section title="System prompt">
      <Loaded resource={prompt} what="the system prompt" skeleton="text">
        {(d) => (
          <>
            <Textarea
              aria-label="System prompt"
              mono
              rows={8}
              value={text ?? ''}
              placeholder={d.default}
              onChange={(e) => setText(e.target.value)}
              hint="Base instructions for managed chats and tasks. Empty uses the default."
            />
            <div className="page-row">
              <Button icon={RotateCcw} onClick={() => setText(d.default)}>
                Use the default
              </Button>
              <Button
                variant="primary"
                icon={Save}
                busy={busy}
                onClick={() => save('the system prompt', () => client.saveSystemPrompt(text ?? ''))}
              >
                Save
              </Button>
            </div>
          </>
        )}
      </Loaded>
    </Section>
  );
}

function Reasoning() {
  const client = useClient();
  const reasoning = useResource('reasoning', () => client.reasoning());
  const { save, busy } = useSaver();
  const [temp, setTemp] = useState('');
  const [max, setMax] = useState('');
  useEffect(() => {
    if (!reasoning.data) return;
    setTemp(reasoning.data.temperature === undefined ? '' : String(reasoning.data.temperature));
    setMax(reasoning.data.maxTokens === undefined ? '' : String(reasoning.data.maxTokens));
  }, [reasoning.data]);
  const t = temp === '' ? undefined : Number(temp);
  const m = max === '' ? undefined : Number(max);
  const bad =
    (t !== undefined && (!Number.isFinite(t) || t < 0 || t > 2)) ||
    (m !== undefined && (!Number.isInteger(m) || m < 1));
  return (
    <Section title="Reasoning">
      <div className="settings-inline">
        <Input
          label="Temperature"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={temp}
          placeholder="Default"
          onChange={(e) => setTemp(e.target.value)}
          hint="0 to 2."
        />
        <Input
          label="Max tokens"
          type="number"
          min={1}
          value={max}
          placeholder="Default"
          onChange={(e) => setMax(e.target.value)}
        />
        <Button
          variant="primary"
          icon={Save}
          busy={busy}
          disabled={bad}
          onClick={() =>
            save('reasoning', () => client.saveReasoning({ temperature: t, maxTokens: m }))
          }
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

function Capabilities() {
  const client = useClient();
  const caps = useResource('capabilities', () => client.capabilities());
  const { save, busy } = useSaver();
  const [root, setRoot] = useState('');
  const [hosts, setHosts] = useState('');
  useEffect(() => {
    if (!caps.data) return;
    setRoot(caps.data.fsRoot ?? '');
    setHosts((caps.data.httpAllowlist ?? []).join('\n'));
  }, [caps.data]);
  return (
    <Section title="Tool access">
      <Input
        label="Files under"
        mono
        value={root}
        onChange={(e) => setRoot(e.target.value)}
        placeholder="The service’s working folder"
        hint="fs.read resolves paths under this folder."
      />
      <Textarea
        label="Web hosts"
        mono
        rows={3}
        value={hosts}
        onChange={(e) => setHosts(e.target.value)}
        hint="One hostname a line that http.request may call. None turns it off."
      />
      <div className="page-row">
        <Button
          variant="primary"
          icon={Save}
          busy={busy}
          onClick={() =>
            save('tool access', () =>
              client.saveCapabilities({
                fsRoot: root.trim() || undefined,
                httpAllowlist: hosts
                  .split('\n')
                  .map((h) => h.trim())
                  .filter(Boolean),
              })
            )
          }
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

function Connection({
  config,
  saveConfig,
}: {
  config: AppConfig | null;
  saveConfig: (c: AppConfig) => Promise<void>;
}) {
  const host = useHost();
  const live = useLive();
  const { save, busy } = useSaver();
  const [url, setUrl] = useState(config?.settings?.gatewayUrl ?? '');
  const [skills, setSkills] = useState(config?.settings?.skillsDir ?? '');
  useEffect(() => {
    setUrl(config?.settings?.gatewayUrl ?? '');
    setSkills(config?.settings?.skillsDir ?? '');
  }, [config]);
  let urlError: string | undefined;
  if (url.trim()) {
    try {
      new URL(url.trim());
    } catch {
      urlError = 'Use a full address, such as http://127.0.0.1:18790.';
    }
  }
  if (!host.writeConfig) return null;
  return (
    <Section title="Background service">
      <Input
        label="Gateway URL"
        mono
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="http://127.0.0.1:18790"
        error={urlError}
      />
      <Input
        label="Skills directory"
        mono
        value={skills}
        onChange={(e) => setSkills(e.target.value)}
        placeholder="The default"
        hint="Applies after a restart."
      />
      <div className="page-row">
        <Button
          variant="primary"
          icon={Save}
          busy={busy}
          disabled={Boolean(urlError)}
          onClick={() =>
            save('the settings', async () => {
              await saveConfig({
                ...config,
                settings: {
                  ...config?.settings,
                  gatewayUrl: url.trim() || undefined,
                  skillsDir: skills.trim() || undefined,
                },
              });
              host.setGatewayUrl?.(url.trim());
              live.invalidate();
            })
          }
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

function Modules({
  config,
  saveConfig,
  modules,
}: {
  config: AppConfig | null;
  saveConfig: (c: AppConfig) => Promise<void>;
  modules: ModuleUI[];
}) {
  const host = useHost();
  const { save, busy } = useSaver();
  const [paths, setPaths] = useState(config?.modulePaths ?? []);
  useEffect(() => setPaths(config?.modulePaths ?? []), [config]);
  if (!host.writeConfig) return null;
  const listed = config?.modules ?? [];
  const isOn = (id: string) => listed.find((m) => m.id === id)?.enabled !== false;
  const setOn = (m: ModuleUI, on: boolean) => {
    const rest = listed.filter((x) => x.id !== m.id);
    void save(
      m.name,
      () =>
        saveConfig({
          ...config,
          modules: [
            ...rest,
            { id: m.id, name: m.name, description: m.description ?? '', enabled: on },
          ],
        }),
      on ? `${m.name} turns on after a restart.` : `${m.name} turns off after a restart.`
    );
  };
  const off = listed.filter((x) => x.enabled === false && !modules.some((m) => m.id === x.id));
  return (
    <Section title="Modules">
      <ul className="settings-list">
        {modules.map((m) => (
          <li key={m.id}>
            <span className="settings-module">
              <span>{m.name}</span>
              {m.description && <span className="page-hint">{m.description}</span>}
            </span>
            <Switch
              checked={isOn(m.id)}
              onChange={(on) => setOn(m, on)}
              label={`${m.name} on`}
              hideLabel
            />
          </li>
        ))}
        {off.map((m) => (
          <li key={m.id}>
            <span className="settings-module">
              <span>{m.name || m.id}</span>
              <span className="page-hint">Off</span>
            </span>
            <Switch
              checked={false}
              onChange={() =>
                void save(
                  m.id,
                  () =>
                    saveConfig({
                      ...config,
                      modules: listed.map((x) => (x.id === m.id ? { ...x, enabled: true } : x)),
                    }),
                  'Turns on after a restart.'
                )
              }
              label={`${m.name || m.id} on`}
              hideLabel
            />
          </li>
        ))}
      </ul>
      <h3 className="settings-subtitle">Module folders</h3>
      <p className="page-hint">Folders that hold a module’s manifest.json.</p>
      <ul className="settings-list">
        {paths.map((p, i) => (
          <li key={i} className="settings-trigger">
            <Input
              aria-label="Module id"
              mono
              value={p.id}
              onChange={(e) =>
                setPaths(paths.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
              }
              placeholder="id"
            />
            <Input
              aria-label="Folder"
              mono
              value={p.path ?? ''}
              onChange={(e) =>
                setPaths(paths.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))
              }
              placeholder="/path/to/module"
            />
            <IconButton
              icon={Trash2}
              label="Remove folder"
              size="sm"
              onClick={() => setPaths(paths.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ul>
      <div className="page-row">
        <Button icon={Plus} onClick={() => setPaths([...paths, { id: '', path: '' }])}>
          Add folder
        </Button>
        <Button
          variant="primary"
          icon={Save}
          busy={busy}
          onClick={() =>
            save(
              'module folders',
              () => saveConfig({ ...config, modulePaths: paths.filter((p) => p.id.trim()) }),
              'Saved. Applies after a restart.'
            )
          }
        >
          Save folders
        </Button>
      </div>
    </Section>
  );
}

export function AdvancedSection({
  config,
  saveConfig,
  modules,
}: {
  config: AppConfig | null;
  saveConfig: (c: AppConfig) => Promise<void>;
  modules: ModuleUI[];
}) {
  return (
    <>
      <Connection config={config} saveConfig={saveConfig} />
      <SystemPrompt />
      <Reasoning />
      <Capabilities />
      <Modules config={config} saveConfig={saveConfig} modules={modules} />
      <Section title="Shortcuts">
        <ul className="settings-keys">
          <li>
            <kbd>⌘K</kbd> Search and commands
          </li>
          <li>
            <kbd>⌘1</kbd>–<kbd>⌘9</kbd> Pages in the rail
          </li>
          <li>
            <kbd>⌘,</kbd> Settings
          </li>
          <li>
            <kbd>⌘↵</kbd> Send or save
          </li>
          <li>
            <kbd>J</kbd> <kbd>K</kbd> <kbd>A</kbd> <kbd>D</kbd> Move, approve and deny in Approvals
          </li>
          <li>
            <kbd>Esc</kbd> Close the top layer
          </li>
        </ul>
      </Section>
    </>
  );
}
