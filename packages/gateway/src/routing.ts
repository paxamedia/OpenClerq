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

import { audit } from '@clerq/store';
import { findProvider } from '@clerq/providers';
import { emit } from './events.js';
import { logger } from './logger.js';
import { recordLLMFallback } from './observability.js';
import { addRunStep, currentRunId, currentSessionId, runEventContext } from './runs.js';
import { getStore, isStoreOpen } from './store.js';

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
    recordLLMFallback();
    emit('model.fallback', payload, {
      ...runEventContext(runId),
      ...(sessionId ? { sessionId } : {}),
    });
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

// ---------------------------------------------------------------------------
// The default chain for chat and tasks
// ---------------------------------------------------------------------------

/** The most models the default chain may list. */
export const MAX_DEFAULT_FALLBACK = 5;
const SETTING = 'routing.fallback';

export class RoutingError extends Error {
  readonly code = 'invalid_routing';
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

/**
 * The models managed chat, `/task`, `/explain` and the gateway's own triggers
 * use, in order, when the default model is unavailable. Empty when none is set,
 * which is the default: nothing is sent to a provider the user did not name.
 * A call that names a model of its own never uses it.
 */
export function getDefaultFallback(): string[] {
  if (!isStoreOpen()) return [];
  try {
    const row = getStore().prepare('SELECT value FROM settings WHERE key = ?').get(SETTING);
    if (!row) return [];
    const parsed = JSON.parse(String(row.value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    // A damaged setting is no chain, never a failed call.
    return [];
  }
}

/**
 * Set the default chain. Each entry is `provider/model` with a provider the
 * registry knows: a bare model id would mean "of the configured provider",
 * which is the one a fallback is for when it is down.
 */
export function setDefaultFallback(
  models: unknown,
  registry: Parameters<typeof findProvider>[0],
  actor = 'operator'
): string[] {
  if (!Array.isArray(models)) {
    throw new RoutingError('fallback must be a list of models, e.g. ["openai/gpt-5-mini"].');
  }
  if (models.length > MAX_DEFAULT_FALLBACK) {
    throw new RoutingError(`fallback may list at most ${MAX_DEFAULT_FALLBACK} models.`);
  }
  const list = models.map((m, i) => {
    if (typeof m !== 'string' || !m.trim()) {
      throw new RoutingError(`fallback entry ${i + 1} must be a model name.`);
    }
    const ref = m.trim();
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash === ref.length - 1) {
      throw new RoutingError(`"${ref}" must name the provider too, as provider/model.`);
    }
    try {
      findProvider(registry, ref.slice(0, slash));
    } catch (e) {
      throw new RoutingError(e instanceof Error ? e.message : String(e));
    }
    return ref;
  });
  const dup = list.find((m, i) => list.indexOf(m) !== i);
  if (dup) throw new RoutingError(`"${dup}" is listed twice.`);
  const db = getStore();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SETTING, JSON.stringify(list), now);
  audit(db, { actor, action: 'routing.updated', detail: { fallback: list } });
  return list;
}
