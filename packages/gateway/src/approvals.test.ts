import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { initStore, closeStore, getStore } from './store.js';
import {
  requestApproval,
  decide,
  listPending,
  waitForDecision,
  denyAllPending,
  tierFor,
} from './approvals.js';
import { subscribeEvents, resetEvents, recentEvents } from './events.js';

beforeAll(async () => {
  await initStore(':memory:');
});
afterAll(() => closeStore());

beforeEach(() => {
  const db = getStore();
  db.prepare('DELETE FROM approvals').run();
  db.prepare('DELETE FROM runs').run();
  db.prepare(
    "INSERT INTO runs (id, status, trigger, created_at) VALUES ('r1','executing','manual','2026-01-01')"
  ).run();
  resetEvents();
});

describe('tierFor', () => {
  it('maps risk to a tier a human can reason about', () => {
    expect(tierFor('read')).toBe('low');
    expect(tierFor('write')).toBe('medium');
    expect(tierFor('network')).toBe('medium');
    expect(tierFor('execute')).toBe('high');
    expect(tierFor('external')).toBe('high');
  });

  it('treats anything unrecognised as high risk', () => {
    expect(tierFor('something-new')).toBe('high');
  });
});

describe('approval lifecycle', () => {
  it('records a request and lists it as pending', () => {
    const r = requestApproval({
      runId: 'r1',
      tool: 'runtime.exec',
      tier: 'high',
      reason: 'needs approval',
    });
    expect(r.id).toBeGreaterThan(0);
    const pending = listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tool: 'runtime.exec', tier: 'high', runId: 'r1' });
  });

  it('emits an event when an approval is requested', () => {
    const seen: string[] = [];
    subscribeEvents((e) => seen.push(e.name));
    requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    expect(seen).toContain('approval.requested');
  });

  it('removes an approval from pending once decided', () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    expect(decide(r.id, { decision: 'approved', decidedBy: 'elina' })).toBe(true);
    expect(listPending()).toHaveLength(0);
  });

  it('does not revisit a decision', () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    expect(decide(r.id, { decision: 'denied' })).toBe(true);
    expect(decide(r.id, { decision: 'approved' })).toBe(false);
  });

  it('reports an unknown id rather than inventing one', () => {
    expect(decide(9999, { decision: 'approved' })).toBe(false);
  });

  it('writes the decision to the audit log', () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    decide(r.id, { decision: 'approved', decidedBy: 'elina' });
    const row = getStore()
      .prepare("SELECT actor, action FROM audit_log WHERE action LIKE 'approval.%'")
      .get();
    expect(row).toMatchObject({ actor: 'elina', action: 'approval.approved' });
  });
});

describe('waitForDecision', () => {
  it('resolves true when approved', async () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    const waiting = waitForDecision(r.id, 5000);
    decide(r.id, { decision: 'approved' });
    expect(await waiting).toBe(true);
  });

  it('resolves false when denied', async () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    const waiting = waitForDecision(r.id, 5000);
    decide(r.id, { decision: 'denied' });
    expect(await waiting).toBe(false);
  });

  it('fails closed on timeout rather than proceeding', async () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'high', reason: 'r' });
    // An unattended run with nobody watching must be refused, never allowed.
    expect(await waitForDecision(r.id, 50)).toBe(false);
  });

  it('returns immediately when already decided', async () => {
    const r = requestApproval({ runId: 'r1', tool: 'x', tier: 'low', reason: 'r' });
    decide(r.id, { decision: 'approved' });
    expect(await waitForDecision(r.id, 5000)).toBe(true);
  });
});

describe('kill switch', () => {
  it('denies every pending approval and reports the count', async () => {
    const a = requestApproval({ runId: 'r1', tool: 'a', tier: 'high', reason: 'r' });
    requestApproval({ runId: 'r1', tool: 'b', tier: 'high', reason: 'r' });
    const waiting = waitForDecision(a.id, 5000);
    expect(denyAllPending()).toBe(2);
    expect(await waiting).toBe(false);
    expect(listPending()).toHaveLength(0);
  });
});
