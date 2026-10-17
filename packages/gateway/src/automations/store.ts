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
import { getStore } from '../store.js';
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
    model_policy: JSON.stringify({ model: spec.agent.model ?? null }),
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
  const spec = parseSpec(source);
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
  const spec = parseSpec(source);
  assertNameFree(spec.name, id);
  const c = columnsOf(spec);
  const db = getStore();
  db.prepare(
    `UPDATE automations SET name = ?, spec = ?, schedule = ?, driver = ?, model_policy = ?,
       sandbox_profile = ?, budget = ?, next_run_at = NULL, updated_at = ? WHERE id = ?`
  ).run(
    c.name,
    source,
    c.schedule,
    c.driver,
    c.model_policy,
    c.sandbox_profile,
    c.budget,
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
  db.prepare(
    'UPDATE automations SET enabled = ?, next_run_at = NULL, updated_at = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, new Date().toISOString(), id);
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
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  audit(db, { actor, action: 'automation.deleted', subject: id });
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

/** What an automation's runs have cost so far this month. */
export function monthSpendUsd(automationId: string, now = new Date()): number {
  const row = getStore()
    .prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE automation_id = ? AND created_at >= ?'
    )
    .get(automationId, monthStart(now).toISOString());
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
