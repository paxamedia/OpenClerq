import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  openStore,
  migrateModule,
  checkModuleSql,
  moduleSqlViolation,
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

  it('refuses data a newer copy of the module wrote, in words, and changes nothing', () => {
    const next = {
      id: 2,
      name: 'tags',
      sql: 'ALTER TABLE mod_hello_world__items ADD COLUMN tag TEXT;',
    };
    migrateModule(db, 'hello-world', [items, next]);
    // The module is now installed at an older version, which ships only migration 1.
    expect(() => migrateModule(db, 'hello-world', [items])).toThrow(
      "This module's data was written by a newer version of it (migration 2); " +
        'this copy knows up to migration 1. Install the newer version of the module.'
    );
    // One module's data is no other's business.
    expect(migrateModule(db, 'other-module', [])).toEqual([]);
    expect(
      db
        .prepare('SELECT count(*) AS n FROM module_migrations WHERE module_id = ?')
        .get('hello-world')
    ).toEqual({ n: 2 });
  });

  it('refuses a module that now ships no migrations at all over data it has', () => {
    migrateModule(db, 'hello-world', [items]);
    expect(() => migrateModule(db, 'hello-world', [])).toThrow(/newer version/);
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
      // (Reading is looked at when a migration is about to run, by migrateModule, not here.)
      'CREATE VIEW mod_hello_world__v AS SELECT id FROM runs',
      `INSERT INTO mod_hello_world__items (id, text) VALUES (1, 'x')
         ON CONFLICT (id) DO UPDATE SET text = excluded.text`,
      "/* it's a comment */ CREATE TABLE mod_hello_world__c (id INTEGER)",
    ];
    for (const sql of allowed) expect(() => checkModuleSql('hello-world', sql), sql).not.toThrow();
  });
});

describe('what a migration may read', () => {
  const mig = (sql: string, id = 1) => ({ id, name: 'm', sql });
  const own = 'CREATE TABLE mod_hello_world__items (id INTEGER PRIMARY KEY, text TEXT);';

  it.each([
    'CREATE VIEW mod_hello_world__v AS SELECT key, value FROM settings',
    'CREATE VIEW mod_hello_world__v AS SELECT * FROM "settings"',
    'CREATE VIEW mod_hello_world__v AS SELECT * FROM main.settings',
    "CREATE VIEW mod_hello_world__v AS SELECT * FROM 'settings'",
    'CREATE VIEW mod_hello_world__v AS SELECT * FROM mod_hello_world__items, settings',
    'CREATE VIEW mod_hello_world__v AS SELECT * FROM (settings)',
    'CREATE VIEW mod_hello_world__v AS SELECT a.id FROM mod_hello_world__items a JOIN runs r ON r.id = a.id',
    'CREATE VIEW mod_hello_world__v AS SELECT (SELECT value FROM settings LIMIT 1) AS v',
    `CREATE TRIGGER mod_hello_world__t AFTER INSERT ON mod_hello_world__items
       BEGIN INSERT INTO mod_hello_world__items (text) SELECT value FROM settings; END`,
    'INSERT INTO mod_hello_world__items (text) SELECT content FROM messages',
    'CREATE TABLE mod_hello_world__j (id INTEGER REFERENCES runs(id))',
    'CREATE VIEW mod_hello_world__v AS SELECT * FROM sqlite_master',
  ])('refuses %s, before anything runs', (view) => {
    expect(() => migrateModule(db, 'hello-world', [mig(own), mig(view, 2)])).toThrow(
      ModuleMigrationError
    );
    // Nothing of it was applied, not even the first, harmless migration.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'mod_hello_world__%'").all()
    ).toEqual([]);
  });

  it('says which migration, and what it read', () => {
    expect(() =>
      migrateModule(db, 'hello-world', [
        mig('CREATE VIEW mod_hello_world__v AS SELECT * FROM settings'),
      ])
    ).toThrow(
      'Migration 1 (m) reads "settings", which is not one of this module\'s objects; a migration may only use names that start with mod_hello_world__.'
    );
  });

  it('does not take a word for a table: a column, a value, a comment or an alias is not a read', () => {
    const fine = [
      'CREATE TABLE mod_hello_world__notes (id INTEGER, memory TEXT, runs INTEGER, messages TEXT, settings TEXT)',
      "INSERT INTO mod_hello_world__items (text) VALUES ('messages'), ('settings'), ('runs')",
      "UPDATE mod_hello_world__items SET text = 'memory' WHERE text = 'settings'",
      "CREATE VIEW mod_hello_world__v AS SELECT text AS runs, text AS memory FROM mod_hello_world__items WHERE text IN ('messages', 'settings')",
      'CREATE VIEW mod_hello_world__w AS SELECT i.text FROM mod_hello_world__items AS i JOIN mod_hello_world__items j ON i.id = j.id',
      '-- FROM settings\nCREATE INDEX mod_hello_world__ix ON mod_hello_world__items (text)',
      'CREATE VIEW mod_hello_world__x AS SELECT * FROM main.mod_hello_world__items',
    ];
    expect(
      migrateModule(db, 'hello-world', [mig(own), ...fine.map((f, i) => mig(f, i + 2))])
    ).toHaveLength(fine.length + 1);
  });

  it('does not look again at a migration that ran before', () => {
    // As it would have been, written before the check: it is recorded, and left alone.
    db.exec('CREATE TABLE mod_hello_world__old (id INTEGER)');
    db.exec('CREATE VIEW mod_hello_world__oldv AS SELECT * FROM settings');
    const sql = 'CREATE VIEW mod_hello_world__oldv AS SELECT * FROM settings';
    db.prepare(
      'INSERT INTO module_migrations (module_id, id, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)'
    ).run('hello-world', 1, 'm', crypto.createHash('sha256').update(sql).digest('hex'), 'now');
    expect(migrateModule(db, 'hello-world', [mig(sql)])).toEqual([]);
  });

  it('counts another module’s tables as foreign, and its own as its own', () => {
    migrateModule(db, 'crm', [
      { id: 1, name: 'a', sql: 'CREATE TABLE mod_crm__deals (id INTEGER)' },
    ]);
    expect(() =>
      migrateModule(db, 'hello-world', [
        mig('CREATE VIEW mod_hello_world__v AS SELECT * FROM mod_crm__deals'),
      ])
    ).toThrow(ModuleMigrationError);
  });
});

