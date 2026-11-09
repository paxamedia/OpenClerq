import { describe, it, expect, beforeEach } from 'vitest';
import {
  openStore,
  migrateModule,
  checkModuleSql,
  ModuleMigrationError,
  type Database,
} from './index.js';

let db: Database;

beforeEach(async () => {
  db = await openStore(':memory:');
});

const items = {
  id: 1,
  name: 'items',
  sql: 'CREATE TABLE mod_hello_world_items (id INTEGER PRIMARY KEY, text TEXT);',
};

describe('module migrations', () => {
  it('applies each once, and records it', () => {
    expect(migrateModule(db, 'hello-world', [items])).toEqual([1]);
    expect(migrateModule(db, 'hello-world', [items])).toEqual([]);
    db.prepare("INSERT INTO mod_hello_world_items (text) VALUES ('x')").run();
    const next = {
      id: 2,
      name: 'tags',
      sql: `ALTER TABLE mod_hello_world_items ADD COLUMN tag TEXT;
            CREATE INDEX IF NOT EXISTS mod_hello_world_items_tag ON mod_hello_world_items(tag);`,
    };
    expect(migrateModule(db, 'hello-world', [next, items])).toEqual([2]);
    const rows = db
      .prepare('SELECT id FROM module_migrations WHERE module_id = ? ORDER BY id')
      .all('hello-world');
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('refuses a migration that changed after it was applied', () => {
    migrateModule(db, 'hello-world', [items]);
    expect(() =>
      migrateModule(db, 'hello-world', [{ ...items, sql: `${items.sql} -- edited` }])
    ).toThrow(/changed after it was applied/);
  });

  it('rolls back a migration that fails', () => {
    const bad = {
      id: 1,
      name: 'bad',
      sql: 'CREATE TABLE mod_hello_world_a (id INTEGER); CREATE TABLE mod_hello_world_a (id INTEGER);',
    };
    expect(() => migrateModule(db, 'hello-world', [bad])).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'mod_hello_world_a'").get()
    ).toBeUndefined();
  });

  it("refuses anything outside the module's own tables", () => {
    const refused = [
      'CREATE TABLE runs2 (id INTEGER)',
      'CREATE TABLE mod_other_x (id INTEGER)',
      'ALTER TABLE runs ADD COLUMN x TEXT',
      'DROP TABLE IF EXISTS memory',
      "INSERT INTO audit_log (at, action) VALUES ('t', 'x')",
      "UPDATE runs SET status = 'done'",
      'DELETE FROM approvals',
      'CREATE INDEX mod_hello_world_i ON runs(id)',
      'CREATE TABLE temp.mod_hello_world_t (id INTEGER)',
      "ATTACH DATABASE 'x.db' AS x",
      'PRAGMA foreign_keys = OFF',
    ];
    for (const sql of refused) {
      expect(() => checkModuleSql('hello-world', sql), sql).toThrow(ModuleMigrationError);
    }
  });

  it('accepts its own objects, quoted or not, and ignores names in comments and strings', () => {
    const allowed = [
      'CREATE TABLE IF NOT EXISTS "mod_hello_world_q" (id INTEGER)',
      'CREATE TABLE main.mod_hello_world_m (id INTEGER)',
      "-- DROP TABLE runs\nINSERT INTO mod_hello_world_items (text) VALUES ('DELETE FROM runs')",
      'CREATE VIRTUAL TABLE mod_hello_world_fts USING fts5(text)',
      `CREATE TRIGGER mod_hello_world_t AFTER INSERT ON mod_hello_world_items
         BEGIN UPDATE mod_hello_world_items SET text = text WHERE id = NEW.id; END`,
      'CREATE VIEW mod_hello_world_v AS SELECT id FROM runs',
    ];
    for (const sql of allowed) expect(() => checkModuleSql('hello-world', sql), sql).not.toThrow();
  });
});
