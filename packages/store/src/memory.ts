/**
 * The memory search index.
 *
 * Search over memory records is SQLite FTS5: a derived index in the table
 * `memory_fts`, one row per record with the same rowid as the record's `seq`.
 * It holds nothing that is not in `memory`, so it is rebuilt rather than
 * migrated, and it is built here, when the store opens, instead of in a
 * migration: a SQLite build without FTS5 must still open the database and
 * keep memory working. There, `searchable()` is false and the caller searches
 * the table by substring instead.
 *
 * FTS5 is in the SQLite that Node 24+ ships (`node:sqlite`) and in the one
 * Bun's `bun:sqlite` uses on macOS, Linux and Windows. It is checked, not
 * assumed.
 *
 * The index is kept in step by the code that writes `memory`, in the same
 * transaction, not by triggers: a trigger that names `memory_fts` would make
 * every write to `memory` fail in a process whose SQLite lacks FTS5, such as
 * another runtime opening the same database file.
 */

import type { Database } from './driver.js';

const state = new WeakMap<Database, boolean>();

/** Index row: the record's key and the text of its value. */
export interface IndexedRecord {
  seq: number;
  key: string;
  /** The value as text: see `memoryText`. */
  text: string;
}

/**
 * The value of a record, as the text the index reads. A string is itself; a
 * number or boolean its text; an object or list the names and scalar values in
 * it, so a search for "deadline" or for "2026" finds `{ deadline: "2026-12-01" }`.
 */
export function memoryText(valueJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (v === null || v === undefined || depth > 8) return;
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        parts.push(k);
        walk(x, depth + 1);
      }
    }
  };
  walk(value, 0);
  return parts.join(' ');
}

/** The words of a search, lowercased, at most `max`. Letters and digits of any script. */
export function searchTokens(text: string, max = 12): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words)].slice(0, max);
}

/**
 * An FTS5 MATCH expression for what a person typed: every word must be there
 * (so adding a word narrows), the last one as a prefix (so a search that is
 * still being typed finds its record). Each word is quoted, so nothing typed
 * is read as FTS5 syntax. Null when the text holds no word.
 */
export function ftsQuery(text: string): string | null {
  const words = searchTokens(text);
  if (words.length === 0) return null;
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(' ');
}

function count(db: Database, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
}

/**
 * Make the search index ready: create it where this SQLite has FTS5, and
 * rebuild it from `memory` when it does not match (first start after the
 * migration; a database another runtime wrote to). Safe to call again. Returns
 * whether memory is searchable by index.
 */
export function ensureMemoryIndex(db: Database): boolean {
  let ok = false;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
         key, body, tokenize = 'unicode61 remove_diacritics 2'
       )`
    );
    ok = true;
  } catch {
    // No FTS5 in this SQLite: memory is searched by substring instead.
  }
  state.set(db, ok);
  if (ok && count(db, 'memory_fts') !== count(db, 'memory')) rebuildMemoryIndex(db);
  return ok;
}

/** Whether `ensureMemoryIndex` found FTS5 for this database. */
export function searchable(db: Database): boolean {
  const known = state.get(db);
  return known === undefined ? ensureMemoryIndex(db) : known;
}

/** Throw the index away and index every record again. */
export function rebuildMemoryIndex(db: Database): void {
  db.transaction(() => {
    db.exec('DELETE FROM memory_fts');
    const insert = db.prepare('INSERT INTO memory_fts (rowid, key, body) VALUES (?, ?, ?)');
    for (const r of db.prepare('SELECT seq, key, value FROM memory').all()) {
      insert.run(Number(r.seq), String(r.key), memoryText(String(r.value)));
    }
  });
}

/** Put a record in the index, replacing what it had there. Call inside the write's transaction. */
export function indexMemory(db: Database, rec: IndexedRecord): void {
  if (!searchable(db)) return;
  db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(rec.seq);
  db.prepare('INSERT INTO memory_fts (rowid, key, body) VALUES (?, ?, ?)').run(
    rec.seq,
    rec.key,
    rec.text
  );
}

/** Take a record out of the index. Call inside the delete's transaction. */
export function unindexMemory(db: Database, seq: number): void {
  if (!searchable(db)) return;
  db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(seq);
}

/**
 * Records matching `query` by index, best first: their `seq` and a score
 * (higher is better). The key counts three times a word in the value.
 */
export function searchMemoryIndex(
  db: Database,
  query: string,
  limit: number
): Array<{ seq: number; score: number }> {
  const match = ftsQuery(query);
  if (!match || !searchable(db)) return [];
  return db
    .prepare(
      `SELECT rowid AS seq, bm25(memory_fts, 3.0, 1.0) AS rank
       FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(match, limit)
    .map((r) => ({ seq: Number(r.seq), score: -Number(r.rank) }));
}
