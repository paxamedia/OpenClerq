import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { setGatewayBaseUrl, gateway, type HealthResponse, type SkillsResponse, type ExplainResponse, type TaskResponse } from './gateway';
import { SettingsWindow } from './SettingsWindow';
import { StatusCard } from './components/StatusCard';
import { CalculatorPanel } from './components/CalculatorPanel';
import { CollapsibleSection } from './components/CollapsibleSection';
import { LogsPanel } from './components/LogsPanel';
import { SkillsSection } from './components/SkillsSection';
import { MemorySection } from './components/MemorySection';
import { loadModules } from './moduleLoader';
import { moduleRegistry } from './moduleRegistry';
import { ModuleHost } from './ModuleHost';

const bundledComponents: Record<string, import('./moduleSlots').ModuleUIComponent> = {};

const GITHUB_URL = 'https://github.com/officeworkersforfree/clerq';
const OPENCLAW_URL = 'https://github.com/openclaw/openclaw';

type View = 'entry' | 'module-select' | 'module' | 'developer';
type Theme = 'auto' | 'light' | 'dark';
type UIMode = 'builder' | 'operator';

const THEME_KEY = 'clerq-theme';
const UI_MODE_KEY = 'clerq-ui-mode';

function getStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'auto';
  const t = localStorage.getItem(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'auto';
}

function getStoredUIMode(): UIMode {
  if (typeof localStorage === 'undefined') return 'builder';
  const m = localStorage.getItem(UI_MODE_KEY);
  return m === 'operator' ? 'operator' : 'builder';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'light') root.dataset.theme = 'light';
  else if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
}

function AboutModal({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'installing' | 'up-to-date' | 'error'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateError(null);
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus('up-to-date');
        return;
      }
      setUpdateStatus('installing');
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpdateStatus('error');
      setUpdateError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!isOpen) return null;
  return (
    <div className="about-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div className="about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <h2 id="about-title">About OpenClerq</h2>
          <button type="button" className="btn btn-ghost about-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="about-body">
          <p><strong>OpenClerq</strong> is your desktop helper — like an administrative worker. It runs on your computer and keeps your data local.</p>
          <h3>Warnings and disclaimer</h3>
          <p><strong>Use at your own risk. No warranty.</strong> This software is provided as-is. The authors are not responsible for any loss or damage arising from its use.</p>
          <h3>Access and permissions</h3>
          <p>To perform local clerical work, this app is allowed to:</p>
          <ul>
            <li><strong>Read and write</strong> your config and optional API key under <code>~/.clerq</code> (config.json, .env).</li>
            <li><strong>Read</strong> paths you choose for modules (e.g. skills directories) and their manifest files.</li>
            <li><strong>Open links</strong> in your browser (e.g. GitHub, docs) when you click them.</li>
            <li>If you configure an <strong>API (cloud)</strong> LLM provider: the gateway (which you run separately) will send requests to that provider; the desktop app only talks to your local gateway.</li>
          </ul>
          <p>Calculations are performed by a local Rust engine on your machine; no calculation data is sent to any server unless you choose a cloud LLM for explanations and tasks.</p>
          <h3>Free and open source</h3>
          <p>You can see the code, use it for free, and build on it. OpenClerq is <em>inspired by</em> <button type="button" className="link-button" onClick={() => openUrl(OPENCLAW_URL)}>OpenClaw</button> (same ideas: gateway, skills, local-first) — our implementation is original. <button type="button" className="link-button" onClick={() => openUrl(GITHUB_URL)}>OpenClerq on GitHub</button>.</p>
          <h3>This version</h3>
          <p>You're using the <strong>open-source OpenClerq desktop app</strong>. Configure your own API keys, tools, and modules locally. Any commercial modules you purchase live separately and are not bundled with this app.</p>
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <button type="button" className="btn" onClick={handleCheckUpdate} disabled={updateStatus === 'checking' || updateStatus === 'installing'}>
              {updateStatus === 'idle' && 'Check for updates'}
              {updateStatus === 'checking' && 'Checking…'}
              {updateStatus === 'installing' && 'Installing…'}
              {updateStatus === 'up-to-date' && 'Up to date'}
              {updateStatus === 'error' && 'Check for updates'}
            </button>
            {updateStatus === 'up-to-date' && <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>You have the latest version.</span>}
            {updateStatus === 'error' && updateError && <span style={{ fontSize: '0.85rem', color: 'var(--error)' }}>{updateError}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppFooter({ onAbout, style }: { onAbout?: () => void; style?: React.CSSProperties }) {
  return (
    <footer className="footer" style={style}>
      <span>OpenClerq</span>
      {onAbout && (
        <>
          <span className="footer-sep">·</span>
          <button type="button" className="btn btn-ghost footer-link" onClick={onAbout}>About</button>
        </>
      )}
    </footer>
  );
}

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const cycle = () => {
    const next: Theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
    setTheme(next);
  };
  const label = theme === 'auto' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark';
  return (
    <button type="button" className="theme-toggle" onClick={cycle} title={label} aria-label={label}>
      <span>{theme === 'auto' ? '◐' : theme === 'light' ? '☀' : '◇'}</span>
      <span>{theme === 'auto' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}</span>
    </button>
  );
}

import type { AppConfig, ModuleEntry, ModulePathEntry } from './configTypes';
export type { AppConfig, ModuleEntry, ModulePathEntry };

const DEFAULT_MODULES: ModuleEntry[] = [
  { id: 'local', name: 'Local', description: 'Add your own — configure below', enabled: true },
];

export async function openSettingsWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel('settings');
  if (existing) {
    await existing.setFocus();
    return;
  }
  const base = window.location.href.split('#')[0];
  const url = `${base}#settings`;
  new WebviewWindow('settings', {
    url,
    title: 'OpenClerq Settings',
    width: 640,
    height: 800,
    minWidth: 520,
    minHeight: 400,
  });
}

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <pre className={`result-box ${error ? 'error' : ''}`}>
      {children}
    </pre>
  );
}

