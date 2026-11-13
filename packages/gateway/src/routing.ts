/**
 * Model routing: what happens when the model in use is unavailable.
 *
 * "Fallback" means using the next model when the current one cannot be used:
 * the provider is down, overloaded or rate limiting, did not answer, or has no
 * key. It is decided from what the provider adapter reports about the failed
 * call, never from the words of an answer. It is not escalation
 * (`agent.model.escalate`), which runs a stronger model when a gate fails.
 *
 * Strictness: a model a person chose is used as chosen. Fallback applies to
 * defaults and to what a spec or a setting names, for runs nobody started with
 * a model of their own.
 */

import { emit } from './events.js';
import { logger } from './logger.js';
import { addRunStep, currentRunId, currentSessionId } from './runs.js';
import { isStoreOpen } from './store.js';

/** What `model.fallback` says. */
export interface FallbackInfo {
  /** The model that could not be used. Absent: the CLI's own default. */
  from: string | undefined;
  to: string;
  /** Why `from` was left: the provider's own error. */
  reason: string;
  /** `automation`: an automation run; `chat`: a chat or task call. */
  scope: 'automation' | 'chat';
  /** Models passed over on the way, and why none of them could be used. */
  skipped?: Array<{ model: string; reason: string }>;
}

const MAX_REASON = 300;

/**
 * Report a move to another model: the `model.fallback` event, with the run
 * and chat session it happened in, and a step on the run so the record shows
 * where its work changed models. Never throws; accounting must not fail the
 * call it describes.
 */
export function recordFallback(
  info: FallbackInfo,
  ctx: { runId?: string; sessionId?: string } = {}
): void {
  const runId = ctx.runId ?? currentRunId();
  const sessionId = ctx.sessionId ?? currentSessionId();
  const reason =
    info.reason.length > MAX_REASON ? `${info.reason.slice(0, MAX_REASON)}…` : info.reason;
  const payload = {
    from: info.from ?? null,
    to: info.to,
    reason,
    scope: info.scope,
    ...(info.skipped?.length ? { skipped: info.skipped } : {}),
  };
  try {
    emit('model.fallback', payload, { runId, sessionId });
    if (runId && isStoreOpen()) {
      addRunStep(runId, {
        kind: 'tool',
        input: { name: 'model.fallback', from: payload.from, to: info.to },
        output: {
          reason,
          ...(info.skipped?.length ? { skipped: info.skipped } : {}),
        },
        status: 'warning',
      });
    }
  } catch (e) {
    logger.warn('Could not record a model fallback', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
