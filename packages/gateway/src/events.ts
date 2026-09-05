/**
 * Typed internal event bus.
 *
 * One bus feeds the UI stream, the log writer, the metrics collector and the
 * audit log, rather than each growing its own ad-hoc mechanism — which is how
 * the pre-0.5 gateway ended up with a log stream, a metrics counter and a
 * secrets audit file that knew nothing about each other.
 *
 * Emitting must never break the emitter: a throwing subscriber is logged and
 * skipped, and a slow subscriber cannot block the caller.
 */

import { logger } from './logger.js';

export type EventName =
  | 'gateway.started'
  | 'gateway.stopped'
  | 'session.created'
  | 'session.updated'
  | 'run.queued'
  | 'run.started'
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
  | 'approval.decided';

/** Correlation ids, so autonomous behaviour can be traced after the fact. */
export interface EventContext {
  requestId?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
}

export interface ClerqEvent<T = unknown> {
  name: EventName;
  at: string;
  context: EventContext;
  payload: T;
}

type Subscriber = (event: ClerqEvent) => void;

const subscribers = new Set<Subscriber>();
const recent: ClerqEvent[] = [];
const MAX_RECENT = 500;

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
  const event: ClerqEvent<T> = {
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
