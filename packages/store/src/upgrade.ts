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
 *
 * Two OpenClerq processes can start on one database at once (a second app
 * window, a dev gateway beside the desktop's). One upgrade lock, a file beside
 * the database, makes the second wait for the first to finish; it then finds
 * nothing left to do, and makes no copy of its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './driver.js';
import { MIGRATIONS } from './migrations.js';
import { ensurePrivateDir, restrictFile } from './local-files.js';

/** How many backups are kept. */
export const BACKUPS_KEPT = 5;

const BACKUP_NAME = /^clerq-schema(\d+)-(\d{8}T\d{9}Z)\.db$/;
const PARTIAL_NAME = /^clerq-schema\d+-\d{8}T\d{9}Z\.db\.\d+\.partial$/;

/** A `.partial` copy this much older than now is from a run that died, not one still writing. */
export const PARTIAL_STALE_MS = 10 * 60_000;
/** An upgrade lock this old is a dead run's, whatever process id it names. */
export const LOCK_STALE_MS = 15 * 60_000;
/** How long a second process waits for the first to finish upgrading before it gives up. */
export const LOCK_WAIT_MS = 120_000;
/** A lock file with nothing readable in it is mid-write; only after this long is it a dead run's. */
const LOCK_UNREADABLE_MS = 15_000;

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

/** Another OpenClerq is upgrading this database and had not finished when this one gave up waiting. */
export class StoreBusyError extends Error {
  constructor(
    /** The process holding the lock, when its lock file said. */
    readonly pid: number | undefined,
    /** Seconds the lock has been held, when its file said. */
    readonly heldSeconds: number | undefined,
    readonly lockFile: string
  ) {
    super(
      `Another OpenClerq${pid !== undefined ? ` (process ${pid})` : ''} is upgrading this database` +
        `${heldSeconds !== undefined ? ` and has been for ${heldSeconds} seconds` : ''}. ` +
        'Wait for it to finish, then start OpenClerq again. ' +
        `If no OpenClerq is running, delete ${shown(lockFile)}.`
    );
    this.name = 'StoreBusyError';
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
  // A copy an earlier run died while writing is never a backup, so it is not kept. One that is
  // young may be another process still writing it, and is left alone.
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (PARTIAL_NAME.test(name) && Date.now() - fs.statSync(file).mtimeMs > PARTIAL_STALE_MS) {
        doomed.push(file);
      }
    }
  } catch {
    /* nothing to look through, or one went while we looked */
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
  // The process id in the name keeps two processes' half-written copies apart.
  const partial = `${file}.${process.pid}.partial`;
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

/** The file that says an upgrade of the database at `dbPath` is under way. */
export function upgradeLockFile(dbPath: string): string {
  return `${dbPath}.upgrade-lock`;
}

interface LockHolder {
  pid?: number;
  /** Milliseconds since the lock was written, from its own timestamp or else the file's. */
  ageMs: number;
  readable: boolean;
}

function readLock(file: string): LockHolder | null {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null; // gone since we looked
  }
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; at?: unknown };
    const at = typeof body.at === 'string' ? Date.parse(body.at) : NaN;
    return {
      pid: typeof body.pid === 'number' ? body.pid : undefined,
      ageMs: Date.now() - (Number.isNaN(at) ? mtime : at),
      readable: true,
    };
  } catch {
    return { ageMs: Date.now() - mtime, readable: false };
  }
}

/** Whether a process with this id exists on this machine (we cannot tell for another's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

function isStale(holder: LockHolder): boolean {
  if (!holder.readable) return holder.ageMs > LOCK_UNREADABLE_MS;
  if (holder.ageMs > LOCK_STALE_MS) return true;
  return holder.pid !== undefined && holder.pid !== process.pid && !alive(holder.pid);
}

/**
 * Take the upgrade lock for the database at `dbPath`, waiting up to `waitMs`
 * while another process holds it. Returns the function that gives it back.
 *
 * The lock is a file made with exclusive create, holding the process id and the
 * time. A lock whose process is gone, or which is older than a quarter of an
 * hour, is a dead run's and is taken over. If the file cannot be made at all
 * (an unwritable folder), nothing is locked and the upgrade carries on: the
 * backup that follows says what is wrong with the folder.
 *
 * Throws StoreBusyError if the wait runs out.
 */
export async function acquireUpgradeLock(
  dbPath: string,
  waitMs: number = LOCK_WAIT_MS
): Promise<() => void> {
  const file = upgradeLockFile(dbPath);
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const startedAt = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        // Only our own: after a take-over the file is another process's.
        const held = readLock(file);
        if (held?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') return () => undefined;
    }
    const holder = readLock(file);
    if (holder && isStale(holder)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() - startedAt >= waitMs) {
      throw new StoreBusyError(
        holder?.pid,
        holder ? Math.round(holder.ageMs / 1000) : undefined,
        file
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
