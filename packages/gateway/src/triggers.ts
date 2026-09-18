/**
 * Triggers: cron schedules, file watchers and webhooks.
 *
 * Stored in the `triggers` table. A pre-0.5 ~/.clerq/triggers.json is imported
 * by the store on first start and archived as triggers.json.migrated, so this
 * module reads only the table — never the file.
 */

import path from 'node:path';
import cron from 'node-cron';
import chokidar from 'chokidar';
import { getStore, isStoreOpen } from './store.js';
import { logger } from './logger.js';

export interface CronTrigger {
  id: string;
  schedule: string;
  message: string;
}

export interface FileTrigger {
  id: string;
  path: string;
  message: string;
}

export interface WebhookTrigger {
  id: string;
  message: string;
}

export interface TriggersConfig {
  cron?: CronTrigger[];
  file?: FileTrigger[];
  webhooks?: Record<string, { message: string }>;
}

/** What fired a task: a schedule, or a watched file changing. */
export type TriggerSource = 'cron' | 'file';

export class TriggerConfigError extends Error {
  readonly code = 'invalid_triggers';
  constructor(message: string) {
    super(message);
    this.name = 'TriggerConfigError';
  }
}

const MAX_ID_LENGTH = 200;

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TriggerConfigError(`${what} must be a non-empty string.`);
  }
  return value;
}

/**
 * Check a config before it replaces the stored one. Rejecting a bad schedule
 * here, with a reason, beats accepting it and silently never firing.
 */
export function validateTriggers(input: unknown): Required<TriggersConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TriggerConfigError('Triggers config must be an object.');
  }
  const raw = input as Record<string, unknown>;
  const out: Required<TriggersConfig> = { cron: [], file: [], webhooks: {} };
  // One table holds all three kinds, so ids share a single namespace.
  const seen = new Set<string>();
  const claim = (id: unknown, what: string): string => {
    const text = requireText(id, `${what} id`);
    if (text.length > MAX_ID_LENGTH) {
      throw new TriggerConfigError(`${what} id is longer than ${MAX_ID_LENGTH} characters.`);
    }
    if (seen.has(text)) {
      throw new TriggerConfigError(`Trigger id "${text}" is used more than once.`);
    }
    seen.add(text);
    return text;
  };

  if (raw.cron !== undefined) {
    if (!Array.isArray(raw.cron)) throw new TriggerConfigError('cron must be a list.');
    for (const t of raw.cron as Array<Record<string, unknown>>) {
      const id = claim(t?.id, 'Cron trigger');
      const schedule = requireText(t.schedule, `Cron trigger "${id}" schedule`);
      if (!cron.validate(schedule)) {
        throw new TriggerConfigError(`Cron trigger "${id}" has an invalid schedule "${schedule}".`);
      }
      out.cron.push({
        id,
        schedule,
        message: requireText(t.message, `Cron trigger "${id}" message`),
      });
    }
  }

  if (raw.file !== undefined) {
    if (!Array.isArray(raw.file)) throw new TriggerConfigError('file must be a list.');
    for (const t of raw.file as Array<Record<string, unknown>>) {
      const id = claim(t?.id, 'File trigger');
      out.file.push({
        id,
        path: requireText(t.path, `File trigger "${id}" path`),
        message: requireText(t.message, `File trigger "${id}" message`),
      });
    }
  }

  if (raw.webhooks !== undefined) {
    if (!raw.webhooks || typeof raw.webhooks !== 'object' || Array.isArray(raw.webhooks)) {
      throw new TriggerConfigError('webhooks must be an object keyed by id.');
    }
    for (const [key, v] of Object.entries(raw.webhooks as Record<string, { message?: unknown }>)) {
      const id = claim(key, 'Webhook');
      out.webhooks[id] = { message: requireText(v?.message, `Webhook "${id}" message`) };
    }
  }

  return out;
}

function loadTriggers(): Required<TriggersConfig> {
  const config: Required<TriggersConfig> = { cron: [], file: [], webhooks: {} };
  const rows = getStore()
    .prepare(
      'SELECT id, kind, schedule, path, message FROM triggers WHERE enabled = 1 ORDER BY rowid'
    )
    .all();
  for (const r of rows) {
    const id = String(r.id);
    const message = String(r.message);
    if (r.kind === 'cron') config.cron.push({ id, schedule: String(r.schedule ?? ''), message });
    else if (r.kind === 'file') config.file.push({ id, path: String(r.path ?? ''), message });
    else if (r.kind === 'webhook') config.webhooks[id] = { message };
  }
  return config;
}

