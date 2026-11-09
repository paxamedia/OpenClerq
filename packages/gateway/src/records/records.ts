/**
 * Shared records: people, organisations and activities that every module can
 * point at, so a contact exists once however many modules know it.
 *
 * A record is found again by an identity: an email or phone for a person, a
 * domain (or email or phone) for an organisation. Identities are normalised
 * and unique, so resolving the same email twice gives the same record.
 *
 * Anything is addressed by a ref, `<module>:<type>:<id>`; core records use the
 * module `core` (`core:person:per_…`). Links join any two refs, so a module's
 * own record (`crm:deal:42`) can point at a person without the core knowing
 * what a deal is.
 */

import crypto from 'node:crypto';
import { getStore } from '../store.js';
import { emit } from '../events.js';
import { currentTenant } from '../tenant.js';

export type CoreType = 'person' | 'organisation' | 'activity';
export type IdentityKind = 'email' | 'phone' | 'domain';

export const CORE_TYPES: CoreType[] = ['person', 'organisation', 'activity'];
const ID_PREFIX: Record<CoreType, string> = { person: 'per', organisation: 'org', activity: 'act' };

export interface Identities {
  emails?: string[];
  phones?: string[];
  domains?: string[];
}

export interface CoreRecord {
  id: string;
  ref: string;
  tenantId: string;
  type: CoreType;
  name: string | null;
  data: Record<string, unknown>;
  emails: string[];
  phones: string[];
  domains: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export class RecordError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'identity_conflict' | 'merged',
    message: string,
    readonly candidates?: CoreRecord[]
  ) {
    super(message);
    this.name = 'RecordError';
  }
}

// ---------------------------------------------------------------------------
// Refs and identities
// ---------------------------------------------------------------------------

const REF = /^([a-z][a-z0-9-]*):([a-z][a-z0-9_-]*):([^\s:][^\s]*)$/;

export function parseRef(ref: string): { module: string; type: string; id: string } {
  const m = REF.exec(String(ref ?? '').trim());
  if (!m) throw new RecordError('invalid', `"${ref}" is not a ref: use <module>:<type>:<id>.`);
  return { module: m[1], type: m[2], id: m[3] };
}

export function refOf(type: CoreType, id: string): string {
  return `core:${type}:${id}`;
}

