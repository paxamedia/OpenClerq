/**
 * Durable store for Clerq.
 *
 * Replaces the JSON blobs under ~/.clerq (memory.json, triggers.json), which
 * were read-modify-write with no locking: two concurrent writers silently
 * clobbered each other. SQLite in WAL mode gives real transactions and lets
 * readers proceed while a writer holds the lock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, type Database } from './driver.js';
import { MIGRATIONS } from './migrations.js';

export type { Database, Statement, Row, Param } from './driver.js';
export { openDatabase } from './driver.js';
export { MIGRATIONS } from './migrations.js';
export { importLegacyJson, type ImportResult } from './import-legacy.js';

export function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'clerq.db');
}

/**
 * Apply any migrations the database has not seen, in order, each in its own
 * transaction. Safe to call on every start; a fully migrated database is a
 * no-op. Returns the ids applied by this call.
 */
export function migrate(db: Database): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r) => Number(r.id))
  );

  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString()
      );
    });
    ran.push(m.id);
  }
  return ran;
}

/**
 * Open the store at `dbPath` (default ~/.clerq/clerq.db), creating the
 * directory if needed, and bring the schema up to date.
 */
export async function openStore(dbPath?: string): Promise<Database> {
  const target = dbPath ?? getDefaultDbPath();
  if (target !== ':memory:') {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = await openDatabase(target);
  migrate(db);
  return db;
}

/** Append an entry to the audit log. Never updated or deleted by the app. */
export function audit(
  db: Database,
  entry: { actor?: string; action: string; subject?: string; detail?: unknown }
): void {
  db.prepare(
    'INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(
    new Date().toISOString(),
    entry.actor ?? null,
    entry.action,
    entry.subject ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail)
  );
}