function AskResultDisplay({ result }: { result: ExplainResponse | TaskResponse | string }) {
  if (typeof result === 'string') {
    return <ResultBox error>{result}</ResultBox>;
  }
  const { explanation, model, disclaimer } = result;
  const taskResult = result as TaskResponse;
  const hasError = taskResult.error != null;
  const taskTrace = (result as unknown as { trace?: { step: string; detail?: string; duration_ms?: number }[] }).trace;
  const hasExtra = 'intent' in result && (taskResult.skillSlug ?? taskResult.error ?? taskTrace?.length);
  return (
    <div className="ask-result">
      {hasError && (
        <div className="ask-result__error">
          <ResultBox error>{taskResult.error}</ResultBox>
        </div>
      )}
      <div className="ask-result__content">
        <pre className={`result-box ${hasError ? 'result-box--muted' : ''}`}>{explanation}</pre>
      </div>
      {(model || disclaimer) && (
        <div className="ask-result__meta">
          {model && <span>Model: {model}</span>}
          {disclaimer && <span>{disclaimer}</span>}
        </div>
      )}
      {(hasExtra || taskTrace?.length) && (
        <details className="ask-result__details">
          <summary>Trace & details</summary>
          {taskTrace?.length ? (
            <div style={{ marginTop: 4 }}>
              {taskTrace.map((s, i) => (
                <div key={i} style={{ fontSize: '0.85rem', marginBottom: 2 }}>
                  <strong>{s.step}</strong>
                  {s.detail && ` — ${s.detail}`}
                  {s.duration_ms != null && ` (${s.duration_ms}ms)`}
                </div>
              ))}
            </div>
          ) : null}
          <pre className="result-box" style={{ marginTop: 4, fontSize: '0.8rem' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function HelpModal({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  if (!isOpen) return null;
  return (
    <div className="about-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div className="about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <h2 id="help-title">Keyboard shortcuts</h2>
          <button type="button" className="btn btn-ghost about-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="about-body">
          <dl style={{ margin: 0 }}>
            <dt><strong>Ask</strong></dt>
            <dd><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline</dd>
            <dt><strong>Tools</strong></dt>
            <dd><kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or <kbd>⌘</kbd>+<kbd>Enter</kbd> on Mac) run tool</dd>
          </dl>
          <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Tip: Use Preview context before sending to see what will be sent to the LLM. Use Dry run (Task mode) to test without API calls.
          </p>
        </div>
      </div>
    </div>
  );
}

function EntryScreen({ onDeveloper, onAbout, themeToggle }: { onDeveloper: () => void; onAbout: () => void; themeToggle: React.ReactNode }) {
  return (
    <div className="entry-screen" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: '1rem', right: '1rem' }}>{themeToggle}</div>
      <h1 className="entry-logo">OpenClerq</h1>
      <p className="entry-tagline">Open-source persistent agentic software</p>
      <div className="entry-choices">
        <button type="button" className="entry-card" onClick={onDeveloper}>
          <h2>OpenClerq</h2>
          <p>Configure API keys, gateway, tools, and skills. Run and test locally.</p>
        </button>
      </div>
      <AppFooter onAbout={onAbout} style={{ marginTop: '3rem' }} />
    </div>
  );
}

function ModuleSelectScreen({
  modules,
  onSelect,
  onBack,
  onAbout,
  themeToggle,
}: {
  modules: ModuleEntry[];
  onSelect: (id: string) => void;
  onBack: () => void;
  onAbout: () => void;
  themeToggle: React.ReactNode;
}) {
  const list = modules.filter((m) => m.enabled !== false);
  return (
    <div className="app">
      <div className="view-header">
        <h1 className="view-title">Choose mode</h1>
        <div className="view-nav">
          {themeToggle}
          <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
        </div>
      </div>
      <p className="section-desc">Select a mode you have configured.</p>
      <div className="module-grid">
        {list.map((m) => (
          <button key={m.id} type="button" className="module-card" onClick={() => onSelect(m.id)}>
            <h3>{m.name}</h3>
            <p>{m.description}</p>
          </button>
        ))}
      </div>
      <AppFooter onAbout={onAbout} />
    </div>
  );
}

function DeveloperView({
  config,
  onSaveConfig: _onSaveConfig,
  onReloadModules: _onReloadModules,
  onBack,
  onAbout,
  onOpenSettings,
  themeToggle,
}: {
  config: AppConfig | null;
  onSaveConfig: (c: AppConfig) => void;
  onReloadModules: (paths: ModulePathEntry[] | undefined) => Promise<void>;
  onBack: () => void;
  onAbout: () => void;
  onOpenSettings: () => void;
  themeToggle: React.ReactNode;
}) {
  const [uiMode, setUiMode] = useState<UIMode>(getStoredUIMode);
  const [gatewayStatus, setGatewayStatus] = useState<HealthResponse | string | null>(null);
  const [metrics, setMetrics] = useState<{
    uptime_seconds: number;
    version?: string;
    service?: string;
    llm_calls_total?: number;
    llm_calls_failed?: number;
    llm_failure_rate?: number;
    llm_avg_latency_ms?: number | null;
    llm_input_tokens_total?: number;
    llm_output_tokens_total?: number;
  } | null>(null);
  const [availableModels, setAvailableModels] = useState<{ models: string[]; current: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillsResponse | string | null>(null);
  const [askInput, setAskInput] = useState('');
  const [askContext, setAskContext] = useState('');
  const [askResult, setAskResult] = useState<ExplainResponse | TaskResponse | string | null>(null);
  const [askLoading, setAskLoading] = useState(false);
  const [askMode, setAskMode] = useState<'explain' | 'task'>('task');
  const [askDryRun, setAskDryRun] = useState(false);
  const [askContextPreview, setAskContextPreview] = useState<{ systemPrompt: string; userContent: string; estimatedInputTokens?: number } | null>(null);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const [toolsList, setToolsList] = useState<Array<{ name: string; description: string }> | string | null>(null);
  const [toolName, setToolName] = useState('');
  const [toolInput, setToolInput] = useState('{"relativePath": "README.md"}');
  const [toolResult, setToolResult] = useState<string | null>(null);
  const runToolButtonRef = useRef<HTMLButtonElement>(null);


  const [gatewayUrl, setGatewayUrl] = useState(config?.settings?.gatewayUrl ?? '');
  const [_skillsDir, setSkillsDir] = useState(config?.settings?.skillsDir ?? '');
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'connected' | 'unreachable'>('unknown');
  const [runMode, setRunMode] = useState<'manual' | 'auto'>(config?.settings?.runMode ?? 'manual');
  const [runFrequencyCount, setRunFrequencyCount] = useState(String(config?.settings?.runFrequencyCount ?? 1));
  const [runFrequencyPeriod, setRunFrequencyPeriod] = useState<'hour' | 'day' | 'week' | 'month'>(config?.settings?.runFrequencyPeriod ?? 'day');
  const [runTaskMessage, setRunTaskMessage] = useState(config?.settings?.runTaskMessage ?? '');
  const [_lastRunAt, setLastRunAt] = useState<number | null>(null);

  useEffect(() => {
    setGatewayUrl(config?.settings?.gatewayUrl ?? '');
    setSkillsDir(config?.settings?.skillsDir ?? '');
    setRunMode((config?.settings?.runMode as 'manual' | 'auto') ?? 'manual');
    setRunFrequencyCount(String(config?.settings?.runFrequencyCount ?? 1));
    setRunFrequencyPeriod((config?.settings?.runFrequencyPeriod as 'hour' | 'day' | 'week' | 'month') ?? 'day');
    setRunTaskMessage(config?.settings?.runTaskMessage ?? '');
  }, [config]);

  const checkConnection = useCallback(async () => {
    setConnectionStatus('unknown');
    setGatewayStatus(null);
    try {
      const h = await gateway.health();
      setConnectionStatus('connected');
      setGatewayStatus(h);
    } catch {
      setConnectionStatus('unreachable');
    }
  }, []);
  useEffect(() => {
    if (gatewayUrl.trim()) checkConnection();
    else setConnectionStatus('unknown');
  }, [gatewayUrl.trim(), checkConnection]);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const fetchMetrics = async () => {
      try {
        const m = await gateway.metrics();
        setMetrics(m);
      } catch {
        setMetrics(null);
      }
    };
    fetchMetrics();
    const id = setInterval(fetchMetrics, 10000);
    return () => clearInterval(id);
  }, [connectionStatus]);

  const fetchModels = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      const m = await gateway.models();
      setAvailableModels(m);
      setSelectedModel(null);
    } catch {
      setAvailableModels(null);
    }
  }, [connectionStatus]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const runScheduledTask = useCallback(async () => {
    const msg = runTaskMessage.trim() || 'Check for pending tasks';
    try {
      await gateway.task(msg);
      setLastRunAt(Date.now());
    } catch (_) { /* ignore */ }
  }, [runTaskMessage]);

  useEffect(() => {
    if (runMode !== 'auto' || !runTaskMessage.trim()) return;
    const count = Math.max(1, parseInt(runFrequencyCount, 10) || 1);
    const periodMs: Record<string, number> = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
    const ms = (periodMs[runFrequencyPeriod] ?? 86400000) / count;
    const id = setInterval(runScheduledTask, ms);
    return () => clearInterval(id);
  }, [runMode, runTaskMessage, runFrequencyCount, runFrequencyPeriod, runScheduledTask]);

  const checkHealth = async () => {
    setGatewayStatus(null);
    try {
      const h = await gateway.health();
      setGatewayStatus(h);
    } catch (e) {
      setGatewayStatus(String(e));
    }
  };

  const loadSkills = async () => {
    setSkills(null);
    try {
      const s = await gateway.skills();
      setSkills(s);
    } catch (e) {
      setSkills(String(e));
    }
  };

  const runAsk = async () => {
    const msg = askInput.trim();
    if (!msg) {
      setAskResult('Enter a message.');
      return;
    }
    setAskResult(null);
    setAskInput('');
    setAskLoading(true);
    try {
      let reply: string;
      const modelOverride =
        availableModels && availableModels.models.length > 1 && selectedModel && selectedModel !== availableModels.current
          ? selectedModel
          : undefined;
      if (askMode === 'explain') {
        let context: Record<string, unknown> | undefined;
        if (askContext.trim()) {
          try {
            context = JSON.parse(askContext.trim()) as Record<string, unknown>;
          } catch {
            setAskResult('Invalid context JSON. Use e.g. {"document": "..."}');
            setAskLoading(false);
            return;
          }
        }
        const r = await gateway.explain(msg, context, modelOverride);
        setAskResult(r);
        reply = r.explanation;
      } else {
        const r = await gateway.task(msg, modelOverride, askDryRun);
        setAskResult(r);
        reply = r.explanation ?? JSON.stringify(r);
      }
      setChatMessages((prev) => [...prev, { role: 'user' as const, content: msg }, { role: 'assistant' as const, content: reply }]);
    } catch (e) {
      const errMsg = String(e);
      setAskResult(errMsg);
      setChatMessages((prev) => [...prev, { role: 'user' as const, content: msg }, { role: 'assistant' as const, content: errMsg }]);
    } finally {
      setAskLoading(false);
    }
  };

  const handleModeChange = (m: UIMode) => {
    setUiMode(m);
    if (typeof localStorage !== 'undefined') localStorage.setItem(UI_MODE_KEY, m);
  };

  const healthResponse = gatewayStatus !== null && typeof gatewayStatus !== 'string' ? gatewayStatus : null;
  const showBuilderTools = uiMode === 'builder';
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="app app--developer">
      <div className="view-header">
        <div>
          <h1 className="view-title">OpenClerq</h1>
          <p className="view-tagline">Control tower for autonomous desktop agents</p>
        </div>
        <div className="view-nav">
          <button type="button" className="btn btn-ghost" onClick={onBack} style={{ fontSize: '0.85rem' }}>
            Change mode
          </button>
          <div className="mode-toggle" role="group" aria-label="UI mode">
            <button
              type="button"
              className={`mode-toggle__btn ${uiMode === 'builder' ? 'mode-toggle--active' : ''}`}
              onClick={() => handleModeChange('builder')}
            >
              Builder
            </button>
            <button
              type="button"
              className={`mode-toggle__btn ${uiMode === 'operator' ? 'mode-toggle--active' : ''}`}
              onClick={() => handleModeChange('operator')}
            >
              Operator
            </button>
          </div>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{gateway.getUrl()}</span>
          {themeToggle}
          <button type="button" className="btn btn-ghost" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts">Help</button>
          <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>Settings</button>
          <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
        </div>
      </div>

      <div className="dev-panels">
      <div className="dev-panel">
        <h2 className="dev-panel-title">Agent core</h2>
      <section className="section dev-section">
        <h2>Gateway</h2>
        <StatusCard
          status={connectionStatus}
          provider={healthResponse?.llm?.provider}
          model={healthResponse?.llm?.model}
          version={metrics?.version}
          uptime={metrics?.uptime_seconds}
          onRetry={checkConnection}
        />
        {showBuilderTools && (
          <>
            <button type="button" className="btn btn-ghost" style={{ marginTop: '0.75rem' }} onClick={checkHealth}>Check health (details)</button>
            {gatewayStatus !== null && (
              <div style={{ marginTop: '0.5rem' }}>
              <ResultBox error={typeof gatewayStatus === 'string'}>
                {typeof gatewayStatus === 'string'
                  ? gatewayStatus
                  : (() => {
                      const h = gatewayStatus as HealthResponse;
                      const llmLine = h.llm
                        ? `LLM: ${h.llm.mode === 'api' ? 'API (cloud)' : 'Local'} — ${h.llm.provider}, ${h.llm.model}\n\n`
                        : '';
                      return llmLine + JSON.stringify(gatewayStatus, null, 2);
                    })()}
              </ResultBox>
              </div>
            )}
          </>
        )}
      </section>

      {showBuilderTools && (
      <CalculatorPanel />
      )}

      {showBuilderTools && (
      <CollapsibleSection title="Tools (core)" defaultOpen={true} badge={toolsList && typeof toolsList !== 'string' ? toolsList.length : undefined}>
        <p className="section-desc">
          Built-in generic tools. Test capabilities like filesystem reads before wiring into modules or skills.
        </p>
        <div className="row" style={{ marginBottom: '0.75rem', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                setToolsList(null);
                const data = await gateway.tools();
                setToolsList(data.tools);
              } catch (e) {
                setToolsList(String(e));
              }
            }}
          >
            Load tools
          </button>
        </div>
        {!toolsList ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Click Load tools to list available tools.</p>
        ) : typeof toolsList === 'string' ? (
          <ResultBox error>{toolsList}</ResultBox>
        ) : (
          <ul style={{ paddingLeft: '1.25rem', marginBottom: '0.75rem' }}>
            {toolsList.map((t) => (
              <li key={t.name}>
                <strong>{t.name}</strong> — {t.description}
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.9rem' }}>Presets:</span>
            <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem' }} onClick={() => { setToolName('fs.read'); setToolInput('{"relativePath": "README.md"}'); }}>
              fs.read README
            </button>
            <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem' }} onClick={() => { setToolName('fs.read'); setToolInput('{"relativePath": "package.json"}'); }}>
              fs.read package.json
            </button>
          </div>
          <label style={{ fontSize: '0.9rem' }}>
            Tool name
            <input
              type="text"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="fs.read or http.request"
              style={{ display: 'block', width: '100%', maxWidth: 260, marginTop: 4 }}
            />
          </label>
          <label style={{ fontSize: '0.9rem' }}>
            Input (JSON)
            <textarea
              value={toolInput}
              onChange={(e) => setToolInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  runToolButtonRef.current?.click();
                }
              }}
              rows={3}
              style={{ width: '100%', fontFamily: 'monospace', marginTop: 4 }}
              title="Ctrl+Enter to run"
            />
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
              <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run
            </p>
          </label>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              ref={runToolButtonRef}
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  setToolResult(null);
                  if (!toolName.trim()) {
                    setToolResult('Tool name is required.');
                    return;
                  }
                  let input: unknown;
                  try {
                    input = toolInput.trim() ? JSON.parse(toolInput) : {};
                  } catch {
                    setToolResult('Invalid JSON in input field.');
                    return;
                  }
                  const out = await gateway.runTool(toolName.trim(), input);
                  setToolResult(JSON.stringify(out.result, null, 2));
                } catch (e) {
                  setToolResult(String(e));
                }
              }}
            >
              Run tool
            </button>
          </div>
          {toolResult !== null && (
            <ResultBox error={toolResult.startsWith('Gateway') || toolResult.startsWith('Error')}>
              {toolResult}
            </ResultBox>
          )}
        </div>
      </CollapsibleSection>
      )}

      <CollapsibleSection
        title="Skills"
        defaultOpen={true}
        badge={skills && typeof skills !== 'string' ? skills.skills.length : undefined}
      >
        <SkillsSection
          skills={skills}
          onLoad={loadSkills}
          connectionOk={connectionStatus === 'connected'}
        />
      </CollapsibleSection>
      <CollapsibleSection title="Memory (file-backed)" defaultOpen={false}>
        <MemorySection connectionOk={connectionStatus === 'connected'} />
      </CollapsibleSection>
      </div>

      <div className="dev-panel">
        <h2 className="dev-panel-title">Run & observe</h2>
      <section className="section dev-section">
        <h2>Ask</h2>
        <p className="section-desc">Send a question or task. The agent provides guidance.</p>
        <div className="row" style={{ gap: '0.75rem', marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
            <input type="radio" checked={askMode === 'task'} onChange={() => setAskMode('task')} />
            Task
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
            <input type="radio" checked={askMode === 'explain'} onChange={() => setAskMode('explain')} />
            Explain
          </label>
          {askMode === 'task' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }} title="Parse intent only, no LLM call">
              <input type="checkbox" checked={askDryRun} onChange={(e) => setAskDryRun(e.target.checked)} />
              Dry run
            </label>
          )}
          {connectionStatus === 'connected' && !availableModels && (
            <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem' }} onClick={fetchModels} title="Retry fetching models">
              Retry models
            </button>
          )}
          {availableModels && availableModels.models.length > 1 && (
            <label style={{ fontSize: '0.9rem' }}>
              Model
              <select
                value={selectedModel ?? availableModels.current}
                onChange={(e) => setSelectedModel(e.target.value || null)}
                style={{ marginLeft: 6 }}
              >
                {availableModels.models.map((m) => (
                  <option key={m} value={m}>
                    {m === availableModels.current ? `${m} (current)` : m}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {askMode === 'explain' && (
          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
              Context (optional JSON — provides extra data for the explanation)
              <textarea
                value={askContext}
                onChange={(e) => setAskContext(e.target.value)}
                placeholder='{"document": "text to explain", "summary": "prior summary"}'
                rows={2}
                style={{ display: 'block', width: '100%', fontFamily: 'monospace', marginTop: 4 }}
              />
            </label>
          </div>
        )}
        <div className="chat-thread" style={{ maxHeight: 320, overflowY: 'auto', marginBottom: '0.75rem', padding: '0.5rem', background: 'var(--surface)', borderRadius: 8 }}>
          {chatMessages.length === 0 && !askLoading ? (
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Ask a question or describe a task.</p>
          ) : (
            <>
              {chatMessages.map((m, i) => (
                <div key={i} className={`chat-message ${m.role}`} style={{ marginBottom: '0.5rem' }}>
                  <strong style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{m.role === 'user' ? 'You' : 'Assistant'}:</strong>
                  <pre style={{ margin: '0.25rem 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.9rem' }}>{m.content}</pre>
                </div>
              ))}
              {askLoading && (
                <div className="chat-message assistant" style={{ marginBottom: '0.5rem' }}>
                  <strong style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Assistant:</strong>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Thinking…</p>
                </div>
              )}
            </>
          )}
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <textarea
              value={askInput}
              onChange={(e) => setAskInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (e.shiftKey) return;
                  e.preventDefault();
                  runAsk();
                }
              }}
              placeholder="Enter your question or task…"
              rows={2}
              style={{ width: '100%' }}
              disabled={askLoading}
              title="Enter to send · Shift+Enter for newline"
              aria-describedby="ask-shortcuts-hint"
            />
            <p id="ask-shortcuts-hint" className="ask-shortcuts-hint" aria-live="polite">
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
            </p>
          </div>
          <div className="row" style={{ gap: '0.5rem', flexShrink: 0, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                const q = askInput.trim() || '(empty)';
                let ctx: Record<string, unknown> | undefined;
                if (askMode === 'explain' && askContext.trim()) {
                  try {
                    ctx = JSON.parse(askContext.trim()) as Record<string, unknown>;
                  } catch {
                    ctx = { raw: askContext };
                  }
                }
                try {
                  const p = await gateway.contextPreview({ question: q, context: ctx });
                  setAskContextPreview(p);
                } catch (e) {
                  setAskContextPreview({ systemPrompt: '', userContent: String(e), estimatedInputTokens: 0 });
                }
              }}
              disabled={askLoading || connectionStatus !== 'connected'}
              title="Show what would be sent to the LLM (no API call)"
            >
              Preview context
            </button>
            {chatMessages.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={async () => {
                    const text = chatMessages
                      .map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`)
                      .join('\n\n');
                    try {
                      await navigator.clipboard.writeText(text);
                      setCopyFeedback(true);
                      setTimeout(() => setCopyFeedback(false), 1500);
                    } catch {
                      const blob = new Blob([text], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `clerq-chat-${new Date().toISOString().slice(0, 10)}.txt`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }
                  }}
                  title="Copy chat to clipboard"
                >
                  {copyFeedback ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    const text = chatMessages
                      .map((m) => `[${m.role === 'user' ? 'You' : 'Assistant'}]\n${m.content}`)
                      .join('\n\n---\n\n');
                    const blob = new Blob([text], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `clerq-chat-${new Date().toISOString().slice(0, 10)}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  title="Download chat as file"
                >
                  Export
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => { setChatMessages([]); setAskResult(null); }} title="Clear chat">
                  Clear
                </button>
              </>
            )}
            <button type="button" className="btn" onClick={runAsk} disabled={askLoading}>
              {askLoading ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
        {askContextPreview && (
          <CollapsibleSection title="Context window preview" defaultOpen={true}>
            <p className="section-desc" style={{ marginBottom: '0.5rem' }}>
              {askContextPreview.estimatedInputTokens != null && (
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>~{askContextPreview.estimatedInputTokens} input tokens · </span>
              )}
              What would be sent to the LLM.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <strong style={{ fontSize: '0.85rem' }}>System prompt</strong>
                <pre style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', maxHeight: 120, overflow: 'auto', padding: 8, background: 'var(--surface)', borderRadius: 4 }}>{askContextPreview.systemPrompt}</pre>
              </div>
              <div>
                <strong style={{ fontSize: '0.85rem' }}>User content</strong>
                <pre style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', maxHeight: 120, overflow: 'auto', padding: 8, background: 'var(--surface)', borderRadius: 4 }}>{askContextPreview.userContent}</pre>
              </div>
              <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setAskContextPreview(null)}>
                Close
              </button>
            </div>
          </CollapsibleSection>
        )}
        {askResult !== null && (
          <AskResultDisplay result={askResult} />
        )}
      </section>
        {connectionStatus === 'connected' && <LogsPanel connected={connectionStatus === 'connected'} />}
        {connectionStatus === 'connected' && metrics && (
          <section className="section dev-section observability-section">
            <h2>Observability</h2>
            <p className="section-desc">Gateway runtime metrics.</p>
            <div className="observability-metrics">
              {metrics.version && (
                <span><strong>Version</strong> {metrics.version}</span>
              )}
              <span><strong>Uptime</strong> {(() => {
                const s = metrics.uptime_seconds;
                if (s < 60) return `${s}s`;
                if (s < 3600) return `${Math.floor(s / 60)}m`;
                return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
              })()}</span>
              {typeof metrics.llm_calls_total === 'number' && metrics.llm_calls_total > 0 && (
                <>
                  <span><strong>LLM calls</strong> {metrics.llm_calls_total}</span>
                  {metrics.llm_avg_latency_ms != null && (
                    <span><strong>Avg latency</strong> {metrics.llm_avg_latency_ms}ms</span>
                  )}
                  {(metrics.llm_input_tokens_total ?? 0) + (metrics.llm_output_tokens_total ?? 0) > 0 && (
                    <span><strong>Tokens</strong> in: {metrics.llm_input_tokens_total ?? 0} out: {metrics.llm_output_tokens_total ?? 0}</span>
                  )}
                  {(metrics.llm_failure_rate ?? 0) > 0 && (
                    <span><strong>Failure rate</strong> {(metrics.llm_failure_rate ?? 0) * 100}%</span>
                  )}
                </>
              )}
            </div>
          </section>
        )}
        {showBuilderTools && (
        <section className="section dev-section" style={{ background: 'transparent', border: '1px dashed var(--card-border)', boxShadow: 'none' }}>
          <p className="section-desc" style={{ marginBottom: 0 }}>
            Features: memory layer, triggers, capabilities, secrets vault, observability, builder/operator modes.
            <button type="button" className="link-button" style={{ marginLeft: 4 }} onClick={() => openUrl('https://github.com/officeworkersforfree/clerq/blob/main/docs/CONTROL_TOWER_VISION.md')}>Control tower vision →</button>
          </p>
        </section>
        )}
      </div>
      </div>

      <AppFooter onAbout={onAbout} />
    </div>
  );
}

function ModulePlaceholderView({ moduleDisplayName: _name, onBack, onAbout, themeToggle }: { moduleDisplayName: string; onBack: () => void; onAbout: () => void; themeToggle: React.ReactNode }) {
  return (
    <div className="app">
      <div className="view-header">
        <h1 className="view-title">Mode</h1>
        <div className="view-nav">
          {themeToggle}
          <button type="button" className="btn btn-ghost" onClick={onBack}>Change mode</button>
        </div>
      </div>
      <section className="section">
        <p className="section-desc">This mode is not implemented yet. Use Developer to configure and run tasks.</p>
      </section>
      <AppFooter onAbout={onAbout} />
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>('developer');
  const [selectedModule, setSelectedModule] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [showAbout, setShowAbout] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  }, [theme]);

  const [loadedModuleManifests, setLoadedModuleManifests] = useState<Array<{ id: string; name: string; description?: string }>>([]);

  const reloadModules = useCallback(async (paths: ModulePathEntry[] | undefined) => {
    if (!paths?.length) {
      setLoadedModuleManifests([]);
      moduleRegistry.setModules([]);
      return;
    }
    const { loaded, errors } = await loadModules(paths);
    if (errors.length) console.warn('[Clerq] Module load errors:', errors);
    setLoadedModuleManifests(loaded.map((m) => ({ id: m.id, name: m.name, description: m.description })));
  }, []);

  useEffect(() => {
    invoke<string>('read_config')
      .then(async (raw) => {
        const c: AppConfig = raw ? JSON.parse(raw) : {};
        setConfig(c);
        if (c.settings?.gatewayUrl) setGatewayBaseUrl(c.settings.gatewayUrl);
        await reloadModules(c.modulePaths);
      })
      .catch(() => setConfig({}));
  }, [reloadModules]);

  const themeToggle = <ThemeToggle theme={theme} setTheme={setTheme} />;

  const baseModules = config?.modules?.length ? config.modules : DEFAULT_MODULES;
  const loadedEntries = loadedModuleManifests.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description ?? '',
    enabled: true,
  }));
  const mergedModules = [...baseModules];
  for (const le of loadedEntries) {
    const idx = mergedModules.findIndex((m) => m.id === le.id);
    if (idx >= 0) mergedModules[idx] = { ...mergedModules[idx], ...le };
    else mergedModules.push(le);
  }
  const allModules = mergedModules.length ? mergedModules : DEFAULT_MODULES;
  const modulesForPicker = allModules.filter((m) => m.enabled !== false).length ? allModules.filter((m) => m.enabled !== false) : DEFAULT_MODULES;

  const onAbout = () => setShowAbout(true);

  if (window.location.hash === '#settings') {
    return <SettingsWindow />;
  }

  if (view === 'entry') {
    return (
      <>
        <EntryScreen
          onDeveloper={() => setView('developer')}
          onAbout={onAbout}
          themeToggle={themeToggle}
        />
        <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
      </>
    );
  }

  if (view === 'module-select') {
    const modesWithDeveloper: ModuleEntry[] = [
      { id: 'developer', name: 'Control Tower', description: 'Gateway, tools, skills, Ask — configure and run tasks', enabled: true },
      ...modulesForPicker.filter((m) => m.id !== 'developer'),
    ];
    return (
      <>
        <ModuleSelectScreen
          modules={modesWithDeveloper.length ? modesWithDeveloper : DEFAULT_MODULES}
          onSelect={(id) => {
            if (id === 'developer') {
              setView('developer');
              setSelectedModule(null);
            } else {
              setView('module');
              setSelectedModule(id);
            }
          }}
          onBack={() => setView('developer')}
          onAbout={onAbout}
          themeToggle={themeToggle}
        />
        <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
      </>
    );
  }

  if (view === 'developer') {
    return (
      <>
        <DeveloperView
          config={config}
          onSaveConfig={setConfig}
          onReloadModules={reloadModules}
          onBack={() => setView('module-select')}
          onAbout={onAbout}
          onOpenSettings={openSettingsWindow}
          themeToggle={themeToggle}
        />
        <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
      </>
    );
  }

  if (view === 'module' && selectedModule) {
    const displayName =
      (config?.modules?.length ? config.modules : DEFAULT_MODULES).find((m) => m.id === selectedModule)?.name ??
      moduleRegistry.getModule(selectedModule)?.name ??
      'Module';
    const moduleState = config?.moduleState?.[selectedModule];
    const handleSaveModuleState = async (state: import('./configTypes').ModuleState) => {
      const next: AppConfig = {
        ...config,
        moduleState: { ...config?.moduleState, [selectedModule!]: state },
      };
      try {
        await invoke('write_config', { json: JSON.stringify(next, null, 2) });
        setConfig(next);
      } catch (_) {}
    };
    return (
      <>
        <ModuleHost
          moduleId={selectedModule}
          moduleDisplayName={displayName}
          onBack={() => setView('module-select')}
          onAbout={onAbout}
          themeToggle={themeToggle}
          bundledComponents={bundledComponents}
          FallbackComponent={ModulePlaceholderView}
          config={config}
          moduleState={moduleState}
          onSaveModuleState={handleSaveModuleState}
        />
        <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
      </>
    );
  }

  return (
    <>
      <DeveloperView
        config={config}
        onSaveConfig={setConfig}
        onReloadModules={reloadModules}
        onBack={() => setView('module-select')}
        onAbout={onAbout}
        onOpenSettings={openSettingsWindow}
        themeToggle={themeToggle}
      />
      <AboutModal open={showAbout} onClose={() => setShowAbout(false)} />
    </>
  );
}

export default App;
