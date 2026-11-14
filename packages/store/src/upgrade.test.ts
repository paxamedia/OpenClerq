/**
 * Upgrading and downgrading a database file: the copy taken before a
 * migration, how many are kept, and the refusal of a database from a newer
 * OpenClerq.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUPS_KEPT,
  MIGRATIONS,
  StoreBackupError,
  StoreTooNewError,
  backupsDir,
  listBackups,
  migrate,
  newestKnownSchema,
  openDatabase,
  openStore,
  schemaVersion,
  type Database,
} from './index.js';

const posix = process.platform !== 'win32';
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
const NEWEST = MIGRATIONS[MIGRATIONS.length - 1].id;

let root: string;
let file: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-upgrade-'));
  file = path.join(root, 'clerq.db');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A database file as an earlier release left it: migrations 1 to `upTo`, with a session and a run in it. */
async function seedAt(upTo: number, at = file): Promise<void> {
  const db = await openDatabase(at);
  db.exec(
    'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
  );
  for (const m of MIGRATIONS.filter((x) => x.id <= upTo)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
      m.id,
      m.name,
      '2026-01-01'
    );
  }
  db.prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('ses_old', 'Written before', 'a', 'a')"
  ).run();
  db.prepare(
    "INSERT INTO runs (id, status, trigger, created_at) VALUES ('run_old', 'done', 'manual', '2026-01-01')"
  ).run();
  db.close();
}

const backupsOf = (at = file) => listBackups(backupsDir(at));

describe('a database that is behind this build', () => {
  it('is copied first, then migrated to the newest schema, and nothing it held is lost', async () => {
    await seedAt(12);
    const log: Array<[string, Record<string, unknown>]> = [];
    const db = await openStore(file, { log: (m, d) => log.push([m, d]) });

    expect(schemaVersion(db)).toBe(NEWEST);
    expect(db.prepare("SELECT title FROM sessions WHERE id = 'ses_old'").get()).toEqual({
      title: 'Written before',
    });
    expect(db.prepare("SELECT status FROM runs WHERE id = 'run_old'").get()).toEqual({
      status: 'done',
    });

    const [backup] = backupsOf();
    expect(backupsOf()).toHaveLength(1);
    expect(backup.schema).toBe(12);
    expect(path.basename(backup.file)).toMatch(/^clerq-schema12-\d{8}T\d{9}Z\.db$/);
    expect(path.dirname(backup.file)).toBe(path.join(root, 'backups'));

    // It names what ran and where the copy is.
    expect(log).toEqual([
      [
        'Store upgraded',
        {
          migrations: MIGRATIONS.filter((m) => m.id > 12).map((m) => m.id),
          backup: backup.file,
        },
      ],
    ]);
    db.close();
  });

  it('leaves a copy that opens on its own, at the schema it was taken at, with the data', async () => {
    await seedAt(12);
    (await openStore(file)).close();
    const [backup] = backupsOf();

    const copy = await openDatabase(backup.file);
    expect(schemaVersion(copy)).toBe(12);
    expect(copy.prepare("SELECT title FROM sessions WHERE id = 'ses_old'").get()).toEqual({
      title: 'Written before',
    });
    expect(copy.prepare("SELECT status FROM runs WHERE id = 'run_old'").get()).toEqual({
      status: 'done',
    });
    // It has none of what the upgrade added.
    expect(
      copy.prepare("SELECT name FROM sqlite_master WHERE name = 'tool_calls'").get()
    ).toBeUndefined();
    copy.close();
  });

  it('puts the copy in a private directory and keeps it private', async () => {
    if (!posix) return;
    await seedAt(12);
    (await openStore(file)).close();
    expect(modeOf(path.join(root, 'backups'))).toBe(0o700);
    expect(modeOf(backupsOf()[0].file)).toBe(0o600);
  });

  it('is copied from the schema it had, not from 1, when only some migrations are pending', async () => {
    await seedAt(NEWEST - 1);
    (await openStore(file)).close();
    expect(backupsOf().map((b) => b.schema)).toEqual([NEWEST - 1]);
  });

  it('leaves no stray file next to the copy', async () => {
    await seedAt(12);
    (await openStore(file)).close();
    expect(fs.readdirSync(path.join(root, 'backups'))).toEqual([
      path.basename(backupsOf()[0].file),
    ]);
  });
});

