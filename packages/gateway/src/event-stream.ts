/**
 * GET /events/stream: the typed event bus as Server-Sent Events.
 *
 * Each frame carries the event's id, so a browser EventSource resends it as
 * Last-Event-ID when it reconnects and the gap is replayed from the backlog.
 * When the gap cannot be replayed (another gateway process, or older than the
 * backlog) the stream sends a `reset` frame first: the client should refetch
 * what it shows.
 *
 * A comment line goes out every heartbeat interval, so proxies keep the
 * connection open and a dead socket is noticed. Under Bun a hang-up fires no
 * event (see gateway.ts), so a write that fails also ends the subscription.
 */

import type { Request, Response } from 'express';
import { eventsSince, lastEventId, subscribeEvents, type ClerqEvent } from './events.js';
import { principalOf } from './security/auth.js';
import { currentTenant, DEFAULT_TENANT } from './tenant.js';
import { tokenStillValid } from './security/scoped-tokens.js';
import { onTokensChanged } from './security/token-watch.js';
import { remoteSettings } from './remote/devices.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;

function heartbeatMs(): number {
  const n = Number(process.env.CLERQ_SSE_HEARTBEAT_MS);
  return Number.isFinite(n) && n >= 50 ? n : DEFAULT_HEARTBEAT_MS;
}

/** `?names=run.,approval.` keeps events whose name starts with one of the prefixes. */
function nameFilter(req: Request): (e: ClerqEvent) => boolean {
  const raw = (req.query as Record<string, unknown>)?.names;
  const prefixes =
    typeof raw === 'string'
      ? raw
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
  if (prefixes.length === 0) return () => true;
  return (e) => prefixes.some((p) => e.name.startsWith(p));
}

function resumeFrom(req: Request): string | null {
  const header = req.headers['last-event-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  // A first connection can name where to start, since EventSource cannot set headers.
  const q = (req.query as Record<string, unknown>)?.lastEventId;
  return typeof q === 'string' && q.trim() ? q.trim() : null;
}

export function streamEvents(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // A scoped token, or the gateway token naming a tenant, sees that tenant's
  // events only; the gateway token alone sees everything.
  const byName = nameFilter(req);
  const tenantOnly = principalOf(res)?.kind !== 'operator' || res.locals.tenantNamed === true;
  const tenant = currentTenant();
  const keep = (e: ClerqEvent) =>
    byName(e) && (!tenantOnly || (e.context.tenantId ?? DEFAULT_TENANT) === tenant);
  let closed = false;
  let unsub: () => void = () => undefined;
  let unwatch: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;

  // A scoped token is checked again on every send and heartbeat, and when
  // tokens change: a revoked or expired token, or a device after remote mode
  // goes off, ends the stream.
  const principal = principalOf(res);
  const stillAllowed = () =>
    !principal ||
    principal.kind === 'operator' ||
    (tokenStillValid(String(principal.tokenId)) &&
      (principal.kind !== 'device' || remoteSettings().enabled));

  const close = () => {
    if (closed) return;
    closed = true;
    unsub();
    unwatch();
    clearInterval(timer);
  };
  const end = () => {
    close();
    if (!res.writableEnded) res.end();
  };
  const write = (chunk: string) => {
    if (closed) return;
    if (res.writableEnded || res.destroyed) return close();
    if (!stillAllowed()) return end();
    try {
      res.write(chunk);
    } catch {
      close();
    }
  };
  const send = (e: ClerqEvent) => {
    if (keep(e)) write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  };

  // The opening id gives a client a resume point before any event arrives.
  write(`retry: 3000\nid: ${lastEventId()}\n: connected\n\n`);
  const from = resumeFrom(req);
  if (from) {
    const missed = eventsSince(from);
    if (missed === null) {
      // The id lets the client resume from here next time.
      write(`event: reset\nid: ${lastEventId()}\ndata: {}\n\n`);
    } else {
      missed.forEach(send);
    }
  }

  unsub = subscribeEvents(send);
  unwatch = onTokensChanged(() => {
    if (!stillAllowed()) end();
  });
  timer = setInterval(() => write(`: ping ${new Date().toISOString()}\n\n`), heartbeatMs());
  timer.unref?.();
  req.on('close', close);
  res.on('close', close);
}
