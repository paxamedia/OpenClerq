/**
 * Automations drafted in a chat (ROADMAP §6.3): draft → preview → dry run →
 * save, and nothing after that.
 *
 * A model in a managed conversation writes a spec with `draft_automation`. The
 * draft is checked by the real spec parser (errors go back to the model with
 * their line) and kept with the conversation. A person previews it, dry-runs
 * it (targets resolved, schedule expanded into real dates, drivers, models and
 * budgets checked, a cost estimate when past runs give one; nothing executed),
 * and saves it. A saved draft is an automation that is switched off and says
 * where it came from (`authored_by: chat <session>`); its first push waits for
 * approval whatever the draft asked for, as every automation's does. Switching
 * it on is a separate action in the Automations screen. No tool of the model's
 * saves, enables, edits or runs an automation: this file is reached from the
 * HTTP API a person uses, and from the one tool that only drafts.
 */

import crypto from 'node:crypto';
import { getStore } from '../store.js';
import { isAssertion, parseSpec, SpecError, type AutomationSpec } from '../automations/spec.js';
import {
  createAutomation,
  getAutomation,
  specRegistry,
  type Automation,
} from '../automations/store.js';
import { previewSpec } from '../automations/routes.js';
import { dueSlots, nextRunsOf } from '../automations/scheduler.js';
import type { RunnerDeps } from '../automations/runner.js';

export interface DraftSummary {
  name: string;
  description?: string;
  /** Cron, in the host's time zone; null when it only runs by hand. */
  schedule: string | null;
  nextRunAt: string | null;
  repo: string;
  driver: string;
  model: string | null;
  push: boolean;
  pullRequest: 'draft' | 'none';
  /** What the draft asked for; the first push waits for approval either way. */
  pushApproval: 'manual' | 'auto';
  maxUsdPerRun: number | null;
  maxUsdPerMonth: number | null;
  /** What the agent is told to do, in full. */
  prompt: string;
  /** The gates: each command, and each diff assertion, as written. */
  gates: string[];
  /** The isolation: `native` (none) unless the spec opts in. */
  sandbox: { profile: string; network: 'all' | string[] | null };
  permissionMode: string;
  allowedTools: string[];
  /** The memory types it reads, and whether notes an agent wrote are among them. */
  memoryRead: string[];
  memoryIncludeAgent: boolean;
  /** What a person should look at before saving it, in words. */
  warnings: string[];
}

export interface Draft {
  id: string;
  sessionId: string;
  /** The chat message's run that drafted it. */
  runId: string | null;
  name: string;
  /** The YAML as the model wrote it. */
  source: string;
  summary: DraftSummary | null;
  /** Why the YAML no longer passes this release's checks (it did when drafted). */
  problem?: string;
  /**
   * The automation it was saved as, once a person saved it. Null again if that
   * automation was deleted (the link is ON DELETE SET NULL), and then the draft
   * may be saved again.
   */
  automationId: string | null;
  savedAt: string | null;
  /** When it was last dry-run; saving needs a dry run of exactly this YAML. */
  dryRunAt: string | null;
  createdAt: string;
}

/** A draft that is not there, or not ready to save. */
export class DraftError extends Error {
  constructor(
    readonly code: 'not_found' | 'needs_dry_run' | 'already_saved',
    message: string
  ) {
    super(message);
    this.name = 'DraftError';
  }
}

function hashOf(source: string): string {
  return crypto.createHash('sha256').update(source).digest('hex');
}

/** The most drafts one conversation keeps; older ones go first. */
export const MAX_DRAFTS_PER_SESSION = 50;

export function summarise(spec: AutomationSpec): DraftSummary {
  return {
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    schedule: spec.schedule ?? null,
    nextRunAt: spec.schedule ? (nextRunsOf(spec.schedule, 1)[0]?.toISOString() ?? null) : null,
    repo: spec.repo.target,
    driver: spec.agent.driver,
    model: spec.agent.model ?? null,
    push: spec.publish.push,
    pullRequest: spec.publish.pullRequest,
    pushApproval: spec.approvals.push,
    maxUsdPerRun: spec.budget.maxUsdPerRun ?? null,
    maxUsdPerMonth: spec.budget.maxUsdPerMonth ?? null,
    prompt: spec.prompt,
    gates: spec.gates.map((g) => (isAssertion(g) ? g.assert : g.run)),
    sandbox: { profile: spec.sandbox.profile, network: spec.sandbox.network ?? null },
    permissionMode: spec.agent.permissionMode,
    allowedTools: spec.agent.allowedTools,
    memoryRead: spec.memory.read,
    memoryIncludeAgent: spec.memory.includeAgent,
    warnings: draftWarnings(spec),
  };
}

