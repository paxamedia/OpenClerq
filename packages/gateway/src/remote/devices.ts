/**
 * Remote mode and device pairing.
 *
 * The gateway stays on loopback. Remote mode is an explicit opt-in that
 * records the HTTPS address of the user's own tunnel or reverse proxy
 * (cloudflared, Tailscale, …), which terminates TLS and forwards to it.
 *
 * Pairing: the desktop asks for a code (single use, five minutes) and shows
 * it with the address as a QR code; the phone sends it to POST /devices/pair
 * and gets a device token scoped to the mobile API set. The gateway token
 * never leaves the machine. Revoking a device invalidates its token at once.
 */

import crypto from 'node:crypto';
import { audit } from '@clerq/store';
import { getStore } from '../store.js';
import { emit } from '../events.js';
import { currentTenant } from '../tenant.js';
import { issueToken, lastSeen, revokeTokens } from '../security/scoped-tokens.js';

export const PAIRING_TTL_MS = 5 * 60_000;
/** A device token expires after this long unused; each use extends it. */
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

/** What a paired phone may do: read status, decide approvals, pause and resume, answer the inbox. */
export const MOBILE_SCOPES = [
  'GET /kill',
  'POST /kill',
  'POST /resume',
  'GET /runs',
  'GET /runs/:id',
  'POST /runs/:id/cancel',
  'GET /automations',
  'GET /automations/:id',
  'POST /automations/:id/enable',
  'POST /automations/:id/disable',
  'GET /approvals',
  'POST /approvals/:id/approve',
  'POST /approvals/:id/deny',
  'GET /inbox',
  'GET /inbox/items/:id',
  'PATCH /inbox/items/:id',
  'POST /inbox/items/:id/respond',
  'GET /events/stream',
  'GET /search',
  'GET /records',
  'GET /records/:id',
  'GET /records/:id/activities',
  'GET /links',
  'GET /extensions',
  'GET /modules',
  'GET /devices/me',
  'DELETE /devices/me',
];

