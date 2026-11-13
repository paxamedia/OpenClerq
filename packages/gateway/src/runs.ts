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
import { gatewayOwner } from './agent-processes.js';

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
  /** The module whose trigger started the run. */
  moduleId?: string;
  /** Which of its triggers. */
  triggerId?: string;
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
  /** A model a person named for this run, which it used as chosen. */
  modelOverride?: string;
}

/** Selects a run with `unpriced_calls`, the input `costKnown` is derived from. */
const RUN_COLUMNS = `runs.*, (
  SELECT COUNT(*) FROM run_steps s
  WHERE s.run_id = runs.id AND s.kind = 'llm' AND s.status IN ('ok', 'unaccounted') AND s.cost_usd IS NULL
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
    moduleId: r.module_id ? String(r.module_id) : undefined,
    triggerId: r.trigger_ref ? String(r.trigger_ref) : undefined,
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
    modelOverride: r.model_override ? String(r.model_override) : undefined,
  };
}

export function createRun(input: {
  trigger: RunTrigger;
  automationId?: string;
  moduleId?: string;
  triggerId?: string;
  input?: string;
  status?: RunStatus;
  repoId?: string;
  /** A model a person named for this run; it is used as chosen, with no fallback. */
  modelOverride?: string;
}): string {
  const id = `run_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const status = input.status ?? 'executing';
  // Who started it, so a later gateway can tell a run still being worked on
  // from one whose gateway died. A queued run has no owner, and has not
  // started, until a gateway leases it.
  const queued = status === 'queued';
  const owner = queued ? { pid: null, start: null } : gatewayOwner();
  getStore()
    .prepare(
      `INSERT INTO runs (id, automation_id, module_id, trigger_ref, input, status, trigger, repo_id, started_at, created_at, owner_pid, owner_start, model_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.automationId ?? null,
      input.moduleId ?? null,
      input.triggerId ?? null,
      input.input ?? null,
      status,
      input.trigger,
      input.repoId ?? null,
      queued ? null : now,
      now,
      owner.pid,
      owner.start,
      input.modelOverride ?? null
    );
  return id;
}

export function finishRun(
  id: string,
  status: Extract<RunStatus, 'done' | 'failed' | 'cancelled'>,
  exitReason?: string
): boolean {
  // A reason recorded during the run ("No changes") stands unless replaced.
  // Only an unfinished run this gateway owns: one another gateway reclaimed
  // (its lease expired) is that gateway's to settle.
  const res = getStore()
    .prepare(
      `UPDATE runs SET status = ?, exit_reason = COALESCE(?, exit_reason), finished_at = ?, lease_until = NULL
       WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')
         AND (owner_pid IS NULL OR owner_pid = ?)`
    )
    .run(status, exitReason ?? null, new Date().toISOString(), id, process.pid);
  return Number(res.changes) > 0;
}

/** Move a run to its next state, before the work of that state starts. */
export function setRunStatus(id: string, status: RunStatus): void {
  getStore().prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  emit('run.status', { status }, { runId: id });
}

/**
 * Move a run from `from` to `to`, and only from `from`: a run that has moved on
 * since (finished, cancelled) is left as it is. Returns whether it moved.
 */
export function setRunStatusIf(id: string, from: RunStatus, to: RunStatus): boolean {
  const res = getStore()
    .prepare('UPDATE runs SET status = ? WHERE id = ? AND status = ?')
    .run(to, id, from);
  if (Number(res.changes) === 0) return false;
  emit('run.status', { status: to }, { runId: id });
  return true;
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

export const INTERRUPTED = 'Interrupted: the gateway stopped while this run was in progress.';

/** An unfinished run, as recovery sees it. */
export interface UnfinishedRun {
  id: string;
  status: RunStatus;
  automationId?: string;
  attempt: number;
  /** The gateway that owned it, as recorded: compared again when it is claimed. */
  ownerPid: number | null;
  ownerStart: string | null;
}

/**
 * Runs a previous gateway left unfinished: started (not queued, which wait for
 * any gateway) and not finished. Runs in `except` are the ones a gateway that
 * is still running is working on.
 */
export function interruptedRuns(options: { except?: ReadonlySet<string> } = {}): UnfinishedRun[] {
  return getStore()
    .prepare(
      `SELECT id, status, automation_id, attempt, owner_pid, owner_start FROM runs
       WHERE status NOT IN ('queued', 'done', 'failed', 'cancelled')`
    )
    .all()
    .filter((r) => !options.except?.has(String(r.id)))
    .map(unfinishedOf);
}

export function unfinishedOf(r: Record<string, unknown>): UnfinishedRun {
  return {
    id: String(r.id),
    status: r.status as RunStatus,
    automationId: r.automation_id ? String(r.automation_id) : undefined,
    attempt: Number(r.attempt ?? 1),
    ownerPid: r.owner_pid === null || r.owner_pid === undefined ? null : Number(r.owner_pid),
    ownerStart: r.owner_start ? String(r.owner_start) : null,
  };
}

/**
 * Take over a run nothing is working on, before doing anything to it: it
 * becomes this gateway's, with a fresh lease, only if it is still exactly as
 * it was read (same status, same owner, and with `leaseBefore`, a lease that
 * expired before then). Two gateways that both find it abandoned cannot both
 * settle it. Returns whether this one got it.
 */
export function claimAbandonedRun(
  run: UnfinishedRun,
  opts: { leaseMs: number; leaseBefore?: string }
): boolean {
  const me = gatewayOwner();
  const res = getStore()
    .prepare(
      `UPDATE runs SET owner_pid = ?, owner_start = ?, lease_until = ?
       WHERE id = ? AND status = ? AND owner_pid IS ? AND owner_start IS ?
         ${opts.leaseBefore ? 'AND lease_until IS NOT NULL AND lease_until < ?' : ''}`
    )
    .run(
      me.pid,
      me.start,
      new Date(Date.now() + opts.leaseMs).toISOString(),
      run.id,
      run.status,
      run.ownerPid,
      run.ownerStart,
      ...(opts.leaseBefore ? [opts.leaseBefore] : [])
    );
  return Number(res.changes) === 1;
}

/**
 * Mark a run that nothing is working on any more as failed. With `from`, only
 * while it is still in that state; with `ownerPid`, only while that gateway
 * owns it (the one that claimed it).
 */
export function failAbandonedRun(
  id: string,
  reason = INTERRUPTED,
  opts: { from?: RunStatus; ownerPid?: number } = {}
): boolean {
  const res = getStore()
    .prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?, exit_reason = ?, lease_until = NULL
       WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')
         AND (? IS NULL OR status = ?) AND (? IS NULL OR owner_pid = ?)`
    )
    .run(
      new Date().toISOString(),
      reason,
      id,
      opts.from ?? null,
      opts.from ?? null,
      opts.ownerPid ?? null,
      opts.ownerPid ?? null
    );
  if (Number(res.changes) === 0) return false;
  emit('run.failed', { error: reason }, { runId: id });
  return true;
}

