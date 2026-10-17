/**
 * Run records.
 *
 * Every execution — a task, a trigger firing, a chat message — gets a durable
 * row moving through the documented state machine. Each transition is written
 * before it takes effect, so a run that dies mid-flight is still visible.
 */

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getStore, isStoreOpen } from './store.js';
import { emit } from './events.js';
import { logger } from './logger.js';

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
  automationName?: string;
  repoId?: string;
  /** The branch an automation run committed to. */
  branch?: string;
  prUrl?: string;
  /** What the run was asked to do. */
  input?: string;
  exitReason?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  /** Sum of the priced model calls. A lower bound when `costKnown` is false. */
  costUsd: number;
  /** False when at least one successful model call had no price in the registry. */
  costKnown: boolean;
  tokensIn: number;
  tokensOut: number;
}

/** Selects a run with `unpriced_calls`, the input `costKnown` is derived from. */
const RUN_COLUMNS = `runs.*, (
  SELECT COUNT(*) FROM run_steps s
  WHERE s.run_id = runs.id AND s.kind = 'llm' AND s.status = 'ok' AND s.cost_usd IS NULL
) AS unpriced_calls, (
  SELECT name FROM automations a WHERE a.id = runs.automation_id
) AS automation_name`;

function rowToRun(r: Record<string, unknown>): RunRecord {
  return {
    id: String(r.id),
    status: r.status as RunStatus,
    trigger: r.trigger as RunTrigger,
    automationId: r.automation_id ? String(r.automation_id) : undefined,
    automationName: r.automation_name ? String(r.automation_name) : undefined,
    repoId: r.repo_id ? String(r.repo_id) : undefined,
    branch: r.branch ? String(r.branch) : undefined,
    prUrl: r.pr_url ? String(r.pr_url) : undefined,
    input: r.input ? String(r.input) : undefined,
    exitReason: r.exit_reason ? String(r.exit_reason) : undefined,
    startedAt: r.started_at ? String(r.started_at) : undefined,
    finishedAt: r.finished_at ? String(r.finished_at) : undefined,
    createdAt: String(r.created_at),
    costUsd: Number(r.cost_usd ?? 0),
    costKnown: Number(r.unpriced_calls ?? 0) === 0,
    tokensIn: Number(r.tokens_in ?? 0),
    tokensOut: Number(r.tokens_out ?? 0),
  };
}

export function createRun(input: {
  trigger: RunTrigger;
  automationId?: string;
  input?: string;
  status?: RunStatus;
}): string {
  const id = `run_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO runs (id, automation_id, input, status, trigger, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.automationId ?? null,
      input.input ?? null,
      input.status ?? 'executing',
      input.trigger,
      now,
      now
    );
  return id;
}

export function finishRun(
  id: string,
  status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>,
  exitReason?: string
): void {
  // A reason recorded during the run ("No changes") stands unless replaced.
  getStore()
    .prepare(
      'UPDATE runs SET status = ?, exit_reason = COALESCE(?, exit_reason), finished_at = ? WHERE id = ?'
    )
    .run(status, exitReason ?? null, new Date().toISOString(), id);
}

/** Move a run to its next state, before the work of that state starts. */
export function setRunStatus(id: string, status: RunStatus): void {
  getStore().prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  emit('run.status', { status }, { runId: id });
}

/** Record what a run produced along the way. */
export function setRunFields(
  id: string,
  fields: { repoId?: string; branch?: string; prUrl?: string; exitReason?: string }
): void {
  const columns: Record<string, string | undefined> = {
    repo_id: fields.repoId,
    branch: fields.branch,
    pr_url: fields.prUrl,
    exit_reason: fields.exitReason,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (set.length === 0) return;
  getStore()
    .prepare(`UPDATE runs SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...set.map(([, v]) => v as string), id);
}

/**
 * Mark runs a previous gateway left unfinished as failed. Nothing can still be
 * working on them: their processes were tied to the gateway that died.
 */
export function reapInterruptedRuns(): string[] {
  const db = getStore();
  const ids = db
    .prepare("SELECT id FROM runs WHERE status NOT IN ('done', 'failed', 'cancelled')")
    .all()
    .map((r) => String(r.id));
  const mark = db.prepare(
    `UPDATE runs SET status = 'failed', finished_at = ?,
       exit_reason = 'Interrupted: the gateway stopped while this run was in progress.'
     WHERE id = ?`
  );
  const now = new Date().toISOString();
  for (const id of ids) mark.run(now, id);
  return ids;
}

export type ArtifactKind = 'diff' | 'log' | 'file' | 'report';

/** The most of one artifact kept, in characters. */
const MAX_ARTIFACT_CHARS = 2_000_000;

