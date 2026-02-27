/**
 * Triggers: cron, file watchers, webhooks.
 * Config from ~/.clerq/triggers.json. Audit-ready: each trigger logs on fire.
 */

import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import chokidar from 'chokidar';
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

function getTriggersPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'triggers.json');
}

function loadTriggers(): TriggersConfig {
  const p = getTriggersPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as TriggersConfig;
  } catch {
    return {};
  }
}

export function saveTriggers(config: TriggersConfig): void {
  const dir = path.dirname(getTriggersPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getTriggersPath(), JSON.stringify(config, null, 2), 'utf8');
}

const cronJobs: cron.ScheduledTask[] = [];
let fileWatcher: ReturnType<typeof chokidar.watch> | null = null;
const webhookTriggers: Map<string, string> = new Map();
let taskRunner: ((message: string) => Promise<unknown>) | null = null;

function setTaskRunner(runner: (message: string) => Promise<unknown>): void {
  taskRunner = runner;
}

async function runTriggeredTask(message: string, source: string, id?: string): Promise<void> {
  logger.info('Trigger firing', { source, id, message: message.slice(0, 50) });
  if (!taskRunner) {
    logger.warn('Trigger skipped: no task runner');
    return;
  }
  try {
    await taskRunner(message);
  } catch (e) {
    logger.error('Trigger task failed', { source, id, err: e instanceof Error ? e.message : String(e) });
  }
}

function startCron(config: TriggersConfig): void {
  cronJobs.forEach((j) => j.stop());
  cronJobs.length = 0;
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
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
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
  webhookTriggers.clear();
  const wh = config.webhooks ?? {};
  for (const [id, v] of Object.entries(wh)) {
    if (v?.message) webhookTriggers.set(id, v.message);
  }
}

export function startTriggers(runner: (message: string) => Promise<unknown>): void {
  setTaskRunner(runner);
  const config = loadTriggers();
  startCron(config);
  startFileWatchers(config);
  loadWebhooks(config);
}

export function getTriggers(): TriggersConfig {
  return loadTriggers();
}

export function getWebhookMessage(id: string): string | null {
  return webhookTriggers.get(id) ?? null;
}
