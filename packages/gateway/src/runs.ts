/**
 * Run records.
 *
 * Before 0.5 a trigger fired, logged 50 characters of its message, and threw
 * the result away: no record that it ran, no output, no failure history. Every
 * execution now gets a durable row moving through the documented state machine,
 * with each transition written before it takes effect so a run that dies
 * mid-flight is visible afterwards rather than vanishing.
 */

import crypto from 'node:crypto';
import { getStore } from './store.js';

export type RunStatus =
  | 'queued'
  | 'leased'
  | 'preparing'
  | 'executing'
  | 'verifying'
  | 'publishing'
  | 'awaiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RunTrigger = 'schedule' | 'event' | 'manual' | 'webhook';

export interface RunRecord {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  automationId?: string;
  exitReason?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

function rowToRun(r: Record<string, unknown>): RunRecord {
  return {
    id: String(r.id),
    status: r.status as RunStatus,
    trigger: r.trigger as RunTrigger,
    automationId: r.automation_id ? String(r.automation_id) : undefined,
    exitReason: r.exit_reason ? String(r.exit_reason) : undefined,
    startedAt: r.started_at ? String(r.started_at) : undefined,
    finishedAt: r.finished_at ? String(r.finished_at) : undefined,
    createdAt: String(r.created_at),
    costUsd: Number(r.cost_usd ?? 0),
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
  };
}

export function createRun(input: { trigger: RunTrigger; automationId?: string }): string {
  const id = `run_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO runs (id, automation_id, status, trigger, started_at, created_at)
       VALUES (?, ?, 'executing', ?, ?, ?)`
    )
    .run(id, input.automationId ?? null, input.trigger, now, now);
  return id;
}

export function finishRun(
  id: string,
  status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>,
  exitReason?: string
): void {
  getStore()
    .prepare('UPDATE runs SET status = ?, exit_reason = ?, finished_at = ? WHERE id = ?')
    .run(status, exitReason ?? null, new Date().toISOString(), id);
}

/** Append a step to a run. `seq` is assigned from the steps already recorded. */
export function addRunStep(
  runId: string,
  step: {
    kind: 'llm' | 'shell' | 'fs' | 'git' | 'gate' | 'tool';
    input?: unknown;
    output?: unknown;
    status?: string;
    durationMs?: number;
  }
): void {
  const db = getStore();
  const next =
    Number(
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM run_steps WHERE run_id = ?').get(runId)
        ?.m ?? 0
    ) + 1;
  db.prepare(
    `INSERT INTO run_steps (run_id, seq, kind, input, output, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    next,
    step.kind,
    step.input === undefined ? null : JSON.stringify(step.input),
    step.output === undefined ? null : JSON.stringify(step.output),
    step.status ?? null,
    step.durationMs ?? null,
    new Date().toISOString()
  );
}

export function listRuns(limit = 50): RunRecord[] {
  return getStore()
    .prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(rowToRun);
}

export function getRun(id: string): (RunRecord & { steps: unknown[] }) | null {
  const db = getStore();
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  if (!row) return null;
  const steps = db
    .prepare(
      'SELECT seq, kind, input, output, status, duration_ms, created_at FROM run_steps WHERE run_id = ? ORDER BY seq'
    )
    .all(id)
    .map((s) => ({
      seq: Number(s.seq),
      kind: String(s.kind),
      input: s.input ? JSON.parse(String(s.input)) : undefined,
      output: s.output ? JSON.parse(String(s.output)) : undefined,
      status: s.status ? String(s.status) : undefined,
      durationMs: s.duration_ms === null ? undefined : Number(s.duration_ms),
      createdAt: String(s.created_at),
    }));
  return { ...rowToRun(row), steps };
}

/**
 * Record one execution end to end: creates the run, runs `fn`, stores the
 * outcome as a step, and closes the run either way. Errors are recorded and
 * rethrown, never swallowed.
 */
export async function recordRun<T>(
  input: { trigger: RunTrigger; automationId?: string; message?: string },
  fn: () => Promise<T>
): Promise<T> {
  const runId = createRun({ trigger: input.trigger, automationId: input.automationId });
  const started = Date.now();
  try {
    const result = await fn();
    addRunStep(runId, {
      kind: 'llm',
      input: input.message,
      output: result,
      status: 'ok',
      durationMs: Date.now() - started,
    });
    finishRun(runId, 'done');
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    addRunStep(runId, {
      kind: 'llm',
      input: input.message,
      status: 'error',
      output: { error: message },
      durationMs: Date.now() - started,
    });
    finishRun(runId, 'failed', message);
    throw e;
  }
}
