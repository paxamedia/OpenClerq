/**
 * Two OpenClerq processes started on one old database at once. Each is a real
 * process running the built store (`dist/`), since the point is what two
 * processes do to each other. Skipped when the package has not been built.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MIGRATIONS,
  listBackups,
  backupsDir,
  openDatabase,
  schemaVersion,
  upgradeLockFile,
} from './index.js';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const NEWEST = MIGRATIONS[MIGRATIONS.length - 1].id;

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-procs-'));
  file = path.join(root, 'clerq.db');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A database at schema 12 with enough in it that copying and migrating it takes a moment. */
async function seedBig(): Promise<void> {
  const db = await openDatabase(file);
  db.exec(
    'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
  );
  for (const m of MIGRATIONS.filter((x) => x.id <= 12)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x');
  }
  db.prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('ses_old', 'kept', 'a', 'a')"
  ).run();
  const add = db.prepare(
    "INSERT INTO messages (session_id, role, content, created_at) VALUES ('ses_old', 'user', ?, 'a')"
  );
  const filler = 'x'.repeat(1000);
  db.transaction(() => {
    for (let i = 0; i < 20_000; i++) add.run(filler);
  });
  db.close();
}

interface Outcome {
  ok: boolean;
  schema?: number;
  logs?: Array<[string, Record<string, unknown>]>;
  name?: string;
  message?: string;
}

const CHILD = `
const { openStore } = await import(process.env.STORE_DIST);
try {
  const logs = [];
  const db = await openStore(process.env.DB, {
    log: (m, d) => logs.push([m, d]),
    lockWaitMs: Number(process.env.WAIT_MS) || undefined,
  });
  const schema = db.prepare('SELECT max(id) AS n FROM schema_migrations').get().n;
  db.close();
  console.log(JSON.stringify({ ok: true, schema, logs }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, name: e.name, message: e.message }));
}
`;

/** Start a process that opens the store at `file`; resolves with what it printed. */
function openInProcess(env: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', CHILD], {
      env: { ...process.env, STORE_DIST: pathToFileURL(DIST).href, DB: file, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as Outcome);
      } catch {
        reject(new Error(`no answer from the process: ${out} ${err}`));
      }
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!fs.existsSync(DIST))('two processes on one old database', () => {
  it('both start, and only the first makes a copy and migrates', async () => {
    for (let round = 0; round < 3; round++) {
      fs.rmSync(file, { force: true });
      fs.rmSync(backupsDir(file), { recursive: true, force: true });
      await seedBig();

      const first = openInProcess();
      await wait(50);
      const second = openInProcess();
      const [a, b] = await Promise.all([first, second]);

      expect([a, b], `round ${round}`).toEqual([
        expect.objectContaining({ ok: true, schema: NEWEST }),
        expect.objectContaining({ ok: true, schema: NEWEST }),
      ]);
      // One of them upgraded and said so; the other found nothing to do.
      const upgrades = [a, b].filter((o) => (o.logs ?? []).some(([m]) => m === 'Store upgraded'));
      expect(upgrades).toHaveLength(1);
      expect(listBackups(backupsDir(file)).map((x) => x.schema)).toEqual([12]);
      expect(fs.readdirSync(backupsDir(file)).filter((n) => n.endsWith('.partial'))).toEqual([]);
      expect(fs.existsSync(upgradeLockFile(file))).toBe(false);
    }
  }, 60_000);

  it('waits for a lock held by a live process, then goes on once it is released', async () => {
    await seedBig();
    // This test process stands in for the one that is upgrading.
    fs.writeFileSync(
      upgradeLockFile(file),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
    );
    const opening = openInProcess();
    await wait(600);
    // Still waiting: nothing migrated, nothing copied.
    const mid = await openDatabase(file);
    expect(schemaVersion(mid)).toBe(12);
    mid.close();
    expect(fs.existsSync(backupsDir(file))).toBe(false);

    fs.rmSync(upgradeLockFile(file));
    const result = await opening;
    expect(result).toMatchObject({ ok: true, schema: NEWEST });
    expect(listBackups(backupsDir(file))).toHaveLength(1);
  }, 30_000);

  it('says so, truthfully, when the other process does not finish in time', async () => {
    await seedBig();
    fs.writeFileSync(
      upgradeLockFile(file),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
    );
    const result = await openInProcess({ WAIT_MS: '300' });
    expect(result.ok).toBe(false);
    expect(result.name).toBe('StoreBusyError');
    expect(result.message).toContain(
      `Another OpenClerq (process ${process.pid}) is upgrading this database`
    );
    expect(result.message).toContain('Wait for it to finish, then start OpenClerq again.');
    expect(result.message).toContain(upgradeLockFile(file));
    // It changed nothing.
    const db = await openDatabase(file);
    expect(schemaVersion(db)).toBe(12);
    db.close();
    expect(fs.existsSync(backupsDir(file))).toBe(false);
  }, 30_000);

  it('takes over the lock of a process that is gone, or one that is far too old', async () => {
    for (const lock of [
      { pid: 2_000_000_000, at: new Date().toISOString() },
      { pid: process.pid, at: new Date(Date.now() - 60 * 60_000).toISOString() },
    ]) {
      fs.rmSync(file, { force: true });
      fs.rmSync(backupsDir(file), { recursive: true, force: true });
      await seedBig();
      fs.writeFileSync(upgradeLockFile(file), JSON.stringify(lock));
      expect(await openInProcess({ WAIT_MS: '5000' })).toMatchObject({ ok: true, schema: NEWEST });
      expect(fs.existsSync(upgradeLockFile(file))).toBe(false);
    }
  }, 30_000);
});
