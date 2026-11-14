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
import { ensureMemoryIndex } from './memory.js';
import { backupDatabase, backupsDir, refuseNewer } from './upgrade.js';

export type { Database, Statement, Row, Param } from './driver.js';
export { openDatabase } from './driver.js';
export { MIGRATIONS, type Migration } from './migrations.js';
export {
  migrateModule,
  addTenantColumns,
  checkModuleSql,
  moduleTablePrefix,
  ModuleMigrationError,
} from './module-migrations.js';
export {
  BACKUPS_KEPT,
  StoreBackupError,
  StoreTooNewError,
  backupDatabase,
  backupsDir,
  listBackups,
  newestKnownSchema,
} from './upgrade.js';
export { importLegacyJson, type ImportResult } from './import-legacy.js';
export {
  ensureMemoryIndex,
  searchable as memorySearchable,
  rebuildMemoryIndex,
  markMemoryIndexCurrent,
  memoryIndexSignature,
  indexMemory,
  unindexMemory,
  searchMemoryIndex,
  memoryText,
  searchTokens,
  ftsQuery,
  type IndexedRecord,
} from './memory.js';
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
 * The newest core migration applied to `db`; null for a database with none
 * (not yet migrated). This is the schema version `GET /version` reports.
 */
export function schemaVersion(db: Database): number | null {
  const table = db
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get();
  if (!table) return null;
  const row = db.prepare('SELECT MAX(id) AS newest FROM schema_migrations').get();
  return row?.newest === null || row?.newest === undefined ? null : Number(row.newest);
}

/** What `migrate` does around the migrations it runs. */
export interface MigrateHooks {
  /**
   * Called once, before any migration runs, when some are pending and the
   * database already holds at least one (so not for a new database). It
   * returns where it saved a copy; if it throws, nothing is migrated.
   */
  backup?: (from: number) => string;
  /** Called after the migrations, with the ids applied and the backup's path if one was made. */
  applied?: (ran: number[], backup?: string) => void;
  /** Where backups live, for the message when the database is newer than this build. */
  backups?: string;
}

/**
 * Apply any migrations the database has not seen, in order, each in its own
 * transaction. Safe to call on every start; a fully migrated database is a
 * no-op. Returns the ids applied by this call.
 *
 * A database that holds a migration newer than this build knows is refused
 * (StoreTooNewError) before anything is changed.
 */
export function migrate(db: Database, hooks: MigrateHooks = {}): number[] {
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
  refuseNewer(applied, hooks.backups);

  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (pending.length === 0) return [];

  const backup = applied.size > 0 && hooks.backup ? hooks.backup(Math.max(...applied)) : undefined;

  const ran: number[] = [];
  for (const m of pending) {
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
  hooks.applied?.(ran, backup);
  return ran;
}

export interface OpenStoreOptions {
  /** Told what an upgrade did: which migrations ran, and where the backup is. */
  log?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * Open the store at `dbPath` (default ~/.clerq/clerq.db), creating the
 * directory if needed, and bring the schema up to date.
 *
 * A file database that is behind this build is backed up (see upgrade.ts)
 * before it is migrated, and one that is ahead of it is refused. Neither
 * applies to `:memory:`.
 */
export async function openStore(
  dbPath?: string,
  options: OpenStoreOptions = {}
): Promise<Database> {
  const target = dbPath ?? getDefaultDbPath();
  if (target === ':memory:') {
    const db = await openDatabase(target);
    migrate(db);
    ensureMemoryIndex(db);
    return db;
  }

  // The database holds conversations, prompts and memory: this account only.
  // A custom location's directory is created private but, if it already
  // exists, left as the operator made it; the default one is always tightened.
  const dir = path.dirname(target);
  if (target === getDefaultDbPath() || !fs.existsSync(dir)) ensurePrivateDir(dir);
  const created = !fs.existsSync(target);

  const db = await openDatabase(target);
  try {
    migrate(db, {
      backups: backupsDir(target),
      backup: (from) => backupDatabase(db, target, from),
      applied: (ran, backup) =>
        options.log?.(backup ? 'Store upgraded' : 'Store created', {
          migrations: ran,
          ...(backup ? { backup } : {}),
        }),
    });
    ensureMemoryIndex(db);
  } catch (e) {
    // Do not leave the file open behind a refusal.
    db.close();
    throw e;
  }
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
