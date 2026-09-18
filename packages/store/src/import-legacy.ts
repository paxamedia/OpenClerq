/**
 * One-time import of the pre-0.5 JSON config files into SQLite.
 *
 * Runs on every start and is idempotent: entries already present are left
 * alone, so an interrupted import simply resumes. The JSON files are renamed
 * to *.migrated rather than deleted, so nothing is destroyed if an operator
 * needs to inspect or roll back.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './driver.js';
import { clerqHome } from './local-files.js';

export interface ImportResult {
  memory: number;
  triggers: number;
  /** Files renamed to *.migrated by this call. */
  archived: string[];
}

function clerqDir(): string {
  return clerqHome();
}

function readJson(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A corrupt file must not stop the gateway from starting. It is left in
    // place, unarchived, so the operator can still see it.
    return null;
  }
}

function archive(file: string, archived: string[]): void {
  try {
    fs.renameSync(file, `${file}.migrated`);
    archived.push(path.basename(file));
  } catch {
    /* leaving the original in place is harmless — the import is idempotent */
  }
}

function importMemory(db: Database, dir: string, out: ImportResult): void {
  const file = path.join(dir, 'memory.json');
  const raw = readJson(file) as Record<string, { value?: unknown; createdAt?: string }> | null;
  if (!raw || typeof raw !== 'object') return;

  const insert = db.prepare(
    `INSERT INTO memory (key, value, type, created_at, updated_at)
     VALUES (?, ?, 'fact', ?, ?)
     ON CONFLICT(key) DO NOTHING`
  );
  db.transaction(() => {
    for (const [key, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object') continue;
      const at = typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString();
      const res = insert.run(key, JSON.stringify(entry.value ?? null), at, at);
      out.memory += res.changes;
    }
  });
  archive(file, out.archived);
}

function importTriggers(db: Database, dir: string, out: ImportResult): void {
  const file = path.join(dir, 'triggers.json');
  const raw = readJson(file) as {
    cron?: Array<{ id?: string; schedule?: string; message?: string }>;
    file?: Array<{ id?: string; path?: string; message?: string }>;
    webhooks?: Record<string, { message?: string }>;
  } | null;
  if (!raw || typeof raw !== 'object') return;

  const insert = db.prepare(
    `INSERT INTO triggers (id, kind, schedule, path, message, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const t of raw.cron ?? []) {
      if (!t?.id || !t.message) continue;
      out.triggers += insert.run(t.id, 'cron', t.schedule ?? null, null, t.message, now).changes;
    }
    for (const t of raw.file ?? []) {
      if (!t?.id || !t.message) continue;
      out.triggers += insert.run(t.id, 'file', null, t.path ?? null, t.message, now).changes;
    }
    for (const [id, v] of Object.entries(raw.webhooks ?? {})) {
      if (!v?.message) continue;
      out.triggers += insert.run(id, 'webhook', null, null, v.message, now).changes;
    }
  });
  archive(file, out.archived);
}

/**
 * Import legacy JSON config into the store. Idempotent.
 * @param dir directory holding the JSON files (default ~/.clerq)
 */
export function importLegacyJson(db: Database, dir?: string): ImportResult {
  const target = dir ?? clerqDir();
  const out: ImportResult = { memory: 0, triggers: 0, archived: [] };
  if (!fs.existsSync(target)) return out;
  importMemory(db, target, out);
  importTriggers(db, target, out);
  return out;
}
