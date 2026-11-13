/**
 * Agent memory, backed by the durable store.
 *
 * Memory 2.0: typed records (fact, preference, decision, procedure, note), any
 * number to a key, each with where it came from, how sure it is and when it
 * lapses; searched with SQLite FTS5 where the SQLite in use has it, by
 * substring where it does not; folded into one record by a model on request,
 * and unfolded again. The pre-2.0 functions (`setMemory`, `getMemory`,
 * `listMemory`, `deleteMemory`, `clearMemory`, `searchMemory`) keep working: a
 * key set the old way is a `fact`, set again it is updated in place.
 *
 * Which records a session or an automation may read is not decided here; see
 * memory-context.ts, which asks `packages/policy`.
 *
 * Replaces ~/.clerq/memory.json, which was read-modify-write with no locking:
 * two concurrent writers each read the whole file, mutated their copy and wrote
 * it back, so one silently lost the other's entries. Existing entries are
 * imported into SQLite on first start (see @clerq/store importLegacyJson).
 */

import crypto from 'node:crypto';
import {
  audit,
  indexMemory,
  memoryText,
  memorySearchable,
  searchMemoryIndex,
  searchTokens,
  unindexMemory,
} from '@clerq/store';
import { isMemoryType, type MemoryType } from '@clerq/policy';
import { emit } from './events.js';
import { currentRunId, currentSessionId } from './runs.js';
import { getStore } from './store.js';

export type MemoryOrigin = 'user' | 'agent' | 'import' | 'consolidation';
export type MemoryStatus = 'active' | 'superseded';

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  key: string;
  value: unknown;
  /** Who wrote it: a person, an agent, an import of older data, or a summary the model made. */
  origin: MemoryOrigin;
  /**
   * True when an agent wrote this record, or any record folded into it by a
   * summary did: text an agent read can end up in a note, and folding it into
   * a summary does not make it a person's.
   */
  agentDerived?: true;
  /** The chat session or run it was learned in. */
  sourceSession?: string;
  /** How sure the writer was, from 0 to 1. */
  confidence?: number;
  /** `superseded`: folded into a summary (`supersededBy`), kept so it can be restored. */
  status: MemoryStatus;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  /** After this time the record is no longer read, and is removed. */
  expiresAt?: string;
}

/** What `listMemory` and `getMemory` return: a record, as an entry of a key. */
export type MemoryEntry = MemoryRecord;

export interface SearchHit extends MemoryRecord {
  /** Higher is a better match. Zero when the search was by substring. */
  score: number;
}

export class MemoryError extends Error {
  constructor(
    readonly code: 'invalid_memory' | 'memory_not_found' | 'cannot_consolidate' | 'memory_changed',
    message: string
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

export const MAX_KEY_CHARS = 256;
/** The longest a value may be, serialised. Memory is for notes, not for documents. */
export const MAX_VALUE_CHARS = 20_000;
const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 1_000;

const COLUMNS =
  'seq, id, type, key, value, origin, agent_derived, source_session, confidence, status, superseded_by, created_at, updated_at, expires_at';

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Tolerate a value written before it was consistently serialised.
    return raw;
  }
}

function rowToRecord(r: Record<string, unknown>): MemoryRecord {
  return {
    id: String(r.id),
    type: String(r.type) as MemoryType,
    key: String(r.key),
    value: parseValue(r.value),
    origin: String(r.origin) as MemoryOrigin,
    ...(Number(r.agent_derived) === 1 ? { agentDerived: true as const } : {}),
    ...(r.source_session ? { sourceSession: String(r.source_session) } : {}),
    ...(r.confidence === null || r.confidence === undefined
      ? {}
      : { confidence: Number(r.confidence) }),
    status: String(r.status) as MemoryStatus,
    ...(r.superseded_by ? { supersededBy: String(r.superseded_by) } : {}),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...(r.expires_at ? { expiresAt: String(r.expires_at) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !key.trim()) {
    throw new MemoryError('invalid_memory', 'key is required.');
  }
  const k = key.trim();
  if (k.length > MAX_KEY_CHARS) {
    throw new MemoryError('invalid_memory', `key may be at most ${MAX_KEY_CHARS} characters.`);
  }
  return k;
}

function checkType(type: unknown): MemoryType {
  if (type === undefined || type === null || type === '') return 'fact';
  if (!isMemoryType(type)) {
    throw new MemoryError(
      'invalid_memory',
      `type must be one of fact, preference, decision, procedure, note (got ${JSON.stringify(type)}).`
    );
  }
  return type;
}

/** The value as stored: JSON text, of at most MAX_VALUE_CHARS. */
function checkValue(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value);
  if (json.length > MAX_VALUE_CHARS) {
    throw new MemoryError(
      'invalid_memory',
      `A record may hold at most ${MAX_VALUE_CHARS} characters; this one has ${json.length}.`
    );
  }
  return json;
}

function checkConfidence(confidence: unknown): number | null {
  if (confidence === undefined || confidence === null) return null;
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new MemoryError('invalid_memory', 'confidence must be a number from 0 to 1.');
  }
  return confidence;
}