export function normaliseEmail(v: string): string | null {
  const e = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** `+` and digits. A leading `00` becomes `+`. No country is guessed. */
export function normalisePhone(v: string): string | null {
  let p = v.trim().replace(/[\s().-]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  return /^\+?\d{6,15}$/.test(p) ? p : null;
}

export function normaliseDomain(v: string): string | null {
  const d = v
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(d) ? d : null;
}

const NORMALISE: Record<IdentityKind, (v: string) => string | null> = {
  email: normaliseEmail,
  phone: normalisePhone,
  domain: normaliseDomain,
};

/** Normalise every identity, refusing the whole set if one is malformed. */
function identityList(ids: Identities): Array<{ kind: IdentityKind; value: string }> {
  const out: Array<{ kind: IdentityKind; value: string }> = [];
  const add = (kind: IdentityKind, list: unknown) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) throw new RecordError('invalid', `${kind}s must be a list.`);
    for (const raw of list) {
      const value = typeof raw === 'string' ? NORMALISE[kind](raw) : null;
      if (!value) throw new RecordError('invalid', `"${String(raw)}" is not a valid ${kind}.`);
      if (!out.some((o) => o.kind === kind && o.value === value)) out.push({ kind, value });
    }
  };
  add('email', ids.emails);
  add('phone', ids.phones);
  add('domain', ids.domains);
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function rowToRecord(r: Record<string, unknown>): CoreRecord {
  const id = String(r.id);
  const ids = getStore()
    .prepare(
      'SELECT kind, value FROM record_identities WHERE tenant_id = ? AND record_id = ? ORDER BY kind, value'
    )
    .all(String(r.tenant_id ?? currentTenant()), id);
  const pick = (k: IdentityKind) => ids.filter((i) => i.kind === k).map((i) => String(i.value));
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(String(r.data ?? '{}'));
  } catch {
    /* a malformed row still reads */
  }
  return {
    id,
    ref: refOf(r.type as CoreType, id),
    tenantId: String(r.tenant_id ?? 'default'),
    type: r.type as CoreType,
    name: r.name === null || r.name === undefined ? null : String(r.name),
    data,
    emails: pick('email'),
    phones: pick('phone'),
    domains: pick('domain'),
    createdBy: r.created_by ? String(r.created_by) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** A record by id. A merged record answers with the record it was merged into. */
export function getRecord(id: string): CoreRecord | null {
  const db = getStore();
  const byId = db.prepare('SELECT * FROM records WHERE tenant_id = ? AND id = ?');
  const tenant = currentTenant();
  let row = byId.get(tenant, id);
  for (let hops = 0; row?.merged_into && hops < 10; hops++) {
    row = byId.get(tenant, String(row.merged_into));
  }
  return row ? rowToRecord(row) : null;
}

function requireRecord(id: string): CoreRecord {
  const r = getRecord(id);
  if (!r) throw new RecordError('not_found', `No record ${id}.`);
  return r;
}

export function findByIdentity(kind: IdentityKind, value: string): CoreRecord | null {
  const v = NORMALISE[kind](value);
  if (!v) return null;
  const row = getStore()
    .prepare(
      'SELECT record_id FROM record_identities WHERE tenant_id = ? AND kind = ? AND value = ?'
    )
    .get(currentTenant(), kind, v);
  return row ? getRecord(String(row.record_id)) : null;
}

/** Records by type, newest first; `q` matches the name or any identity. */
export function listRecords(
  opts: { type?: string; q?: string; limit?: number } = {}
): CoreRecord[] {
  const where = ['tenant_id = ?', 'merged_into IS NULL'];
  const params: Array<string | number> = [currentTenant()];
  if (opts.type) {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts.q?.trim()) {
    const like = `%${opts.q
      .trim()
      .toLowerCase()
      .replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(LOWER(COALESCE(name, '')) LIKE ? ESCAPE '\\' OR id IN (
         SELECT record_id FROM record_identities WHERE tenant_id = ? AND value LIKE ? ESCAPE '\\'))`
    );
    params.push(like, currentTenant(), like);
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  return getStore()
    .prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params)
    .map(rowToRecord);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function attach(recordId: string, ids: Array<{ kind: IdentityKind; value: string }>): void {
  const db = getStore();
  const tenant = currentTenant();
  const owner = db.prepare(
    'SELECT record_id FROM record_identities WHERE tenant_id = ? AND kind = ? AND value = ?'
  );
  const insert = db.prepare(
    'INSERT INTO record_identities (tenant_id, kind, value, record_id) VALUES (?, ?, ?, ?)'
  );
  for (const i of ids) {
    const found = owner.get(tenant, i.kind, i.value);
    if (!found) insert.run(tenant, i.kind, i.value, recordId);
    else if (String(found.record_id) !== recordId) {
      throw new RecordError(
        'identity_conflict',
        `${i.value} already belongs to ${found.record_id}.`,
        [getRecord(String(found.record_id))].filter((r): r is CoreRecord => r !== null)
      );
    }
  }
}

export function createRecord(input: {
  type: CoreType;
  name?: string | null;
  data?: Record<string, unknown>;
  identities?: Identities;
  /** When an activity happened. */
  occurredAt?: string;
  actor?: string;
}): CoreRecord {
  if (!CORE_TYPES.includes(input.type)) {
    throw new RecordError('invalid', `type must be one of ${CORE_TYPES.join(', ')}.`);
  }
  const ids = identityList(input.identities ?? {});
  const id = `${ID_PREFIX[input.type]}_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const db = getStore();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO records
         (id, tenant_id, type, name, data, occurred_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      currentTenant(),
      input.type,
      input.name?.trim() || null,
      JSON.stringify(input.data ?? {}),
      input.occurredAt ?? null,
      input.actor ?? null,
      now,
      now
    );
    attach(id, ids);
  });
  const record = requireRecord(id);
  emit('record.created', {
    ref: record.ref,
    type: record.type,
    tenantId: record.tenantId,
    by: input.actor,
  });
  return record;
}

/**
 * Find the record these identities belong to, or create one. Every identity
 * that matches must point at the same record; new identities are added to it.
 */
export function resolveRecord(input: {
  type: CoreType;
  name?: string;
  data?: Record<string, unknown>;
  identities: Identities;
  create?: boolean;
  actor?: string;
}): { record: CoreRecord | null; created: boolean; matchedBy: string[] } {
  if (!CORE_TYPES.includes(input.type) || input.type === 'activity') {
    throw new RecordError('invalid', 'Resolve a person or an organisation.');
  }
  const ids = identityList(input.identities);
  if (ids.length === 0)
    throw new RecordError('invalid', 'Give at least one email, phone or domain.');
  const db = getStore();
  const owner = db.prepare(
    'SELECT record_id FROM record_identities WHERE tenant_id = ? AND kind = ? AND value = ?'
  );
  const matches = new Map<string, string[]>();
  for (const i of ids) {
    const row = owner.get(currentTenant(), i.kind, i.value);
    if (!row) continue;
    const rec = getRecord(String(row.record_id));
    if (!rec) continue;
    matches.set(rec.id, [...(matches.get(rec.id) ?? []), `${i.kind}:${i.value}`]);
  }
  if (matches.size > 1) {
    throw new RecordError(
      'identity_conflict',
      'These identities belong to different records. Merge them first.',
      [...matches.keys()].map((id) => requireRecord(id))
    );
  }
  if (matches.size === 1) {
    const [id, matchedBy] = [...matches.entries()][0];
    const existing = requireRecord(id);
    if (existing.type !== input.type) {
      throw new RecordError(
        'identity_conflict',
        `${matchedBy[0]} belongs to a ${existing.type}, not a ${input.type}.`,
        [existing]
      );
    }
    const missing = ids.filter((i) => !matchedBy.includes(`${i.kind}:${i.value}`));
    if (missing.length > 0 || (input.name && !existing.name)) {
      db.transaction(() => {
        attach(id, missing);
        db.prepare('UPDATE records SET name = COALESCE(name, ?), updated_at = ? WHERE id = ?').run(
          input.name?.trim() || null,
          new Date().toISOString(),
          id
        );
      });
      emit('record.updated', { ref: existing.ref, by: input.actor });
    }
    return { record: requireRecord(id), created: false, matchedBy };
  }
  if (input.create === false) return { record: null, created: false, matchedBy: [] };
  const record = createRecord({
    type: input.type,
    name: input.name,
    data: input.data,
    identities: input.identities,
    actor: input.actor,
  });
  return { record, created: true, matchedBy: [] };
}

export function updateRecord(
  id: string,
  patch: {
    name?: string | null;
    /** Merged into the stored data; a null value removes that key. */
    data?: Record<string, unknown>;
    add?: Identities;
    remove?: Identities;
  },
  actor?: string
): CoreRecord {
  const current = requireRecord(id);
  const db = getStore();
  const data = { ...current.data };
  for (const [k, v] of Object.entries(patch.data ?? {})) {
    if (v === null) delete data[k];
    else data[k] = v;
  }
  const add = identityList(patch.add ?? {});
  const remove = identityList(patch.remove ?? {});
  db.transaction(() => {
    attach(current.id, add);
    const del = db.prepare(
      'DELETE FROM record_identities WHERE kind = ? AND value = ? AND record_id = ?'
    );
    for (const i of remove) del.run(i.kind, i.value, current.id);
    db.prepare('UPDATE records SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(
      patch.name === undefined ? current.name : patch.name?.trim() || null,
      JSON.stringify(data),
      new Date().toISOString(),
      current.id
    );
  });
  emit('record.updated', { ref: current.ref, by: actor });
  return requireRecord(current.id);
}

/**
 * Merge `fromId` into `intoId`: its identities and links move, its data fills
 * gaps, and it answers as `intoId` from then on.
 */
export function mergeRecords(intoId: string, fromId: string, actor?: string): CoreRecord {
  const into = requireRecord(intoId);
  const from = requireRecord(fromId);
  if (into.id === from.id) throw new RecordError('invalid', 'A record cannot merge into itself.');
  if (into.type !== from.type) {
    throw new RecordError('invalid', `Cannot merge a ${from.type} into a ${into.type}.`);
  }
  const db = getStore();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE record_identities SET record_id = ? WHERE record_id = ?').run(
      into.id,
      from.id
    );
    // Move the merged record's links to the target, skipping any it already has.
    const tenant = currentTenant();
    const moved = db
      .prepare('SELECT * FROM record_links WHERE tenant_id = ? AND (from_ref = ? OR to_ref = ?)')
      .all(tenant, from.ref, from.ref);
    db.prepare('DELETE FROM record_links WHERE tenant_id = ? AND (from_ref = ? OR to_ref = ?)').run(
      tenant,
      from.ref,
      from.ref
    );
    const insert = db.prepare(
      `INSERT INTO record_links (tenant_id, from_ref, to_ref, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    );
    for (const l of moved) {
      const a = String(l.from_ref) === from.ref ? into.ref : String(l.from_ref);
      const b = String(l.to_ref) === from.ref ? into.ref : String(l.to_ref);
      insert.run(
        tenant,
        a,
        b,
        String(l.kind),
        l.created_by ? String(l.created_by) : null,
        String(l.created_at)
      );
    }
    db.prepare('UPDATE records SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(
      into.name ?? from.name,
      JSON.stringify({ ...from.data, ...into.data }),
      now,
      into.id
    );
    db.prepare('UPDATE records SET merged_into = ?, updated_at = ? WHERE id = ?').run(
      into.id,
      now,
      from.id
    );
  });
  emit('record.merged', { ref: into.ref, from: from.ref, by: actor });
  return requireRecord(into.id);
}

