/**
 * Chat sessions.
 *
 * A session is a conversation with a transcript; a message in it is a run with
 * `trigger: 'manual'`. That is the whole trick of the console — it reuses the
 * runs, steps, cost accounting and event bus the automation runner already has,
 * instead of growing a parallel set of its own.
 *
 * Two pipeline modes, per conversation and overridable per message:
 *
 *   raw      OpenClerq adds nothing. No system prompt, no skill selection, no
 *            memory, no tools. A text channel to the provider, and the exact
 *            request body is kept so it can be inspected.
 *   managed  The full pipeline, as POST /task runs it.
 */

import crypto from 'node:crypto';
import { getStore } from '../store.js';

export type PipelineMode = 'raw' | 'managed';

export interface Session {
  id: string;
  title: string | null;
  mode: PipelineMode;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Provider, model, tokens, cost and the request body, for assistant turns. */
  meta?: Record<string, unknown>;
}

export class SessionError extends Error {
  readonly code = 'invalid_session';
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Validate a pipeline mode, falling back when none is given. */
export function parseMode(value: unknown, fallback: PipelineMode = 'raw'): PipelineMode {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'raw' && value !== 'managed') {
    throw new SessionError(`mode must be "raw" or "managed" (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function rowToSession(r: Record<string, unknown>): Session {
  let mode: PipelineMode = 'raw';
  try {
    const meta = JSON.parse(String(r.metadata ?? '{}')) as { mode?: PipelineMode };
    if (meta.mode === 'managed') mode = 'managed';
  } catch {
    /* a malformed row still lists, in the safer mode */
  }
  return {
    id: String(r.id),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    mode,
    model: r.model === null || r.model === undefined ? null : String(r.model),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    messageCount: Number(r.message_count ?? 0),
  };
}

const SESSION_COLUMNS = `sessions.*, (
  SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id
) AS message_count`;

export function createSession(
  input: {
    title?: string;
    mode?: unknown;
    model?: string;
  } = {}
): Session {
  const mode = parseMode(input.mode);
  const id = `ses_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO sessions (id, title, status, model, metadata, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`
    )
    .run(
      id,
      input.title?.trim() || null,
      input.model?.trim() || null,
      JSON.stringify({ mode }),
      now,
      now
    );
  return getSession(id)!;
}

export function listSessions(limit = 50): Session[] {
  return getStore()
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC LIMIT ?`)
    .all(limit)
    .map(rowToSession);
}

export function getSession(id: string): Session | null {
  const row = getStore().prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id);
  return row ? rowToSession(row) : null;
}

export function updateSession(
  id: string,
  patch: { title?: string; mode?: unknown; model?: string | null }
): Session | null {
  const current = getSession(id);
  if (!current) return null;
  const mode = patch.mode === undefined ? current.mode : parseMode(patch.mode);
  const title = patch.title === undefined ? current.title : patch.title.trim() || null;
  const model = patch.model === undefined ? current.model : (patch.model?.trim() ?? null) || null;

  getStore()
    .prepare('UPDATE sessions SET title = ?, model = ?, metadata = ?, updated_at = ? WHERE id = ?')
    .run(title, model, JSON.stringify({ mode }), new Date().toISOString(), id);
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  // Messages go with it: the schema cascades.
  return getStore().prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
}

/** Roughly four characters per token — enough to show context pressure. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function addMessage(
  sessionId: string,
  message: { role: Message['role']; content: string; meta?: Record<string, unknown> }
): Message {
  const db = getStore();
  const now = new Date().toISOString();

  const res = db
    .prepare(
      `INSERT INTO messages (session_id, role, content, meta, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      message.role,
      message.content,
      message.meta ? JSON.stringify(message.meta) : null,
      estimateTokens(message.content),
      now
    );
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);

  return {
    id: Number(res.lastInsertRowid),
    role: message.role,
    content: message.content,
    meta: message.meta,
    createdAt: now,
  };
}

function parseMeta(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An assistant turn written before migration 3 kept its metadata inside the
 * text. Only those rows are decoded: a user's words are never reinterpreted.
 */
function decodeLegacy(content: string): { content: string; meta?: Record<string, unknown> } {
  if (!content.startsWith('{"text":')) return { content };
  try {
    const parsed = JSON.parse(content) as { text?: unknown; meta?: unknown };
    if (typeof parsed.text !== 'string') return { content };
    return {
      content: parsed.text,
      meta:
        parsed.meta && typeof parsed.meta === 'object'
          ? (parsed.meta as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return { content };
  }
}

export function listMessages(sessionId: string): Message[] {
  return getStore()
    .prepare(
      'SELECT id, role, content, meta, created_at FROM messages WHERE session_id = ? ORDER BY id'
    )
    .all(sessionId)
    .map((r) => {
      let content = String(r.content);
      let meta = parseMeta(r.meta);
      if (meta === undefined && r.role === 'assistant') {
        ({ content, meta } = decodeLegacy(content));
      }
      return {
        id: Number(r.id),
        role: r.role as Message['role'],
        content,
        meta,
        createdAt: String(r.created_at),
      };
    });
}

/** The conversation so far, as the provider wants it. */
export function conversation(
  sessionId: string
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return listMessages(sessionId)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}