export function addArtifact(
  runId: string,
  kind: ArtifactKind,
  content: string,
  name?: string
): number {
  const text =
    content.length > MAX_ARTIFACT_CHARS
      ? `${content.slice(0, MAX_ARTIFACT_CHARS)}\n[…truncated at ${MAX_ARTIFACT_CHARS} characters]`
      : content;
  const res = getStore()
    .prepare(
      'INSERT INTO artifacts (run_id, kind, path, blob, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      runId,
      kind,
      name ?? null,
      text,
      crypto.createHash('sha256').update(text).digest('hex'),
      new Date().toISOString()
    );
  return Number(res.lastInsertRowid);
}

export interface ArtifactInfo {
  id: number;
  kind: ArtifactKind;
  name?: string;
  size: number;
  sha256: string;
}

function listArtifacts(runId: string): ArtifactInfo[] {
  return getStore()
    .prepare(
      'SELECT id, kind, path, LENGTH(blob) AS size, sha256 FROM artifacts WHERE run_id = ? ORDER BY id'
    )
    .all(runId)
    .map((a) => ({
      id: Number(a.id),
      kind: a.kind as ArtifactKind,
      name: a.path ? String(a.path) : undefined,
      size: Number(a.size ?? 0),
      sha256: String(a.sha256),
    }));
}

