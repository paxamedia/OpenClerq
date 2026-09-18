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
import { clerqHome, ensurePrivateDir, restrictFile } from './local-files.js';

export type { Database, Statement, Row, Param } from './driver.js';
export { openDatabase } from './driver.js';
export { MIGRATIONS } from './migrations.js';
export { importLegacyJson, type ImportResult } from './import-legacy.js';
export {
  clerqHome,
  ensurePrivateDir,
  restrictFile,
  writePrivateFile,
  appendPrivateFile,
  secureClerqHome,
} from './local-files.js';

export function getDefaultDbPath(): string {
  return path.join(clerqHome(), 'clerq.db');
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
  if (target === ':memory:') {
    const db = await openDatabase(target);
    migrate(db);
    return db;
  }

  // The database holds conversations, prompts and memory: this account only.
  // A custom location's directory is created private but, if it already
  // exists, left as the operator made it; the default one is always tightened.
  const dir = path.dirname(target);
  if (target === getDefaultDbPath() || !fs.existsSync(dir)) ensurePrivateDir(dir);
  const created = !fs.existsSync(target);

  const db = await openDatabase(target);
  migrate(db);
  // Migrating writes, so the WAL and shared-memory files exist by now too. A
  // database this call created is ours to tighten regardless of the opt-out.
  for (const file of [target, `${target}-wal`, `${target}-shm`]) restrictFile(file, created);
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
