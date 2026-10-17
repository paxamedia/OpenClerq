/**
 * Cron schedules for enabled automations.
 *
 * A firing while the same automation is still running, or while the global
 * limit is reached, is skipped and logged rather than queued: a durable queue
 * with catch-up after sleep is the next step for this module.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../logger.js';
import { getAutomation, listAutomations, setNextRunAt } from './store.js';
import { startAutomationRun, AutomationBusy, type RunnerDeps } from './runner.js';

const jobs = new Map<string, ScheduledTask>();

/** When a cron expression next fires, in the host's time zone. */
export function nextRunOf(expression: string): Date | null {
  if (!cron.validate(expression)) return null;
  const probe = cron.schedule(expression, () => undefined);
  try {
    return probe.getNextRun();
  } finally {
    void probe.destroy();
  }
}

function fire(id: string, deps: RunnerDeps): void {
  const automation = getAutomation(id);
  const job = jobs.get(id);
  if (job) setNextRunAt(id, job.getNextRun());
  if (!automation?.enabled) return;
  try {
    const { runId } = startAutomationRun(automation, 'schedule', deps);
    logger.info('Scheduled automation run started', { automation: automation.name, runId });
  } catch (e) {
    if (e instanceof AutomationBusy) {
      logger.warn('Scheduled automation run skipped', {
        automation: automation.name,
        reason: e.message,
      });
      return;
    }
    logger.error('Scheduled automation run failed to start', {
      automation: automation.name,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

export function stopAutomationSchedules(): void {
  for (const job of jobs.values()) void job.destroy();
  jobs.clear();
}

/** (Re)start a schedule for every enabled automation that has one. */
export function startAutomationSchedules(deps: RunnerDeps): void {
  stopAutomationSchedules();
  for (const automation of listAutomations()) {
    const schedule = automation.spec?.schedule;
    if (!automation.enabled || !schedule) {
      // Not scheduled, so it has no next run, whatever an earlier start recorded.
      if (automation.nextRunAt) setNextRunAt(automation.id, null);
      continue;
    }
    const job = cron.schedule(schedule, () => fire(automation.id, deps), { name: automation.id });
    jobs.set(automation.id, job);
    setNextRunAt(automation.id, job.getNextRun());
  }
}

export function scheduledAutomationIds(): string[] {
  return [...jobs.keys()];
}