describe('moduleSqlViolation', () => {
  it('names the first thing that is not the module’s, or nothing', () => {
    expect(moduleSqlViolation('hello-world', 'SELECT 1')).toBeNull();
    expect(moduleSqlViolation('hello-world', 'PRAGMA user_version')).toEqual({
      kind: 'forbidden',
      word: 'PRAGMA',
    });
    expect(moduleSqlViolation('hello-world', 'DROP INDEX idx_repos_name')).toEqual({
      kind: 'object',
      name: 'idx_repos_name',
    });
    expect(moduleSqlViolation('hello-world', 'DROP INDEX IF EXISTS idx_x')).toEqual({
      kind: 'object',
      name: 'idx_x',
    });
    expect(moduleSqlViolation('hello-world', 'DROP TRIGGER IF EXISTS some_trigger')).toEqual({
      kind: 'object',
      name: 'some_trigger',
    });
    expect(moduleSqlViolation('hello-world', 'DROP INDEX mod_hello_world__ix')).toBeNull();
  });

  it('refuses REINDEX, with no name or another’s, when asked to', () => {
    expect(moduleSqlViolation('hello-world', 'REINDEX')).toBeNull();
    expect(moduleSqlViolation('hello-world', 'REINDEX', { reindex: true })).toEqual({
      kind: 'object',
      name: 'REINDEX',
    });
    expect(moduleSqlViolation('hello-world', 'reindex;', { reindex: true })).toEqual({
      kind: 'object',
      name: 'REINDEX',
    });
    expect(moduleSqlViolation('hello-world', 'REINDEX idx_repos_name', { reindex: true })).toEqual({
      kind: 'object',
      name: 'idx_repos_name',
    });
    expect(
      moduleSqlViolation('hello-world', 'REINDEX "mod_hello_world__ix"', { reindex: true })
    ).toBeNull();
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
