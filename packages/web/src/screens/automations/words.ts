/** What the automations list and detail say about queueing, catching up and missed times. */

import type { AutomationSummary } from '@clerq/gateway-client';
import { exactTime } from '../../app/format';

type Missed = NonNullable<AutomationSummary['missedSlots']>;

const WHY: Record<Missed['reason'], string> = {
  catch_up_off: 'skipped, because catch-up is off for this automation',
  paused: 'skipped, because the emergency stop was holding schedules',
  already_queued: 'skipped, because a run was already waiting',
  enqueue_failed: 'not started, because the run could not be queued',
};

/** "Missed 3 scheduled runs: skipped, because catch-up is off for this automation." */
export function missedWords(m: Missed): string {
  const n = `${m.count}${m.capped ? ' or more' : ''}`;
  const what = m.count === 1 && !m.capped ? 'scheduled run' : 'scheduled runs';
  const error = m.reason === 'enqueue_failed' && m.error ? ` (${m.error})` : '';
  return `Missed ${n} ${what}: ${WHY[m.reason]}${error}.`;
}

/** When the first missed time was, as a short sentence. */
export function missedSince(m: Missed): string {
  return `The first was due ${exactTime(m.first)}.`;
}

/** Whether to say a schedule catches up, and how. */
export function catchUpWords(a: Pick<AutomationSummary, 'schedule' | 'catchUp'>): string | null {
  if (!a.schedule) return null;
  return a.catchUp
    ? 'Catches up: a time missed while the computer slept runs once when it wakes.'
    : 'A time missed while the computer slept is skipped.';
}

/** What the Run now button says, and whether it can be pressed: a run waiting or going blocks another. */
export function runNow(a: Pick<AutomationSummary, 'running' | 'queued' | 'problem'>): {
  label: string;
  disabled: boolean;
} {
  return {
    label: a.running ? 'Running' : a.queued ? 'Queued' : 'Run now',
    disabled: Boolean(a.problem) || Boolean(a.queued),
  };
}
