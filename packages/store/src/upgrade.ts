/**
 * What happens to a database file when OpenClerq is upgraded or, by mistake,
 * downgraded.
 *
 *   Newer than this build  refused, in plain words: an older program cannot
 *                          know what a newer one changed.
 *   Behind this build      backed up first with VACUUM INTO, then migrated.
 *
 * Backups live in `<store dir>/backups`, one per upgrade, the newest five kept.
 * VACUUM INTO works the same on node:sqlite and bun:sqlite, takes a consistent
 * snapshot of a database in use (the write-ahead log included), and leaves a
 * single ordinary file: copy it over `clerq.db` to go back.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './driver.js';
import { MIGRATIONS } from './migrations.js';
import { ensurePrivateDir, restrictFile } from './local-files.js';

/** How many backups are kept. */
export const BACKUPS_KEPT = 5;

const BACKUP_NAME = /^clerq-schema(\d+)-(\d{8}T\d{9}Z)\.db$/;
const PARTIAL_NAME = /^clerq-schema\d+-\d{8}T\d{9}Z\.db\.partial$/;

/** The newest schema this build knows: the id of its last migration. */
export function newestKnownSchema(): number {
  return MIGRATIONS.reduce((newest, m) => Math.max(newest, m.id), 0);
}

/** Where a database's backups go: `backups` beside it. */
export function backupsDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backups');
}

/** A path with the home directory written as `~`, for messages a person reads. */
function shown(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p;
}

/** The database was written by a newer OpenClerq than this one. */
export class StoreTooNewError extends Error {
  constructor(
    /** The newest migration the database holds. */
    readonly found: number,
    /** The newest this build knows. */
    readonly known: number,
    /** Where backups are, when the database is a file. */
    readonly backups?: string
  ) {
    super(
      `This database was written by a newer OpenClerq (schema ${found}); this build knows schema ${known}. ` +
        `Install the newer version${backups ? `, or restore a backup from ${shown(backups)}` : ''}.`
    );
    this.name = 'StoreTooNewError';
  }
}

/** The copy taken before an upgrade could not be made, so nothing was changed. */
export class StoreBackupError extends Error {
  constructor(reason: string, backups: string) {
    super(
      `Could not back up the database before upgrading it: ${reason}. Nothing was changed. ` +
        `Make sure ${shown(backups)} can be written and the disk has room for a copy of the database, then start OpenClerq again.`
    );
    this.name = 'StoreBackupError';
  }
}

/** Throw if any applied migration id is newer than this build knows. */
export function refuseNewer(applied: Iterable<number>, backups?: string): void {
  const known = newestKnownSchema();
  let found = 0;
  for (const id of applied) found = Math.max(found, id);
  if (found > known) throw new StoreTooNewError(found, known, backups);
}

/** `20261113T101530123Z`: UTC, fixed width, so names sort in time order. */
function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace('.', '');
}

/** The backups in `dir`, newest first. Files that are not ours are not listed. */
export function listBackups(dir: string): Array<{ file: string; schema: number; stamp: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const m = BACKUP_NAME.exec(name);
      return m ? [{ file: path.join(dir, name), schema: Number(m[1]), stamp: m[2] }] : [];
    })
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : b.schema - a.schema));
}

/** Delete all but the newest `keep` backups, and never `protect`. Failures are left for next time. */
function pruneBackups(dir: string, keep: number, protect: string): void {
  const rest = listBackups(dir).filter((b) => b.file !== protect);
  const doomed = rest.slice(Math.max(0, keep - 1)).map((b) => b.file);
  // A copy an earlier run died while writing: never a backup, so never kept.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (PARTIAL_NAME.test(name) && path.join(dir, name) !== `${protect}.partial`) {
        doomed.push(path.join(dir, name));
      }
    }
  } catch {
    /* nothing to look through */
  }
  for (const file of doomed) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(file + suffix, { force: true });
      } catch {
        /* a file in use; the next upgrade tries again */
      }
    }
  }
}

/**
 * Write a consistent copy of `db` (a file at `dbPath`, now at schema `from`)
 * to `<dir>/backups/clerq-schema<from>-<UTC timestamp>.db`, and return its
 * path. The directory is 0700 and the copy 0600; older backups beyond the
 * newest five are deleted afterwards.
 *
 * The copy is written under a `.partial` name and renamed when whole, so a
 * file with a backup's name is always a complete one. Throws StoreBackupError,
 * and leaves nothing behind, if it cannot.
 */
export function backupDatabase(
  db: Database,
  dbPath: string,
  from: number,
  now: Date = new Date()
): string {
  const dir = backupsDir(dbPath);
  const file = path.join(dir, `clerq-schema${from}-${stamp(now)}.db`);
  const partial = `${file}.partial`;
  try {
    ensurePrivateDir(dir);
    if (fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists`);
    // VACUUM INTO needs a path that does not exist yet (Bun's SQLite refuses
    // even an empty file), so the copy is tightened as soon as it is made; the
    // directory it is made in is private.
    fs.rmSync(partial, { force: true });
    db.prepare('VACUUM INTO ?').run(partial);
    restrictFile(partial, true);
    fs.renameSync(partial, file);
  } catch (e) {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      /* nothing was written, or it cannot be removed either */
    }
    throw new StoreBackupError(e instanceof Error ? e.message : String(e), dir);
  }
  pruneBackups(dir, BACKUPS_KEPT, file);
  return file;
}