describe('a copy is made only when there is something to migrate', () => {
  it('is not made for a new database', async () => {
    const log: string[] = [];
    (await openStore(file, { log: (m) => log.push(m) })).close();
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
    expect(log).toEqual(['Store created']);
  });

  it('is not made again for a database that is already current', async () => {
    await seedAt(12);
    (await openStore(file)).close();
    expect(backupsOf()).toHaveLength(1);
    const log: string[] = [];
    (await openStore(file, { log: (m) => log.push(m) })).close();
    (await openStore(file)).close();
    expect(backupsOf()).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it('is not made for a database in memory', async () => {
    const before = fs.existsSync('backups');
    (await openStore(':memory:')).close();
    expect(fs.existsSync('backups')).toBe(before);
  });
});

describe('the newest copies are kept', () => {
  it(`keeps ${BACKUPS_KEPT} and deletes the older ones, by the time in the name`, async () => {
    await seedAt(12);
    const dir = path.join(root, 'backups');
    fs.mkdirSync(dir);
    // Seven older copies, written out of order, plus things that are not ours.
    const stamps = [
      '20260301T000000000Z',
      '20260101T000000000Z',
      '20260601T000000000Z',
      '20260201T000000000Z',
      '20260501T000000000Z',
      '20260401T000000000Z',
      '20260701T000000000Z',
    ];
    stamps.forEach((s, i) => fs.writeFileSync(path.join(dir, `clerq-schema${i + 1}-${s}.db`), 'x'));
    fs.writeFileSync(path.join(dir, 'clerq-schema9-20260101T000000000Z.db-wal'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, 'clerq-schema3-by-hand.db'), 'mine');
    fs.writeFileSync(path.join(dir, 'clerq-schema2-20260115T000000000Z.db.partial'), 'half');

    (await openStore(file)).close();

    const kept = backupsOf();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    // The new one, then the four newest before it.
    expect(kept[0].schema).toBe(12);
    expect(kept.slice(1).map((b) => b.stamp)).toEqual([
      '20260701T000000000Z',
      '20260601T000000000Z',
      '20260501T000000000Z',
      '20260401T000000000Z',
    ]);
    const left = fs.readdirSync(dir);
    expect(left).toContain('notes.txt');
    expect(left).toContain('clerq-schema3-by-hand.db');
    // A copy an earlier run died while writing is not a backup, and goes.
    expect(left.some((n) => n.endsWith('.partial'))).toBe(false);
  });

  it('never deletes the copy it has just made, even if the clock went backwards', async () => {
    await seedAt(12);
    const dir = path.join(root, 'backups');
    fs.mkdirSync(dir);
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(dir, `clerq-schema${i}-2099010${i}T000000000Z.db`), 'x');
    }
    (await openStore(file)).close();
    expect(backupsOf().filter((b) => b.schema === 12)).toHaveLength(1);
    expect(backupsOf()).toHaveLength(BACKUPS_KEPT);
  });
});

describe('a copy that cannot be made', () => {
  it('stops the upgrade, changes nothing and says why', async () => {
    await seedAt(12);
    // Where the backups go is a file, so nothing can be written there.
    fs.writeFileSync(path.join(root, 'backups'), 'in the way');

    const error = await openStore(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreBackupError);
    expect((error as Error).message).toMatch(
      /^Could not back up the database before upgrading it: /
    );
    expect((error as Error).message).toContain('Nothing was changed.');
    expect((error as Error).message).toContain(path.join(root, 'backups'));

    const db = await openDatabase(file);
    expect(schemaVersion(db)).toBe(12);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'tool_calls'").get()
    ).toBeUndefined();
    expect(db.prepare("SELECT title FROM sessions WHERE id = 'ses_old'").get()).toBeDefined();
    db.close();
    expect(fs.readFileSync(path.join(root, 'backups'), 'utf8')).toBe('in the way');
  });

  it('succeeds on the next start once the cause is gone', async () => {
    await seedAt(12);
    fs.writeFileSync(path.join(root, 'backups'), 'in the way');
    await expect(openStore(file)).rejects.toBeInstanceOf(StoreBackupError);
    fs.rmSync(path.join(root, 'backups'));
    const db = await openStore(file);
    expect(schemaVersion(db)).toBe(NEWEST);
    expect(backupsOf()).toHaveLength(1);
    db.close();
  });
});

describe('a database from a newer OpenClerq', () => {
  async function seedNewer(at = file): Promise<void> {
    await seedAt(NEWEST, at);
    const db = await openDatabase(at);
    db.prepare(
      "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, 'from_the_future', 'x')"
    ).run(NEWEST + 2);
    db.close();
  }

  it('is refused, in words that say what to do', async () => {
    const home = path.join(root, 'home');
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.clerq'), { recursive: true });
    const at = path.join(home, '.clerq', 'clerq.db');
    await seedNewer(at);

    const error = await openStore().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreTooNewError);
    expect((error as Error).message).toBe(
      `This database was written by a newer OpenClerq (schema ${NEWEST + 2}); this build knows schema ${NEWEST}. ` +
        'Install the newer version, or restore a backup from ~/.clerq/backups.'
    );
    expect(error).toMatchObject({ found: NEWEST + 2, known: NEWEST });
  });

  it('names the real directory when the database is somewhere else', async () => {
    await seedNewer();
    const error = (await openStore(file).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain(`restore a backup from ${path.join(root, 'backups')}.`);
  });

  it('is left as it was: nothing migrated, no copy, the file free to use', async () => {
    await seedNewer();
    const before = fs.readFileSync(file);
    await expect(openStore(file)).rejects.toBeInstanceOf(StoreTooNewError);
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    // The handle was closed: the file can be opened and changed again.
    const db = await openDatabase(file);
    expect(schemaVersion(db)).toBe(NEWEST + 2);
    db.close();
  });

  it('is refused by migrate() too, before it changes anything', async () => {
    const db = await openDatabase(':memory:');
    db.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
    );
    db.prepare("INSERT INTO schema_migrations VALUES (3, 'core', 'x')").run();
    db.prepare("INSERT INTO schema_migrations VALUES (999, 'later', 'x')").run();
    expect(() => migrate(db)).toThrow(/written by a newer OpenClerq \(schema 999\)/);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
    db.close();
  });

  it('is not mistaken for a database that merely has a gap', async () => {
    // Ids this build knows, in any combination, are fine: only a higher id is "newer".
    const db = await openDatabase(':memory:');
    db.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
    );
    db.prepare("INSERT INTO schema_migrations VALUES (1, 'core_schema', 'x')").run();
    for (const m of MIGRATIONS.slice(0, 1)) db.exec(m.sql);
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });
});

describe('schemaVersion', () => {
  it('is null before anything is migrated, and the newest migration after', async () => {
    const db: Database = await openDatabase(':memory:');
    expect(schemaVersion(db)).toBeNull();
    migrate(db);
    expect(schemaVersion(db)).toBe(newestKnownSchema());
    expect(schemaVersion(db)).toBe(NEWEST);
    db.close();
  });
});
