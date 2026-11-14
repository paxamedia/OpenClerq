/** Settings sections that edit what the background service stores. */

import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, Play, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { SegmentedControl, Switch } from '../../ui/Choice';
import { EmptyState } from '../../ui/Display';
import { Input, Select, Textarea } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
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

/** Saves a section: shows success or the reason as a toast, and keeps a busy flag. */
export function useSaver() {
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
export function ConfirmDelete({
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

// ---------------------------------------------------------------------------

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