/**
 * Replace the stored triggers with `config`, atomically. Triggers that keep
 * their id keep their `last_fired` history.
 */
export function saveTriggers(config: unknown): void {
  const valid = validateTriggers(config);
  const db = getStore();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO triggers (id, kind, schedule, path, message, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, schedule = excluded.schedule,
       path = excluded.path, message = excluded.message, enabled = 1`
  );

  db.transaction(() => {
    const keep = new Set<string>();
    for (const t of valid.cron) {
      upsert.run(t.id, 'cron', t.schedule, null, t.message, now);
      keep.add(t.id);
    }
    for (const t of valid.file) {
      upsert.run(t.id, 'file', null, t.path, t.message, now);
      keep.add(t.id);
    }
    for (const [id, v] of Object.entries(valid.webhooks)) {
      upsert.run(id, 'webhook', null, null, v.message, now);
      keep.add(id);
    }
    const remove = db.prepare('DELETE FROM triggers WHERE id = ?');
    for (const r of db.prepare('SELECT id FROM triggers').all()) {
      if (!keep.has(String(r.id))) remove.run(String(r.id));
    }
  });
}

/** Record that a trigger fired. Never fails the task it describes. */
export function markTriggerFired(id: string): void {
  try {
    getStore()
      .prepare('UPDATE triggers SET last_fired = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  } catch (e) {
    logger.warn('Could not record trigger firing', {
      id,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

const cronJobs: cron.ScheduledTask[] = [];
let fileWatcher: ReturnType<typeof chokidar.watch> | null = null;
const webhookTriggers: Map<string, string> = new Map();
let taskRunner: ((message: string, source: TriggerSource) => Promise<unknown>) | null = null;

async function runTriggeredTask(message: string, source: TriggerSource, id: string): Promise<void> {
  logger.info('Trigger firing', { source, id, message: message.slice(0, 50) });
  if (!taskRunner) {
    logger.warn('Trigger skipped: no task runner');
    return;
  }
  markTriggerFired(id);
  try {
    await taskRunner(message, source);
  } catch (e) {
    logger.error('Trigger task failed', {
      source,
      id,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

function startCron(config: TriggersConfig): void {
  const list = config.cron ?? [];
  for (const t of list) {
    if (!cron.validate(t.schedule)) {
      logger.warn('Invalid cron schedule', { id: t.id, schedule: t.schedule });
      continue;
    }
    const job = cron.schedule(t.schedule, () => runTriggeredTask(t.message, 'cron', t.id));
    cronJobs.push(job);
  }
}

function startFileWatchers(config: TriggersConfig): void {
  const list = config.file ?? [];
  if (list.length === 0) return;
  const pathsToWatch = [...new Set(list.map((t) => t.path))];
  const pathToTriggers = new Map<string, FileTrigger[]>();
  for (const t of list) {
    const arr = pathToTriggers.get(t.path) ?? [];
    arr.push(t);
    pathToTriggers.set(t.path, arr);
  }
  try {
    fileWatcher = chokidar.watch(pathsToWatch, { ignoreInitial: true });
    fileWatcher.on('all', (_event: string, p: string) => {
      const triggers = pathToTriggers.get(p) ?? pathToTriggers.get(path.normalize(p));
      for (const t of triggers ?? []) {
        runTriggeredTask(t.message, 'file', t.id);
      }
    });
  } catch (e) {
    logger.error('File watcher failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

function loadWebhooks(config: TriggersConfig): void {
  const wh = config.webhooks ?? {};
  for (const [id, v] of Object.entries(wh)) {
    if (v?.message) webhookTriggers.set(id, v.message);
  }
}

/** Stop every cron job and file watcher, and forget the webhooks. */
export function stopTriggers(): void {
  cronJobs.forEach((j) => j.stop());
  cronJobs.length = 0;
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
  webhookTriggers.clear();
}

/** (Re)start triggers from the store. Safe to call again after a save. */
export function startTriggers(
  runner: (message: string, source: TriggerSource) => Promise<unknown>
): void {
  stopTriggers();
  taskRunner = runner;
  if (!isStoreOpen()) {
    logger.error('Triggers not started: the store is not open');
    return;
  }
  const config = loadTriggers();
  startCron(config);
  startFileWatchers(config);
  loadWebhooks(config);
}

export function getTriggers(): Required<TriggersConfig> {
  return loadTriggers();
}

export function getWebhookMessage(id: string): string | null {
  return webhookTriggers.get(id) ?? null;
}