/** What deserves a second look in a drafted spec, before it is saved. */
export function draftWarnings(spec: AutomationSpec): string[] {
  const out: string[] = [];
  if (spec.publish.push && spec.approvals.push === 'auto') {
    out.push(
      'After its first push, it pushes without asking (approvals.push: auto). The first push still waits.'
    );
  }
  if (spec.sandbox.profile === 'native') {
    out.push('It runs without isolation: the agent and the gates have your account’s access.');
  }
  const commands = spec.gates.filter((g) => !isAssertion(g));
  if (commands.length > 0) {
    out.push(
      `Its gates run ${commands.length === 1 ? 'a command' : `${commands.length} commands`} on this machine.`
    );
  }
  if (spec.publish.push && spec.gates.length === 0) {
    out.push('It has no gates: nothing is checked before it pushes.');
  }
  if (spec.memory.includeAgent) {
    out.push('It reads notes an agent wrote (memory.include_agent).');
  }
  return out;
}

function rowToDraft(r: Record<string, unknown>): Draft {
  const source = String(r.spec);
  let summary: DraftSummary | null = null;
  let problem: string | undefined;
  try {
    summary = summarise(parseSpec(source));
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    runId: r.run_id ? String(r.run_id) : null,
    name: String(r.name),
    source,
    summary,
    ...(problem ? { problem } : {}),
    automationId: r.automation_id ? String(r.automation_id) : null,
    savedAt: r.saved_at ? String(r.saved_at) : null,
    // Only a dry run of this very YAML counts.
    dryRunAt: r.dry_run_hash === hashOf(source) && r.dry_run_at ? String(r.dry_run_at) : null,
    createdAt: String(r.created_at),
  };
}

/** The line a spec error points at, quoted, so the model sees what it wrote there. */
export function specErrorForModel(source: string, e: SpecError): string {
  const lines = [
    `The spec was not drafted: ${e.message}`,
    ...(e.line ? [`  ${e.line} | ${source.split('\n')[e.line - 1] ?? ''}`] : []),
    'Fix it and call draft_automation again with the whole spec.',
  ];
  return lines.join('\n');
}

/**
 * Check a spec with the real parser and keep it as a draft of this
 * conversation. Throws SpecError, with the line, when it does not parse.
 */
