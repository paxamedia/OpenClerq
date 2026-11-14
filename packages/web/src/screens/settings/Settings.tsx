/**
 * Settings, in the main window, with its own section list: General, Models &
 * keys, Secrets, GitHub, Plugins, Skills, Memory, Triggers, Remote, Devices, Advanced.
 */

import { useState } from 'react';
import { Check, CircleAlert, KeyRound, OctagonX, Play } from 'lucide-react';
import type { ProviderInfo } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/Choice';
import { KeyValue } from '../../ui/Display';
import { Input, Select } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Dialog } from '../../ui/Modal';
import { StatusTag } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { cx } from '../../ui/cx';
import { useClient, useHost, type AppConfig } from '../../app/client';
import { useProviders } from '../../app/data';
import { duration, errorMessage } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import type { ModuleUI } from '../../app/modules';
import { Link } from '../../app/router';
import { useTheme, type Theme } from '../../app/theme';
import { Loaded, Page, PageHeader, PHONE_QUERY, Section, useMedia } from '../../shell/layout';
import { ModuleFrame } from '../../shell/ModuleFrame';
import { useExtensions } from '../../app/extensions';
import { DevicesSection, RemoteSection } from './devices';
import { GithubSection } from './github';
import { MemorySection } from './memory';
import { PluginsSection } from './plugins';
import { FallbackSection } from './routing';
import { AdvancedSection, SecretsSection, TriggersSection } from './sections';
import { SkillsSection } from './skills';
import './settings.css';

export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', keywords: 'theme start page stop' },
  { id: 'models', label: 'Models & keys', keywords: 'providers api key anthropic openai test' },
  { id: 'secrets', label: 'Secrets', keywords: 'vault tokens keychain' },
  {
    id: 'github',
    label: 'GitHub',
    keywords: 'app sign in device flow install repositories pull request token',
  },
  {
    id: 'plugins',
    label: 'Plugins',
    keywords: 'modules permissions approve approval enforce enforcement trust checksum legacy',
  },
  {
    id: 'skills',
    label: 'Skills',
    keywords: 'schema trust trusted block blocked untrust checksum enforce enforcement declare',
  },
  { id: 'memory', label: 'Memory', keywords: 'entries' },
  { id: 'triggers', label: 'Triggers', keywords: 'cron webhook file watcher schedule task' },
  { id: 'remote', label: 'Remote', keywords: 'phone tunnel proxy https ntfy push' },
  { id: 'devices', label: 'Devices', keywords: 'phone pair qr revoke mobile' },
  {
    id: 'advanced',
    label: 'Advanced',
    keywords: 'gateway url system prompt reasoning capabilities modules paths',
  },
] as const;

export type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export interface SettingsProps {
  section: string | null;
  config: AppConfig | null;
  saveConfig: (c: AppConfig) => Promise<void>;
  modules: ModuleUI[];
}

