/**
 * Migrations a module ships for its own tables.
 *
 * A module owns tables named `mod_<id>__*` (hyphens in the id become
 * underscores) and nothing else: a migration that creates, alters, drops or
 * writes any other object is refused before it runs. This keeps modules from
 * colliding with core tables and with each other; it is not a security
 * boundary, since module code has the store anyway.
 *
 * Every table a module creates gets a `tenant_id` column (default
 * `default`) and an index on it, added by the store after each migration,
 * so module data is scoped by tenant whether or not the module thinks about it.
 *
 * Like core migrations they are append-only. Each is recorded with a checksum,
 * and one that changed after it was applied is refused rather than skipped.
 */

import crypto from 'node:crypto';
import type { Database } from './driver.js';
import type { Migration } from './migrations.js';

export class ModuleMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleMigrationError';
  }
}

/** Lower-case words joined by single hyphens: `crm`, `crm-sync`. */
export const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * `mod_<id>__`, hyphens as underscores. The double underscore cannot occur in
 * an id, so `mod_crm__` never covers `crm-sync`'s `mod_crm_sync__`.
 */
export function moduleTablePrefix(moduleId: string): string {
  return `mod_${moduleId.replace(/-/g, '_')}__`;
}

/**
 * Blank out comments and string literals in one pass, left to right, so a
 * `--` inside a string or a quote inside a comment cannot hide a statement.
 * Quoted identifiers are kept: they are names.
 */
function code(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      i = j + 1;
      out += "''";
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const end = sql.indexOf(close, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const NAME = String.raw`((?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+))?)`;

/** Statements that name an object the migration creates, changes or writes. */
const TARGETS = [
  String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|VIEW|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  String.raw`\bALTER\s+TABLE\s+${NAME}`,
  String.raw`\bRENAME\s+TO\s+${NAME}`,
  String.raw`\bDROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?${NAME}`,
  String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${NAME}`,
  // Not the `DO UPDATE SET` of an upsert, whose target is its INSERT's.
  String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?(?!SET\b)${NAME}`,
  String.raw`\bDELETE\s+FROM\s+${NAME}`,
  // The table an index or trigger is defined on.
  String.raw`\bON\s+(?!CONFLICT\b)${NAME}\s*(?:\(|BEGIN\b|FOR\b|WHEN\b)`,
].map((p) => new RegExp(p, 'gi'));

const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|VACUUM)\b/i;

function bare(name: string): { schema?: string; object: string } {
  const parts = name.split(/\s*\.\s*/).map((p) => p.replace(/^["`[]|["`\]]$/g, ''));
  return parts.length === 2 ? { schema: parts[0], object: parts[1] } : { object: parts[0] };
}

/** Throw unless every object `sql` creates, changes or writes belongs to the module. */
export function checkModuleSql(moduleId: string, sql: string): void {
  const text = code(sql);
  const forbidden = FORBIDDEN.exec(text);
  if (forbidden) {
    throw new ModuleMigrationError(
      `${forbidden[1].toUpperCase()} is not allowed in a module migration.`
    );
  }
  const prefix = moduleTablePrefix(moduleId);
  for (const re of TARGETS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const { schema, object } = bare(m[1]);
      if ((schema && schema.toLowerCase() !== 'main') || !object.toLowerCase().startsWith(prefix)) {
        throw new ModuleMigrationError(
          `"${m[1]}" is not one of this module's objects; its names must start with ${prefix}.`
        );
      }
    }
  }
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/**
 * Apply a module's migrations it has not seen, in id order, each in its own
 * transaction. Returns the ids applied by this call.
 */
export function migrateModule(db: Database, moduleId: string, migrations: Migration[]): number[] {
  if (!MODULE_ID.test(moduleId)) {
    throw new ModuleMigrationError(
      `"${moduleId}" is not a module id: use lower-case words and single hyphens.`
    );
  }
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].id === sorted[i - 1].id) {
      throw new ModuleMigrationError(`Migration ${sorted[i].id} appears twice.`);
    }
  }
  for (const m of sorted) checkModuleSql(moduleId, m.sql);

  const applied = new Map(
    db
      .prepare('SELECT id, checksum FROM module_migrations WHERE module_id = ?')
      .all(moduleId)
      .map((r) => [Number(r.id), String(r.checksum)])
  );
  const ran: number[] = [];
  for (const m of sorted) {
    const sum = checksum(m.sql);
    const before = applied.get(m.id);
    if (before !== undefined) {
      if (before !== sum) {
        throw new ModuleMigrationError(
          `Migration ${m.id} (${m.name}) changed after it was applied. Add a new migration instead.`
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      addTenantColumns(db, moduleId);
      db.prepare(
        'INSERT INTO module_migrations (module_id, id, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)'
      ).run(moduleId, m.id, m.name, sum, new Date().toISOString());
    });
    ran.push(m.id);
  }
  return ran;
}

/**
 * Give each of a module's ordinary tables a `tenant_id` column and an index,
 * where it lacks them. Virtual tables (FTS and the like) and their shadow
 * tables are left alone: SQLite cannot alter them.
 */
export function addTenantColumns(db: Database, moduleId: string): string[] {
  const prefix = moduleTablePrefix(moduleId);
  const objects = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'")
    .all(`${prefix.replace(/_/g, '\\_')}%`)
    .map((r) => ({ name: String(r.name), sql: String(r.sql ?? '') }));
  const virtual = objects.filter((o) => /^CREATE\s+VIRTUAL\b/i.test(o.sql)).map((o) => o.name);
  const added: string[] = [];
  for (const { name } of objects) {
    if (virtual.some((v) => name === v || name.startsWith(`${v}_`))) continue;
    const cols = db
      .prepare(`PRAGMA table_info("${name}")`)
      .all()
      .map((c) => String(c.name));
    if (cols.includes('tenant_id')) continue;
    db.exec(`ALTER TABLE "${name}" ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    db.exec(`CREATE INDEX IF NOT EXISTS "${name}_tenant" ON "${name}"(tenant_id)`);
    added.push(name);
  }
  return added;
}
