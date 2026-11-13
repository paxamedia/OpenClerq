import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openStore,
  openDatabase,
  migrate,
  MIGRATIONS,
  ensureMemoryIndex,
  memorySearchable,
  rebuildMemoryIndex,
  indexMemory,
  unindexMemory,
  searchMemoryIndex,
  memoryText,
  searchTokens,
  ftsQuery,
  type Database,
} from './index.js';

let db: Database;

beforeEach(async () => {
  db = await openStore(':memory:');
});

afterEach(() => {
  db.close();
});

/** A record in `memory` and in the index, as the gateway writes one. */
function remember(key: string, value: unknown): number {
  const json = JSON.stringify(value);
  const res = db
    .prepare(
      `INSERT INTO memory (id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .run(`mem_${key}`, key, json);
  const seq = Number(res.lastInsertRowid);
  indexMemory(db, { seq, key, text: memoryText(json) });
  return seq;
}

describe('migration 16: memory records', () => {
  /** A database as release 0.6a left it: migrations 1 to 15, with the old memory table. */
  async function oldDatabase(): Promise<Database> {
    const old = await openDatabase(':memory:');
    old.exec(
      'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
    );
    for (const m of MIGRATIONS.filter((x) => x.id <= 15)) {
      old.exec(m.sql);
      old
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(m.id, m.name, '2026-01-01');
    }
    return old;
  }

  it('carries every existing row across, whatever it held', async () => {
    const old = await oldDatabase();
    const insert = old.prepare(
      `INSERT INTO memory (key, value, type, source_session, confidence, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'tone',
      JSON.stringify('formal'),
      'fact',
      null,
      null,
      '2026-01-02',
      '2026-01-03',
      null
    );
    insert.run(
      'billing',
      JSON.stringify({ rate: 80, currency: 'EUR' }),
      'fact',
      'ses_1',
      0.9,
      '2026-02-01',
      '2026-02-02',
      '2099-01-01T00:00:00.000Z'
    );
    // The old table had no checks: a type nobody defined and a confidence out of range.
    insert.run('odd', 'null', 'weird', null, 5, '2026-03-01', '2026-03-01', null);

    expect(migrate(old).slice(-2)).toEqual([16, 17]);

    const rows = old.prepare('SELECT * FROM memory ORDER BY created_at').all();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.key, r.value, r.created_at, r.updated_at])).toEqual([
      ['tone', '"formal"', '2026-01-02', '2026-01-03'],
      ['billing', '{"rate":80,"currency":"EUR"}', '2026-02-01', '2026-02-02'],
      ['odd', 'null', '2026-03-01', '2026-03-01'],
    ]);
    expect(rows[1]).toMatchObject({
      source_session: 'ses_1',
      confidence: 0.9,
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    expect(rows.map((r) => r.type)).toEqual(['fact', 'fact', 'fact']);
    expect(rows[2].confidence).toBeNull();
    expect(rows.every((r) => r.origin === 'import' && r.status === 'active')).toBe(true);
    // Nothing from before was written by an agent.
    expect(rows.every((r) => r.agent_derived === 0)).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows.every((r) => /^mem_[0-9a-f]{16}$/.test(String(r.id)))).toBe(true);
    old.close();
  });

  it('lets a key hold several records, which the old table did not', async () => {
    const old = await oldDatabase();
    migrate(old);
    const add = (id: string) =>
      old
        .prepare(
          "INSERT INTO memory (id, key, value, created_at, updated_at) VALUES (?, 'k', '1', 'a', 'a')"
        )
        .run(id);
    add('mem_a');
    add('mem_b');
    expect(old.prepare("SELECT COUNT(*) AS n FROM memory WHERE key = 'k'").get()?.n).toBe(2);
    expect(() => add('mem_a')).toThrow();
    old.close();
  });

  it('checks the type, the origin, the status and the confidence', () => {
    const add = (extra: string, value: string) =>
      db
        .prepare(
          `INSERT INTO memory (id, key, value, ${extra}, created_at, updated_at) VALUES ('m', 'k', '1', ?, 'a', 'a')`
        )
        .run(value);
    expect(() => add('type', 'opinion')).toThrow();
    expect(() => add('origin', 'robot')).toThrow();
    expect(() => add('status', 'gone')).toThrow();
    expect(() => add('confidence', '1.5')).toThrow();
    db.exec('DELETE FROM memory');
    for (const type of ['fact', 'preference', 'decision', 'procedure', 'note']) {
      db.prepare(
        "INSERT INTO memory (id, key, value, type, created_at, updated_at) VALUES (?, 'k', '1', ?, 'a', 'a')"
      ).run(`m_${type}`, type);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n).toBe(5);
  });

  it('marks a record an agent wrote as agent-derived, for databases that already hold one', async () => {
    const old = await oldDatabase();
    migrate(old);
    // Migration 17 on its own, over a table that already has an agent's record.
    old.exec('DROP TABLE memory');
    old.exec(
      "CREATE TABLE memory (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, origin TEXT, status TEXT DEFAULT 'active', key TEXT, value TEXT)"
    );
    old.exec(
      "INSERT INTO memory (id, origin, key, value) VALUES ('a', 'agent', 'k', '1'), ('u', 'user', 'k', '2')"
    );
    old.exec(MIGRATIONS.find((m) => m.id === 17)?.sql as string);
    expect(old.prepare('SELECT id, agent_derived FROM memory ORDER BY id').all()).toEqual([
      { id: 'a', agent_derived: 1 },
      { id: 'u', agent_derived: 0 },
    ]);
    old.close();
  });

  it('is applied once', () => {
    expect(migrate(db)).toEqual([]);
  });
});

