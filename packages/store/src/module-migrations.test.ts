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
  sql: 'CREATE TABLE mod_hello_world__items (id INTEGER PRIMARY KEY, text TEXT);',
};

describe('module migrations', () => {
  it('applies each once, and records it', () => {
    expect(migrateModule(db, 'hello-world', [items])).toEqual([1]);
    expect(migrateModule(db, 'hello-world', [items])).toEqual([]);
    db.prepare("INSERT INTO mod_hello_world__items (text) VALUES ('x')").run();
    const next = {
      id: 2,
      name: 'tags',
      sql: `ALTER TABLE mod_hello_world__items ADD COLUMN tag TEXT;
            CREATE INDEX IF NOT EXISTS mod_hello_world__items_tag ON mod_hello_world__items(tag);`,
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
      sql: 'CREATE TABLE mod_hello_world__a (id INTEGER); CREATE TABLE mod_hello_world__a (id INTEGER);',
    };
    expect(() => migrateModule(db, 'hello-world', [bad])).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'mod_hello_world__a'").get()
    ).toBeUndefined();
  });

  it("refuses anything outside the module's own tables", () => {
    const refused = [
      'CREATE TABLE runs2 (id INTEGER)',
      'CREATE TABLE mod_other__x (id INTEGER)',
      'ALTER TABLE runs ADD COLUMN x TEXT',
      'DROP TABLE IF EXISTS memory',
      "INSERT INTO audit_log (at, action) VALUES ('t', 'x')",
      "UPDATE runs SET status = 'done'",
      'DELETE FROM approvals',
      'CREATE INDEX mod_hello_world__i ON runs(id)',
      'CREATE TABLE temp.mod_hello_world__t (id INTEGER)',
      "ATTACH DATABASE 'x.db' AS x",
      "UPDATE runs AS r SET status = 'done'",
      "INSERT INTO mod_hello_world__items (text) VALUES ('--'); DROP TABLE runs",
      "INSERT INTO mod_hello_world__items (text) VALUES ('it''s'); DELETE FROM runs",
      'PRAGMA foreign_keys = OFF',
    ];
    for (const sql of refused) {
      expect(() => checkModuleSql('hello-world', sql), sql).toThrow(ModuleMigrationError);
    }
  });

  it('accepts its own objects, quoted or not, and ignores names in comments and strings', () => {
    const allowed = [
      'CREATE TABLE IF NOT EXISTS "mod_hello_world__q" (id INTEGER)',
      'CREATE TABLE main.mod_hello_world__m (id INTEGER)',
      "-- DROP TABLE runs\nINSERT INTO mod_hello_world__items (text) VALUES ('DELETE FROM runs')",
      'CREATE VIRTUAL TABLE mod_hello_world__fts USING fts5(text)',
      `CREATE TRIGGER mod_hello_world__t AFTER INSERT ON mod_hello_world__items
         BEGIN UPDATE mod_hello_world__items SET text = text WHERE id = NEW.id; END`,
      'CREATE VIEW mod_hello_world__v AS SELECT id FROM runs',
      `INSERT INTO mod_hello_world__items (id, text) VALUES (1, 'x')
         ON CONFLICT (id) DO UPDATE SET text = excluded.text`,
      "/* it's a comment */ CREATE TABLE mod_hello_world__c (id INTEGER)",
    ];
    for (const sql of allowed) expect(() => checkModuleSql('hello-world', sql), sql).not.toThrow();
  });
});

describe('module table prefixes', () => {
  it('do not overlap between modules whose ids share a start', () => {
    migrateModule(db, 'crm', [
      { id: 1, name: 's', sql: 'CREATE TABLE mod_crm__sync_state (id INTEGER);' },
    ]);
    migrateModule(db, 'crm-sync', [
      { id: 1, name: 's', sql: 'CREATE TABLE mod_crm_sync__state (id INTEGER);' },
    ]);
    expect(() => checkModuleSql('crm', 'DROP TABLE mod_crm_sync__state')).toThrow(
      ModuleMigrationError
    );
    expect(() => checkModuleSql('crm-sync', 'DROP TABLE mod_crm__sync_state')).toThrow(
      ModuleMigrationError
    );
  });

  it('refuse ids with a doubled or trailing hyphen', () => {
    for (const id of ['a--b', 'a-', 'A']) {
      expect(() => migrateModule(db, id, []), id).toThrow(/not a module id/);
    }
  });
});

describe('module tables and tenants', () => {
  it('get a tenant_id column and index, defaulting to default', () => {
    migrateModule(db, 'hello-world', [
      items,
      { id: 2, name: 'fts', sql: 'CREATE VIRTUAL TABLE mod_hello_world__fts USING fts5(text);' },
    ]);
    db.prepare("INSERT INTO mod_hello_world__items (text) VALUES ('x')").run();
    expect(db.prepare('SELECT tenant_id FROM mod_hello_world__items').get()).toEqual({
      tenant_id: 'default',
    });
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mod_hello_world__items'"
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain('mod_hello_world__items_tenant');
    // The virtual table is left as it was.
    const cols = db
      .prepare('PRAGMA table_info(mod_hello_world__fts)')
      .all()
      .map((c) => c.name);
    expect(cols).not.toContain('tenant_id');
  });

  it('keep a tenant_id the module declared itself', () => {
    migrateModule(db, 'own', [
      {
        id: 1,
        name: 'own',
        sql: "CREATE TABLE mod_own__t (id INTEGER, tenant_id TEXT NOT NULL DEFAULT 'default');",
      },
    ]);
    const cols = db
      .prepare('PRAGMA table_info(mod_own__t)')
      .all()
      .map((c) => c.name);
    expect(cols.filter((c) => c === 'tenant_id')).toHaveLength(1);
  });
});
