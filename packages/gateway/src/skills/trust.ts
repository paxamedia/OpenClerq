/**
 * What the person decided about each skill: trusted (with the checksum of the files they
 * looked at, what it declared and which files it had), or blocked. A skill with no row has not
 * been decided on. `modified` is never stored: it is a trusted row whose checksum is not the
 * files' now.
 */

import { audit } from '@clerq/store';
import type { SkillNeeds } from '@clerq/plugin-sdk/skill';
import { getStore } from '../store.js';
import { logger } from '../logger.js';

export interface TrustedFile {
  path: string;
  sha256: string;
}

export interface TrustRecord {
  /** Where the skill was found: `directory` (the skills folder), or `module:<id>` / `plugin:<id>`. */
  source: string;
  slug: string;
  status: 'trusted' | 'blocked';
  /** `sha256:<hex>` of the files at the time; null for a block made on files that could not be read. */
  checksum: string | null;
  name: string | null;
  version: string | null;
  /** What the skill declared when it was decided on. */
  needs: SkillNeeds | null;
  files: TrustedFile[] | null;
  decidedAt: string;
  decidedBy: string;
}

function json<T>(text: unknown): T | null {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toRecord(r: Record<string, unknown>): TrustRecord {
  return {
    source: String(r.source),
    slug: String(r.slug),
    status: r.status === 'blocked' ? 'blocked' : 'trusted',
    checksum: typeof r.checksum === 'string' ? r.checksum : null,
    name: typeof r.name === 'string' ? r.name : null,
    version: typeof r.version === 'string' ? r.version : null,
    needs: json<SkillNeeds>(r.needs),
    files: json<TrustedFile[]>(r.files),
    decidedAt: String(r.decided_at),
    decidedBy: String(r.decided_by),
  };
}

/** The decision on a skill, or undefined when there is none. Throws when the store cannot be read. */
export function getTrust(source: string, slug: string): TrustRecord | undefined {
  const row = getStore()
    .prepare('SELECT * FROM skill_trust WHERE source = ? AND slug = ?')
    .get(source, slug);
  return row ? toRecord(row) : undefined;
}

export function listTrust(): TrustRecord[] {
  return getStore()
    .prepare('SELECT * FROM skill_trust ORDER BY source, slug')
    .all()
    .map((r) => toRecord(r));
}

/** Record a decision, replacing the one there was. */
export function saveTrust(r: TrustRecord): void {
  getStore()
    .prepare(
      `INSERT INTO skill_trust
         (source, slug, status, checksum, name, version, needs, files, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, slug) DO UPDATE SET
         status = excluded.status, checksum = excluded.checksum, name = excluded.name,
         version = excluded.version, needs = excluded.needs, files = excluded.files,
         decided_at = excluded.decided_at, decided_by = excluded.decided_by`
    )
    .run(
      r.source,
      r.slug,
      r.status,
      r.checksum,
      r.name,
      r.version,
      r.needs ? JSON.stringify(r.needs) : null,
      r.files ? JSON.stringify(r.files) : null,
      r.decidedAt,
      r.decidedBy
    );
}

/** Forget the decision on a skill. True when there was one. */
export function deleteTrust(source: string, slug: string): boolean {
  const res = getStore()
    .prepare('DELETE FROM skill_trust WHERE source = ? AND slug = ?')
    .run(source, slug);
  return Number(res.changes) > 0;
}

/** Write an audit row; never throws, as nothing may fail because its record could not be made. */
export function auditSkill(action: string, subject: string, actor: string, detail: unknown): void {
  try {
    audit(getStore(), { actor, action, subject, detail });
  } catch (e) {
    logger.warn('Could not audit a skill change', {
      subject,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