describe('the search text', () => {
  it('reads strings, numbers and the names and values inside an object or list', () => {
    expect(memoryText('"plain text"')).toBe('plain text');
    expect(memoryText('42')).toBe('42');
    expect(memoryText('true')).toBe('true');
    expect(memoryText('null')).toBe('');
    expect(memoryText('{"deadline":"2026-12-01","tags":["a","b"],"n":{"x":1}}')).toBe(
      'deadline 2026-12-01 tags a b n x 1'
    );
    // A value that is not JSON is its own text, not an error.
    expect(memoryText('not json')).toBe('not json');
  });

  it('takes words in any script, once each', () => {
    expect(searchTokens('Quarterly filing, FILING due 2026!')).toEqual([
      'quarterly',
      'filing',
      'due',
      '2026',
    ]);
    expect(searchTokens('日本語 テスト')).toEqual(['日本語', 'テスト']);
    expect(searchTokens('--- ???')).toEqual([]);
  });

  it('quotes every word, so nothing typed is FTS syntax, and makes the last a prefix', () => {
    expect(ftsQuery('quarterly fil')).toBe('"quarterly" "fil"*');
    expect(ftsQuery('a OR b NEAR(c) "d" -e *')).toBe('"a" "or" "b" "near" "c" "d" "e"*');
    expect(ftsQuery('   ')).toBeNull();
    // For a whole message: any word, none of them a prefix.
    expect(ftsQuery(['quarterly', 'filing'], 'any')).toBe('"quarterly" OR "filing"');
    expect(ftsQuery([], 'any')).toBeNull();
  });
});

describe('the search index', () => {
  it('is there where SQLite has FTS5, which Node 24 and Bun do', () => {
    expect(ensureMemoryIndex(db)).toBe(true);
    expect(memorySearchable(db)).toBe(true);
  });

  it('finds a record by a word in its key or its value, best first', () => {
    const invoice = remember('invoice-2026', { note: 'quarterly filing for the shop' });
    remember('unrelated', { note: 'nothing here' });
    const filing = remember('quarterly', 'filing filing filing deadline');
    const hits = searchMemoryIndex(db, 'quarterly filing', 10);
    expect(hits.map((h) => h.seq).sort()).toEqual([invoice, filing].sort());
    // The key counts for more than a word in the value.
    expect(hits[0].seq).toBe(filing);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('needs every word, matches the last as a prefix and ignores case and accents', () => {
    remember('cafe', 'Crème brûlée recipe');
    expect(searchMemoryIndex(db, 'creme brulee', 10)).toHaveLength(1);
    expect(searchMemoryIndex(db, 'CRÈME rec', 10)).toHaveLength(1);
    expect(searchMemoryIndex(db, 'creme pizza', 10)).toEqual([]);
  });

  it('with any, finds a record that has some of the words, the best match first', () => {
    const both = remember('quarterly-filing', 'quarterly vat filing for the shop');
    const one = remember('shop', 'the shop is closed on mondays');
    remember('other', 'nothing relevant');
    const hits = searchMemoryIndex(db, ['quarterly', 'filing', 'closed'], 10, 'any');
    expect(hits.map((h) => h.seq)).toEqual([both, one]);
    expect(searchMemoryIndex(db, ['quarterly', 'filing', 'closed'], 10, 'all')).toEqual([]);
    expect(searchMemoryIndex(db, [], 10, 'any')).toEqual([]);
  });

  it('reads punctuation and operators as text, not as syntax', () => {
    remember('k', 'plain words');
    for (const q of ['"', 'plain OR', '(((', 'a:b', 'plain -words', 'NEAR(', '*']) {
      expect(() => searchMemoryIndex(db, q, 10), q).not.toThrow();
    }
    expect(searchMemoryIndex(db, '', 10)).toEqual([]);
  });

  it('drops a record that is removed or changed', () => {
    const seq = remember('k', 'alpha beta');
    expect(searchMemoryIndex(db, 'alpha', 10)).toHaveLength(1);
    indexMemory(db, { seq, key: 'k', text: 'gamma' });
    expect(searchMemoryIndex(db, 'alpha', 10)).toEqual([]);
    expect(searchMemoryIndex(db, 'gamma', 10)).toHaveLength(1);
    unindexMemory(db, seq);
    expect(searchMemoryIndex(db, 'gamma', 10)).toEqual([]);
  });

  it('is rebuilt from the table when it does not match it', () => {
    remember('a', 'one');
    remember('b', 'two');
    // A runtime without FTS5 wrote a record; the next start brings the index back in line.
    db.prepare(
      "INSERT INTO memory (id, key, value, created_at, updated_at) VALUES ('mem_c', 'c', '\"three\"', 'a', 'a')"
    ).run();
    expect(searchMemoryIndex(db, 'three', 10)).toEqual([]);
    ensureMemoryIndex(db);
    expect(searchMemoryIndex(db, 'three', 10)).toHaveLength(1);
    rebuildMemoryIndex(db);
    expect(searchMemoryIndex(db, 'one', 10)).toHaveLength(1);
  });

  it('degrades, without failing, where SQLite has no FTS5', async () => {
    const real = await openDatabase(':memory:');
    migrate(real);
    // A SQLite build that does not know the module.
    const without: Database = {
      ...real,
      exec(sql) {
        if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
        real.exec(sql);
      },
    };
    expect(ensureMemoryIndex(without)).toBe(false);
    expect(memorySearchable(without)).toBe(false);
    // Writes keep working; there is simply nothing to index or ask.
    expect(() => indexMemory(without, { seq: 1, key: 'k', text: 't' })).not.toThrow();
    expect(() => unindexMemory(without, 1)).not.toThrow();
    expect(searchMemoryIndex(without, 'anything', 5)).toEqual([]);
    real.close();
  });
});
