/**
 * Chat console — a first-party module over the same slot contract third-party
 * modules use, not a special case wired into the app shell. Disable it and the
 * gateway, scheduler and automations carry on unchanged.
 *
 * Three panels over one transport:
 *   Raw      the conversation goes to the provider as-is, and the exact request
 *            body is inspectable. Nothing of ours is added.
 *   Managed  the full pipeline: system prompt, skill routing, the lot.
 *   Compare  one message to several models, side by side with cost and latency.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  gateway,
  type ChatMessage,
  type ChatSession,
  type ComparisonColumn,
  type PipelineMode,
  type ProviderInfo,
} from '@clerq/gateway-client';

type Panel = 'chat' | 'compare';

function money(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return 'cost unknown';
  return `$${cost.toFixed(cost < 0.01 ? 5 : 2)}`;
}

/** The one-line summary under an assistant turn. */
function MetaLine({ meta }: { meta: ChatMessage['meta'] }) {
  // A comparison's numbers belong to its columns, not to the turn as a whole.
  if (!meta || meta.columns) return null;
  const parts: string[] = [];
  if (meta.provider && meta.model) parts.push(`${meta.provider}/${meta.model}`);
  else if (meta.model) parts.push(String(meta.model));
  if (typeof meta.tokensIn === 'number') parts.push(`${meta.tokensIn} in / ${meta.tokensOut} out`);
  if (meta.mode !== 'managed') parts.push(money(meta.costUsd));
  if (typeof meta.latencyMs === 'number') parts.push(`${meta.latencyMs} ms`);
  if (!parts.length) return null;
  return <div className="chat-meta">{parts.join(' · ')}</div>;
}

function RequestInspector({ request }: { request: unknown }) {
  const [open, setOpen] = useState(false);
  if (!request) return null;
  return (
    <div className="chat-inspect">
      <button type="button" className="btn btn-small" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide request' : 'Show request'}
      </button>
      {open && <pre className="chat-json">{JSON.stringify(request, null, 2)}</pre>}
    </div>
  );
}