export class RemoteError extends Error {
  constructor(
    readonly code: 'invalid' | 'remote_disabled' | 'bad_code' | 'not_found' | 'rate_limited',
    message: string
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface RemoteSettings {
  enabled: boolean;
  /** The tunnel's HTTPS address, e.g. https://clerq.example.com. */
  publicUrl: string | null;
  ntfyServer: string;
}

let cached: RemoteSettings | null = null;

function readSetting(key: string): string | null {
  const row = getStore().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

function writeSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, now);
}

export function remoteSettings(): RemoteSettings {
  if (cached) return cached;
  cached = {
    enabled: readSetting('remote.enabled') === 'true',
    publicUrl: readSetting('remote.publicUrl'),
    ntfyServer: readSetting('remote.ntfyServer') ?? DEFAULT_NTFY_SERVER,
  };
  return cached;
}

/** For tests that reopen the store. */
export function forgetRemoteSettings(): void {
  cached = null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** HTTPS, or plain HTTP to this machine only (for development). */
function checkUrl(raw: string, what: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RemoteError('invalid', `${what} is not a URL.`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new RemoteError('invalid', `${what} must be https:// (plain http only to localhost).`);
  }
  return u.toString().replace(/\/$/, '');
}

export function updateRemoteSettings(
  patch: { enabled?: unknown; publicUrl?: unknown; ntfyServer?: unknown },
  actor: string
): RemoteSettings {
  const current = remoteSettings();
  const next: RemoteSettings = { ...current };
  if (patch.publicUrl !== undefined) {
    next.publicUrl =
      patch.publicUrl === null || patch.publicUrl === ''
        ? null
        : checkUrl(String(patch.publicUrl), 'publicUrl');
  }
  if (patch.ntfyServer !== undefined) {
    next.ntfyServer = patch.ntfyServer
      ? checkUrl(String(patch.ntfyServer), 'ntfyServer')
      : DEFAULT_NTFY_SERVER;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean')
      throw new RemoteError('invalid', 'enabled must be true or false.');
    next.enabled = patch.enabled;
  }
  if (next.enabled && !next.publicUrl) {
    throw new RemoteError(
      'invalid',
      'Set publicUrl, the address of your tunnel, to turn remote mode on.'
    );
  }
  writeSetting('remote.enabled', String(next.enabled));
  writeSetting('remote.publicUrl', next.publicUrl ?? '');
  writeSetting('remote.ntfyServer', next.ntfyServer);
  cached = { ...next, publicUrl: next.publicUrl || null };
  if (current.enabled !== next.enabled) {
    audit(getStore(), { actor, action: next.enabled ? 'remote.enabled' : 'remote.disabled' });
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** Crockford base32 without I, L, O, U: easy to read off a screen and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newCode(): string {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

function hashCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return crypto.createHash('sha256').update(clean).digest('hex');
}

/** A single-use code for pairing a phone with the current tenant. */
export function createPairingCode(): { code: string; url: string; expiresAt: string; qr: string } {
  const remote = remoteSettings();
  if (!remote.enabled || !remote.publicUrl) {
    throw new RemoteError('remote_disabled', 'Turn remote mode on first (PUT /remote).');
  }
  const code = newCode();
  const now = Date.now();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  const db = getStore();
  // Expired codes are of no further use.
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(new Date(now).toISOString());
  db.prepare(
    'INSERT INTO pairing_codes (code_hash, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(hashCode(code), currentTenant(), new Date(now).toISOString(), expiresAt);
  const shown = `${code.slice(0, 5)}-${code.slice(5)}`;
  return {
    code: shown,
    url: remote.publicUrl,
    expiresAt,
    qr: JSON.stringify({ url: remote.publicUrl, code: shown, expires: expiresAt }),
  };
}

/** Failed attempts in the last minute, gateway-wide: a ceiling on guessing. */
const failures: number[] = [];
const MAX_FAILURES_PER_MINUTE = 10;

function noteFailure(): void {
  failures.push(Date.now());
}

function tooManyFailures(): boolean {
  const cutoff = Date.now() - 60_000;
  while (failures.length > 0 && failures[0] < cutoff) failures.shift();
  return failures.length >= MAX_FAILURES_PER_MINUTE;
}

export function resetPairingLimiter(): void {
  failures.length = 0;
}

export interface Device {
  id: string;
  tenantId: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  push: { server: string; topic: string } | null;
}

function rowToDevice(r: Record<string, unknown>): Device {
  const id = String(r.id);
  return {
    id,
    tenantId: String(r.tenant_id),
    name: String(r.name),
    platform: String(r.platform),
    createdAt: String(r.created_at),
    lastSeenAt: lastSeen('device', id),
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    push:
      r.push_server && r.push_topic
        ? { server: String(r.push_server), topic: String(r.push_topic) }
        : null,
  };
}

/** Exchange a pairing code for a device and its token. */
export function pairDevice(input: { code?: unknown; deviceName?: unknown; platform?: unknown }): {
  device: Device;
  token: string;
  expiresAt: string;
  scopes: string[];
} {
  if (tooManyFailures())
    throw new RemoteError('rate_limited', 'Too many attempts. Try again in a minute.');
  const remote = remoteSettings();
  if (!remote.enabled)
    throw new RemoteError('remote_disabled', 'Remote mode is off on this gateway.');
  const name = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 100) : '';
  const platform = typeof input.platform === 'string' ? input.platform.trim().slice(0, 30) : '';
  if (typeof input.code !== 'string' || !name || !platform) {
    throw new RemoteError('invalid', 'Send code, deviceName and platform.');
  }
  const db = getStore();
  const now = new Date().toISOString();
  // Claim the code in one statement, so it cannot be used twice.
  const claimed = db
    .prepare(
      'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?'
    )
    .run(now, hashCode(input.code), now).changes;
  if (claimed === 0) {
    noteFailure();
    throw new RemoteError('bad_code', 'That code is wrong, used or expired.');
  }
  const tenant = String(
    db.prepare('SELECT tenant_id FROM pairing_codes WHERE code_hash = ?').get(hashCode(input.code))
      ?.tenant_id ?? 'default'
  );
  const id = `dev_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO devices (id, tenant_id, name, platform, push_server, push_topic, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenant,
    name,
    platform,
    remote.ntfyServer,
    `clerq-${crypto.randomBytes(16).toString('hex')}`,
    now
  );
  const { token, expiresAt } = issueToken({
    kind: 'device',
    subject: id,
    scopes: MOBILE_SCOPES,
    ttlMs: DEVICE_IDLE_MS,
    idleMs: DEVICE_IDLE_MS,
    tenantId: tenant,
  });
  audit(db, {
    actor: `device:${id}`,
    action: 'device.paired',
    subject: id,
    detail: { name, platform },
  });
  emit('device.paired', { id, name, platform });
  return { device: getDevice(id) as Device, token, expiresAt, scopes: MOBILE_SCOPES };
}

export function getDevice(id: string): Device | null {
  const row = getStore().prepare('SELECT * FROM devices WHERE id = ?').get(id);
  return row ? rowToDevice(row) : null;
}

/** Devices of the current tenant, newest first. */
export function listDevices(): Device[] {
  return getStore()
    .prepare('SELECT * FROM devices WHERE tenant_id = ? ORDER BY created_at DESC')
    .all(currentTenant())
    .map(rowToDevice);
}

/** Paired and not revoked, across tenants: the push publisher's list. */
export function activeDevices(): Device[] {
  return getStore()
    .prepare('SELECT * FROM devices WHERE revoked_at IS NULL')
    .all()
    .map(rowToDevice);
}

export function revokeDevice(id: string, actor: string): Device {
  const device = getDevice(id);
  if (!device || device.tenantId !== currentTenant()) {
    throw new RemoteError('not_found', `No device ${id}.`);
  }
  revokeTokens('device', id);
  if (!device.revokedAt) {
    getStore()
      .prepare('UPDATE devices SET revoked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    audit(getStore(), { actor, action: 'device.revoked', subject: id });
    emit('device.revoked', { id });
  }
  return getDevice(id) as Device;
}
