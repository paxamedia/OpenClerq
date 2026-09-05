/**
 * Agent memory, backed by the durable store.
 *
 * Replaces ~/.clerq/memory.json, which was read-modify-write with no locking:
 * two concurrent writers each read the whole file, mutated their copy and wrote
 * it back, so one silently lost the other's entries. Existing entries are
 * imported into SQLite on first start (see @clerq/store importLegacyJson).
 */

import { getStore } from './store.js';

export interface MemoryEntry {
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt?: string;
}

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Tolerate a value written before it was consistently serialised.
    return raw;
  }
}

export function listMemory(): MemoryEntry[] {
  const rows = getStore()
    .prepare('SELECT key, value, created_at, updated_at FROM memory ORDER BY updated_at DESC')
    .all();
  return rows.map((r) => ({
    key: String(r.key),
    value: parseValue(r.value),
    createdAt: String(r.created_at),
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  }));
}

export function getMemory(key: string): MemoryEntry | null {
  const row = getStore()
    .prepare('SELECT key, value, created_at, updated_at FROM memory WHERE key = ?')
    .get(key);
  if (!row) return null;
  return {
    key: String(row.key),
    value: parseValue(row.value),
    createdAt: String(row.created_at),
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

/** Insert or update in one statement — no read-modify-write window. */
export function setMemory(key: string, value: unknown): void {
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO memory (key, value, type, created_at, updated_at)
       VALUES (?, ?, 'fact', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value ?? null), now, now);
}

export function deleteMemory(key: string): boolean {
  return getStore().prepare('DELETE FROM memory WHERE key = ?').run(key).changes > 0;
}

export function clearMemory(): number {
  return getStore().prepare('DELETE FROM memory').run().changes;
}

/** Substring search across keys and serialised values. */
export function searchMemory(query: string, limit = 50): MemoryEntry[] {
  const like = `%${query}%`;
  const rows = getStore()
    .prepare(
      `SELECT key, value, created_at, updated_at FROM memory
       WHERE key LIKE ? OR value LIKE ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(like, like, limit);
  return rows.map((r) => ({
    key: String(r.key),
    value: parseValue(r.value),
    createdAt: String(r.created_at),
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  }));
}
