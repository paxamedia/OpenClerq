/**
 * Which failures an automation run is tried again after, and when.
 *
 * Only failures that say nothing about the task are retried: the agent's
 * process crashed, the model provider was down or overloaded, or the run's
 * lease expired because its gateway stopped. A run that failed a policy
 * decision, a budget, a time limit, a denial, a gate or a cancel is never
 * retried: doing the same again would end the same way, or spend more than
 * the user agreed to. A gate failure can instead escalate to another model
 * (agent.model.escalate), which is the runner's business.
 */

import type { DriverResult } from '@clerq/drivers';
import type { AutomationSpec } from './spec.js';

export type TransientCause = 'driver_crash' | 'provider_unavailable' | 'lease_expired';

/** A run failure that a retry may get past. */
export class TransientFailure extends Error {
  constructor(
    message: string,
    readonly kind: TransientCause
  ) {
    super(message);
    this.name = 'TransientFailure';
  }
}

/** The longest wait before a retry, however many came before. */
export const MAX_BACKOFF_MS = 3_600_000;

/**
 * A model provider that is down, overloaded or rate limiting, as a provider
 * error (`Anthropic returned 529: …`), a CLI's report of one (`API Error:
 * 500 …`, `overloaded_error`), or a connection that never got an answer.
 */
const PROVIDER_DOWN =
  /\b(?:returned|API Error:?)\s*(?:5\d\d|429)\b|\boverloaded(?:_error)?\b|\brate[_ ]limit(?:ed|_error)?\b|\bfetch failed\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bsocket hang up\b/i;

/**
 * Why a failed agent result is worth another attempt, or null when it is not.
 * Only what the driver itself reports counts: that the CLI crashed, the API
 * error it printed (`result.apiError`), or the error of the agent's last model
 * call when the driver makes the calls itself (builtin, `lastModelError`).
 * Never the summary: it carries the agent's own final message, which may talk
 * about any error ("the endpoint returned 500") without being one.
 */
export function transientCause(
  result: DriverResult,
  lastModelError?: string
): TransientCause | null {
  if (result.ok || result.cancelled || result.timedOut) return null;
  // The agent was refused something: a decision, not an accident.
  if (result.permissionDenials.length > 0) return null;
  if (result.crashed) return 'driver_crash';
  if (lastModelError && PROVIDER_DOWN.test(lastModelError)) return 'provider_unavailable';
  if (result.apiError && PROVIDER_DOWN.test(result.apiError)) return 'provider_unavailable';
  return null;
}

/**
 * When to try a run again after attempt `attempt` (from 1) failed in a way
 * worth retrying, or null when the spec's retries are used up. The wait is
 * `retry.backoff`, doubled for each retry before, at most an hour.
 */
export function retryPlan(
  spec: AutomationSpec,
  attempt: number,
  now = Date.now()
): { notBefore: Date; retry: number; of: number } | null {
  if (attempt > spec.retry.maxRetries) return null;
  const wait = Math.min(spec.retry.backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return { notBefore: new Date(now + wait), retry: attempt, of: spec.retry.maxRetries };
}

/** The stages a run is retried from when its lease expires: work in progress. */
export const RETRYABLE_STAGES: ReadonlySet<string> = new Set([
  'preparing',
  'executing',
  'verifying',
]);
