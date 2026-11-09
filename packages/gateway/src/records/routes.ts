/**
 * HTTP endpoints for shared records, links and activities.
 */

import type { Express, Request, Response } from 'express';
import { logger } from '../logger.js';
import { principalOf } from '../security/auth.js';
import {
  RecordError,
  activitiesOf,
  addActivity,
  createRecord,
  deleteRecord,
  getRecord,
  link,
  linksOf,
  listRecords,
  mergeRecords,
  resolveRecord,
  unlink,
  updateRecord,
  type CoreType,
  type Identities,
} from './records.js';

/** Who is acting, for the record's `createdBy` and the events. */
export function actorOf(res: Response): string {
  const p = principalOf(res);
  if (!p || p.kind === 'operator') return 'operator';
  return `${p.kind}:${p.subject}`;
}

function fail(res: Response, e: unknown, code: string): Response {
  if (e instanceof RecordError) {
    const status = { invalid: 400, not_found: 404, identity_conflict: 409 }[e.code];
    return res.status(status).json({
      error: e.code,
      message: e.message,
      ...(e.candidates ? { candidates: e.candidates } : {}),
    });
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.error(code, { err: message });
  return res.status(500).json({ error: code, message });
}

function identities(body: Record<string, unknown>): Identities {
  return {
    emails: body.emails as string[] | undefined,
    phones: body.phones as string[] | undefined,
    domains: body.domains as string[] | undefined,
  };
}

const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

export function mountRecordRoutes(app: Express): void {
  app.get('/records', (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, unknown>;
      res.json({
        records: listRecords({
          type: typeof q.type === 'string' ? q.type : undefined,
          q: typeof q.q === 'string' ? q.q : undefined,
          limit: Number(q.limit) || undefined,
        }),
      });
    } catch (e) {
      fail(res, e, 'records_list_failed');
    }
  });

  app.post('/records', (req: Request, res: Response) => {
    try {
      const b = body(req);
      res.status(201).json(
        createRecord({
          type: b.type as CoreType,
          name: typeof b.name === 'string' ? b.name : undefined,
          data: (b.data as Record<string, unknown>) ?? undefined,
          identities: identities(b),
          actor: actorOf(res),
        })
      );
    } catch (e) {
      fail(res, e, 'record_create_failed');
    }
  });

  /** Find a person or organisation by any of its identities, creating it unless `create: false`. */
  app.post('/records/resolve', (req: Request, res: Response) => {
    try {
      const b = body(req);
      const out = resolveRecord({
        type: b.type as CoreType,
        name: typeof b.name === 'string' ? b.name : undefined,
        data: (b.data as Record<string, unknown>) ?? undefined,
        identities: identities(b),
        create: b.create !== false,
        actor: actorOf(res),
      });
      if (!out.record) return res.status(404).json({ error: 'not_found', ...out });
      res.status(out.created ? 201 : 200).json(out);
    } catch (e) {
      fail(res, e, 'record_resolve_failed');
    }
  });

  app.post('/records/links', (req: Request, res: Response) => {
    try {
      const b = body(req);
      res.status(201).json(link(String(b.from), String(b.to), String(b.kind), actorOf(res)));
    } catch (e) {
      fail(res, e, 'record_link_failed');
    }
  });

  app.delete('/records/links', (req: Request, res: Response) => {
    try {
      const b = { ...(req.query as Record<string, unknown>), ...body(req) };
      res.json({ ok: unlink(String(b.from), String(b.to), String(b.kind), actorOf(res)) });
    } catch (e) {
      fail(res, e, 'record_unlink_failed');
    }
  });

  app.get('/records/:id', (req: Request, res: Response) => {
    try {
      const record = getRecord(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'not_found' });
      res.json({ ...record, links: linksOf(record.ref) });
    } catch (e) {
      fail(res, e, 'record_get_failed');
    }
  });

  app.patch('/records/:id', (req: Request, res: Response) => {
    try {
      const b = body(req);
      res.json(
        updateRecord(
          String(req.params.id),
          {
            name: b.name as string | null | undefined,
            data: b.data as Record<string, unknown> | undefined,
            add: b.add as Identities | undefined,
            remove: b.remove as Identities | undefined,
          },
          actorOf(res)
        )
      );
    } catch (e) {
      fail(res, e, 'record_update_failed');
    }
  });

  app.post('/records/:id/merge', (req: Request, res: Response) => {
    try {
      res.json(mergeRecords(String(req.params.id), String(body(req).from), actorOf(res)));
    } catch (e) {
      fail(res, e, 'record_merge_failed');
    }
  });

  app.delete('/records/:id', (req: Request, res: Response) => {
    try {
      deleteRecord(String(req.params.id), actorOf(res));
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, 'record_delete_failed');
    }
  });

  /** Links of any ref, core or a module's: `GET /links?ref=crm:deal:42`. */
  app.get('/links', (req: Request, res: Response) => {
    try {
      res.json({ links: linksOf(String((req.query as Record<string, unknown>).ref ?? '')) });
    } catch (e) {
      fail(res, e, 'links_failed');
    }
  });

  app.get('/records/:id/activities', (req: Request, res: Response) => {
    try {
      const record = getRecord(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'not_found' });
      res.json({ activities: activitiesOf(record.ref, Number(req.query.limit) || 50) });
    } catch (e) {
      fail(res, e, 'activities_failed');
    }
  });

  app.post('/activities', (req: Request, res: Response) => {
    try {
      const b = body(req);
      res.status(201).json(
        addActivity({
          kind: String(b.kind ?? ''),
          summary: String(b.summary ?? ''),
          refs: b.refs as string[],
          at: typeof b.at === 'string' ? b.at : undefined,
          data: b.data as Record<string, unknown> | undefined,
          actor: actorOf(res),
        })
      );
    } catch (e) {
      fail(res, e, 'activity_create_failed');
    }
  });
}