/**
 * Delete a record, and the records merged into it. A merged-away id is
 * refused: it answers as the record it was merged into, and deleting that by
 * a stale id would be a surprise.
 */
export function deleteRecord(id: string, actor?: string): void {
  const rec = requireRecord(id);
  if (rec.id !== id) {
    throw new RecordError('merged', `${id} was merged into ${rec.id}; delete that one instead.`);
  }
  const db = getStore();
  const tenant = currentTenant();
  // Everything merged into it, however many merges deep.
  const merged: string[] = [];
  const childrenOf = db.prepare('SELECT id FROM records WHERE tenant_id = ? AND merged_into = ?');
  for (let i = -1; i < merged.length; i++) {
    const parent = i < 0 ? rec.id : merged[i];
    for (const row of childrenOf.all(tenant, parent)) merged.push(String(row.id));
  }
  db.transaction(() => {
    const del = db.prepare('DELETE FROM records WHERE tenant_id = ? AND id = ?');
    for (const m of merged.reverse()) del.run(tenant, m);
    db.prepare('DELETE FROM record_links WHERE tenant_id = ? AND (from_ref = ? OR to_ref = ?)').run(
      currentTenant(),
      rec.ref,
      rec.ref
    );
    del.run(tenant, rec.id);
  });
  emit('record.deleted', { ref: rec.ref, by: actor });
}

