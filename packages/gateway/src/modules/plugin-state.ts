/**
 * What the gateway remembers about each plugin between starts: whether the
 * person turned it off, the state its last start ended in, the version that
 * last started (for `upgrade`) and what was approved (migration 22), and the
 * one setting, `plugins.enforce`.
 */

import type { PluginPermissions } from '@clerq/plugin-sdk';
import { getStore, isStoreOpen } from '../store.js';

export type PluginStateName = 'disabled' | 'awaiting_approval' | 'enabled' | 'failed' | 'refused';
export type PluginKind = 'plugin' | 'legacy';

export interface Approval {
  version: string | null;
  permissionsHash: string;
  checksum: string;
  /** What was approved, so a later change can be shown as a difference. */
  permissions: PluginPermissions | null;
  at: string;
  /** `operator`, or `bundled` for a first-party plugin approved by its shipped checksum. */
  by: string;
}

export interface PluginRow {
  id: string;
  kind: PluginKind;
  desired: 'enabled' | 'disabled';
  state: PluginStateName;
  reason: string | null;
  version: string | null;
  permissionsHash: string | null;
  checksum: string | null;
  startedVersion: string | null;
  approval: Approval | null;
  firstSeenAt: string;
  updatedAt: string;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toRow(r: Record<string, unknown>): PluginRow {
  let permissions: PluginPermissions | null = null;
  try {
    if (r.approved_permissions) permissions = JSON.parse(String(r.approved_permissions));
  } catch {
    permissions = null;
  }
  return {
    id: String(r.id),
    kind: r.kind as PluginKind,
    desired: r.desired as 'enabled' | 'disabled',
    state: r.state as PluginStateName,
    reason: str(r.reason),
    version: str(r.version),
    permissionsHash: str(r.permissions_hash),
    checksum: str(r.checksum),
    startedVersion: str(r.started_version),
    approval:
      r.approved_checksum && r.approved_permissions_hash
        ? {
            version: str(r.approved_version),
            permissionsHash: String(r.approved_permissions_hash),
            checksum: String(r.approved_checksum),
            permissions,
            at: String(r.approved_at ?? ''),
            by: String(r.approved_by ?? 'operator'),
          }
        : null,
    firstSeenAt: String(r.first_seen_at),
    updatedAt: String(r.updated_at),
  };
}

export function readPluginRow(id: string): PluginRow | undefined {
  const r = getStore().prepare('SELECT * FROM plugin_state WHERE id = ?').get(id);
  return r ? toRow(r) : undefined;
}

export function listPluginRows(): PluginRow[] {
  return getStore()
    .prepare('SELECT * FROM plugin_state ORDER BY id')
    .all()
    .map((r) => toRow(r));
}

/** Make the row for a plugin seen for the first time. */
export function createPluginRow(input: {
  id: string;
  kind: PluginKind;
  version: string | null;
}): PluginRow {
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO plugin_state (id, kind, desired, state, version, first_seen_at, updated_at)
       VALUES (?, ?, 'enabled', 'disabled', ?, ?, ?)`
    )
    .run(input.id, input.kind, input.version, now, now);
  return readPluginRow(input.id) as PluginRow;
}

/** What a start or a person's choice changes. Fields left out stay as they are. */
export interface PluginRowUpdate {
  kind?: PluginKind;
  desired?: 'enabled' | 'disabled';
  state?: PluginStateName;
  reason?: string | null;
  version?: string | null;
  permissionsHash?: string | null;
  checksum?: string | null;
  startedVersion?: string | null;
}

const COLUMN: Record<keyof PluginRowUpdate, string> = {
  kind: 'kind',
  desired: 'desired',
  state: 'state',
  reason: 'reason',
  version: 'version',
  permissionsHash: 'permissions_hash',
  checksum: 'checksum',
  startedVersion: 'started_version',
};

export function updatePluginRow(id: string, update: PluginRowUpdate): void {
  const keys = (Object.keys(update) as Array<keyof PluginRowUpdate>).filter(
    (k) => update[k] !== undefined
  );
  const sets = keys.map((k) => `${COLUMN[k]} = ?`);
  getStore()
    .prepare(`UPDATE plugin_state SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => update[k] as string | null), new Date().toISOString(), id);
}

export function saveApproval(id: string, a: Approval): void {
  getStore()
    .prepare(
      `UPDATE plugin_state SET approved_version = ?, approved_permissions_hash = ?,
         approved_checksum = ?, approved_permissions = ?, approved_at = ?, approved_by = ?,
         updated_at = ? WHERE id = ?`
    )
    .run(
      a.version,
      a.permissionsHash,
      a.checksum,
      a.permissions ? JSON.stringify(a.permissions) : null,
      a.at,
      a.by,
      new Date().toISOString(),
      id
    );
}

// ---------------------------------------------------------------------------
// The setting

const ENFORCE_KEY = 'plugins.enforce';

/**
 * Whether the person has turned plugin permission enforcement on. Off unless they did, and on
 * when it cannot be told: a store that cannot be read, or a value that is neither `true` nor
 * `false`, must not switch the checks off.
 */
export function enforcing(): boolean {
  try {
    if (!isStoreOpen()) return true;
    const row = getStore().prepare('SELECT value FROM settings WHERE key = ?').get(ENFORCE_KEY);
    return row === undefined ? false : row.value !== 'false';
  } catch {
    return true;
  }
}

export function setEnforcing(on: boolean): void {
  getStore()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(ENFORCE_KEY, on ? 'true' : 'false', new Date().toISOString());
}
