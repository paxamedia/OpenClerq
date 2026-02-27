/**
 * In-memory log buffer and SSE stream for real-time observability.
 * Audit-ready: each entry has timestamp, level, message, optional data.
 */

export interface LogEntry {
  id: string;
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
  data?: Record<string, unknown>;
}

const MAX_BUFFER = 500;
const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let idSeq = 0;

function nextId(): string {
  idSeq += 1;
  return `log-${idSeq}`;
}

export function appendLog(level: LogEntry['level'], msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    id: nextId(),
    ts: new Date().toISOString(),
    level,
    msg,
    data,
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  listeners.forEach((fn) => {
    try {
      fn(entry);
    } catch (_) {}
  });
}

export function getLogBuffer(): LogEntry[] {
  return [...buffer];
}

export function subscribe(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