export function createDraft(sessionId: string, runId: string | null, source: string): Draft {
  if (typeof source !== 'string') throw new SpecError('The spec must be YAML text.');
  const spec = parseSpec(source, { registry: specRegistry() });
  const id = `drf_${crypto.randomUUID()}`;
  const db = getStore();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO automation_drafts (id, session_id, run_id, name, spec, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, runId, spec.name, source, new Date().toISOString());
    db.prepare(
      `DELETE FROM automation_drafts WHERE session_id = ? AND automation_id IS NULL AND id NOT IN (
         SELECT id FROM automation_drafts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    ).run(sessionId, sessionId, MAX_DRAFTS_PER_SESSION);
  });
  return getDraft(sessionId, id) as Draft;
}

export function getDraft(sessionId: string, id: string): Draft | null {
  const row = getStore()
    .prepare('SELECT * FROM automation_drafts WHERE id = ? AND session_id = ?')
    .get(id, sessionId);
  return row ? rowToDraft(row) : null;
}

export function listDrafts(sessionId: string): Draft[] {
  return getStore()
    .prepare('SELECT * FROM automation_drafts WHERE session_id = ? ORDER BY created_at, rowid')
    .all(sessionId)
    .map(rowToDraft);
}

function requireDraft(sessionId: string, id: string): Draft {
  const draft = getDraft(sessionId, id);
  // A draft of another conversation is not found here either.
  if (!draft) throw new DraftError('not_found', `No draft ${id} in this conversation.`);
  return draft;
}

export interface CostEstimate {
  /** What a run of this driver and model has cost on average, from past runs; null without any. */
  perRunUsd: number | null;
  /** Firings in the next 30 days, times the average. Null without a schedule or data. */
  perMonthUsd: number | null;
  /** Past runs the average is taken from. */
  basedOnRuns: number;
  /** Firings in the next 30 days (counted up to 1,000). */
  firingsPerMonth: number | null;
  /** The ceiling the spec's own budget sets, per run and per month. */
  capPerRunUsd: number | null;
  capPerMonthUsd: number | null;
  note: string;
}

/** Runs the average is taken from, at most, and how far back. */
const ESTIMATE_RUNS = 50;
const ESTIMATE_DAYS = 90;

/**
 * An estimate from what finished automation runs with the same driver and
 * model cost in the last 90 days. Nothing is guessed: without such runs the
 * estimate says so, and gives the spec's own budget as the ceiling.
 */
export function estimateCost(spec: AutomationSpec, now = new Date()): CostEstimate {
  const since = new Date(now.getTime() - ESTIMATE_DAYS * 86_400_000).toISOString();
  const model = spec.agent.model ?? null;
  const rows = getStore()
    .prepare(
      `SELECT r.cost_usd FROM runs r JOIN automations a ON a.id = r.automation_id
       WHERE a.driver = ? AND json_extract(a.model_policy, '$.model') IS ?
         AND r.status IN ('done', 'failed') AND r.created_at >= ? AND r.cost_usd > 0
       ORDER BY r.created_at DESC LIMIT ?`
    )
    .all(spec.agent.driver, model, since, ESTIMATE_RUNS);
  const costs = rows.map((r) => Number(r.cost_usd));
  const perRun =
    costs.length > 0
      ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1e4) / 1e4
      : null;
  const slots = spec.schedule
    ? dueSlots(spec.schedule, now, new Date(now.getTime() + 30 * 86_400_000))
    : null;
  const firings = spec.schedule ? (slots?.count ?? 0) : null;
  const perMonth =
    perRun !== null && firings !== null ? Math.round(perRun * firings * 100) / 100 : null;
  const who = `${spec.agent.driver}${model ? ` with ${model}` : ''}`;
  return {
    perRunUsd: perRun,
    perMonthUsd: perMonth,
    basedOnRuns: costs.length,
    firingsPerMonth: firings,
    capPerRunUsd: spec.budget.maxUsdPerRun ?? null,
    capPerMonthUsd: spec.budget.maxUsdPerMonth ?? null,
    note:
      perRun === null
        ? `No finished runs of ${who} in the last ${ESTIMATE_DAYS} days to estimate from.`
        : `Average of the last ${costs.length} finished run${costs.length === 1 ? '' : 's'} of ${who}.`,
  };
}

/**
 * What saving and running the draft would do, without doing any of it: the
 * automation preview's checks (repository, drivers, models, budgets, tokens,
 * approvals), the next firings as real dates in the host's time zone, and a
 * cost estimate.
 */
export async function dryRunDraft(sessionId: string, id: string, deps: RunnerDeps) {
  const draft = requireDraft(sessionId, id);
  const spec = parseSpec(draft.source, { registry: specRegistry() });
  const preview = await previewSpec(spec, deps);
  // Saving is allowed once this YAML has been dry-run.
  getStore()
    .prepare('UPDATE automation_drafts SET dry_run_hash = ?, dry_run_at = ? WHERE id = ?')
    .run(hashOf(draft.source), new Date().toISOString(), draft.id);
  // A chat-authored automation's first push waits whatever the draft says; the
  // preview already judges it as one that has never pushed.
  return {
    draftId: draft.id,
    ...preview,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    estimate: estimateCost(spec),
    executed: false as const,
  };
}

/**
 * Save a draft as an automation, at a person's request: switched off, with
 * `authored_by: chat <session>`. Only after a dry run of exactly this YAML, and
 * once (again only if the automation it became was deleted).
 */
export function saveDraft(sessionId: string, id: string, actor = 'operator'): Automation {
  const draft = requireDraft(sessionId, id);
  if (draft.automationId) {
    throw new DraftError(
      'already_saved',
      `This draft was already saved as ${getAutomation(draft.automationId)?.name ?? 'an automation'}.`
    );
  }
  if (!draft.dryRunAt) {
    throw new DraftError('needs_dry_run', 'Dry-run this draft before saving it.');
  }
  const created = createAutomation(draft.source, actor, { authoredBy: `chat ${sessionId}` });
  getStore()
    .prepare('UPDATE automation_drafts SET automation_id = ?, saved_at = ? WHERE id = ?')
    .run(created.id, new Date().toISOString(), draft.id);
  return created;
}
