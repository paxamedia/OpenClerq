/**
 * Real-time log stream panel. Connects to gateway SSE and displays execution logs.
 * Audit-ready: timestamp, level, message, optional data.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { gateway } from '../gateway';

interface LogEntry {
  id: string;
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
  data?: Record<string, unknown>;
}

export function LogsPanel({ connected }: { connected: boolean }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<LogEntry[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const flushPending = useCallback(() => {
    if (paused || pendingRef.current.length === 0) return;
    setLogs((prev) => {
      const next = [...prev, ...pendingRef.current];
      pendingRef.current = [];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, [paused]);

  useEffect(() => {
    if (!connected) {
      setLogs([]);
      setError(null);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }
    setError(null);
    const url = gateway.logsStreamUrl();
    const es = new EventSource(url);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        if (paused) {
          pendingRef.current.push(entry);
        } else {
          setLogs((prev) => {
            const next = [...prev, entry];
            return next.length > 500 ? next.slice(-500) : next;
          });
        }
      } catch (_) {}
    };
    es.onerror = () => {
      setError('Log stream disconnected');
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [connected]);

  useEffect(() => {
    if (!paused && pendingRef.current.length > 0) flushPending();
  }, [paused, flushPending]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, paused]);

  return (
    <section className="section dev-section logs-panel">
      <div className="logs-panel__header">
        <h2>Logs</h2>
        <div className="row" style={{ gap: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setLogs([]);
              pendingRef.current = [];
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="section-desc">Real-time gateway execution logs. Audit trail for debugging.</p>
      {!connected && (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Connect to gateway to stream logs.</p>
      )}
      {connected && error && (
        <p style={{ fontSize: '0.9rem', color: 'var(--error)' }}>{error}</p>
      )}
      {connected && (
        <div
          ref={scrollRef}
          className="logs-panel__output"
          role="log"
          aria-live="polite"
        >
          {logs.length === 0 && !error && (
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Waiting for logs…</p>
          )}
          {logs.map((entry) => (
            <div
              key={entry.id}
              className={`logs-panel__entry logs-panel__entry--${entry.level.toLowerCase()}`}
            >
              <span className="logs-panel__ts">{entry.ts}</span>
              <span className="logs-panel__level">{entry.level}</span>
              <span className="logs-panel__msg">{entry.msg}</span>
              {entry.data && Object.keys(entry.data).length > 0 && (
                <span className="logs-panel__data">{JSON.stringify(entry.data)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
