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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStore } from '../store.js';

export type PipelineMode = 'raw' | 'managed';

/**
 * How a managed conversation's agent treats the folder attached to it, as
 * the builtin agent's permission modes say: `acceptEdits` (the default, full
 * access) works without asking; `default` asks before writes and commands;
 * `plan` only reads. A push always waits.
 */
export type ChatPermissionMode = 'acceptEdits' | 'default' | 'plan';
export const CHAT_PERMISSION_MODES: readonly ChatPermissionMode[] = [
  'acceptEdits',
  'default',
  'plan',
];

export interface Session {
  id: string;
  title: string | null;
  mode: PipelineMode;
  model: string | null;
  /**
   * A folder attached to a managed conversation: its agent reads, writes and
   * runs commands there. Without one the agent has no file or shell tools.
   */
  workspace: string | null;
  permissionMode: ChatPermissionMode;
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

interface SessionMeta {
  mode?: PipelineMode;
  workspace?: string;
  permissionMode?: ChatPermissionMode;
  [key: string]: unknown;
}

function metaOf(r: Record<string, unknown>): SessionMeta {
  try {
    const parsed = JSON.parse(String(r.metadata ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SessionMeta) : {};
  } catch {
    /* a malformed row still lists, in the safer mode */
    return {};
  }
}

function rowToSession(r: Record<string, unknown>): Session {
  const meta = metaOf(r);
  const mode: PipelineMode = meta.mode === 'managed' ? 'managed' : 'raw';
  return {
    id: String(r.id),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    mode,
    model: r.model === null || r.model === undefined ? null : String(r.model),
    workspace: typeof meta.workspace === 'string' ? meta.workspace : null,
    permissionMode: CHAT_PERMISSION_MODES.includes(meta.permissionMode as ChatPermissionMode)
      ? (meta.permissionMode as ChatPermissionMode)
      : 'acceptEdits',
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
    workspace?: unknown;
    permissionMode?: unknown;
  } = {}
): Session {
  const mode = parseMode(input.mode);
  const workspace = input.workspace === undefined ? null : parseWorkspace(input.workspace);
  const permissionMode =
    input.permissionMode === undefined ? undefined : parsePermissionMode(input.permissionMode);
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
      JSON.stringify({
        mode,
        ...(workspace ? { workspace } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      }),
      now,
      now
    );
  return getSession(id)!;
}

/** The agent id of a session that holds a sub-agent's transcript. */
export const SUBAGENT_AGENT_ID = 'subagent';

/**
 * A session for a sub-agent's run: its task and, when it ends, its answer.
 * Not listed with the chats; the run links to it.
 */
export function createSubagentSession(input: {
  title: string;
  model?: string;
  parentRunId: string;
  parentSessionId?: string;
}): string {
  const id = `ses_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO sessions (id, title, agent_id, status, model, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .run(
      id,
      input.title,
      SUBAGENT_AGENT_ID,
      input.model ?? null,
      JSON.stringify({
        mode: 'managed',
        parentRunId: input.parentRunId,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      }),
      now,
      now
    );
  return id;
}

export function listSessions(limit = 50): Session[] {
  return (
    getStore()
      // A sub-agent's transcript is reached from its run, not listed among the chats.
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE agent_id IS NOT 'subagent'
       ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit)
      .map(rowToSession)
  );
}

export function getSession(id: string): Session | null {
  const row = getStore().prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id);
  return row ? rowToSession(row) : null;
}

/**
 * A folder to attach to a conversation: an existing directory, by its real
 * path (`~` expanded). Null or "" detaches. The file system root is refused.
 */
export function parseWorkspace(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new SessionError('workspace must be a folder path or null.');
  const expanded = value.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(expanded)) {
    throw new SessionError('workspace must be an absolute path (or start with ~).');
  }
  let real: string;
  try {
    real = fs.realpathSync.native(expanded);
  } catch {
    throw new SessionError(`${expanded} does not exist.`);
  }
  if (!fs.statSync(real).isDirectory()) throw new SessionError(`${real} is not a folder.`);
  if (path.dirname(real) === real) {
    throw new SessionError('Attach a project folder, not the root of the disk.');
  }
  return real;
}

export function parsePermissionMode(value: unknown): ChatPermissionMode {
  if (!CHAT_PERMISSION_MODES.includes(value as ChatPermissionMode)) {
    throw new SessionError(`permissionMode must be one of ${CHAT_PERMISSION_MODES.join(', ')}.`);
  }
  return value as ChatPermissionMode;
}

export function updateSession(
  id: string,
  patch: {
    title?: string;
    mode?: unknown;
    model?: string | null;
    workspace?: unknown;
    permissionMode?: unknown;
  }
): Session | null {
  const row = getStore().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return null;
  const current = rowToSession(row);
  const meta = metaOf(row);
  const mode = patch.mode === undefined ? current.mode : parseMode(patch.mode);
  const title = patch.title === undefined ? current.title : patch.title.trim() || null;
  const model = patch.model === undefined ? current.model : (patch.model?.trim() ?? null) || null;
  const workspace =
    patch.workspace === undefined ? current.workspace : parseWorkspace(patch.workspace);
  const permissionMode =
    patch.permissionMode === undefined
      ? current.permissionMode
      : parsePermissionMode(patch.permissionMode);

  // Other keys (a sub-agent's parent) are kept as they are.
  const next: SessionMeta = { ...meta, mode, permissionMode };
  if (workspace) next.workspace = workspace;
  else delete next.workspace;
  getStore()
    .prepare('UPDATE sessions SET title = ?, model = ?, metadata = ?, updated_at = ? WHERE id = ?')
    .run(title, model, JSON.stringify(next), new Date().toISOString(), id);
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
