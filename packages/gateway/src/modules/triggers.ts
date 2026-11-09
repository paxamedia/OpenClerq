/**
 * Handler triggers: a cron schedule, a watched file or a webhook that calls a
 * module's function. Every firing is a recorded run, named after the module
 * and the trigger, so it shows in run history and the kill switch reaches it.
 *
 * Like the gateway's own triggers, a firing while the same trigger's last run
 * is still going is skipped rather than queued, and the kill switch pauses
 * them all until POST /resume.
 */

import cron, { type ScheduledTask } from 'node-cron';
import chokidar from 'chokidar';
import type { ModuleTriggerDef, TriggerEvent, TriggerSource } from '@clerq/module-sdk';
import { logger } from '../logger.js';
import { addRunStep, currentRunId, currentRunSignal, recordRun, type RunTrigger } from '../runs.js';
import { nextRunOf } from '../automations/scheduler.js';
import { FILE_DEBOUNCE_MS } from '../triggers.js';

const TRIGGER_ID = /^[a-z0-9][a-z0-9_-]*$/;

export class TriggerError extends Error {
  constructor(
    readonly code: 'not_found' | 'busy' | 'paused' | 'invalid',
    message: string
  ) {
    super(message);
    this.name = 'TriggerError';
  }
}

interface Registered {
  moduleId: string;
  def: ModuleTriggerDef;
  job?: ScheduledTask;
  watcher?: ReturnType<typeof chokidar.watch>;
  timer?: NodeJS.Timeout;
  running: boolean;
  lastFiredAt?: string;
}

/** What GET /modules shows of a trigger. */
export interface TriggerInfo {
  id: string;
  kind: ModuleTriggerDef['kind'];
  schedule?: string;
  path?: string;
  description?: string;
  nextRunAt: string | null;
  running: boolean;
  lastFiredAt: string | null;
}

const RUN_TRIGGER: Record<TriggerSource, RunTrigger> = {
  cron: 'schedule',
  file: 'event',
  webhook: 'webhook',
  manual: 'manual',
};

export class ModuleTriggers {
  private readonly registered = new Map<string, Registered>();
  private paused = false;

  /** Validate and record a trigger, and arm it unless the kill switch holds them. */
  register(moduleId: string, def: ModuleTriggerDef): void {
    if (!TRIGGER_ID.test(def.id)) {
      throw new TriggerError(
        'invalid',
        `Invalid trigger id "${def.id}". Use a-z, 0-9, "_" and "-".`
      );
    }
    const key = `${moduleId}/${def.id}`;
    if (this.registered.has(key)) {
      throw new TriggerError('invalid', `Trigger "${def.id}" is already registered.`);
    }
    if (typeof def.handler !== 'function') {
      throw new TriggerError('invalid', `Trigger "${def.id}" has no handler.`);
    }
    if (def.kind === 'cron' && !(def.schedule && cron.validate(def.schedule))) {
      throw new TriggerError('invalid', `Trigger "${def.id}" needs a valid cron schedule.`);
    }
    if (def.kind === 'file' && !def.path) {
      throw new TriggerError('invalid', `Trigger "${def.id}" needs a path to watch.`);
    }
    if (!['cron', 'file', 'webhook'].includes(def.kind)) {
      throw new TriggerError('invalid', `Trigger "${def.id}" has unknown kind "${def.kind}".`);
    }
    const r: Registered = { moduleId, def, running: false };
    this.registered.set(key, r);
    if (!this.paused) this.arm(r);
  }

