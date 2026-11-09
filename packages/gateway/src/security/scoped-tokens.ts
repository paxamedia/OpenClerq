/**
 * Scoped tokens: narrower and shorter-lived than the gateway token.
 *
 * A module's UI gets one valid for `/api/modules/<id>/*` plus the core
 * endpoints its manifest declares; a paired device gets one for the mobile
 * API set. Only a SHA-256 of each token is stored, and any of them can be
 * revoked at once.
 *
 * A scope is `METHOD /path`, where METHOD may be `*`, a `:name` segment
 * matches any one segment, and a trailing `/*` matches the path and anything
 * below it.
 */

import crypto from 'node:crypto';
import { getStore, isStoreOpen } from '../store.js';
import { DEFAULT_TENANT } from '../tenant.js';

export type TokenKind = 'module' | 'device';

export interface Principal {
  kind: 'operator' | TokenKind;
  /** The token's row id; absent for the gateway token. */
  tokenId?: string;
  /** The module id or device id. */
  subject?: string;
  /** The tenant a scoped token is bound to. */
  tenantId?: string;
  scopes?: string[];
}

/**
 * Never reachable with a scoped token, whatever its scopes say: minting and
 * revoking tokens, pairing and remote settings, and the vault.
 */
const OPERATOR_ONLY = [
  /^\/modules\/[^/]+\/tokens?(\/|$)/,
  /^\/devices(?!\/me(\/|$))(\/|$)/,
  /^\/remote(\/|$)/,
  /^\/secrets(\/|$)/,
];

export const SCOPE = /^(GET|POST|PUT|PATCH|DELETE|\*) (\/[^\s]*)$/;

const LAST_SEEN_EVERY_MS = 60_000;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * The path as the checks compare it: each segment decoded and lower-cased,
 * empty segments dropped. Express matches routes without regard to case, so
 * `/SECRETS` must be checked as `/secrets`. Null when a segment cannot be
 * decoded.
 */
export function normalisePath(path: string): string | null {
  try {
    const segments = path
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s).toLowerCase());
    if (segments.some((s) => s.includes('/'))) return null;
    return `/${segments.join('/')}`;
  } catch {
    return null;
  }
}

export function operatorOnly(path: string): boolean {
  const p = normalisePath(path);
  return p === null || OPERATOR_ONLY.some((re) => re.test(p));
}

/** Whether one scope admits `method path`. */
export function scopeAllows(scope: string, method: string, path: string): boolean {
  const m = SCOPE.exec(scope);
  const p = normalisePath(path);
  if (!m || p === null) return false;
  if (m[1] !== '*' && m[1] !== method.toUpperCase()) return false;
  const want = m[2].toLowerCase().split('/').filter(Boolean);
  const got = p.split('/').filter(Boolean);
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '*' && i === want.length - 1) return true;
    if (i >= got.length) return false;
    if (want[i].startsWith(':')) continue;
    if (want[i] !== got[i]) return false;
  }
  return want.length === got.length;
}

/**
 * A scope a manifest may declare: a fixed first segment, so it names part of
 * the API rather than all of it.
 */
export function declarableScope(scope: string): boolean {
  const m = SCOPE.exec(scope);
  if (!m) return false;
  const first = m[2].split('/').filter(Boolean)[0];
  return first !== undefined && first !== '*' && !first.startsWith(':');
}

export function principalAllows(p: Principal, method: string, path: string): boolean {
  if (p.kind === 'operator') return true;
  if (operatorOnly(path)) return false;
  // HEAD reads what GET reads.
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method;
  return (p.scopes ?? []).some((s) => scopeAllows(s, m, path));
}

export function issueToken(input: {
  kind: TokenKind;
  subject: string;
  scopes: string[];
  ttlMs: number;
  /** Extend the expiry to now + idleMs on each use. */
  idleMs?: number;
  tenantId?: string;
}): { id: string; token: string; expiresAt: string } {
  const bad = input.scopes.find((s) => !SCOPE.test(s));
  if (bad) throw new Error(`Invalid scope "${bad}". Use "METHOD /path".`);
  const id = `tok_${crypto.randomUUID()}`;
  const token = `clq${input.kind === 'module' ? 'm' : 'd'}_${crypto.randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const expiresAt = new Date(now + input.ttlMs).toISOString();
  getStore()
    .prepare(
      `INSERT INTO scoped_tokens
         (id, kind, subject, tenant_id, token_hash, scopes, created_at, expires_at, idle_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.kind,
      input.subject,
      input.tenantId ?? DEFAULT_TENANT,
      hash(token),
      JSON.stringify(input.scopes),
      new Date(now).toISOString(),
      expiresAt,
      input.idleMs ?? null
    );
  return { id, token, expiresAt };
}

/**
 * The principal a scoped token stands for, or null when it is unknown,
 * expired or revoked. Records the use, at most once a minute per token.
 */
export function resolveToken(token: string): Principal | null {
  if (!isStoreOpen() || !/^clq[md]_[0-9a-f]{64}$/.test(token)) return null;
  const db = getStore();
  const row = db
    .prepare(
      `SELECT id, kind, subject, tenant_id, scopes, expires_at, idle_ms, revoked_at, last_seen_at
       FROM scoped_tokens WHERE token_hash = ?`
    )
    .get(hash(token));
  if (!row || row.revoked_at) return null;
  const now = Date.now();
  if (Date.parse(String(row.expires_at)) <= now) return null;
  const lastSeen = row.last_seen_at ? Date.parse(String(row.last_seen_at)) : 0;
  if (now - lastSeen >= LAST_SEEN_EVERY_MS) {
    const idle = row.idle_ms === null || row.idle_ms === undefined ? null : Number(row.idle_ms);
    db.prepare(
      'UPDATE scoped_tokens SET last_seen_at = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?'
    ).run(
      new Date(now).toISOString(),
      idle === null ? null : new Date(now + idle).toISOString(),
      String(row.id)
    );
  }
  return {
    kind: row.kind as TokenKind,
    tokenId: String(row.id),
    subject: String(row.subject),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT),
    scopes: JSON.parse(String(row.scopes)) as string[],
  };
}

/** Revoke every live token of one module or device. Returns how many. */
export function revokeTokens(kind: TokenKind, subject: string): number {
  const now = new Date().toISOString();
  return getStore()
    .prepare(
      `UPDATE scoped_tokens SET revoked_at = ?
       WHERE kind = ? AND subject = ? AND revoked_at IS NULL AND expires_at > ?`
    )
    .run(now, kind, subject, now).changes;
}

/** When a device or module last used a token, if ever. */
export function lastSeen(kind: TokenKind, subject: string): string | null {
  const row = getStore()
    .prepare('SELECT MAX(last_seen_at) AS at FROM scoped_tokens WHERE kind = ? AND subject = ?')
    .get(kind, subject);
  return row?.at ? String(row.at) : null;
}