/**
 * Mark runs a previous gateway left unfinished as failed. Nothing can still be
 * working on them: their processes were tied to the gateway that died. Runs in
 * `except` are the ones a gateway that is still running is working on, and are
 * left as they are. Queued runs are not interrupted: they wait for a gateway.
 */
export function reapInterruptedRuns(options: { except?: ReadonlySet<string> } = {}): string[] {
  const ids = interruptedRuns(options).map((r) => r.id);
  for (const id of ids) failAbandonedRun(id);
  return ids;
}

/**
 * Put a run back in the queue to be tried again once `notBefore` has passed:
 * written before anything else happens to it, so a gateway that stops now
 * still finds it queued. It loses its owner and its lease, and its attempt
 * count goes up unless `sameAttempt` (it never started any work).
 */
export function requeueRun(
  id: string,
  opts: {
    notBefore?: Date;
    reason: string;
    sameAttempt?: boolean;
    /** Only while the run is still in this state. */
    from?: RunStatus;
    /** Only while this gateway owns it. Default: this one. */
    ownerPid?: number;
  }
): boolean {
  const owner = opts.ownerPid ?? process.pid;
  const res = getStore()
    .prepare(
      `UPDATE runs SET status = 'queued', lease_until = NULL, owner_pid = NULL, owner_start = NULL,
         not_before = ?, attempt = attempt + ?, exit_reason = ?
       WHERE id = ? AND status NOT IN ('queued', 'done', 'failed', 'cancelled')
         AND (? IS NULL OR status = ?) AND owner_pid = ?`
    )
    .run(
      opts.notBefore?.toISOString() ?? null,
      opts.sameAttempt ? 0 : 1,
      opts.reason,
      id,
      opts.from ?? null,
      opts.from ?? null,
      owner
    );
  if (Number(res.changes) === 0) return false;
  emit('run.status', { status: 'queued' }, { runId: id });
  emit(
    'run.queued',
    { retry: !opts.sameAttempt, notBefore: opts.notBefore?.toISOString() },
    { runId: id }
  );
  return true;
}

