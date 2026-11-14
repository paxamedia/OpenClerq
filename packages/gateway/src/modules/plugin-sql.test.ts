import { describe, expect, it } from 'vitest';
import { changesData, scanSql } from './plugin-sql.js';

const names = (sql: string) => scanSql(sql).names;

describe('reading the names in a statement', () => {
  it('finds bare, double-quoted, bracketed, backticked and string names, lower-cased', () => {
    expect(names('UPDATE Settings SET v = 1')).toContain('settings');
    expect(names('UPDATE "Settings" SET v = 1')).toContain('settings');
    expect(names('UPDATE [Settings] SET v = 1')).toContain('settings');
    expect(names('UPDATE `Settings` SET v = 1')).toContain('settings');
    expect(names("UPDATE 'Settings' SET v = 1")).toContain('settings');
    expect(names('SELECT * FROM main.settings')).toEqual(['select', 'from', 'main', 'settings']);
  });

  it('reads an escaped quote inside a quoted name, and a name that is split by one', () => {
    expect(names('SELECT "a""b" FROM t')).toContain('a"b');
    expect(names("SELECT 'it''s' FROM t")).toContain("it's");
    expect(names('SELECT [a b] FROM t')).toContain('a b');
  });

  it('skips comments, and does not read a comment as a name', () => {
    expect(names('SELECT 1 -- settings\nFROM t')).toEqual(['select', 'from', 't']);
    expect(names('SELECT /* settings */ 1 FROM t')).toEqual(['select', 'from', 't']);
    // ...and does not let a comment hide what comes after it.
    expect(names('/* x */ settings')).toEqual(['settings']);
    expect(names("-- one\nUPDATE settings SET v = '--'")).toContain('settings');
  });

  it('survives an unterminated quote or comment', () => {
    expect(() => names('SELECT "abc')).not.toThrow();
    expect(() => names('SELECT /* abc')).not.toThrow();
    expect(() => names("SELECT 'abc")).not.toThrow();
    expect(() => names('SELECT [abc')).not.toThrow();
  });

  it('keeps bare keywords apart from names, for the ones that are banned', () => {
    const scan = scanSql("PRAGMA table_info(runs); SELECT 'vacuum' FROM t");
    expect(scan.words.has('pragma')).toBe(true);
    // A string that says vacuum is not the keyword.
    expect(scan.words.has('vacuum')).toBe(false);
    expect(scan.names).toContain('vacuum');
  });

  it('says whether a statement changes anything', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'update t set a = 1',
      'DELETE FROM t',
      'REPLACE INTO t VALUES (1)',
      'DROP TABLE t',
      'ALTER TABLE t ADD COLUMN c',
      'CREATE INDEX i ON t(a)',
      'WITH x AS (SELECT 1) UPDATE t SET a = 1',
    ]) {
      expect(changesData(scanSql(sql)), sql).toBe(true);
    }
    for (const sql of [
      'SELECT * FROM t',
      "SELECT 'update' FROM t",
      'select count(*) from t where a = 1',
    ]) {
      expect(changesData(scanSql(sql)), sql).toBe(false);
    }
  });
});