function checkExpiry(expiresAt: unknown): string | null {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
  const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(t)) {
    throw new MemoryError(
      'invalid_memory',
      'expiresAt must be a date and time, such as 2026-12-31.'
    );
  }
  if (t <= Date.now()) {
    throw new MemoryError('invalid_memory', 'expiresAt must be in the future.');
  }
  return new Date(t).toISOString();
}

function checkOrigin(origin: unknown): MemoryOrigin {
  if (origin === undefined || origin === null || origin === '') return 'user';
  if (
    origin !== 'user' &&
    origin !== 'agent' &&
    origin !== 'import' &&
    origin !== 'consolidation'
  ) {
    throw new MemoryError('invalid_memory', 'origin must be user, agent, import or consolidation.');
  }
  return origin;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type Action =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'consolidated'
  | 'unconsolidated'
  | 'expired'
  | 'cleared';

/** Tell the rest of the gateway memory changed: the settings screen reloads on it. */
function announce(
  action: Action,
  detail: { id?: string; key?: string; type?: MemoryType; ids?: string[] }
) {
  emit(
    'memory.updated',
    { action, ...detail },
    { runId: currentRunId(), sessionId: currentSessionId() }
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const newId = () => `mem_${crypto.randomBytes(8).toString('hex')}`;

export interface NewRecord {
  type?: unknown;
  key: unknown;
  value: unknown;
  confidence?: unknown;
  expiresAt?: unknown;
  sourceSession?: string | null;
  origin?: unknown;
}

/** Insert one record and index it. The caller holds the transaction. */
function insertRow(
  rec: {
    id: string;
    type: MemoryType;
    key: string;
    valueJson: string;
    origin: MemoryOrigin;
    agentDerived: boolean;
    sourceSession: string | null;
    confidence: number | null;
    expiresAt: string | null;
  },
  now: string
): void {
  const db = getStore();
  const res = db
    .prepare(
      `INSERT INTO memory
         (id, type, key, value, origin, agent_derived, source_session, confidence, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(
      rec.id,
      rec.type,
      rec.key,
      rec.valueJson,
      rec.origin,
      rec.agentDerived ? 1 : 0,
      rec.sourceSession,
      rec.confidence,
      now,
      now,
      rec.expiresAt
    );
  indexMemory(db, {
    seq: Number(res.lastInsertRowid),
    key: rec.key,
    text: memoryText(rec.valueJson),
  });
}

/**
 * `ids` and every record folded into them by a summary, at any depth: what a
 * summary stands for is its sources, and theirs if they are summaries too.
 */
function withSources(ids: string[]): string[] {
  const db = getStore();
  const all = new Set(ids);
  let frontier = [...ids];
  while (frontier.length > 0) {
    const next = db
      .prepare(
        `SELECT id FROM memory WHERE superseded_by IN (${frontier.map(() => '?').join(', ')})`
      )
      .all(...frontier)
      .map((r) => String(r.id))
      .filter((id) => !all.has(id));
    for (const id of next) all.add(id);
    frontier = next;
  }
  return [...all];
}

/** Delete rows by id, and their index entries. The caller holds the transaction. */
function deleteRows(ids: string[]): number {
  const db = getStore();
  let n = 0;
  for (const id of ids) {
    const row = db.prepare('SELECT seq FROM memory WHERE id = ?').get(id);
    if (!row) continue;
    unindexMemory(db, Number(row.seq));
    n += db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes;
  }
  return n;
}

/** Add a record. It is always a new one: a key may hold any number. */
export function addRecord(input: NewRecord): MemoryRecord {
  const key = checkKey(input.key);
  const rec = {
    id: newId(),
    type: checkType(input.type),
    key,
    valueJson: checkValue(input.value),
    origin: checkOrigin(input.origin),
    sourceSession: input.sourceSession?.trim() || null,
    confidence: checkConfidence(input.confidence),
    expiresAt: checkExpiry(input.expiresAt),
  };
  const now = new Date().toISOString();
  getStore().transaction(() => insertRow({ ...rec, agentDerived: rec.origin === 'agent' }, now));
  announce('created', { id: rec.id, key, type: rec.type });
  return getRecord(rec.id) as MemoryRecord;
}

/**
 * Set a key the way memory has always worked: the newest live record of that
 * key and type is updated in place, or a new one is made when there is none.
 * The type is `fact` unless given.
 */
export function setMemory(
  key: string,
  value: unknown,
  extra: Omit<NewRecord, 'key' | 'value'> = {}
): MemoryRecord {
  const k = checkKey(key);
  const type = checkType(extra.type);
  const valueJson = checkValue(value);
  const now = new Date().toISOString();
  const db = getStore();
  const found = db
    .prepare(
      `SELECT id FROM memory WHERE key = ? AND type = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, seq DESC LIMIT 1`
    )
    .get(k, type, now);
  if (!found) return addRecord({ ...extra, key: k, value, type });
  return updateRecord(String(found.id), {
    value,
    ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
    ...(extra.expiresAt !== undefined ? { expiresAt: extra.expiresAt } : {}),
  });
}

export interface RecordPatch {
  key?: unknown;
  type?: unknown;
  value?: unknown;
  confidence?: unknown;
  expiresAt?: unknown;
}

/** Change a record. Only what the patch names changes; `null` clears confidence or expiry. */
export function updateRecord(id: string, patch: RecordPatch): MemoryRecord {
  const db = getStore();
  const row = db.prepare(`SELECT ${COLUMNS} FROM memory WHERE id = ?`).get(id);
  if (!row) throw new MemoryError('memory_not_found', `No memory record ${id}.`);
  const key = patch.key === undefined ? String(row.key) : checkKey(patch.key);
  const type = patch.type === undefined ? (String(row.type) as MemoryType) : checkType(patch.type);
  const valueJson = patch.value === undefined ? String(row.value) : checkValue(patch.value);
  const confidence =
    patch.confidence === undefined
      ? row.confidence === null
        ? null
        : Number(row.confidence)
      : checkConfidence(patch.confidence);
  const expiresAt =
    patch.expiresAt === undefined
      ? row.expires_at
        ? String(row.expires_at)
        : null
      : checkExpiry(patch.expiresAt);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE memory SET key = ?, type = ?, value = ?, confidence = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(key, type, valueJson, confidence, expiresAt, now, id);
    indexMemory(db, { seq: Number(row.seq), key, text: memoryText(valueJson) });
  });
  announce('updated', { id, key, type });
  return getRecord(id) as MemoryRecord;
}

/**
 * Delete a record. A summary takes everything folded into it along, at any
 * depth: it says the same, and deleting one is meant to forget it.
 */
export function deleteRecord(id: string): boolean {
  const db = getStore();
  const row = db.prepare('SELECT key, type FROM memory WHERE id = ?').get(id);
  if (!row) return false;
  db.transaction(() => deleteRows(withSources([id])));
  announce('deleted', { id, key: String(row.key), type: String(row.type) as MemoryType });
  return true;
}

/** Delete everything remembered under a key, summaries and the records behind them too. */
export function deleteMemory(key: string): boolean {
  const db = getStore();
  const ids = db
    .prepare('SELECT id FROM memory WHERE key = ?')
    .all(key)
    .map((r) => String(r.id));
  if (ids.length === 0) return false;
  db.transaction(() => deleteRows(withSources(ids)));
  announce('deleted', { key, ids });
  return true;
}

export function clearMemory(): number {
  const db = getStore();
  const n = db.transaction(() => {
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n ?? 0);
    if (memorySearchable(db)) db.exec('DELETE FROM memory_fts');
    db.exec('DELETE FROM memory');
    return count;
  });
  if (n > 0) announce('cleared', {});
  return n;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getRecord(id: string): MemoryRecord | null {
  const row = getStore().prepare(`SELECT ${COLUMNS} FROM memory WHERE id = ?`).get(id);
  return row ? rowToRecord(row) : null;
}

/** The newest live record of a key (of one type, when given). */
export function getMemory(key: string, type?: MemoryType): MemoryRecord | null {
  const now = new Date().toISOString();
  const row = getStore()
    .prepare(
      `SELECT ${COLUMNS} FROM memory WHERE key = ? ${type ? 'AND type = ?' : ''}
         AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC, seq DESC LIMIT 1`
    )
    .get(...(type ? [key, type, now] : [key, now]));
  return row ? rowToRecord(row) : null;
}

export interface ListFilter {
  type?: MemoryType;
  key?: string;
  /** `active` (the default): in use. `superseded`: folded into a summary. `all`. */
  status?: 'active' | 'superseded' | 'all';
  /** Include records past their expiry that have not been removed yet. */
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT);
}

/** Records, newest first. */
export function listRecords(filter: ListFilter = {}): MemoryRecord[] {
  pruneIfDue();
  const where: string[] = [];
  const args: Array<string | number> = [];
  const status = filter.status ?? 'active';
  if (status !== 'all') {
    where.push('status = ?');
    args.push(status);
  }
  if (filter.type) {
    where.push('type = ?');
    args.push(filter.type);
  }
  if (filter.key !== undefined) {
    where.push('key = ?');
    args.push(filter.key);
  }
  if (!filter.includeExpired) {
    where.push('(expires_at IS NULL OR expires_at > ?)');
    args.push(new Date().toISOString());
  }
  return getStore()
    .prepare(
      `SELECT ${COLUMNS} FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC, seq DESC LIMIT ? OFFSET ?`
    )
    .all(...args, clampLimit(filter.limit), Math.max(0, Math.floor(filter.offset ?? 0)))
    .map(rowToRecord);
}

/** Every record in use, newest first: the list the settings screen shows. */
export function listMemory(filter: Pick<ListFilter, 'type' | 'key' | 'limit'> = {}): MemoryEntry[] {
  return listRecords({ ...filter, status: 'active' });
}

export interface SearchOptions {
  /** Only these types. Absent: every type. */
  types?: readonly MemoryType[];
  limit?: number;
  /** `all`: every word must be there (a search a person typed). `any`: ranked by how many (a message). */
  match?: 'all' | 'any';
}

export interface SearchResult {
  hits: SearchHit[];
  /** `fts5`: by the index. `substring`: by substring, where there is no index or nothing matched by word. */
  mode: 'fts5' | 'substring';
}

/** Words that say little about what a message is about, left out of a search by `any`. */
const STOP = new Set(
  (
    'the and for with that this from have has had are was were been will would could should can you ' +
    'your yours not but how what when where why who which about into than then them they their there ' +
    'please just also very more some any all out one our his her its let get got did does done its'
  ).split(' ')
);

function wordsOf(query: string, match: 'all' | 'any'): string[] {
  const words = searchTokens(query);
  // A message is full of small words; a search a person typed is theirs to judge.
  return match === 'any' ? words.filter((w) => w.length >= 3 && !STOP.has(w)) : words;
}

/** Search records by what they say: their key and their value. Never returns a record out of use. */
export function searchRecords(query: string, opts: SearchOptions = {}): SearchResult {
  pruneIfDue();
  const match = opts.match ?? 'all';
  const limit = clampLimit(opts.limit ?? 50);
  const words = wordsOf(query, match);
  const db = getStore();
  const mode = memorySearchable(db) ? 'fts5' : 'substring';
  if (words.length === 0) return { hits: [], mode };
  const types = opts.types ? [...opts.types] : undefined;
  if (types && types.length === 0) return { hits: [], mode };
  const now = new Date().toISOString();
  const typeSql = types ? `AND type IN (${types.map(() => '?').join(', ')})` : '';

  if (memorySearchable(db)) {
    // More than wanted, since some of what the index finds is out of use.
    const ranked = searchMemoryIndex(db, words, Math.min(limit * 5, 500), match);
    if (ranked.length > 0) {
      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM memory
           WHERE seq IN (${ranked.map(() => '?').join(', ')}) AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?) ${typeSql}`
        )
        .all(...ranked.map((r) => r.seq), now, ...(types ?? []));
      const bySeq = new Map(rows.map((r) => [Number(r.seq), r]));
      const hits = ranked
        .filter((r) => bySeq.has(r.seq))
        .slice(0, limit)
        .map((r) => ({
          ...rowToRecord(bySeq.get(r.seq) as Record<string, unknown>),
          score: r.score,
        }));
      if (hits.length > 0) return { hits, mode: 'fts5' };
    }
  }

  // Nothing by word (or no index): a word inside a word, or in a script the
  // index does not split, is found by substring.
  const like = (w: string) => `%${w.replace(/[\\%_]/g, '\\$&')}%`;
  const each = words.map(
    () => `(lower(key) LIKE ? ESCAPE '\\' OR lower(value) LIKE ? ESCAPE '\\')`
  );
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM memory
       WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?) ${typeSql}
         AND (${each.join(match === 'any' ? ' OR ' : ' AND ')})
       ORDER BY updated_at DESC, seq DESC LIMIT ?`
    )
    .all(now, ...(types ?? []), ...words.flatMap((w) => [like(w), like(w)]), limit);
  return { hits: rows.map((r) => ({ ...rowToRecord(r), score: 0 })), mode: 'substring' };
}

/** Search as it always was: records whose key or value hold the text. */
export function searchMemory(query: string, limit = 50): MemoryEntry[] {
  return searchRecords(query, { limit }).hits;
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

let lastPrune = 0;
const PRUNE_EVERY_MS = 3_600_000;

/**
 * Remove records past their expiry. A summary that has expired takes everything
 * folded into it along, at any depth. A record folded into a summary that has
 * not expired goes on its own expiry, and undoing the summary then restores
 * what is left.
 */
export function pruneExpired(): number {
  lastPrune = Date.now();
  const db = getStore();
  const now = new Date().toISOString();
  const expired = db
    .prepare('SELECT id FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .all(now)
    .map((r) => String(r.id));
  if (expired.length === 0) return 0;
  const ids = withSources(expired);
  const n = db.transaction(() => deleteRows(ids));
  audit(db, { actor: 'system', action: 'memory.expired', detail: { removed: n } });
  announce('expired', { ids });
  return n;
}

/** Read paths never return an expired record; this only keeps the table tidy, once an hour. */
function pruneIfDue(): void {
  if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
  try {
    pruneExpired();
  } catch {
    lastPrune = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/** What a summariser is given: the records of one key, oldest first. */
export interface ConsolidationInput {
  key: string;
  type: MemoryType;
  records: Array<{ id: string; createdAt: string; value: unknown }>;
}

export type Summariser = (input: ConsolidationInput) => Promise<{ text: string; model?: string }>;

export interface Consolidation {
  /** The one record that now stands for them. */
  record: MemoryRecord;
  /** The records folded into it, now `superseded`. */
  superseded: string[];
  model?: string;
}

/**
 * Fold the records under one key (of one type) into a single record written
 * by `summarise`, which is a model call. The records are not deleted: they stay
 * as `superseded`, pointing at the summary, and `unconsolidate` restores them.
 * The change is in the audit log with who asked and which model wrote it.
 *
 * Refused when the key has fewer than two records in use, when they are of
 * several types and none was named, and when any of them changed while the
 * summary was being written.
 */
export async function consolidate(
  input: { key: unknown; type?: unknown; actor?: string },
  summarise: Summariser
): Promise<Consolidation> {
  const key = checkKey(input.key);
  const db = getStore();
  const sources = () =>
    db
      .prepare(
        `SELECT ${COLUMNS} FROM memory WHERE key = ? ${input.type ? 'AND type = ?' : ''}
           AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at, seq`
      )
      .all(
        ...(input.type
          ? [key, checkType(input.type), new Date().toISOString()]
          : [key, new Date().toISOString()])
      )
      .map(rowToRecord);

  const before = sources();
  if (before.length < 2) {
    throw new MemoryError(
      'cannot_consolidate',
      `"${key}" has ${before.length} record${before.length === 1 ? '' : 's'} in use; summarising needs at least two.`
    );
  }
  const types = [...new Set(before.map((r) => r.type))];
  if (types.length > 1) {
    throw new MemoryError(
      'cannot_consolidate',
      `The records of "${key}" are of several types (${types.join(', ')}). Say which type to summarise.`
    );
  }
  const type = types[0];

  const { text, model } = await summarise({
    key,
    type,
    records: before.map((r) => ({ id: r.id, createdAt: r.createdAt, value: r.value })),
  });
  const summary = text.trim();
  if (!summary) {
    throw new MemoryError(
      'cannot_consolidate',
      'The model returned an empty summary; nothing was changed.'
    );
  }

  const confidences = before.flatMap((r) => (r.confidence === undefined ? [] : [r.confidence]));
  // The summary lives as long as what it says: until the latest source lapses,
  // and for good when any source does not. Otherwise a note set to expire would be
  // forgotten while its words went on in a summary that never does.
  const lapses = before.map((r) => (r.expiresAt ? Date.parse(r.expiresAt) : null));
  const expiresAt = lapses.every((t): t is number => t !== null)
    ? new Date(Math.max(...lapses)).toISOString()
    : null;
  // Where it was learned, when the sources agree.
  const sessions = new Set(before.map((r) => r.sourceSession ?? null));
  const sourceSession = sessions.size === 1 ? ([...sessions][0] ?? null) : null;
  const agentDerived = before.some((r) => r.origin === 'agent' || r.agentDerived === true);
  const id = newId();
  const now = new Date().toISOString();
  db.transaction(() => {
    // The model call took time; what it read must still be what is there.
    const after = sources();
    // By what they say as well as when they were saved: two writes in one millisecond differ in their text.
    const same = (a: MemoryRecord, b: MemoryRecord) =>
      a.id === b.id &&
      a.updatedAt === b.updatedAt &&
      JSON.stringify(a.value) === JSON.stringify(b.value);
    if (after.length !== before.length || after.some((r, i) => !same(r, before[i]))) {
      throw new MemoryError(
        'memory_changed',
        `The records of "${key}" changed while they were being summarised. Nothing was changed; try again.`
      );
    }
    insertRow(
      {
        id,
        type,
        key,
        valueJson: checkValue(summary),
        origin: 'consolidation',
        agentDerived,
        sourceSession,
        // A model's summary is no more certain than the least certain record in it.
        confidence: confidences.length ? Math.min(...confidences) : null,
        expiresAt,
      },
      now
    );
    db.prepare(
      `UPDATE memory SET status = 'superseded', superseded_by = ?, updated_at = ?
       WHERE id IN (${before.map(() => '?').join(', ')})`
    ).run(id, now, ...before.map((r) => r.id));
    audit(db, {
      actor: input.actor ?? 'operator',
      action: 'memory.consolidated',
      subject: key,
      detail: { id, type, model: model ?? null, superseded: before.map((r) => r.id) },
    });
  });
  announce('consolidated', { id, key, type, ids: before.map((r) => r.id) });
  return {
    record: getRecord(id) as MemoryRecord,
    superseded: before.map((r) => r.id),
    ...(model ? { model } : {}),
  };
}

/**
 * Undo a consolidation: the summary is removed and the records folded into it
 * are in use again, as they were. Edits made to the summary since are lost.
 */
export function unconsolidate(id: string, actor = 'operator'): { restored: string[] } {
  const db = getStore();
  const row = db.prepare('SELECT key, type, origin, status FROM memory WHERE id = ?').get(id);
  if (!row) throw new MemoryError('memory_not_found', `No memory record ${id}.`);
  if (String(row.origin) !== 'consolidation') {
    throw new MemoryError(
      'cannot_consolidate',
      `${id} is not a summary, so there is nothing to undo.`
    );
  }
  // Undoing a summary that is itself folded into another would put its records back beside
  // the summary that already stands for them: that one is undone first.
  if (String(row.status) !== 'active') {
    throw new MemoryError(
      'cannot_consolidate',
      `${id} is itself folded into a later summary. Undo that one first.`
    );
  }
  const restored = db
    .prepare('SELECT id FROM memory WHERE superseded_by = ?')
    .all(id)
    .map((r) => String(r.id));
  db.transaction(() => {
    if (restored.length > 0) {
      db.prepare(
        `UPDATE memory SET status = 'active', superseded_by = NULL, updated_at = ?
         WHERE superseded_by = ?`
      ).run(new Date().toISOString(), id);
    }
    deleteRows([id]);
    audit(db, {
      actor,
      action: 'memory.unconsolidated',
      subject: String(row.key),
      detail: { id, restored },
    });
  });
  announce('unconsolidated', {
    id,
    key: String(row.key),
    type: String(row.type) as MemoryType,
    ids: restored,
  });
  return { restored };
}
