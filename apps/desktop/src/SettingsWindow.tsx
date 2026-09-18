/**
 * Standalone Settings window — full-screen layout, fetches config on mount.
 */
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setGatewayBaseUrl, gateway, initGatewayAuth } from './gateway';
import type { AppConfig, ModuleEntry, ModulePathEntry } from './configTypes';
import {
  cronForRuns,
  isRunPeriod,
  persistentRunTrigger,
  syncPersistentRun,
  withPersistentRun,
  DEFAULT_RUN_MESSAGE,
  MAX_RUNS,
  type CronTrigger,
  type RunPeriod,
} from './persistentRun';
import { SecretsVaultSection } from './components/SecretsVaultSection';
import { TriggersSection } from './components/TriggersSection';
import { CapabilitiesSection } from './components/CapabilitiesSection';
import { ReasoningSection } from './components/ReasoningSection';
import { SystemPromptSection } from './components/SystemPromptSection';

const DEFAULT_MODULES = [
  { id: 'local', name: 'Local', description: 'Add your own — configure below', enabled: true },
];

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

interface Notice {
  text: string;
  error: boolean;
}

/** An empty count means one run, as it always has. */
function parseRunCount(text: string): number {
  return text.trim() ? Number(text) : 1;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The trigger saved settings ask for, or undefined when they cannot be scheduled as saved. */
function savedTrigger(settings: AppConfig['settings']): CronTrigger | null | undefined {
  try {
    return persistentRunTrigger({
      mode: settings?.runMode === 'auto' ? 'auto' : 'manual',
      count: settings?.runFrequencyCount ?? 1,
      period: settings?.runFrequencyPeriod ?? 'day',
      message: settings?.runTaskMessage ?? '',
    });
  } catch {
    return undefined;
  }
}

/**
 * Saved Automatic settings promise runs only if the gateway holds their
 * trigger. It may not: settings saved by a version that never scheduled them,
 * a save the gateway missed, or an edit under Triggers. Say so, rather than
 * show a schedule that is not running.
 */
async function scheduleNotice(settings: AppConfig['settings']): Promise<Notice | null> {
  const wanted = savedTrigger(settings);
  // Settings that cannot be scheduled are explained beside the form fields.
  if (wanted === undefined) return null;
  try {
    if (withPersistentRun(await gateway.triggers(), wanted) === null) return null;
  } catch {
    // An unreachable gateway is reported by the sections that call it.
    return null;
  }
  return wanted
    ? { text: 'The gateway is not running this schedule. Save to apply it.', error: true }
    : { text: 'The gateway still runs an automatic schedule. Save to stop it.', error: true };
}

export function SettingsWindow() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [defaultModule, setDefaultModule] = useState('');
  const [skillsDir, setSkillsDir] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMessage, setApiKeyMessage] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<'manual' | 'auto'>('manual');
  const [runFrequencyCount, setRunFrequencyCount] = useState('1');
  const [runFrequencyPeriod, setRunFrequencyPeriod] = useState<RunPeriod>('day');
  const [runTaskMessage, setRunTaskMessage] = useState('');
  const [runMessage, setRunMessage] = useState<Notice | null>(null);
  const [configMessage, setConfigMessage] = useState<Notice | null>(null);
  const [modules, setModules] = useState<ModuleEntry[]>(DEFAULT_MODULES);
  const [modulePaths, setModulePaths] = useState<ModulePathEntry[]>([]);
  const [runningNow, setRunningNow] = useState(false);
  // Set once the gateway URL from config.json is applied and the token loaded.
  // The sections below call the gateway on mount, so they wait for it.
  const [gatewayReady, setGatewayReady] = useState(false);
  // Bumped when this window changes the triggers, so the Triggers section
  // reloads rather than later saving its stale copy over the change.
  const [triggersVersion, setTriggersVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // This window has its own JS context, so it loads the gateway token itself.
    const authed = initGatewayAuth().catch(() => false);
    invoke<string>('read_config')
      .then((raw) => {
        const c: AppConfig = raw ? JSON.parse(raw) : {};
        if (cancelled) return c;
        setConfig(c);
        const gw = c?.settings?.gatewayUrl ?? '';
        setGatewayUrl(gw);
        if (gw) setGatewayBaseUrl(gw);
        setDefaultModule(c?.settings?.defaultModule ?? '');
        setSkillsDir(c?.settings?.skillsDir ?? '');
        // config.json is also edited by hand, so fall back rather than trust it.
        const saved = c?.settings;
        setRunMode(saved?.runMode === 'auto' ? 'auto' : 'manual');
        setRunFrequencyCount(String(saved?.runFrequencyCount ?? 1));
        setRunFrequencyPeriod(
          isRunPeriod(saved?.runFrequencyPeriod) ? saved.runFrequencyPeriod : 'day'
        );
        setRunTaskMessage(typeof saved?.runTaskMessage === 'string' ? saved.runTaskMessage : '');
        setModules(c?.modules?.length ? c.modules : [...DEFAULT_MODULES]);
        setModulePaths(c?.modulePaths ?? []);
        return c;
      })
      .catch(() => {
        const c: AppConfig = {};
        if (!cancelled) setConfig(c);
        return c;
      })
      .then(async (c) => {
        await authed;
        if (cancelled) return;
        setGatewayReady(true);
        const notice = await scheduleNotice(c?.settings);
        // A save made meanwhile has the newer word.
        if (!cancelled && notice) setRunMessage((m) => m ?? notice);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateModule = (i: number, patch: Partial<ModuleEntry>) => {
    setModules((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  };
  const updateModulePath = (i: number, patch: Partial<ModulePathEntry>) => {
    setModulePaths((prev) => prev.map((mp, j) => (j === i ? { ...mp, ...patch } : mp)));
  };
  const addModule = () =>
    setModules((prev) => [...prev, { id: '', name: '', description: '', enabled: true }]);
  const removeModule = (i: number) => setModules((prev) => prev.filter((_, j) => j !== i));
  const addModulePath = () => setModulePaths((prev) => [...prev, { id: '', path: '' }]);
  const removeModulePath = (i: number) => setModulePaths((prev) => prev.filter((_, j) => j !== i));

  const saveSettingsAndModules = useCallback(async () => {
    setConfigMessage(null);
    setRunMessage(null);
    const gwUrl = gatewayUrl.trim();
    if (gwUrl) {
      try {
        new URL(gwUrl);
      } catch {
        setConfigMessage({
          text: 'Invalid Gateway URL. Use e.g. http://127.0.0.1:18790',
          error: true,
        });
        return;
      }
    }
    const count = parseRunCount(runFrequencyCount);
    let trigger: CronTrigger | null;
    try {
      trigger = persistentRunTrigger({
        mode: runMode,
        count,
        period: runFrequencyPeriod,
        message: runTaskMessage,
      });
    } catch (e) {
      setConfigMessage({ text: `Not saved. Persistent run: ${errorText(e)}`, error: true });
      return;
    }
    try {
      const next: AppConfig = {
        settings: {
          ...config?.settings,
          gatewayUrl: gwUrl || undefined,
          defaultModule: defaultModule.trim() || undefined,
          skillsDir: skillsDir.trim() || undefined,
          runMode,
          runFrequencyCount: Number.isInteger(count) && count >= 1 ? count : 1,
          runFrequencyPeriod,
          runTaskMessage: runTaskMessage.trim() || undefined,
        },
        modules: modules.filter((m) => m.id.trim()),
        modulePaths: modulePaths.filter((mp) => mp.id?.trim()),
      };
      await invoke('write_config', { json: JSON.stringify(next, null, 2) });
      setConfig(next);
      if (next.settings?.gatewayUrl) setGatewayBaseUrl(next.settings.gatewayUrl);
    } catch (e) {
      setConfigMessage({ text: `Error: ${errorText(e)}`, error: true });
      return;
    }
    // After the config write, so a changed gateway URL is already in use.
    try {
      const changed = await syncPersistentRun(gateway, trigger);
      if (changed) setTriggersVersion((v) => v + 1);
      setRunMessage(
        trigger
          ? { text: `The gateway runs this on schedule ${trigger.schedule}.`, error: false }
          : changed
            ? { text: 'Automatic runs stopped.', error: false }
            : null
      );
      setConfigMessage({ text: 'Settings saved to ~/.clerq/config.json', error: false });
    } catch (e) {
      const reason = errorText(e);
      setRunMessage({ text: `The schedule was not updated: ${reason}`, error: true });
      setConfigMessage({
        text: `Settings saved to ~/.clerq/config.json, but automatic runs were not updated on the gateway: ${reason}`,
        error: true,
      });
    }
  }, [
    config,
    gatewayUrl,
    defaultModule,
    skillsDir,
    runMode,
    runFrequencyCount,
    runFrequencyPeriod,
    runTaskMessage,
    modules,
    modulePaths,
  ]);

  const saveApiKey = useCallback(async () => {
    setApiKeyMessage(null);
    try {
      await invoke('write_api_key', { apiKey });
      setApiKeyMessage('Saved to ~/.clerq/.env. Restart the gateway to use it.');
    } catch (e) {
      setApiKeyMessage(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [apiKey]);

  const runScheduledTask = useCallback(async () => {
    setRunMessage(null);
    setRunningNow(true);
    try {
      await gateway.task(runTaskMessage.trim() || DEFAULT_RUN_MESSAGE);
      setRunMessage({ text: 'Run finished.', error: false });
    } catch (e) {
      setRunMessage({ text: `Run failed: ${errorText(e)}`, error: true });
    } finally {
      setRunningNow(false);
    }
  }, [runTaskMessage]);

  const schedulePreview = (() => {
    if (runMode !== 'auto') return null;
    try {
      return { schedule: cronForRuns(parseRunCount(runFrequencyCount), runFrequencyPeriod) };
    } catch (e) {
      return { error: errorText(e) };
    }
  })();

  return (
    <div className="app app--settings-window">
      <div className="view-header">
        <h1 className="view-title">Settings</h1>
      </div>
      <div className="settings-window-content">
        <section className="section dev-section">
          <h2>Connection & config</h2>
          <p className="section-desc">
            Saved to ~/.clerq/config.json. Gateway URL is used for all API calls.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.9rem' }}>
              Gateway URL
              <input
                type="url"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                placeholder="http://127.0.0.1:18790"
                style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }}
              />
            </label>
            <label style={{ fontSize: '0.9rem' }}>
              Default mode (optional)
              <select
                value={defaultModule}
                onChange={(e) => setDefaultModule(e.target.value)}
                style={{ marginLeft: 8, marginTop: 4 }}
              >
                <option value="">—</option>
                {modules
                  .filter((m) => m.enabled !== false)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label style={{ fontSize: '0.9rem' }}>
              Skills directory (optional)
              <input
                type="text"
                value={skillsDir}
                onChange={(e) => setSkillsDir(e.target.value)}
                placeholder="/path/to/skills or leave default"
                style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }}
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Restart gateway after changing.
              </span>
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={saveSettingsAndModules}>
                Save settings
              </button>
            </div>
          </div>
          {configMessage !== null && (
            <ResultBox error={configMessage.error}>{configMessage.text}</ResultBox>
          )}
        </section>

        <section className="section dev-section">
          <h2>Module paths</h2>
          <p className="section-desc">
            Paths to pluggable modules (local dirs with manifest.json).
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {modulePaths.map((mp, i) => (
              <div
                key={i}
                className="row"
                style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
              >
                <input
                  placeholder="id"
                  value={mp.id}
                  onChange={(e) => updateModulePath(i, { id: e.target.value })}
                  style={{ width: 120 }}
                />
                <input
                  placeholder="path"
                  value={mp.path ?? ''}
                  onChange={(e) => updateModulePath(i, { path: e.target.value })}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeModulePath(i)}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={addModulePath}>
                + Add module path
              </button>
              <button type="button" className="btn" onClick={saveSettingsAndModules}>
                Save
              </button>
            </div>
          </div>
        </section>

        <section className="section dev-section">
          <h2>Modes</h2>
          <p className="section-desc">Add, edit, or remove modes.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {modules.map((m, i) => (
              <div
                key={i}
                className="row"
                style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
              >
                <input
                  placeholder="id"
                  value={m.id}
                  onChange={(e) => updateModule(i, { id: e.target.value })}
                  style={{ width: 120 }}
                />
                <input
                  placeholder="Name"
                  value={m.name}
                  onChange={(e) => updateModule(i, { name: e.target.value })}
                  style={{ width: 140 }}
                />
                <input
                  placeholder="Description"
                  value={m.description}
                  onChange={(e) => updateModule(i, { description: e.target.value })}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem' }}
                >
                  <input
                    type="checkbox"
                    checked={m.enabled !== false}
                    onChange={(e) => updateModule(i, { enabled: e.target.checked })}
                  />
                  enabled
                </label>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeModule(i)}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={addModule}>
                + Add mode
              </button>
              <button type="button" className="btn" onClick={saveSettingsAndModules}>
                Save modes
              </button>
            </div>
          </div>
        </section>

        <section className="section dev-section">
          <h2>Secrets vault</h2>
          <p className="section-desc">
            Encrypted storage for API keys and tokens. Set CLERQ_VAULT_KEY (32-byte hex) in gateway
            environment to enable. Values are never exposed.
          </p>
          {gatewayReady && <SecretsVaultSection />}
        </section>

        <section className="section dev-section">
          <h2>API key</h2>
          <p className="section-desc">
            Saves to ~/.clerq/.env. Required for Explain and Task. Restart gateway after saving.
          </p>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-..."
              style={{ flex: 1, minWidth: 200 }}
            />
            <button type="button" className="btn" onClick={saveApiKey}>
              Save
            </button>
          </div>
          {apiKeyMessage !== null && (
            <ResultBox error={apiKeyMessage.startsWith('Could')}>{apiKeyMessage}</ResultBox>
          )}
        </section>

        <section className="section dev-section">
          <h2>Persistent run</h2>
          <p className="section-desc">
            Run the task now, or let the gateway run it on a schedule. Automatic runs are saved as a
            cron trigger (listed under Triggers) and recorded as scheduled runs.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.9rem' }}>
              Mode
              <select
                value={runMode}
                onChange={(e) => setRunMode(e.target.value as 'manual' | 'auto')}
                style={{ marginLeft: 8 }}
              >
                <option value="manual">Manual</option>
                <option value="auto">Automatic</option>
              </select>
            </label>
            {runMode === 'auto' && (
              <label style={{ fontSize: '0.9rem' }}>
                Runs per period
                <input
                  type="number"
                  min={1}
                  max={MAX_RUNS[runFrequencyPeriod]}
                  value={runFrequencyCount}
                  onChange={(e) => setRunFrequencyCount(e.target.value)}
                  style={{ width: 60, marginLeft: 8 }}
                />
                <select
                  value={runFrequencyPeriod}
                  onChange={(e) => setRunFrequencyPeriod(e.target.value as RunPeriod)}
                  style={{ marginLeft: 8 }}
                >
                  <option value="hour">hour</option>
                  <option value="day">day</option>
                  <option value="week">week</option>
                  <option value="month">month</option>
                </select>
                {schedulePreview && (
                  <span
                    style={{
                      display: 'block',
                      marginTop: 4,
                      fontSize: '0.8rem',
                      color: schedulePreview.error ? 'var(--error)' : 'var(--text-muted)',
                    }}
                  >
                    {schedulePreview.error ?? `Cron schedule: ${schedulePreview.schedule}`}
                  </span>
                )}
              </label>
            )}
            <label style={{ fontSize: '0.9rem' }}>
              Task message
              <input
                type="text"
                value={runTaskMessage}
                onChange={(e) => setRunTaskMessage(e.target.value)}
                placeholder={`e.g. ${DEFAULT_RUN_MESSAGE}`}
                style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }}
              />
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={saveSettingsAndModules}>
                Save
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={runScheduledTask}
                disabled={runningNow}
              >
                {runningNow ? 'Running…' : 'Run now'}
              </button>
            </div>
          </div>
          {runMessage !== null && <ResultBox error={runMessage.error}>{runMessage.text}</ResultBox>}
        </section>

        <section className="section dev-section">
          <h2>System prompt</h2>
          {gatewayReady && <SystemPromptSection />}
        </section>

        <section className="section dev-section">
          <h2>Reasoning</h2>
          {gatewayReady && <ReasoningSection />}
        </section>

        <section className="section dev-section">
          <h2>Capabilities</h2>
          {gatewayReady && <CapabilitiesSection />}
        </section>

        <section className="section dev-section">
          <h2>Triggers</h2>
          {gatewayReady && <TriggersSection key={triggersVersion} />}
        </section>
      </div>
    </div>
  );
}
