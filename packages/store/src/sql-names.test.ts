import { describe, expect, it } from 'vitest';
import { allNames, referencedNames, sqlWords } from './sql-names.js';

describe('every name a statement could mean', () => {
  it('finds bare, double-quoted, bracketed and backticked names, lower-cased', () => {
    for (const q of ['Settings', '"Settings"', '[Settings]', '`Settings`']) {
      expect(allNames(`UPDATE ${q} SET v = 1`), q).toContain('settings');
    }
    expect(allNames('SELECT * FROM main.settings')).toEqual(['select', 'from', 'main', 'settings']);
  });

  it('reads a string as a name only where SQLite does: after FROM, JOIN, INTO, UPDATE, TABLE, … and a dot', () => {
    for (const sql of [
      "UPDATE 'settings' SET v = 1",
      "INSERT INTO 'settings' (key) VALUES ('a')",
      "DELETE FROM 'settings'",
      "SELECT * FROM t JOIN 'settings' ON 1",
      "SELECT * FROM t, 'settings'",
      "SELECT * FROM main.'settings'",
      "SELECT * FROM ('settings')",
      "DROP TABLE IF EXISTS 'settings'",
      "CREATE INDEX i ON 'settings' (key)",
      "SELECT * FROM t, ('settings')",
    ]) {
      expect(allNames(sql), sql).toContain('settings');
    }
  });

  it('does not take an ordinary string for a name', () => {
    for (const sql of [
      "INSERT INTO t (v) VALUES ('settings')",
      "INSERT INTO t (a, b) VALUES ('x', 'settings')",
      "SELECT * FROM t WHERE kind = 'settings'",
      "SELECT * FROM t WHERE kind IN ('a', 'settings')",
      "SELECT 'settings' FROM t",
      "SELECT f('a', 'settings') FROM t",
      "UPDATE t SET v = 'settings'",
      "SELECT * FROM t JOIN u ON u.k = 'settings'",
      "SELECT * FROM t WHERE x LIKE 'settings'",
    ]) {
      expect(allNames(sql), sql).not.toContain('settings');
    }
  });

  it('knows a comma in a VALUES or SELECT list from one in a FROM list, past a subquery', () => {
    expect(allNames("SELECT * FROM (SELECT 1), 'settings'")).toContain('settings');
    expect(allNames("SELECT (SELECT 1 FROM u), 'settings' FROM t")).not.toContain('settings');
  });

  it('skips comments and survives an unterminated quote or comment', () => {
    expect(allNames('SELECT 1 -- settings\nFROM t')).toEqual(['select', 'from', 't']);
    expect(allNames('/* settings */ SELECT 1')).toEqual(['select']);
    for (const q of ['SELECT "abc', 'SELECT /* abc', "SELECT 'abc", 'SELECT [abc']) {
      expect(() => allNames(q)).not.toThrow();
    }
  });

  it('keeps the bare keywords apart', () => {
    const words = sqlWords('PRAGMA table_info(runs); SELECT \'vacuum\', "attach" FROM t');
    expect(words.has('pragma')).toBe(true);
    expect(words.has('vacuum')).toBe(false);
    expect(words.has('attach')).toBe(false);
  });
});

describe('the names a statement reads or writes', () => {
  const refs = (sql: string) => referencedNames(sql);

  it('finds them where they stand', () => {
    expect(refs('SELECT a FROM settings s JOIN runs r ON r.id = s.id')).toEqual(
      expect.arrayContaining(['settings', 'runs'])
    );
    expect(refs('INSERT INTO t SELECT * FROM messages')).toEqual(
      expect.arrayContaining(['t', 'messages'])
    );
    expect(refs('UPDATE OR REPLACE settings SET v = 1')).toContain('settings');
    expect(refs('INSERT OR REPLACE INTO settings (k) VALUES (1)')).toContain('settings');
    expect(refs('DELETE FROM runs')).toContain('runs');
    expect(refs('CREATE TABLE t (id INTEGER REFERENCES runs(id))')).toContain('runs');
    expect(refs('SELECT * FROM main.settings')).toContain('settings');
    expect(refs('SELECT * FROM "temp"."settings"')).toContain('settings');
    expect(refs('SELECT * FROM a, b, settings')).toContain('settings');
    expect(refs('SELECT * FROM (settings)')).toContain('settings');
    expect(refs("SELECT * FROM 'settings'")).toContain('settings');
  });

  it('does not take a column, a value or an alias for a reference', () => {
    expect(refs('CREATE TABLE t (memory TEXT, runs INTEGER)')).not.toContain('memory');
    expect(refs('SELECT memory, runs FROM t')).toEqual(['t']);
    expect(refs('SELECT t.runs FROM t')).toEqual(['t']);
    expect(refs("INSERT INTO t (v) VALUES ('settings')")).toEqual(['t']);
    expect(refs('SELECT x AS memory FROM t')).toEqual(['t']);
  });
});
