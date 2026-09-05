/**
 * Human approval for risky tool calls.
 *
 * The policy engine decides a call needs a human; this is where the run waits
 * for one. A pending approval is a row in the store, so a decision survives a
 * gateway restart and the record of who decided what is auditable afterwards.
 *
 * Waiting fails closed: if nobody decides within the timeout, the call is
 * refused rather than allowed. An unattended run that silently proceeds because
 * no operator was watching is the exact failure this exists to prevent.
 */

import { audit } from '@clerq/store';
import { getStore } from './store.js';
import { emit } from './events.js';
import { logger } from './logger.js';

/** Risk tiers, ordered by how much damage an unwanted call could do. */
export type RiskTier = 'low' | 'medium' | 'high';

export interface ApprovalRequest {
  id: number;
  runId: string;
  tool: string;
  tier: RiskTier;
  reason: string;
  arguments?: unknown;
  requestedAt: string;
}

export interface ApprovalDecision {
  decision: 'approved' | 'denied';
  decidedBy?: string;
  reason?: string;
}

/** Map a tool's risk to the tier shown to a human. */
export function tierFor(risk: string): RiskTier {
  switch (risk) {
    case 'read':
      return 'low';
    case 'write':
    case 'network':
      return 'medium';
    case 'execute':
    case 'external':
      return 'high';
    default:
      return 'high';
  }
}

const waiters = new Map<number, (d: ApprovalDecision) => void>();

/** Record a pending approval and notify anything listening. */
export function requestApproval(input: {
  runId: string;
  tool: string;
  tier: RiskTier;
  reason: string;
  arguments?: unknown;
}): ApprovalRequest {
  const now = new Date().toISOString();
  const res = getStore()
    .prepare('INSERT INTO approvals (run_id, step_id, requested_at, reason) VALUES (?, ?, ?, ?)')
    .run(
      input.runId,
      null,
      now,
      JSON.stringify({ tool: input.tool, tier: input.tier, reason: input.reason })
    );

  const id = Number(res.lastInsertRowid);
  const request: ApprovalRequest = {
    id,
    runId: input.runId,
    tool: input.tool,
    tier: input.tier,
    reason: input.reason,
    arguments: input.arguments,
    requestedAt: now,
  };

  emit('approval.requested', request, { runId: input.runId });
  logger.info('Approval requested', { id, tool: input.tool, tier: input.tier });
  return request;
}

/** Record a decision and release anything waiting on it. */
export function decide(id: number, decision: ApprovalDecision): boolean {
  const db = getStore();
  const row = db.prepare('SELECT id, run_id, decision FROM approvals WHERE id = ?').get(id);
  if (!row) return false;
  if (row.decision) return false; // already decided; decisions are not revisited

  db.prepare('UPDATE approvals SET decision = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(
    decision.decision,
    decision.decidedBy ?? 'operator',
    new Date().toISOString(),
    id
  );

  audit(db, {
    actor: decision.decidedBy ?? 'operator',
    action: `approval.${decision.decision}`,
    subject: String(id),
    detail: { runId: row.run_id, reason: decision.reason },
  });

  emit('approval.decided', { id, ...decision }, { runId: String(row.run_id) });

  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter(decision);
  }
  return true;
}

export function listPending(): ApprovalRequest[] {
  return getStore()
    .prepare(
      'SELECT id, run_id, requested_at, reason FROM approvals WHERE decision IS NULL ORDER BY id'
    )
    .all()
    .map((r) => {
      let meta: { tool?: string; tier?: RiskTier; reason?: string } = {};
      try {
        meta = JSON.parse(String(r.reason ?? '{}'));
      } catch {
        /* a malformed row still lists, just without detail */
      }
      return {
        id: Number(r.id),
        runId: String(r.run_id),
        tool: meta.tool ?? 'unknown',
        tier: meta.tier ?? 'high',
        reason: meta.reason ?? '',
        requestedAt: String(r.requested_at),
      };
    });
}

/**
 * Block until the approval is decided, or the timeout expires.
 *
 * Resolves false on timeout — never true. Failing closed is the whole point.
 */
export function waitForDecision(id: number, timeoutMs = 300_000): Promise<boolean> {
  return new Promise((resolve) => {
    // It may already have been decided between request and wait.
    const existing = getStore().prepare('SELECT decision FROM approvals WHERE id = ?').get(id);
    if (existing?.decision) {
      resolve(existing.decision === 'approved');
      return;
    }

    const timer = setTimeout(() => {
      waiters.delete(id);
      logger.warn('Approval timed out; refusing the call', { id, timeoutMs });
      resolve(false);
    }, timeoutMs);

    waiters.set(id, (d) => {
      clearTimeout(timer);
      resolve(d.decision === 'approved');
    });
  });
}

/** Refuse every pending approval — used by the kill switch. */
export function denyAllPending(reason = 'Cancelled by operator'): number {
  const pending = listPending();
  for (const p of pending) {
    decide(p.id, { decision: 'denied', decidedBy: 'kill-switch', reason });
  }
  return pending.length;
}