  list(moduleId: string): TriggerInfo[] {
    return [...this.registered.values()]
      .filter((r) => r.moduleId === moduleId)
      .map((r) => ({
        id: r.def.id,
        kind: r.def.kind,
        schedule: r.def.schedule,
        path: r.def.path,
        description: r.def.description,
        nextRunAt:
          r.def.kind === 'cron' && !this.paused && r.def.schedule
            ? (nextRunOf(r.def.schedule)?.toISOString() ?? null)
            : null,
        running: r.running,
        lastFiredAt: r.lastFiredAt ?? null,
      }));
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** The kill switch: disarm every schedule and watcher. */
  pause(): void {
    this.paused = true;
    for (const r of this.registered.values()) this.disarm(r);
  }

  resume(): void {
    this.paused = false;
    for (const r of this.registered.values()) {
      this.disarm(r);
      this.arm(r);
    }
  }

  /** Forget a module's triggers, e.g. when its register() failed part-way. */
  remove(moduleId: string): void {
    for (const [key, r] of this.registered) {
      if (r.moduleId !== moduleId) continue;
      this.disarm(r);
      this.registered.delete(key);
    }
  }

  /**
   * Fire a trigger from outside its schedule: its webhook, or by hand.
   * Resolves with the run id once the run exists; the run carries on.
   */
  fireNow(moduleId: string, triggerId: string, payload?: unknown): Promise<string> {
    const r = this.registered.get(`${moduleId}/${triggerId}`);
    if (!r) throw new TriggerError('not_found', `No trigger "${triggerId}" in ${moduleId}.`);
    if (this.paused) {
      throw new TriggerError(
        'paused',
        'Triggers are paused by the kill switch. POST /resume to resume them.'
      );
    }
    if (r.running) {
      throw new TriggerError('busy', `Trigger "${triggerId}" is still running its last firing.`);
    }
    return new Promise((resolve, reject) => {
      this.fire(r, r.def.kind === 'webhook' ? 'webhook' : 'manual', payload, resolve).catch(reject);
    });
  }

  private arm(r: Registered): void {
    if (r.def.kind === 'cron' && r.def.schedule) {
      r.job = cron.schedule(r.def.schedule, () => void this.fireQuietly(r, 'cron'));
    } else if (r.def.kind === 'file' && r.def.path) {
      try {
        r.watcher = chokidar.watch(r.def.path, { ignoreInitial: true });
        r.watcher.on('all', (_event: string, p: string) => {
          // A save is often several events: fire once the file has been quiet.
          clearTimeout(r.timer);
          r.timer = setTimeout(
            () => void this.fireQuietly(r, 'file', { path: p }),
            FILE_DEBOUNCE_MS
          );
        });
      } catch (e) {
        logger.error('Module file trigger failed to watch', {
          moduleId: r.moduleId,
          trigger: r.def.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private disarm(r: Registered): void {
    if (r.job) void r.job.destroy();
    r.job = undefined;
    clearTimeout(r.timer);
    r.timer = undefined;
    void r.watcher?.close();
    r.watcher = undefined;
  }

  /** A scheduled or file firing: nobody is waiting, so failures are logged. */
  private async fireQuietly(r: Registered, source: TriggerSource, extra?: { path?: string }) {
    if (r.running) {
      logger.warn('Module trigger skipped: its previous run is still in flight', {
        moduleId: r.moduleId,
        trigger: r.def.id,
      });
      return;
    }
    try {
      await this.fire(r, source, undefined, undefined, extra?.path);
    } catch (e) {
      logger.error('Module trigger run failed', {
        moduleId: r.moduleId,
        trigger: r.def.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async fire(
    r: Registered,
    source: TriggerSource,
    payload?: unknown,
    onCreated?: (runId: string) => void,
    changedPath?: string
  ): Promise<void> {
    r.running = true;
    r.lastFiredAt = new Date().toISOString();
    try {
      await recordRun(
        {
          trigger: RUN_TRIGGER[source],
          moduleId: r.moduleId,
          triggerId: r.def.id,
          message: `${r.moduleId}: ${r.def.id}`,
          onCreated,
        },
        async () => {
          const runId = currentRunId() as string;
          const event: TriggerEvent = {
            triggerId: r.def.id,
            source,
            runId,
            payload,
            path: changedPath,
            signal: currentRunSignal() as AbortSignal,
          };
          const started = Date.now();
          const result = await r.def.handler(event);
          addRunStep(runId, {
            kind: 'tool',
            input: { module: r.moduleId, trigger: r.def.id, source },
            output: result === undefined ? undefined : result,
            status: 'ok',
            durationMs: Date.now() - started,
          });
          return result;
        }
      );
    } finally {
      r.running = false;
    }
  }
}
