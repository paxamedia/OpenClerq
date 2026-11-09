/**
 * One inbox: everything waiting for a person, from every module. Items are
 * approvals, replies to answer, tasks and alerts. Pending tool approvals join
 * the list when it is read (`apr_<n>`) and are decided where they always were.
 *
 * A module adds items with ctx.inbox.add, keyed by its own id so adding the
 * same thing twice updates it, and can answer a person's response with
 * ctx.inbox.onRespond, e.g. to send a reply.
 */

import crypto from 'node:crypto';
import { getStore } from '../store.js';
import { emit } from '../events.js';
import { listPending } from '../approvals.js';
import { currentTenant, DEFAULT_TENANT } from '../tenant.js';

export type InboxKind = 'approval' | 'reply' | 'task' | 'alert';
export type InboxStatus = 'open' | 'done' | 'dismissed';

export interface InboxItem {
  id: string;
  moduleId: string | null;
  externalId: string | null;
  kind: InboxKind;
  title: string;
  body: string | null;
  /** The record it is about, `<module>:<type>:<id>`. */
  ref: string | null;
  /** A path in the module's UI that opens it. */
  link: string | null;
  status: InboxStatus;
  priority: number;
  dueAt: string | null;
  /** For an approval: the run waiting on it. */
  runId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export class InboxError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'no_handler',
    message: string
  ) {
    super(message);
    this.name = 'InboxError';
  }
}

const KINDS = new Set<InboxKind>(['approval', 'reply', 'task', 'alert']);
const STATUSES = new Set<InboxStatus>(['open', 'done', 'dismissed']);

export type RespondHandler = (
  item: InboxItem,
  response: { text?: string; data?: unknown; by: string }
) => unknown;

const responders = new Map<string, RespondHandler>();

export function onRespond(moduleId: string, handler: RespondHandler): void {
  if (typeof handler !== 'function') throw new Error('onRespond needs a function.');
  responders.set(moduleId, handler);
}

export function offRespond(moduleId: string): void {
  responders.delete(moduleId);
}

function rowToItem(r: Record<string, unknown>): InboxItem {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    moduleId: s(r.module_id),
    externalId: s(r.external_id),
    kind: r.kind as InboxKind,
    title: String(r.title),
    body: s(r.body),
    ref: s(r.ref),
    link: s(r.link),
    status: r.status as InboxStatus,
    priority: Number(r.priority ?? 0),
    dueAt: s(r.due_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    resolvedAt: s(r.resolved_at),
    resolvedBy: s(r.resolved_by),
  };
}

export function getItem(id: string): InboxItem | null {
  const row = getStore()
    .prepare('SELECT * FROM inbox_items WHERE tenant_id = ? AND id = ?')
    .get(currentTenant(), id);
  return row ? rowToItem(row) : null;
}

export interface NewItem {
  kind: InboxKind;
  title: string;
  body?: string;
  ref?: string;
  link?: string;
  priority?: number;
  dueAt?: string;
  /** The module's own id for it; adding the same one again updates the item. */
  externalId?: string;
}