function Columns({
  columns,
  chosen,
  onPromote,
}: {
  columns: ComparisonColumn[];
  chosen?: number | null;
  onPromote?: (index: number) => void;
}) {
  return (
    <div className="chat-columns">
      {columns.map((c, i) => (
        <div key={`${c.model}-${i}`} className={`chat-column${chosen === i ? ' is-chosen' : ''}`}>
          <div className="chat-column-head">
            <strong>{c.model}</strong>
            {chosen === i && <span className="chat-chosen">in transcript</span>}
          </div>
          {c.error ? (
            <p className="chat-error">{c.error}</p>
          ) : (
            <p className="chat-column-body">{c.text}</p>
          )}
          <div className="chat-meta">
            {[
              typeof c.tokensIn === 'number' ? `${c.tokensIn} in / ${c.tokensOut} out` : null,
              c.error ? null : money(c.costUsd),
              typeof c.latencyMs === 'number' ? `${c.latencyMs} ms` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {onPromote && !c.error && chosen !== i && (
            <button type="button" className="btn btn-small" onClick={() => onPromote(i)}>
              Use this answer
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function ChatConsole({
  moduleDisplayName,
  onBack,
  onAbout,
  themeToggle,
}: {
  moduleDisplayName: string;
  onBack: () => void;
  onAbout: () => void;
  themeToggle: React.ReactNode;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [current, setCurrent] = useState<(ChatSession & { messages: ChatMessage[] }) | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [panel, setPanel] = useState<Panel>('chat');
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  /** The answer being streamed, so Stop can end it — and its spending. */
  const inFlight = useRef<AbortController | null>(null);

  const refreshSessions = useCallback(async () => {
    const { sessions: list } = await gateway.sessions();
    setSessions(list);
    return list;
  }, []);

  const openSession = useCallback(async (id: string) => {
    setError(null);
    setCurrent(await gateway.session(id));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [list, registry] = await Promise.all([refreshSessions(), gateway.providers()]);
        setProviders(registry.providers);
        if (list.length) await openSession(list[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshSessions, openSession]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [current?.messages.length, streaming]);

  const modelOptions = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({ ref: m.ref, label: `${p.label} · ${m.id}`, ready: p.ready }))
      ),
    [providers]
  );

  const newSession = useCallback(
    async (mode: PipelineMode) => {
      try {
        const session = await gateway.createSession({ mode });
        await refreshSessions();
        await openSession(session.id);
        setPanel('chat');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refreshSessions, openSession]
  );

  const setMode = useCallback(
    async (mode: PipelineMode) => {
      if (!current) return;
      await gateway.updateSession(current.id, { mode });
      await openSession(current.id);
      await refreshSessions();
    },
    [current, openSession, refreshSessions]
  );

  const send = useCallback(async () => {
    if (!current || !draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStreaming('');
    const text = draft;
    setDraft('');
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      await gateway.sendMessage(
        current.id,
        { text, model: model || undefined },
        // Managed mode answers in one piece; raw mode arrives token by token.
        (delta) => setStreaming((s) => s + delta),
        controller.signal
      );
      await openSession(current.id);
      await refreshSessions();
    } catch (e) {
      if (controller.signal.aborted) {
        // Stopped on purpose: the gateway recorded the run as cancelled and
        // kept the question, so show the transcript as it now stands.
        await openSession(current.id).catch(() => undefined);
        await refreshSessions().catch(() => undefined);
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setDraft(text);
      }
    } finally {
      inFlight.current = null;
      setStreaming('');
      setBusy(false);
    }
  }, [current, draft, model, busy, openSession, refreshSessions]);

  const stop = useCallback(() => {
    inFlight.current?.abort();
  }, []);

  // Leaving the console mid-answer stops the answer too.
  useEffect(() => () => inFlight.current?.abort(), []);

  const runComparison = useCallback(async () => {
    if (!current || !draft.trim() || compareModels.length < 2) return;
    setBusy(true);
    setError(null);
    const text = draft;
    setDraft('');
    try {
      await gateway.compare(current.id, { text, models: compareModels });
      await openSession(current.id);
      await refreshSessions();
      setPanel('chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDraft(text);
    } finally {
      setBusy(false);
    }
  }, [current, draft, compareModels, openSession, refreshSessions]);

  const promote = useCallback(
    async (messageId: number, index: number) => {
      if (!current) return;
      await gateway.promote(current.id, messageId, index);
      await openSession(current.id);
    },
    [current, openSession]
  );

  const removeSession = useCallback(
    async (id: string) => {
      await gateway.deleteSession(id);
      const list = await refreshSessions();
      if (current?.id === id) {
        if (list.length) await openSession(list[0].id);
        else setCurrent(null);
      }
    },
    [current, refreshSessions, openSession]
  );

  return (
    <div className="app">
      <div className="view-header">
        <button type="button" className="btn btn-small" onClick={onBack}>
          ← Back
        </button>
        <h1 className="view-title">{moduleDisplayName}</h1>
        <div className="view-header-actions">
          {themeToggle}
          <button type="button" className="btn btn-small" onClick={onAbout}>
            About
          </button>
        </div>
      </div>

      {/* Outside the session branch: a failure to create the first conversation
          has no transcript to appear under. */}
      {error && <p className="chat-error">{error}</p>}

      <div className="chat-layout">
        <aside className="chat-sidebar">
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => newSession('raw')}>
              New raw chat
            </button>
            <button type="button" className="btn btn-small" onClick={() => newSession('managed')}>
              New managed chat
            </button>
          </div>
          <ul className="chat-session-list">
            {sessions.map((s) => (
              <li key={s.id} className={s.id === current?.id ? 'is-active' : undefined}>
                <button type="button" className="chat-session" onClick={() => openSession(s.id)}>
                  <span className="chat-session-title">{s.title ?? 'Untitled'}</span>
                  <span className="chat-session-sub">
                    {s.mode} · {s.messageCount} messages
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`Delete ${s.title ?? 'conversation'}`}
                  onClick={() => removeSession(s.id)}
                >
                  ×
                </button>
              </li>
            ))}
            {!sessions.length && <li className="chat-empty">No conversations yet.</li>}
          </ul>
        </aside>

        <section className="chat-main">
          {!current ? (
            <p className="chat-empty">
              Start a conversation to talk to any model you have a key for.
            </p>
          ) : (
            <>
              <div className="chat-toolbar">
                <label>
                  Pipeline
                  <select
                    value={current.mode}
                    onChange={(e) => setMode(e.target.value as PipelineMode)}
                  >
                    <option value="raw">Raw — nothing added</option>
                    <option value="managed">Managed — full pipeline</option>
                  </select>
                </label>
                <label>
                  Model
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">Configured default</option>
                    {modelOptions.map((m) => (
                      <option key={m.ref} value={m.ref} disabled={!m.ready}>
                        {m.label}
                        {m.ready ? '' : ' (no key)'}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => setPanel(panel === 'compare' ? 'chat' : 'compare')}
                >
                  {panel === 'compare' ? 'Back to chat' : 'Compare models'}
                </button>
              </div>

              <div className="chat-transcript">
                {current.messages.map((m) => (
                  <article key={m.id} className={`chat-turn chat-turn--${m.role}`}>
                    {m.meta?.columns ? (
                      <Columns
                        columns={m.meta.columns}
                        chosen={m.meta.chosen}
                        onPromote={(index) => promote(m.id, index)}
                      />
                    ) : (
                      <p className="chat-text">{m.content}</p>
                    )}
                    <MetaLine meta={m.meta} />
                    {m.meta?.request ? <RequestInspector request={m.meta.request} /> : null}
                  </article>
                ))}
                {streaming && (
                  <article className="chat-turn chat-turn--assistant">
                    <p className="chat-text">{streaming}</p>
                  </article>
                )}
                <div ref={transcriptEnd} />
              </div>

              {panel === 'compare' && (
                <div className="chat-compare-picker">
                  <p className="section-desc">
                    Pick two or more models. The same message goes to each; the first answer becomes
                    the turn until you choose another.
                  </p>
                  <div className="chat-compare-models">
                    {modelOptions.map((m) => (
                      <label key={m.ref} className={m.ready ? undefined : 'is-disabled'}>
                        <input
                          type="checkbox"
                          disabled={!m.ready}
                          checked={compareModels.includes(m.ref)}
                          onChange={(e) =>
                            setCompareModels((prev) =>
                              e.target.checked ? [...prev, m.ref] : prev.filter((x) => x !== m.ref)
                            )
                          }
                        />
                        {m.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="chat-composer">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    panel === 'compare' ? 'Message to send to every selected model' : 'Message'
                  }
                  rows={3}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (panel === 'compare') runComparison();
                      else send();
                    }
                  }}
                />
                {busy && panel !== 'compare' ? (
                  <button type="button" className="btn" onClick={stop}>
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={
                      busy || !draft.trim() || (panel === 'compare' && compareModels.length < 2)
                    }
                    onClick={panel === 'compare' ? runComparison : send}
                  >
                    {busy ? 'Working…' : panel === 'compare' ? 'Compare' : 'Send'}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default ChatConsole;