function StopEverything() {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const status = useResource('kill', () => client.killStatus(), { on: ['runs', 'health'] });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      const r = await client.kill();
      toast({
        message: `Stopped: ${r.cancelledRuns} runs cancelled, ${r.deniedApprovals} approvals refused, schedules paused.`,
        tone: 'ok',
      });
      live.invalidate();
    } catch (e) {
      toast({ message: `Couldn’t stop everything. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    try {
      await client.resume();
      live.invalidate();
    } catch (e) {
      toast({ message: `Couldn’t restart schedules. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  const paused = status.data?.triggersPaused;
  return (
    <Section title="Emergency stop">
      <p className="page-hint">
        {paused
          ? 'Schedules are paused. Nothing starts on its own until you restart them.'
          : 'Cancel every run, refuse waiting approvals and pause schedules.'}
      </p>
      <div className="page-row">
        {paused ? (
          <Button variant="primary" icon={Play} busy={busy} onClick={resume}>
            Restart schedules
          </Button>
        ) : (
          <Button variant="danger" icon={OctagonX} onClick={() => setConfirm(true)}>
            Stop everything
          </Button>
        )}
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Stop everything?"
        description={`This cancels ${status.data?.activeRuns ?? 'every'} running ${status.data?.activeRuns === 1 ? 'run' : 'runs'}, refuses every waiting approval and pauses all schedules until you restart them.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep running
            </Button>
            <Button variant="danger" icon={OctagonX} busy={busy} onClick={stop}>
              Stop everything
            </Button>
          </>
        }
      />
    </Section>
  );
}

function GeneralSection({ config, saveConfig, modules }: Omit<SettingsProps, 'section'>) {
  const [theme, setTheme] = useTheme();
  const toast = useToast();
  const host = useHost();
  const start = config?.settings?.defaultModule ?? '/';
  const pages = [
    { path: '/', label: 'Home' },
    ...modules.map((m) => ({ path: m.rail[0]?.path ?? `/m/${m.id}`, label: m.name })),
    { path: '/runs', label: 'Runs' },
    { path: '/inbox', label: 'Inbox' },
  ];
  const setStart = async (path: string) => {
    try {
      await saveConfig({
        ...config,
        settings: { ...config?.settings, defaultModule: path === '/' ? undefined : path },
      });
    } catch (e) {
      toast({ message: `Couldn’t save. ${errorMessage(e)}`, tone: 'err' });
    }
  };
  return (
    <>
      <Section title="Appearance">
        <SegmentedControl<Theme>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'auto', label: 'Match system' },
          ]}
        />
      </Section>
      {host.writeConfig && (
        <Section title="Start page">
          <Select
            aria-label="Start page"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            hint="The page OpenClerq opens on."
          >
            {pages.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label}
              </option>
            ))}
          </Select>
        </Section>
      )}
      <StopEverything />
    </>
  );
}

function ProviderRow({
  p,
  current,
}: {
  p: ProviderInfo;
  current: { provider: string; model: string } | undefined;
}) {
  const client = useClient();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const model = p.models[0]?.ref ?? (p.defaultModel ? `${p.id}/${p.defaultModel}` : null);

  // A one-word raw chat, then the conversation is deleted. It costs a fraction of a cent.
  const test = async () => {
    if (!model) return;
    setTesting(true);
    setResult(null);
    const started = Date.now();
    let sessionId: string | null = null;
    try {
      const s = await client.createSession({ mode: 'raw', model, title: `Key test: ${p.label}` });
      sessionId = s.id;
      await client.sendMessage(s.id, { text: 'Reply with the word OK.', model });
      setResult({ ok: true, text: `Answered in ${duration(Date.now() - started)}.` });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      if (sessionId) await client.deleteSession(sessionId).catch(() => undefined);
      setTesting(false);
    }
  };

  return (
    <li className="settings-provider">
      <div className="settings-provider-main">
        <span className="settings-provider-name">
          {p.label}
          {current?.provider === p.id && <span className="settings-default">Default</span>}
        </span>
        <span className="page-hint">
          {p.local ? 'Runs on this computer' : 'Cloud'} · {p.models.length}{' '}
          {p.models.length === 1 ? 'model' : 'models'}
          {p.defaultModel ? ` · ${p.defaultModel}` : ''}
        </span>
        {!p.ready && p.reason && (
          <span className="page-hint">
            {p.reason.replace(/^Set /, 'Needs ')} in the background service’s settings, then a
            restart.
          </span>
        )}
        {result && (
          <span
            className={cx('settings-test', result.ok ? 'tone-text-ok' : 'tone-text-err')}
            role="status"
          >
            <Icon glyph={result.ok ? Check : CircleAlert} size={14} /> {result.text}
          </span>
        )}
      </div>
      <StatusTag tone={p.ready ? 'ok' : 'muted'}>
        {p.ready ? (p.local ? 'Ready' : 'Key set') : p.local ? 'Not running' : 'No key'}
      </StatusTag>
      <Button size="sm" busy={testing} disabled={!p.ready || !model} onClick={test}>
        Test
      </Button>
    </li>
  );
}

function ModelsSection() {
  const providers = useProviders();
  const host = useHost();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!host.saveApiKey || !key.trim()) return;
    setSaving(true);
    try {
      await host.saveApiKey(key.trim());
      setKey('');
      toast({ message: 'Saved. Restart OpenClerq to use the new key.', tone: 'ok' });
    } catch (e) {
      toast({ message: `Couldn’t save the key. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Section title="Providers">
        <Loaded resource={providers} what="providers" skeleton="rows">
          {(d) => (
            <>
              <KeyValue
                items={[
                  {
                    label: 'Default model',
                    value: `${d.current.provider} · ${d.current.model}`,
                    mono: true,
                  },
                ]}
              />
              <ul className="settings-providers">
                {d.providers.map((p) => (
                  <ProviderRow key={p.id} p={p} current={d.current} />
                ))}
              </ul>
              <p className="page-hint">
                Test sends one short message and costs a fraction of a cent.
              </p>
            </>
          )}
        </Loaded>
      </Section>
      <FallbackSection />
      {host.saveApiKey && (
        <Section title="Anthropic key">
          <div className="settings-inline">
            <Input
              type="password"
              label="API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
              hint="Stored on this computer for the background service. Applies after a restart."
            />
            <Button
              variant="primary"
              icon={KeyRound}
              busy={saving}
              disabled={!key.trim()}
              onClick={save}
            >
              Save key
            </Button>
          </div>
        </Section>
      )}
    </>
  );
}

export function Settings({ section, config, saveConfig, modules }: SettingsProps) {
  const phone = useMedia(PHONE_QUERY);
  const extensions = useExtensions();
  // Modules' own settings pages, after the built-in sections.
  const pages = (extensions.data?.['settings.page'] ?? []).map((p) => ({
    id: `${p.moduleId}.${p.id}`,
    label: p.title ?? p.moduleId,
    page: p,
  }));
  const all = [
    ...SETTINGS_SECTIONS.map((s) => ({ id: s.id as string, label: s.label, page: null })),
    ...pages,
  ];
  const current = all.find((s) => s.id === section) ?? (phone ? null : all[0]);

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections">
      <ul>
        {all.map((s) => (
          <li key={s.id}>
            <Link
              to={`/settings/${s.id}`}
              className={cx('settings-nav-link', current?.id === s.id && 'is-active')}
              aria-current={current?.id === s.id ? 'page' : undefined}
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );

  const body = !current ? null : current.page ? (
    <ModuleFrame
      key={current.id}
      moduleId={current.page.moduleId}
      path={current.page.path ?? '/'}
      title={current.label}
    />
  ) : current.id === 'general' ? (
    <GeneralSection config={config} saveConfig={saveConfig} modules={modules} />
  ) : current.id === 'models' ? (
    <ModelsSection />
  ) : current.id === 'secrets' ? (
    <SecretsSection />
  ) : current.id === 'github' ? (
    <GithubSection />
  ) : current.id === 'plugins' ? (
    <PluginsSection />
  ) : current.id === 'skills' ? (
    <SkillsSection />
  ) : current.id === 'memory' ? (
    <MemorySection />
  ) : current.id === 'triggers' ? (
    <TriggersSection config={config} saveConfig={saveConfig} />
  ) : current.id === 'remote' ? (
    <RemoteSection />
  ) : current.id === 'devices' ? (
    <DevicesSection />
  ) : (
    <AdvancedSection config={config} saveConfig={saveConfig} modules={modules} />
  );

  return (
    <Page>
      <PageHeader
        crumbs={
          current
            ? [{ label: 'Settings', to: '/settings' }, { label: current.label }]
            : [{ label: 'Settings' }]
        }
        title={current ? `Settings: ${current.label}` : 'Settings'}
      />
      {phone ? (
        current ? (
          <div className="settings-body">{body}</div>
        ) : (
          nav
        )
      ) : (
        <div className="settings">
          {nav}
          <div className="settings-body">{body}</div>
        </div>
      )}
    </Page>
  );
}
