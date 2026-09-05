import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, migrate, audit, type Database } from './index.js';
import { importLegacyJson } from './import-legacy.js';

let db: Database;

beforeEach(async () => {
  db = await openStore(':memory:');
});

afterEach(() => {
  db.close();
});

describe('driver', () => {
  it('uses a built-in backend, never a native addon', () => {
    // better-sqlite3 cannot be embedded by `bun build --compile`, which is how
    // the desktop sidecar is produced. Both backends here ship with the runtime.
    expect(['node:sqlite', 'bun:sqlite']).toContain(db.backend);
  });

  it('round-trips values and normalises booleans and undefined', () => {
    db.exec('CREATE TABLE t (a INTEGER, b TEXT, c INTEGER)');
    db.prepare('INSERT INTO t VALUES (?, ?, ?)').run(1, 'x', true);
    db.prepare('INSERT INTO t VALUES (?, ?, ?)').run(2, null, false);
    const rows = db.prepare('SELECT a, b, c FROM t ORDER BY a').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ a: 1, b: 'x', c: 1 });
    expect(rows[1]).toMatchObject({ a: 2, b: null, c: 0 });
  });

  it('reports changes from run()', () => {
    db.exec('CREATE TABLE t (a INTEGER)');
    const res = db.prepare('INSERT INTO t VALUES (?)').run(1);
    expect(res.changes).toBe(1);
  });

  it('returns undefined rather than null for a missing row', () => {
    db.exec('CREATE TABLE t (a INTEGER)');
    expect(db.prepare('SELECT a FROM t WHERE a = ?').get(99)).toBeUndefined();
  });

  it('rolls back a failed transaction', () => {
    db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run(2);
        db.prepare('INSERT INTO t VALUES (?)').run(1); // duplicate key
      })
    ).toThrow();
    // The whole transaction is undone, including the row that would have worked.
    expect(db.prepare('SELECT count(*) AS n FROM t').get()?.n).toBe(1);
  });

  it('commits a successful transaction', () => {
    db.exec('CREATE TABLE t (a INTEGER)');
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run(1);
      db.prepare('INSERT INTO t VALUES (?)').run(2);
    });
    expect(db.prepare('SELECT count(*) AS n FROM t').get()?.n).toBe(2);
  });
});

describe('migrations', () => {
  it('creates every table the roadmap schema names', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name));
    for (const t of [
      'sessions',
      'messages',
      'repos',
      'automations',
      'automation_targets',
      'runs',
      'run_steps',
      'artifacts',
      'approvals',
      'memory',
      'triggers',
      'audit_log',
      'schema_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent — a second run applies nothing', () => {
    expect(migrate(db)).toEqual([]);
  });

  it('records what it applied', () => {
    const rows = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ id: 1, name: 'core_schema' });
  });

  it('enforces foreign keys', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO run_steps (run_id, seq, kind, created_at) VALUES ('nope', 1, 'llm', '2026-01-01')"
        )
        .run()
    ).toThrow();
  });

  it('rejects an invalid run status', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO runs (id, status, trigger, created_at) VALUES ('r1', 'bogus', 'manual', '2026-01-01')"
        )
        .run()
    ).toThrow();
  });

  it('accepts a valid run and cascades step deletion', () => {
    db.prepare(
      "INSERT INTO runs (id, status, trigger, created_at) VALUES ('r1', 'queued', 'manual', '2026-01-01')"
    ).run();
    db.prepare(
      "INSERT INTO run_steps (run_id, seq, kind, created_at) VALUES ('r1', 1, 'llm', '2026-01-01')"
    ).run();
    db.prepare("DELETE FROM runs WHERE id = 'r1'").run();
    expect(db.prepare('SELECT count(*) AS n FROM run_steps').get()?.n).toBe(0);
  });
});

describe('audit log', () => {
  it('appends entries with serialised detail', () => {
    audit(db, { actor: 'tester', action: 'run.started', subject: 'r1', detail: { a: 1 } });
    const row = db.prepare('SELECT actor, action, subject, detail FROM audit_log').get();
    expect(row).toMatchObject({ actor: 'tester', action: 'run.started', subject: 'r1' });
    expect(JSON.parse(String(row?.detail))).toEqual({ a: 1 });
  });
});

describe('legacy JSON import', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-import-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports memory.json and archives the file', () => {
    fs.writeFileSync(
      path.join(dir, 'memory.json'),
      JSON.stringify({ a: { value: { n: 1 }, createdAt: '2026-01-01T00:00:00.000Z' } })
    );
    const res = importLegacyJson(db, dir);
    expect(res.memory).toBe(1);
    expect(res.archived).toContain('memory.json');
    expect(fs.existsSync(path.join(dir, 'memory.json.migrated'))).toBe(true);

    const row = db.prepare('SELECT key, value, created_at FROM memory').get();
    expect(row?.key).toBe('a');
    expect(JSON.parse(String(row?.value))).toEqual({ n: 1 });
    expect(row?.created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('imports all three trigger kinds', () => {
    fs.writeFileSync(
      path.join(dir, 'triggers.json'),
      JSON.stringify({
        cron: [{ id: 'c1', schedule: '0 3 * * *', message: 'nightly' }],
        file: [{ id: 'f1', path: '/tmp/x', message: 'on change' }],
        webhooks: { w1: { message: 'hooked' } },
      })
    );
    const res = importLegacyJson(db, dir);
    expect(res.triggers).toBe(3);
    const kinds = db
      .prepare('SELECT kind FROM triggers ORDER BY kind')
      .all()
      .map((r) => r.kind);
    expect(kinds).toEqual(['cron', 'file', 'webhook']);
  });

  it('is idempotent — re-importing adds nothing', () => {
    fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ a: { value: 1 } }));
    expect(importLegacyJson(db, dir).memory).toBe(1);
    // File is archived, so a second call is a no-op even before the conflict clause.
    expect(importLegacyJson(db, dir).memory).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM memory').get()?.n).toBe(1);
  });

  it('survives a corrupt file without throwing, and leaves it in place', () => {
    fs.writeFileSync(path.join(dir, 'memory.json'), '{ not json');
    const res = importLegacyJson(db, dir);
    expect(res.memory).toBe(0);
    expect(res.archived).not.toContain('memory.json');
    expect(fs.existsSync(path.join(dir, 'memory.json'))).toBe(true);
  });

  it('does nothing when the directory has no legacy files', () => {
    expect(importLegacyJson(db, dir)).toMatchObject({ memory: 0, triggers: 0, archived: [] });
  });
});

describe('on-disk database', () => {
  it('creates the file, enables WAL, and persists across reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-db-'));
    const file = path.join(dir, 'nested', 'clerq.db');
    try {
      const disk = await openStore(file);
      disk
        .prepare(
          "INSERT INTO runs (id, status, trigger, created_at) VALUES ('r1', 'queued', 'manual', '2026-01-01')"
        )
        .run();
      expect(String(disk.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal');
      disk.close();

      const reopened = await openStore(file);
      expect(reopened.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(1);
      // Reopening must not re-run migrations.
      expect(migrate(reopened)).toEqual([]);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
