/**
 * Automations and the repositories they target, in the store.
 *
 * The YAML is kept as written, so what a user saved is what they get back;
 * the columns beside it are copies for listing and scheduling.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { audit } from '@clerq/store';
import type { Registry } from '@clerq/providers';
import { getRegistry } from '../agent/llm-provider.js';
import { getStore } from '../store.js';
import { cancelQueuedRun } from '../runs.js';
import { parseSpec, SpecError, type AutomationSpec } from './spec.js';

export interface Automation {
  id: string;
  name: string;
  /** The YAML as saved. */
  source: string;
  /**
   * The parsed spec, or null when a spec saved by an earlier release no longer
   * passes this release's checks. `problem` then says why; editing fixes it.
   */
  spec: AutomationSpec | null;
  problem?: string;
  enabled: boolean;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class AutomationError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict',
    message: string
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

/**
 * The registry a spec being saved or previewed is checked against: the
 * gateway's, which is what the builtin agent resolves models in. A stored spec
 * is not re-checked when it is read, so editing providers.yaml never makes the
 * list of automations fail; a run checks again before it starts. A registry that
 * cannot be read is no check here (the run says why).
 */
export function specRegistry(): Registry | undefined {
  try {
    return getRegistry();
  } catch {
    return undefined;
  }
}

function rowToAutomation(r: Record<string, unknown>): Automation {
  const source = String(r.spec);
  let spec: AutomationSpec | null = null;
  let problem: string | undefined;
  try {
    spec = parseSpec(source);
  } catch (e) {
    // One stale spec must not take the whole list down with it.
    problem = e instanceof Error ? e.message : String(e);
  }
  return {
    id: String(r.id),
    name: String(r.name),
    source,
    spec,
    ...(problem ? { problem } : {}),
    enabled: Number(r.enabled) === 1,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function columnsOf(spec: AutomationSpec) {
  return {
    name: spec.name,
    schedule: spec.schedule ?? null,
    driver: spec.agent.driver,
    model_policy: JSON.stringify({
      model: spec.agent.model ?? null,
      ...(spec.agent.escalate.length ? { escalate: spec.agent.escalate } : {}),
      ...(spec.agent.fallback.length ? { fallback: spec.agent.fallback } : {}),
    }),
    sandbox_profile: spec.sandbox.profile,
    budget: JSON.stringify(spec.budget),
  };
}

export function listAutomations(): Automation[] {
  return getStore().prepare('SELECT * FROM automations ORDER BY name').all().map(rowToAutomation);
}

export function getAutomation(id: string): Automation | null {
  const row = getStore().prepare('SELECT * FROM automations WHERE id = ?').get(id);
  return row ? rowToAutomation(row) : null;
}

function requireAutomation(id: string): Automation {
  const found = getAutomation(id);
  if (!found) throw new AutomationError('not_found', `No automation ${id}.`);
  return found;
}

function assertNameFree(name: string, exceptId?: string): void {
  const row = getStore().prepare('SELECT id FROM automations WHERE name = ?').get(name);
  if (row && String(row.id) !== exceptId) {
    throw new AutomationError('conflict', `An automation named "${name}" already exists.`);
  }
}

/**
 * Save a new automation. It always starts disabled: switching it on is a
 * separate, deliberate act, so whatever wrote the spec cannot also arm it.
 */
export function createAutomation(source: string, actor = 'operator'): Automation {
  const spec = parseSpec(source, { registry: specRegistry() });
  assertNameFree(spec.name);
  const id = `aut_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const c = columnsOf(spec);
  const db = getStore();
  db.prepare(
    `INSERT INTO automations
       (id, name, spec, schedule, enabled, driver, model_policy, sandbox_profile, budget, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    c.name,
    source,
    c.schedule,
    c.driver,
    c.model_policy,
    c.sandbox_profile,
    c.budget,
    now,
    now
  );
  audit(db, { actor, action: 'automation.created', subject: id, detail: { name: spec.name } });
  return requireAutomation(id);
}

/** Replace an automation's spec. Whether it is enabled does not change. */
export function updateAutomation(id: string, source: string, actor = 'operator'): Automation {
  requireAutomation(id);
  const spec = parseSpec(source, { registry: specRegistry() });
  assertNameFree(spec.name, id);
  const c = columnsOf(spec);
  const db = getStore();
  db.prepare(
    `UPDATE automations SET name = ?, spec = ?, schedule = ?, driver = ?, model_policy = ?,
       sandbox_profile = ?, budget = ?, next_run_at = NULL, updated_at = ?, last_slot_at = ?
     WHERE id = ?`
  ).run(
    c.name,
    source,
    c.schedule,
    c.driver,
    c.model_policy,
    c.sandbox_profile,
    c.budget,
    new Date().toISOString(),
    // A new schedule counts from now: slots of the old one are not missed.
    new Date().toISOString(),
    id
  );
  audit(db, { actor, action: 'automation.updated', subject: id, detail: { name: spec.name } });
  return requireAutomation(id);
}

export function setAutomationEnabled(
  id: string,
  enabled: boolean,
  actor = 'operator',
  reason?: string
): Automation {
  const found = requireAutomation(id);
  if (enabled && !found.spec) {
    throw new SpecError(`Fix the spec before enabling it: ${found.problem}`);
  }
  const db = getStore();
  // Switched off, it should not start anything more: a run still waiting is cancelled.
  if (!enabled) cancelQueuedRunsOf(id, 'The automation was switched off before this run started.');
  // Slots while it was off are not missed: its schedule counts from now.
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE automations SET enabled = ?, next_run_at = NULL, updated_at = ?,
       last_slot_at = CASE WHEN ? = 1 THEN ? ELSE last_slot_at END
     WHERE id = ?`
  ).run(enabled ? 1 : 0, now, enabled ? 1 : 0, now, id);
  audit(db, {
    actor,
    action: enabled ? 'automation.enabled' : 'automation.disabled',
    subject: id,
    detail: reason ? { reason } : undefined,
  });
  return requireAutomation(id);
}

export function deleteAutomation(id: string, actor = 'operator'): void {
  requireAutomation(id);
  const db = getStore();
  // A run still waiting has nothing to run once its automation is gone.
  cancelQueuedRunsOf(id, 'The automation was deleted before this run started.');
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  audit(db, { actor, action: 'automation.deleted', subject: id });
}

function cancelQueuedRunsOf(automationId: string, reason: string): void {
  for (const r of getStore()
    .prepare("SELECT id FROM runs WHERE automation_id = ? AND status = 'queued'")
    .all(automationId)) {
    cancelQueuedRun(String(r.id), reason);
  }
}

/** The latest schedule slot this automation has dealt with: run, or recorded as missed. */
export function getLastSlotAt(id: string): Date | null {
  const row = getStore().prepare('SELECT last_slot_at FROM automations WHERE id = ?').get(id);
  return row?.last_slot_at ? new Date(String(row.last_slot_at)) : null;
}

export function setLastSlotAt(id: string, at: Date | null): void {
  getStore()
    .prepare('UPDATE automations SET last_slot_at = ? WHERE id = ?')
    .run(at ? at.toISOString() : null, id);
}

export function setNextRunAt(id: string, at: Date | null): void {
  getStore()
    .prepare('UPDATE automations SET next_run_at = ? WHERE id = ?')
    .run(at ? at.toISOString() : null, id);
}

/** Start of the current calendar month in the host's time zone. */
function monthStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** What an automation's runs, and the sub-agents they started, have cost so far this month. */
export function monthSpendUsd(automationId: string, now = new Date()): number {
  const row = getStore()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs
       WHERE created_at >= ?
         AND (automation_id = ? OR parent_run_id IN (SELECT id FROM runs WHERE automation_id = ?))`
    )
    .get(monthStart(now).toISOString(), automationId, automationId);
  return Number(row?.total ?? 0);
}

/** Whether any earlier run of this automation pushed. */
export function hasPushedBefore(automationId: string): boolean {
  const row = getStore()
    .prepare(
      `SELECT 1 AS hit FROM runs WHERE automation_id = ? AND exit_reason LIKE 'Published%' LIMIT 1`
    )
    .get(automationId);
  return Boolean(row);
}

export function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
}

