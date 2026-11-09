import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initStore, closeStore, getStore } from '../store.js';
import {
  issueToken,
  resolveToken,
  revokeTokens,
  scopeAllows,
  principalAllows,
  lastSeen,
} from './scoped-tokens.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => closeStore());

describe('scopes', () => {
  it('match method, named segments and a trailing wildcard', () => {
    expect(scopeAllows('GET /runs', 'GET', '/runs')).toBe(true);
    expect(scopeAllows('GET /runs', 'POST', '/runs')).toBe(false);
    expect(scopeAllows('GET /runs', 'GET', '/runs/1')).toBe(false);
    expect(scopeAllows('GET /runs/:id', 'GET', '/runs/run_1')).toBe(true);
    expect(scopeAllows('* /api/modules/a/*', 'DELETE', '/api/modules/a/x/y')).toBe(true);
    expect(scopeAllows('* /api/modules/a/*', 'GET', '/api/modules/a')).toBe(true);
    expect(scopeAllows('* /api/modules/a/*', 'GET', '/api/modules/ab/x')).toBe(false);
    expect(scopeAllows('nonsense', 'GET', '/')).toBe(false);
  });

  it('never reach operator-only endpoints, whatever they say', () => {
    const p = { kind: 'module' as const, scopes: ['* /*'] };
    expect(principalAllows(p, 'GET', '/runs')).toBe(true);
    expect(principalAllows(p, 'POST', '/modules/a/token')).toBe(false);
    expect(principalAllows(p, 'GET', '/secrets')).toBe(false);
    expect(principalAllows(p, 'GET', '/devices')).toBe(false);
    expect(principalAllows(p, 'GET', '/devices/me')).toBe(true);
    expect(principalAllows(p, 'PUT', '/remote')).toBe(false);
  });
});

describe('scoped tokens', () => {
  it('resolve until they expire or are revoked, recording use', () => {
    const live = issueToken({
      kind: 'module',
      subject: 'm1',
      scopes: ['GET /runs'],
      ttlMs: 60_000,
    });
    expect(live.token).toMatch(/^clqm_[0-9a-f]{64}$/);
    expect(resolveToken(live.token)).toMatchObject({ kind: 'module', subject: 'm1' });
    expect(lastSeen('module', 'm1')).not.toBeNull();
    // Only a hash is stored.
    const raw = JSON.stringify(getStore().prepare('SELECT * FROM scoped_tokens').all());
    expect(raw).not.toContain(live.token);

    const old = issueToken({ kind: 'module', subject: 'm1', scopes: [], ttlMs: -1 });
    expect(resolveToken(old.token)).toBeNull();

    expect(revokeTokens('module', 'm1')).toBe(1);
    expect(resolveToken(live.token)).toBeNull();
    expect(resolveToken('clqm_nothex')).toBeNull();
  });

  it('slide their expiry with use when idle-limited', () => {
    const t = issueToken({
      kind: 'device',
      subject: 'd1',
      scopes: [],
      ttlMs: 1000,
      idleMs: 3_600_000,
    });
    resolveToken(t.token);
    const row = getStore().prepare('SELECT expires_at FROM scoped_tokens WHERE id = ?').get(t.id);
    expect(Date.parse(String(row?.expires_at)) - Date.now()).toBeGreaterThan(3_000_000);
  });

  it('refuse a malformed scope', () => {
    expect(() =>
      issueToken({ kind: 'module', subject: 'x', scopes: ['runs'], ttlMs: 1000 })
    ).toThrow(/Invalid scope/);
  });
});