/** Cancel a run that is still waiting in the queue. Returns false when it is not queued. */
export function cancelQueuedRun(id: string, reason = 'Cancelled'): boolean {
  const res = getStore()
    .prepare(
      `UPDATE runs SET status = 'cancelled', exit_reason = ?, finished_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .run(reason, new Date().toISOString(), id);
  if (Number(res.changes) === 0) return false;
  emit('run.cancelled', { reason }, { runId: id });
  return true;
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

export type ToolCallStatus = 'running' | 'ok' | 'error' | 'denied';
export type ApprovalState = 'not_required' | 'approved' | 'denied';

/** Record a tool call an agent started, beside the step that shows it. Returns its row id. */
export function addToolCall(
  runId: string,
  call: { stepSeq?: number; callId?: string; name: string; input?: unknown }
): number {
  const res = getStore()
    .prepare(
      `INSERT INTO tool_calls (run_id, step_seq, call_id, name, input, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(
      runId,
      call.stepSeq ?? null,
      call.callId ?? null,
      call.name,
      call.input === undefined ? null : JSON.stringify(call.input),
      new Date().toISOString()
    );
  return Number(res.lastInsertRowid);
}

/** How a tool call ended. */
export function completeToolCall(
  id: number,
  done: {
    output?: string;
    status: Exclude<ToolCallStatus, 'running'>;
    durationMs?: number;
    approval?: ApprovalState;
  }
): void {
  getStore()
    .prepare(
      `UPDATE tool_calls SET output = ?, status = ?, duration_ms = ?, approval_state = ?, finished_at = ?
       WHERE id = ?`
    )
    .run(
      done.output ?? null,
      done.status,
      done.durationMs ?? null,
      done.approval ?? null,
      new Date().toISOString(),
      id
    );
}

export interface ToolCallRecord {
  id: number;
  stepSeq?: number;
  callId?: string;
  name: string;
  input?: unknown;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
  approvalState: ApprovalState | null;
}

/** A run's tool calls, in the order they were made. */
export function listToolCalls(runId: string): ToolCallRecord[] {
  return getStore()
    .prepare(
      `SELECT id, step_seq, call_id, name, input, output, status, duration_ms, approval_state
       FROM tool_calls WHERE run_id = ? ORDER BY id`
    )
    .all(runId)
    .map((r) => ({
      id: Number(r.id),
      stepSeq: r.step_seq === null ? undefined : Number(r.step_seq),
      callId: r.call_id === null ? undefined : String(r.call_id),
      name: String(r.name),
      input: r.input ? JSON.parse(String(r.input)) : undefined,
      output: r.output === null ? undefined : String(r.output),
      status: String(r.status) as ToolCallStatus,
      durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
      approvalState: r.approval_state === null ? null : (String(r.approval_state) as ApprovalState),
    }));
}

/** Newest first. `since` keeps runs created at or after that ISO time. */
export function listRuns(limit = 50, opts: { since?: string } = {}): RunRecord[] {
  const where = opts.since ? 'WHERE created_at >= ?' : '';
  const params = opts.since ? [opts.since, limit] : [limit];
  return getStore()
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)
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
const runContext = new AsyncLocalStorage<{
  runId: string;
  controller: AbortController;
  sessionId?: string;
}>();

/** Runs still executing, so the kill switch can reach every one of them. */
const activeRuns = new Map<string, AbortController>();

export function currentRunId(): string | undefined {
  return runContext.getStore()?.runId;
}

/** The chat session the current run belongs to, if it is a chat message. */
export function currentSessionId(): string | undefined {
  return runContext.getStore()?.sessionId;
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

/** Cancel one run, running or queued. Returns false when it was neither. */
export function cancelRun(runId: string, reason = 'Cancelled'): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return isStoreOpen() && cancelQueuedRun(runId, reason);
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
  /**
   * `unaccounted`: the call (or a failed agent attempt) may have cost
   * something that nobody reported, so the run's cost is a lower bound.
   */
  status: 'ok' | 'error' | 'unaccounted';
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
    moduleId?: string;
    triggerId?: string;
    message?: string;
    signal?: AbortSignal;
    /** The chat session the run is a message of, for the events it emits. */
    sessionId?: string;
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
    moduleId: input.moduleId,
    triggerId: input.triggerId,
    input: input.message,
    status: input.status,
  });
  input.onCreated?.(runId);
  return executeRun(runId, input, fn);
}

/** What `executeRun` does with an error instead of failing the run. */
export interface Requeue {
  notBefore?: Date;
  /** Shown on the run while it waits. */
  reason: string;
}

/**
 * Run `fn` as the run `runId`, which already exists (a queued run a gateway
 * has leased, say): with the run as its context, cancellable, and closed
 * either way. `retry`, when given, may turn a failure into another attempt:
 * it returns where the run goes back to the queue, or null to let it fail.
 * A requeued run's promise resolves with undefined.
 */
export async function executeRun<T>(
  runId: string,
  input: {
    trigger: RunTrigger;
    automationId?: string;
    moduleId?: string;
    triggerId?: string;
    signal?: AbortSignal;
    sessionId?: string;
    /** A requeue; null to fail as is; `{ failure }` to fail with that reason instead. */
    retry?: (e: unknown) => Requeue | { failure: string } | null;
  },
  fn: () => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const detach = link(input.signal, controller);
  activeRuns.set(runId, controller);
  emit(
    'run.started',
    {
      trigger: input.trigger,
      automationId: input.automationId,
      moduleId: input.moduleId,
      triggerId: input.triggerId,
    },
    { runId }
  );
  try {
    const result = await runContext.run({ runId, controller, sessionId: input.sessionId }, fn);
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
    let message = e instanceof Error ? e.message : String(e);
    const again = input.retry?.(e);
    if (again && 'failure' in again) message = again.failure;
    else if (again && requeueRun(runId, again)) return undefined as T;
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