/** The repos row for a local path, created on first use. */
export function ensureLocalRepo(localPath: string): string {
  const resolved = expandHome(localPath);
  const db = getStore();
  const found = db.prepare('SELECT id FROM repos WHERE local_path = ?').get(resolved);
  if (found) return String(found.id);
  const id = `repo_${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  db.prepare(
    `INSERT INTO repos (id, name, kind, local_path, created_at) VALUES (?, ?, 'local', ?, ?)`
  ).run(id, `${path.basename(resolved)}-${hash}`, resolved, new Date().toISOString());
  return id;
}

/**
 * The repos row for an automation's repository, created on first use: a local
 * path, or a remote by its URL, with the clone in the workspace cache (once
 * the run knows where that is) and the vault secret it is reached with.
 */
export function ensureRepoRow(spec: AutomationSpec, clonePath?: string): string {
  if (spec.repo.kind === 'local') return ensureLocalRepo(spec.repo.path);
  const db = getStore();
  const { url, project, kind } = spec.repo;
  const found = db
    .prepare('SELECT id, local_path, credential_ref FROM repos WHERE url = ?')
    .get(url);
  if (found) {
    if (
      (clonePath && found.local_path !== clonePath) ||
      found.credential_ref !== spec.publish.tokenSecret
    ) {
      db.prepare(
        'UPDATE repos SET local_path = COALESCE(?, local_path), credential_ref = ? WHERE id = ?'
      ).run(clonePath ?? null, spec.publish.tokenSecret, String(found.id));
    }
    return String(found.id);
  }
  const id = `repo_${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
  db.prepare(
    `INSERT INTO repos (id, name, kind, url, local_path, credential_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `${project.replace(/\//g, '-')}-${hash}`,
    kind,
    url,
    clonePath ?? null,
    spec.publish.tokenSecret,
    new Date().toISOString()
  );
  return id;
}
