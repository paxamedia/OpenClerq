/**
 * HTTP endpoints for the one inbox.
 */

import type { Express, Request, Response } from 'express';
import { logger } from '../logger.js';
import { actorOf } from '../records/routes.js';
import {
  InboxError,
  addItem,
  getItem,
  listInbox,
  respond,
  setStatus,
  type InboxKind,
  type InboxStatus,
} from './inbox.js';

function fail(res: Response, e: unknown, code: string): Response {
  if (e instanceof InboxError) {
    const status = { invalid: 400, not_found: 404, no_handler: 409 }[e.code];
    return res.status(status).json({ error: e.code, message: e.message });
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.error(code, { err: message });
  return res.status(500).json({ error: code, message });
}

/** Approvals are decided at /approvals/:id/approve|deny, not here. */
function refuseApproval(res: Response, id: string): boolean {
  if (!id.startsWith('apr_')) return false;
  res.status(400).json({
    error: 'invalid',
    message: `Decide approvals with POST /approvals/${id.slice(4)}/approve or /deny.`,
  });
  return true;
}

export function mountInboxRoutes(app: Express): void {
  app.get('/inbox', (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, unknown>;
      res.json({
        items: listInbox({
          status: typeof q.status === 'string' ? (q.status as InboxStatus) : undefined,
          kind: typeof q.kind === 'string' ? (q.kind as InboxKind) : undefined,
          moduleId: typeof q.module === 'string' ? q.module : undefined,
          limit: Number(q.limit) || undefined,
        }),
      });
    } catch (e) {
      fail(res, e, 'inbox_list_failed');
    }
  });

  /** Add an item from outside a module (a script, the operator). */
  app.post('/inbox/items', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json(
        addItem(typeof b.moduleId === 'string' ? b.moduleId : null, {
          kind: b.kind as InboxKind,
          title: String(b.title ?? ''),
          body: typeof b.body === 'string' ? b.body : undefined,
          ref: typeof b.ref === 'string' ? b.ref : undefined,
          link: typeof b.link === 'string' ? b.link : undefined,
          priority: typeof b.priority === 'number' ? b.priority : undefined,
          dueAt: typeof b.dueAt === 'string' ? b.dueAt : undefined,
          externalId: typeof b.externalId === 'string' ? b.externalId : undefined,
        })
      );
    } catch (e) {
      fail(res, e, 'inbox_add_failed');
    }
  });

  app.get('/inbox/items/:id', (req: Request, res: Response) => {
    const item = getItem(String(req.params.id));
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json(item);
  });

  /** Mark done, dismissed, or open again. */
  app.patch('/inbox/items/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (refuseApproval(res, id)) return;
    try {
      const b = (req.body ?? {}) as { status?: InboxStatus };
      res.json(setStatus(id, b.status as InboxStatus, actorOf(res)));
    } catch (e) {
      fail(res, e, 'inbox_update_failed');
    }
  });

  /** Answer an item; its module's handler acts on it. */
  app.post('/inbox/items/:id/respond', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (refuseApproval(res, id)) return;
    try {
      const b = (req.body ?? {}) as { text?: unknown; data?: unknown };
      res.json(
        await respond(
          id,
          { text: typeof b.text === 'string' ? b.text : undefined, data: b.data },
          actorOf(res)
        )
      );
    } catch (e) {
      fail(res, e, 'inbox_respond_failed');
    }
  });
}
