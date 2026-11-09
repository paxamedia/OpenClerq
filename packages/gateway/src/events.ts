/**
 * Typed internal event bus.
 *
 * One bus feeds the UI stream, the log writer, the metrics collector and the
 * audit log, so they all see the same events with the same correlation ids.
 *
 * Emitting must never break the emitter: a throwing subscriber is logged and
 * skipped, and a slow subscriber cannot block the caller.
 */

import { logger } from './logger.js';
import { currentTenant, DEFAULT_TENANT } from './tenant.js';

/** Core events, plus `module.<id>.<name>` from modules (see ModuleContext.events). */
export type EventName = CoreEventName | `module.${string}`;

export type CoreEventName =
  | 'gateway.started'
  | 'gateway.stopped'
  | 'session.created'
  | 'session.updated'
  | 'run.queued'
  | 'run.started'
  | 'run.status'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'agent.turn.started'
  | 'agent.turn.completed'
  | 'tool.requested'
  | 'tool.approval_required'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'gate.started'
  | 'gate.passed'
  | 'gate.failed'
  | 'model.called'
  | 'model.fallback'
  | 'budget.exceeded'
  | 'memory.updated'
  | 'approval.requested'
  | 'approval.decided'
  | 'kill.engaged'
  | 'kill.released'
  | 'notify.posted'
  | 'notify.badge'
  | 'service.changed'
  | 'record.created'
  | 'record.updated'
  | 'record.merged'
  | 'record.deleted'
  | 'record.linked'
  | 'record.unlinked'
  | 'activity.added'
  | 'inbox.item.created'
  | 'inbox.item.updated'
  | 'inbox.item.responded'
  | 'device.paired'
  | 'device.revoked';

/** Correlation ids, so autonomous behaviour can be traced after the fact. */
export interface EventContext {
  requestId?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  /** Set when the event happened in a tenant other than `default`. */
  tenantId?: string;
}

export interface ClerqEvent<T = unknown> {
  /**
   * `<epoch>-<seq>`: the epoch changes with every gateway start and the
   * sequence rises by one per event, so a stream can resume after a drop and
   * notice when it cannot.
   */
  id: string;
  name: EventName;
  at: string;
  context: EventContext;
  payload: T;
}

type Subscriber = (event: ClerqEvent) => void;

const subscribers = new Set<Subscriber>();
const recent: ClerqEvent[] = [];
const MAX_RECENT = 500;

/** Distinguishes this process's event ids from an earlier gateway's. */
const EPOCH = Date.now().toString(36);
let seq = 0;

/** Split an event id. Null when it is malformed. */
export function parseEventId(id: string): { epoch: string; seq: number } | null {
  const m = /^([0-9a-z]+)-(\d+)$/.exec(id.trim());
  return m ? { epoch: m[1], seq: Number(m[2]) } : null;
}

/**
 * The events after `lastId`, oldest first, or null when they cannot all be
 * supplied: the id is from another gateway process, or older than the backlog.
 */
export function eventsSince(lastId: string): ClerqEvent[] | null {
  const parsed = parseEventId(lastId);
  if (!parsed || parsed.epoch !== EPOCH || parsed.seq > seq) return null;
  const oldest = recent.length > 0 ? (parseEventId(recent[0].id)?.seq ?? 0) : seq + 1;
  // The event right after lastId must still be in the backlog.
  if (parsed.seq + 1 < oldest) return null;
  return recent.filter((e) => (parseEventId(e.id)?.seq ?? 0) > parsed.seq);
}

/** The id of the newest event, so a client can resume from "now". */
export function lastEventId(): string {
  return `${EPOCH}-${seq}`;
}

/** Subscribe to every event. Returns an unsubscribe function. */
export function subscribeEvents(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** The most recent events, oldest first. Used to prime a new UI stream. */
export function recentEvents(limit = MAX_RECENT): ClerqEvent[] {
  return recent.slice(-limit);
}

export function emit<T>(name: EventName, payload: T, context: EventContext = {}): ClerqEvent<T> {
  seq += 1;
  const tenant = currentTenant();
  if (tenant !== DEFAULT_TENANT && context.tenantId === undefined) {
    context = { ...context, tenantId: tenant };
  }
  const event: ClerqEvent<T> = {
    id: `${EPOCH}-${seq}`,
    name,
    at: new Date().toISOString(),
    context,
    payload,
  };

  recent.push(event as ClerqEvent);
  if (recent.length > MAX_RECENT) recent.shift();

  for (const fn of subscribers) {
    try {
      fn(event as ClerqEvent);
    } catch (e) {
      // A broken subscriber must not take down the code that emitted.
      logger.warn('Event subscriber threw', {
        event: name,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return event;
}

/** Drop every subscriber. Tests use this; the gateway does not. */
export function resetEvents(): void {
  subscribers.clear();
  recent.length = 0;
}
