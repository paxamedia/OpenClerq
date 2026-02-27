/**
 * Standalone Settings window — full-screen layout, fetches config on mount.
 */
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setGatewayBaseUrl, gateway } from './gateway';
import type { AppConfig, ModuleEntry, ModulePathEntry } from './configTypes';
import { SecretsVaultSection } from './components/SecretsVaultSection';
import { TriggersSection } from './components/TriggersSection';
import { CapabilitiesSection } from './components/CapabilitiesSection';
import { ReasoningSection } from './components/ReasoningSection';
import { SystemPromptSection } from './components/SystemPromptSection';

const DEFAULT_MODULES = [{ id: 'local', name: 'Local', description: 'Add your own — configure below', enabled: true }];

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
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
  const [runFrequencyPeriod, setRunFrequencyPeriod] = useState<'hour' | 'day' | 'week' | 'month'>('day');
  const [runTaskMessage, setRunTaskMessage] = useState('');
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleEntry[]>(DEFAULT_MODULES);
  const [modulePaths, setModulePaths] = useState<ModulePathEntry[]>([]);

  useEffect(() => {
    invoke<string>('read_config')
      .then((raw) => {
        const c: AppConfig = raw ? JSON.parse(raw) : {};
        setConfig(c);
        const gw = c?.settings?.gatewayUrl ?? '';
        setGatewayUrl(gw);
        if (gw) setGatewayBaseUrl(gw);
        setDefaultModule(c?.settings?.defaultModule ?? '');
        setSkillsDir(c?.settings?.skillsDir ?? '');
        setRunMode((c?.settings?.runMode as 'manual' | 'auto') ?? 'manual');
        setRunFrequencyCount(String(c?.settings?.runFrequencyCount ?? 1));
        setRunFrequencyPeriod((c?.settings?.runFrequencyPeriod as 'hour' | 'day' | 'week' | 'month') ?? 'day');
        setRunTaskMessage(c?.settings?.runTaskMessage ?? '');
        setModules(c?.modules?.length ? c.modules : [...DEFAULT_MODULES]);
        setModulePaths(c?.modulePaths ?? []);
      })
      .catch(() => setConfig({}));
  }, []);

  const updateModule = (i: number, patch: Partial<ModuleEntry>) => {
    setModules((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  };
  const updateModulePath = (i: number, patch: Partial<ModulePathEntry>) => {
    setModulePaths((prev) => prev.map((mp, j) => (j === i ? { ...mp, ...patch } : mp)));
  };
  const addModule = () => setModules((prev) => [...prev, { id: '', name: '', description: '', enabled: true }]);
  const removeModule = (i: number) => setModules((prev) => prev.filter((_, j) => j !== i));
  const addModulePath = () => setModulePaths((prev) => [...prev, { id: '', path: '' }]);
  const removeModulePath = (i: number) => setModulePaths((prev) => prev.filter((_, j) => j !== i));

  const saveSettingsAndModules = useCallback(async () => {
    setConfigMessage(null);
    const gwUrl = gatewayUrl.trim();
    if (gwUrl) {
      try {
        new URL(gwUrl);
      } catch {
        setConfigMessage('Invalid Gateway URL. Use e.g. http://127.0.0.1:18790');
        return;
      }
    }
    const freq = Math.max(1, parseInt(runFrequencyCount, 10) || 1);
    if (runFrequencyCount.trim() && (parseInt(runFrequencyCount, 10) < 1 || Number.isNaN(parseInt(runFrequencyCount, 10)))) {
      setConfigMessage('Runs per period must be at least 1.');
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
          runFrequencyCount: freq,
          runFrequencyPeriod,
          runTaskMessage: runTaskMessage.trim() || undefined,
        },
        modules: modules.filter((m) => m.id.trim()),
        modulePaths: modulePaths.filter((mp) => mp.id?.trim()),
      };
      await invoke('write_config', { json: JSON.stringify(next, null, 2) });
      setConfig(next);
      if (next.settings?.gatewayUrl) setGatewayBaseUrl(next.settings.gatewayUrl);
      setConfigMessage('Settings saved to ~/.clerq/config.json');
    } catch (e) {
      setConfigMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [config, gatewayUrl, defaultModule, skillsDir, runMode, runFrequencyCount, runFrequencyPeriod, runTaskMessage, modules, modulePaths]);

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
    try {
      await gateway.task(runTaskMessage.trim() || 'Check for pending tasks');
    } catch (_) { /* ignore */ }
  }, [runTaskMessage]);

  return (
    <div className="app app--settings-window">
      <div className="view-header">
        <h1 className="view-title">Settings</h1>
      </div>
      <div className="settings-window-content">
        <section className="section dev-section">
          <h2>Connection & config</h2>
          <p className="section-desc">Saved to ~/.clerq/config.json. Gateway URL is used for all API calls.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.9rem' }}>
              Gateway URL
              <input type="url" value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} placeholder="http://127.0.0.1:18790" style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }} />
            </label>
            <label style={{ fontSize: '0.9rem' }}>
              Default mode (optional)
              <select value={defaultModule} onChange={(e) => setDefaultModule(e.target.value)} style={{ marginLeft: 8, marginTop: 4 }}>
                <option value="">—</option>
                {modules.filter((m) => m.enabled !== false).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: '0.9rem' }}>
              Skills directory (optional)
              <input type="text" value={skillsDir} onChange={(e) => setSkillsDir(e.target.value)} placeholder="/path/to/skills or leave default" style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }} />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Restart gateway after changing.</span>
            </label>
            <div className="row">
              <button type="button" className="btn" onClick={saveSettingsAndModules}>Save settings</button>
            </div>
          </div>
          {configMessage !== null && <ResultBox error={!configMessage.includes('saved')}>{configMessage}</ResultBox>}
        </section>

        <section className="section dev-section">
          <h2>Module paths</h2>
          <p className="section-desc">Paths to pluggable modules (local dirs with manifest.json).</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {modulePaths.map((mp, i) => (
              <div key={i} className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <input placeholder="id" value={mp.id} onChange={(e) => updateModulePath(i, { id: e.target.value })} style={{ width: 120 }} />
                <input placeholder="path" value={mp.path ?? ''} onChange={(e) => updateModulePath(i, { path: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
                <button type="button" className="btn btn-ghost" onClick={() => removeModulePath(i)} title="Remove">✕</button>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={addModulePath}>+ Add module path</button>
              <button type="button" className="btn" onClick={saveSettingsAndModules}>Save</button>
            </div>
          </div>
        </section>

        <section className="section dev-section">
          <h2>Modes</h2>
          <p className="section-desc">Add, edit, or remove modes.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {modules.map((m, i) => (
              <div key={i} className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <input placeholder="id" value={m.id} onChange={(e) => updateModule(i, { id: e.target.value })} style={{ width: 120 }} />
                <input placeholder="Name" value={m.name} onChange={(e) => updateModule(i, { name: e.target.value })} style={{ width: 140 }} />
                <input placeholder="Description" value={m.description} onChange={(e) => updateModule(i, { description: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={m.enabled !== false} onChange={(e) => updateModule(i, { enabled: e.target.checked })} />
                  enabled
                </label>
                <button type="button" className="btn btn-ghost" onClick={() => removeModule(i)} title="Remove">✕</button>
              </div>
            ))}
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={addModule}>+ Add mode</button>
              <button type="button" className="btn" onClick={saveSettingsAndModules}>Save modes</button>
            </div>
          </div>
        </section>

        <section className="section dev-section">
          <h2>Secrets vault</h2>
          <p className="section-desc">
            Encrypted storage for API keys and tokens. Set CLERQ_VAULT_KEY (32-byte hex) in gateway environment to enable. Values are never exposed.
          </p>
          <SecretsVaultSection />
        </section>

        <section className="section dev-section">
          <h2>API key</h2>
          <p className="section-desc">Saves to ~/.clerq/.env. Required for Explain and Task. Restart gateway after saving.</p>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-..." style={{ flex: 1, minWidth: 200 }} />
            <button type="button" className="btn" onClick={saveApiKey}>Save</button>
          </div>
          {apiKeyMessage !== null && <ResultBox error={apiKeyMessage.startsWith('Could')}>{apiKeyMessage}</ResultBox>}
        </section>

        <section className="section dev-section">
          <h2>Persistent run</h2>
          <p className="section-desc">Manual or automatic runs.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.9rem' }}>
              Mode
              <select value={runMode} onChange={(e) => setRunMode(e.target.value as 'manual' | 'auto')} style={{ marginLeft: 8 }}>
                <option value="manual">Manual</option>
                <option value="auto">Automatic</option>
              </select>
            </label>
            {runMode === 'auto' && (
              <>
                <label style={{ fontSize: '0.9rem' }}>
                  Runs per period
                  <input type="number" min={1} value={runFrequencyCount} onChange={(e) => setRunFrequencyCount(e.target.value)} style={{ width: 60, marginLeft: 8 }} />
                  <select value={runFrequencyPeriod} onChange={(e) => setRunFrequencyPeriod(e.target.value as 'hour' | 'day' | 'week' | 'month')} style={{ marginLeft: 8 }}>
                    <option value="hour">hour</option>
                    <option value="day">day</option>
                    <option value="week">week</option>
                    <option value="month">month</option>
                  </select>
                </label>
                <label style={{ fontSize: '0.9rem' }}>
                  Task message
                  <input type="text" value={runTaskMessage} onChange={(e) => setRunTaskMessage(e.target.value)} placeholder="e.g. Check for pending tasks" style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }} />
                </label>
              </>
            )}
            <div className="row">
              <button type="button" className="btn" onClick={runScheduledTask}>Run now</button>
            </div>
          </div>
        </section>

        <section className="section dev-section">
          <h2>System prompt</h2>
          <SystemPromptSection />
        </section>

        <section className="section dev-section">
          <h2>Reasoning</h2>
          <ReasoningSection />
        </section>

        <section className="section dev-section">
          <h2>Capabilities</h2>
          <CapabilitiesSection />
        </section>

        <section className="section dev-section">
          <h2>Triggers</h2>
          <TriggersSection />
        </section>
      </div>
    </div>
  );
}