/** Add an item, or update the module's item with the same externalId (reopening it). */
export function addItem(moduleId: string | null, input: NewItem): InboxItem {
  if (!KINDS.has(input.kind))
    throw new InboxError('invalid', 'kind must be approval, reply, task or alert.');
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 300) : '';
  if (!title) throw new InboxError('invalid', 'An inbox item needs a title.');
  if (input.dueAt !== undefined && Number.isNaN(Date.parse(input.dueAt))) {
    throw new InboxError('invalid', 'dueAt must be an ISO time.');
  }
  const db = getStore();
  const now = new Date().toISOString();
  const fields = [
    input.kind,
    title,
    input.body?.slice(0, 5000) ?? null,
    input.ref ?? null,
    input.link ?? null,
    Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
    input.dueAt ? new Date(input.dueAt).toISOString() : null,
  ];
  const existing =
    input.externalId !== undefined
      ? db
          .prepare(
            `SELECT id FROM inbox_items
             WHERE tenant_id = ? AND COALESCE(module_id, '') = ? AND external_id = ?`
          )
          .get(currentTenant(), moduleId ?? '', String(input.externalId))
      : undefined;
  if (existing) {
    const id = String(existing.id);
    db.prepare(
      `UPDATE inbox_items SET kind = ?, title = ?, body = ?, ref = ?, link = ?, priority = ?,
         due_at = ?, status = 'open', resolved_at = NULL, resolved_by = NULL, updated_at = ?
       WHERE id = ?`
    ).run(...fields, now, id);
    const item = getItem(id) as InboxItem;
    emit('inbox.item.updated', {
      id,
      moduleId,
      kind: item.kind,
      title: item.title,
      status: item.status,
    });
    return item;
  }
  const id = `inb_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO inbox_items
       (id, tenant_id, module_id, external_id, kind, title, body, ref, link, priority, due_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    currentTenant(),
    moduleId,
    input.externalId === undefined ? null : String(input.externalId),
    ...fields,
    now,
    now
  );
  const item = getItem(id) as InboxItem;
  emit('inbox.item.created', { id, moduleId, kind: item.kind, title: item.title });
  return item;
}

export function setStatus(id: string, status: InboxStatus, by: string): InboxItem {
  if (!STATUSES.has(status))
    throw new InboxError('invalid', 'status must be open, done or dismissed.');
  const item = getItem(id);
  if (!item) throw new InboxError('not_found', `No inbox item ${id}.`);
  const now = new Date().toISOString();
  const open = status === 'open';
  getStore()
    .prepare(
      'UPDATE inbox_items SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?'
    )
    .run(status, open ? null : now, open ? null : by, now, id);
  emit('inbox.item.updated', {
    id,
    moduleId: item.moduleId,
    kind: item.kind,
    title: item.title,
    status,
  });
  return getItem(id) as InboxItem;
}

/** A module's item by its own id. */
export function findExternal(moduleId: string, externalId: string): InboxItem | null {
  const row = getStore()
    .prepare('SELECT * FROM inbox_items WHERE tenant_id = ? AND module_id = ? AND external_id = ?')
    .get(currentTenant(), moduleId, externalId);
  return row ? rowToItem(row) : null;
}

/** Pending tool approvals, as inbox items. */
function approvalItems(): InboxItem[] {
  return listPending().map((a) => {
    return {
      id: `apr_${a.id}`,
      moduleId: null,
      externalId: String(a.id),
      kind: 'approval' as const,
      title: `Approve ${a.tool}`,
      body: a.reason || null,
      ref: null,
      link: null,
      status: 'open' as const,
      // High-risk approvals first.
      priority: { high: 2, medium: 1, low: 0 }[a.tier] ?? 1,
      dueAt: null,
      runId: a.runId,
      createdAt: a.requestedAt,
      updatedAt: a.requestedAt,
      resolvedAt: null,
      resolvedBy: null,
    };
  });
}

export function listInbox(
  opts: { status?: InboxStatus; kind?: InboxKind; moduleId?: string; limit?: number } = {}
): InboxItem[] {
  const status = opts.status ?? 'open';
  const where = ['tenant_id = ?', 'status = ?'];
  const params: Array<string | number> = [currentTenant(), status];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.moduleId) {
    where.push('module_id = ?');
    params.push(opts.moduleId);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  params.push(limit);
  const stored = getStore()
    .prepare(
      `SELECT * FROM inbox_items WHERE ${where.join(' AND ')}
       ORDER BY priority DESC, created_at DESC LIMIT ?`
    )
    .all(...params)
    .map(rowToItem);
  const approvals =
    // Runs and their approvals are not per tenant yet: they show in the default one.
    status === 'open' &&
    (!opts.kind || opts.kind === 'approval') &&
    !opts.moduleId &&
    currentTenant() === DEFAULT_TENANT
      ? approvalItems()
      : [];
  return [...approvals, ...stored]
    .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/**
 * A person answers an item (a reply's text, a task's outcome). The module's
 * onRespond handler gets it; unless it throws, the item is done.
 */
export async function respond(
  id: string,
  response: { text?: string; data?: unknown },
  by: string
): Promise<{ item: InboxItem; result: unknown }> {
  const item = getItem(id);
  if (!item) throw new InboxError('not_found', `No inbox item ${id}.`);
  const handler = item.moduleId ? responders.get(item.moduleId) : undefined;
  if (!handler) throw new InboxError('no_handler', 'Nothing handles responses to this item.');
  const result = await handler(item, { ...response, by });
  emit('inbox.item.responded', { id, moduleId: item.moduleId, by });
  return { item: setStatus(id, 'done', by), result };
}