// ---------------------------------------------------------------------------
// Links and activities
// ---------------------------------------------------------------------------

export interface RecordLink {
  from: string;
  to: string;
  kind: string;
  createdBy: string | null;
  createdAt: string;
}

const LINK_KIND = /^[a-z][a-z0-9_.-]{0,63}$/;

/** A core ref is rewritten to the record it was merged into; others pass through. */
function canonical(ref: string): string {
  const r = parseRef(ref);
  if (r.module !== 'core') return `${r.module}:${r.type}:${r.id}`;
  const rec = getRecord(r.id);
  if (!rec || rec.type !== r.type) throw new RecordError('not_found', `No record ${ref}.`);
  return rec.ref;
}

export function link(from: string, to: string, kind: string, actor?: string): RecordLink {
  if (!LINK_KIND.test(kind)) throw new RecordError('invalid', `Invalid link kind "${kind}".`);
  const a = canonical(from);
  const b = canonical(to);
  const now = new Date().toISOString();
  getStore()
    .prepare(
      `INSERT INTO record_links (tenant_id, from_ref, to_ref, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
    .run(currentTenant(), a, b, kind, actor ?? null, now);
  emit('record.linked', { from: a, to: b, kind, by: actor });
  return { from: a, to: b, kind, createdBy: actor ?? null, createdAt: now };
}

export function unlink(from: string, to: string, kind: string, actor?: string): boolean {
  const removed =
    getStore()
      .prepare(
        'DELETE FROM record_links WHERE tenant_id = ? AND from_ref = ? AND to_ref = ? AND kind = ?'
      )
      .run(currentTenant(), canonical(from), canonical(to), kind).changes > 0;
  if (removed) emit('record.unlinked', { from, to, kind, by: actor });
  return removed;
}

/** Every link to or from a ref. */
export function linksOf(ref: string): RecordLink[] {
  const r = canonical(ref);
  return getStore()
    .prepare(
      `SELECT * FROM record_links WHERE tenant_id = ? AND (from_ref = ? OR to_ref = ?)
       ORDER BY created_at DESC`
    )
    .all(currentTenant(), r, r)
    .map((l) => ({
      from: String(l.from_ref),
      to: String(l.to_ref),
      kind: String(l.kind),
      createdBy: l.created_by ? String(l.created_by) : null,
      createdAt: String(l.created_at),
    }));
}

/**
 * Something that happened, about one or more records: an email sent, a call,
 * a note. Stored as an `activity` record linked `about` each ref.
 */
export function addActivity(input: {
  kind: string;
  summary: string;
  refs: string[];
  at?: string;
  data?: Record<string, unknown>;
  actor?: string;
}): CoreRecord {
  if (!LINK_KIND.test(input.kind)) {
    throw new RecordError('invalid', `Invalid activity kind "${input.kind}".`);
  }
  if (!input.summary?.trim()) throw new RecordError('invalid', 'An activity needs a summary.');
  if (!Array.isArray(input.refs) || input.refs.length === 0) {
    throw new RecordError('invalid', 'An activity needs at least one ref.');
  }
  const at = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(at.getTime())) throw new RecordError('invalid', 'at must be an ISO time.');
  // Checked before anything is written, so a bad ref leaves no activity behind.
  const refs = input.refs.map(canonical);
  const activity = createRecord({
    type: 'activity',
    name: input.summary.trim().slice(0, 500),
    data: { ...input.data, kind: input.kind, at: at.toISOString() },
    occurredAt: at.toISOString(),
    actor: input.actor,
  });
  for (const r of refs) link(activity.ref, r, 'about', input.actor);
  emit('activity.added', { ref: activity.ref, kind: input.kind, refs, by: input.actor });
  return activity;
}

/** Activities about a ref, newest first. */
export function activitiesOf(ref: string, limit = 50): CoreRecord[] {
  const r = canonical(ref);
  return getStore()
    .prepare(
      `SELECT records.* FROM record_links l
       JOIN records ON records.tenant_id = l.tenant_id AND l.from_ref = 'core:activity:' || records.id
       WHERE l.tenant_id = ? AND l.to_ref = ? AND l.kind = 'about'
       ORDER BY records.occurred_at DESC LIMIT ?`
    )
    .all(currentTenant(), r, Math.min(Math.max(limit, 1), 500))
    .map(rowToRecord);
}