export function getArtifact(
  runId: string,
  id: number
): (ArtifactInfo & { content: string }) | null {
  const a = getStore()
    .prepare('SELECT id, kind, path, blob, sha256 FROM artifacts WHERE run_id = ? AND id = ?')
    .get(runId, id);
  if (!a) return null;
  const content = a.blob === null || a.blob === undefined ? '' : String(a.blob);
  return {
    id: Number(a.id),
    kind: a.kind as ArtifactKind,
    name: a.path ? String(a.path) : undefined,
    size: content.length,
    sha256: String(a.sha256),
    content,
  };
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
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number | null;
  }
): number {
  const db = getStore();
  const next =
    Number(
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM run_steps WHERE run_id = ?').get(runId)
        ?.m ?? 0
    ) + 1;
  db.prepare(
    `INSERT INTO run_steps
       (run_id, seq, kind, input, output, status, duration_ms, tokens_in, tokens_out, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    next,
    step.kind,
    step.input === undefined ? null : JSON.stringify(step.input),
    step.output === undefined ? null : JSON.stringify(step.output),
    step.status ?? null,
    step.durationMs ?? null,
    step.tokensIn ?? null,
    step.tokensOut ?? null,
    step.costUsd ?? null,
    new Date().toISOString()
  );
  return next;
}

/** Fill in a step once the work it describes has finished. */
export function completeRunStep(
  runId: string,
  seq: number,
  step: { output?: unknown; status?: string; durationMs?: number }
): void {
  getStore()
    .prepare(
      `UPDATE run_steps SET output = ?, status = COALESCE(?, status), duration_ms = COALESCE(?, duration_ms)
       WHERE run_id = ? AND seq = ?`
    )
    .run(
      step.output === undefined ? null : JSON.stringify(step.output),
      step.status ?? null,
      step.durationMs ?? null,
      runId,
      seq
    );
}

export function listRuns(limit = 50): RunRecord[] {
  return getStore()
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map(rowToRun);
}

export function getRun(
  id: string
): (RunRecord & { steps: unknown[]; artifacts: ArtifactInfo[] }) | null {
  const db = getStore();
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id);
  if (!row) return null;
  const steps = db
    .prepare(
      `SELECT seq, kind, input, output, status, duration_ms, tokens_in, tokens_out, cost_usd, created_at
       FROM run_steps WHERE run_id = ? ORDER BY seq`
    )
    .all(id)
    .map((s) => ({
      seq: Number(s.seq),
      kind: String(s.kind),
      input: s.input ? JSON.parse(String(s.input)) : undefined,
      output: s.output ? JSON.parse(String(s.output)) : undefined,
      status: s.status ? String(s.status) : undefined,
      durationMs: s.duration_ms === null ? undefined : Number(s.duration_ms),
      tokensIn: s.tokens_in === null ? undefined : Number(s.tokens_in),
      tokensOut: s.tokens_out === null ? undefined : Number(s.tokens_out),
      // null, not undefined: an unknown cost must survive serialisation to JSON.
      costUsd: s.cost_usd === null ? null : Number(s.cost_usd),
      createdAt: String(s.created_at),
    }));
  return { ...rowToRun(row), steps, artifacts: listArtifacts(id) };
}

/** The run the current async call chain belongs to, if any. */
const runContext = new AsyncLocalStorage<{ runId: string; controller: AbortController }>();

/** Runs still executing, so the kill switch can reach every one of them. */
const activeRuns = new Map<string, AbortController>();

export function currentRunId(): string | undefined {
  return runContext.getStore()?.runId;
}

/**
 * The current run's cancellation signal. A model call inside a run listens to
 * it, so cancelling the run stops the call — and the spend — mid-flight.
 */
export function currentRunSignal(): AbortSignal | undefined {
  return runContext.getStore()?.controller.signal;
}

export function activeRunIds(): string[] {
  return [...activeRuns.keys()];
}

/** Cancel one run. Returns false when it was not running. */
export function cancelRun(runId: string, reason = 'Cancelled'): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort(new RunCancelled(reason));
  return true;
}

/** Cancel every run in flight. Returns how many were stopped. */
export function cancelAllRuns(reason = 'Cancelled'): number {
  const ids = activeRunIds();
  for (const id of ids) cancelRun(id, reason);
  return ids.length;
}

/** Thrown into a run that was cancelled, so it ends as cancelled rather than failed. */
export class RunCancelled extends Error {
  readonly cancelled = true;
  constructor(reason: string) {
    super(reason);
    this.name = 'RunCancelled';
  }
}

function isCancellation(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e as { cancelled?: unknown })?.cancelled === true;
}

export interface ModelCallRecord {
  provider: string;
  model: string;
  prompt: string;
  status: 'ok' | 'error';
  text?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
  latencyMs: number;
}

/**
 * Account for one model call against the run that made it: a step carrying its
 * tokens and cost, and the run's totals incremented in the same transaction so
 * the two can never disagree.
 *
 * Outside a run this does nothing. Accounting must never fail the call it
 * describes, so store errors are logged rather than thrown.
 */
export function recordModelCall(call: ModelCallRecord): void {
  const runId = currentRunId();
  emit(
    'model.called',
    {
      provider: call.provider,
      model: call.model,
      status: call.status,
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      costUsd: call.costUsd,
      latencyMs: call.latencyMs,
    },
    { runId }
  );
  if (!runId || !isStoreOpen()) return;

  try {
    const db = getStore();
    db.transaction(() => {
      addRunStep(runId, {
        kind: 'llm',
        input: { provider: call.provider, model: call.model, prompt: call.prompt },
        output: call.status === 'ok' ? { text: call.text } : { error: call.error },
        status: call.status,
        durationMs: call.latencyMs,
        tokensIn: call.tokensIn,
        tokensOut: call.tokensOut,
        costUsd: call.costUsd,
      });
      db.prepare(
        `UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
                         cost_usd = cost_usd + ?
         WHERE id = ?`
      ).run(call.tokensIn ?? 0, call.tokensOut ?? 0, call.costUsd ?? 0, runId);
    });
  } catch (e) {
    logger.warn('Could not record model call against run', {
      runId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Record one execution end to end: creates the run, runs `fn` with the run as
 * its context so every model call inside it is accounted against it, and
 * closes the run either way. Errors are recorded and rethrown, never swallowed.
 *
 * `signal` ties the run to something outside it — a client connection, say —
 * so the run is cancelled when that goes away. A cancelled run is recorded as
 * cancelled, not failed.
 */
export async function recordRun<T>(
  input: {
    trigger: RunTrigger;
    automationId?: string;
    message?: string;
    signal?: AbortSignal;
    /** The state the run starts in. Default: executing. */
    status?: RunStatus;
    /** Called once the run exists, before `fn` starts. */
    onCreated?: (runId: string) => void;
  },
  fn: () => Promise<T>
): Promise<T> {
  const runId = createRun({
    trigger: input.trigger,
    automationId: input.automationId,
    input: input.message,
    status: input.status,
  });
  input.onCreated?.(runId);
  const controller = new AbortController();
  const detach = link(input.signal, controller);
  activeRuns.set(runId, controller);
  emit('run.started', { trigger: input.trigger, automationId: input.automationId }, { runId });
  try {
    const result = await runContext.run({ runId, controller }, fn);
    // A run whose work swallowed the cancellation still did not finish.
    if (controller.signal.aborted) throw reasonOf(controller.signal);
    finishRun(runId, 'done');
    emit('run.completed', {}, { runId });
    return result;
  } catch (e) {
    if (isCancellation(e, controller.signal)) {
      // Cancelled from outside: the signal says why. Cancelled by the run's own
      // decision (a push nobody approved): the error does.
      const reason = controller.signal.aborted
        ? reasonOf(controller.signal).message
        : e instanceof Error
          ? e.message
          : 'Cancelled';
      finishRun(runId, 'cancelled', reason);
      emit('run.cancelled', { reason }, { runId });
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    finishRun(runId, 'failed', message);
    emit('run.failed', { error: message }, { runId });
    throw e;
  } finally {
    activeRuns.delete(runId);
    detach();
  }
}

/** Abort `controller` when `signal` aborts. Returns a function that unlinks them. */
function link(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => controller.abort(new RunCancelled('The client disconnected.'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new RunCancelled('Cancelled');
}
