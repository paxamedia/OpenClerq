/**
 * The skills the gateway can use, their trust state, and which one a message gets.
 *
 * A skill is prompt text, so what matters is that the text the model is given is the text the
 * user decided about. Every use starts here: a skill's folder is read **once**, its files are
 * hashed from the bytes read, the SKILL.md the instructions come from is the one of those bytes,
 * and the trust state is judged on that hash. Nothing is cached between uses, and the state is
 * not stored: a skill whose files are not the ones that were trusted is `modified` the moment it
 * is read, whatever happened to its modified time.
 *
 * The user decides (`untrusted` is where every skill starts); enforcement, the one switch of
 * `plugins.enforce`, decides what the decision does (docs/SKILLS.md):
 *
 *   off  a blocked skill is skipped, because blocking is the user's own choice; any other is
 *        used, with its state in the trace;
 *   on   only a trusted skill is used.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readSkillDir,
  SkillFilesError,
  type SkillFile,
  type SkillRead,
} from '@clerq/plugin-sdk/node';
import {
  diffSkillNeeds,
  NO_NEEDS,
  type NeedChange,
  type SkillNeeds,
} from '@clerq/plugin-sdk/skill';
import { rankSkills } from '../agent/skill-selector.js';
import { logger } from '../logger.js';
import { listSkillDirs, parseSkillMd, type SkillMeta } from '../skills-loader.js';
import { auditSkill, deleteTrust, getTrust, saveTrust, type TrustRecord } from './trust.js';

export type SkillTrust = 'untrusted' | 'trusted' | 'modified' | 'blocked';
export type TrustedBy = 'user' | 'bundled' | 'plugin';

/** A folder that holds one folder per skill, and where it came from. */
export interface SkillSourceDir {
  dir: string;
  /** `directory` (the skills folder), `module:<id>` (a legacy module's) or `plugin:<id>`. */
  source: string;
}

/** A skill as the folder listing found it: enough to route on, and to read again. */
export interface SkillRef {
  dirName: string;
  /** The skill's own folder. */
  dir: string;
  source: string;
  slug: string;
  meta: SkillMeta;
}

export interface SkillChanges {
  files: { added: string[]; removed: string[]; changed: string[] };
  needs: NeedChange[];
  version: { from: string | null; to: string | null } | null;
}

/** One skill read once, and judged. */
export interface SkillView {
  ref: SkillRef;
  slug: string;
  name: string;
  source: string;
  meta: SkillMeta;
  /** The instructions, from the SKILL.md whose bytes `checksum` covers. */
  body: string;
  needs: SkillNeeds;
  warnings: string[];
  /** The checksum its author wrote in SKILL.md, when one is there and well formed. */
  declaredChecksum: string | null;
  /** The checksum of the files as they were read; null when they could not be hashed. */
  checksum: string | null;
  files: SkillFile[];
  /** Why the files could not be hashed (a link in the folder, say), when they could not. */
  problem: string | null;
  state: SkillTrust;
  /** The state in a sentence. */
  reason: string;
  trustedBy: TrustedBy | null;
  trustedAt: string | null;
  /** What differs from what was trusted, when there is a decision and the files are not it. */
  changes: SkillChanges | null;
}

/** What happened to one skill in a selection: used, or passed over, and why. */
export interface SkillUse {
  slug: string;
  name: string;
  source: string;
  trust: SkillTrust;
  checksum: string | null;
  used: boolean;
  /** Why it was skipped, or the warning that goes with using it. */
  note: string | null;
  needs: SkillNeeds;
}

export interface SkillPick {
  /** The skill whose instructions go in the prompt; null when none is used. */
  use: SkillUse | null;
  view: SkillView | null;
  /** Skills that matched better and were passed over, best first. */
  skipped: SkillUse[];
  /** Whether enforcement was on when this was decided. */
  enforced: boolean;
}

export class SkillError extends Error {
  constructor(
    readonly code: 'not_found' | 'stale' | 'not_trustable' | 'invalid',
    message: string
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

export interface CatalogDeps {
  /** Where skills are, in the order they win a clash of names. Read at every call. */
  sources(): SkillSourceDir[];
  /** Whether the user has turned enforcement on (`plugins.enforce`). Read at every call. */
  enforcing(): boolean;
  /** Whether the plugin that is running is the one that was approved. */
  pluginApproved(pluginId: string): boolean;
  /** Skills that ship with OpenClerq: slug to the checksum they ship with. */
  bundled?: Readonly<Record<string, string>>;
  /** For tests: called after the folders are listed and before a skill's files are read. */
  beforeRead?(skillDir: string): void | Promise<void>;
}

const MAX_SKIPPED_SHOWN = 5;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** A skill's files, as a record keeps them, compared with what they are now. */
function compareFiles(
  was: Array<{ path: string; sha256: string }> | null,
  now: SkillFile[]
): SkillChanges['files'] {
  const before = new Map((was ?? []).map((f) => [f.path, f.sha256]));
  const after = new Map(now.map((f) => [f.path, f.sha256]));
  return {
    added: [...after.keys()].filter((p) => !before.has(p)).sort(),
    removed: [...before.keys()].filter((p) => !after.has(p)).sort(),
    changed: [...after.keys()]
      .filter((p) => before.has(p) && before.get(p) !== after.get(p))
      .sort(),
  };
}

export class SkillCatalog {
  /** When an audit row of each kind was last written, so a busy chat does not fill the log. */
  private readonly noted = new Map<string, number>();

  constructor(private readonly deps: CatalogDeps) {}

  // -------------------------------------------------------------------------
  // Finding skills

  /** Every skill the folders hold, first found winning a name; nothing but each SKILL.md's top is read. */
  async refs(): Promise<SkillRef[]> {
    const seen = new Set<string>();
    const out: SkillRef[] = [];
    for (const { dir, source } of this.deps.sources()) {
      for (const { dirName, meta } of await listSkillDirs(dir)) {
        if (seen.has(meta.slug)) continue;
        seen.add(meta.slug);
        out.push({ dirName, dir: path.join(dir, dirName), source, slug: meta.slug, meta });
      }
    }
    return out;
  }

  /** Whether any module or plugin has a skills folder, for the list's `source`. */
  hasModuleSources(): boolean {
    return this.deps.sources().some((s) => s.source !== 'directory');
  }

  /** The skill folder for `slug`, or undefined. */
  async refOf(slug: string): Promise<SkillRef | undefined> {
    return (await this.refs()).find((r) => r.slug === slug);
  }

  // -------------------------------------------------------------------------
  // Reading one skill, once

  /**
   * Read a skill's folder and judge it. The checksum, the instructions and the declared needs are
   * all of the same bytes. Null when the folder is no longer a skill.
   *
   * A folder that cannot be hashed (a link in it) is still read, by a plain read of SKILL.md, so
   * a skill that loaded before keeps loading while enforcement is off; it is `untrusted`, cannot
   * be trusted, and is never used with enforcement on.
   */
  async view(ref: SkillRef): Promise<SkillView | null> {
    await this.deps.beforeRead?.(ref.dir);
    let read: SkillRead | null = null;
    let problem: string | null = null;
    try {
      read = await readSkillDir(ref.dir);
    } catch (e) {
      problem =
        e instanceof SkillFilesError
          ? e.message
          : `The skill's files could not be read (${message(e)}).`;
    }
    let md: string | null;
    if (read) {
      md = read.skillMd ? read.skillMd.toString('utf8') : null;
    } else {
      md = await fs.readFile(path.join(ref.dir, 'SKILL.md'), 'utf8').catch(() => null);
    }
    if (md === null) return null;
    const parsed = parseSkillMd(md, ref.dirName);
    if (!parsed) return null;
    const meta = parsed.meta;
    const slug = meta.slug;
    const base = {
      ref,
      slug,
      name: meta.name,
      source: ref.source,
      meta,
      body: parsed.body,
      needs: meta.needs ?? NO_NEEDS,
      warnings: meta.warnings ?? [],
      declaredChecksum: meta.checksum ?? null,
      checksum: read?.checksum ?? null,
      files: read?.files ?? [],
      problem,
    };
    let record: TrustRecord | undefined;
    let recordProblem: string | null = null;
    try {
      record = getTrust(ref.source, slug);
    } catch (e) {
      recordProblem = `What you decided about skills could not be read (${message(e)}).`;
    }
    const view = this.judge(base, record, recordProblem);
    this.noteChange(view, record);
    return view;
  }

  /** The state of a skill that has been read, given the decision on it. Pure. */
  private judge(
    base: Omit<SkillView, 'state' | 'reason' | 'trustedBy' | 'trustedAt' | 'changes'>,
    record: TrustRecord | undefined,
    recordProblem: string | null = null
  ): SkillView {
    const { checksum, declaredChecksum, problem, source, slug } = base;
    const done = (
      state: SkillTrust,
      reason: string,
      trustedBy: TrustedBy | null = null,
      trustedAt: string | null = null
    ): SkillView => ({
      ...base,
      state,
      reason,
      trustedBy,
      trustedAt,
      changes:
        record && checksum !== null && record.checksum !== checksum
          ? {
              files: compareFiles(record.files, base.files),
              needs: record.needs ? diffSkillNeeds(record.needs, base.needs) : [],
              version:
                (record.version ?? null) !== (base.meta.version ?? null)
                  ? { from: record.version, to: base.meta.version ?? null }
                  : null,
            }
          : null,
    });

    if (record?.status === 'blocked') {
      return done(
        'blocked',
        `You blocked this skill.${
          record.checksum && checksum && record.checksum !== checksum
            ? ' Its files have changed since.'
            : ''
        }`
      );
    }
    if (recordProblem) return done('untrusted', recordProblem);
    if (source.startsWith('plugin:')) {
      const approved = this.deps.pluginApproved(source.slice('plugin:'.length));
      return approved
        ? done('trusted', 'Approved with its plugin.', 'plugin')
        : done('untrusted', 'It comes with a plugin that has not been approved.');
    }
    if (problem !== null || checksum === null) {
      return done(
        'untrusted',
        `${sentence(problem ?? 'Its files could not be read')} It cannot be trusted until that is fixed.`
      );
    }
    if (record?.status === 'trusted') {
      return record.checksum === checksum
        ? done(
            'trusted',
            `You trusted this version on ${record.decidedAt.slice(0, 10)}.`,
            'user',
            record.decidedAt
          )
        : done('modified', 'Its files have changed since you trusted it.');
    }
    const shipped = this.deps.bundled?.[slug];
    if (shipped !== undefined) {
      return shipped === checksum
        ? done('trusted', 'It ships with OpenClerq, unchanged.', 'bundled')
        : done('modified', 'Its files differ from the version that ships with OpenClerq.');
    }
    if (declaredChecksum !== null && declaredChecksum !== checksum) {
      return done('modified', 'The files do not match the checksum in SKILL.md.');
    }
    return done('untrusted', 'You have not decided on this skill.');
  }

  /** Every skill, read and judged. */
  async list(): Promise<SkillView[]> {
    const refs = await this.refs();
    const views = await Promise.all(refs.map((r) => this.view(r)));
    return views.filter((v): v is SkillView => v !== null);
  }

  /** One skill by name, read and judged. */
  async find(slug: string): Promise<SkillView | null> {
    const ref = await this.refOf(slug);
    return ref ? this.view(ref) : null;
  }

  // -------------------------------------------------------------------------
  // Choosing a skill for a message

  private useOf(view: SkillView, used: boolean, note: string | null): SkillUse {
    return {
      slug: view.slug,
      name: view.name,
      source: view.source,
      trust: view.state,
      checksum: view.checksum,
      used,
      note,
      needs: view.needs,
    };
  }

  /**
   * Whether a skill read now may have its instructions used. A blocked skill never; with
   * enforcement on, only a trusted one. Otherwise yes, and the note says what is not as it
   * should be.
   */
  private verdict(view: SkillView, enforced: boolean): { used: boolean; note: string | null } {
    if (view.state === 'blocked') return { used: false, note: view.reason };
    if (view.state === 'trusted') return { used: true, note: null };
    if (enforced) {
      return {
        used: false,
        note: `${sentence(view.reason)} Enforcement is on, so only trusted skills are used.`,
      };
    }
    return {
      used: true,
      note: `${sentence(view.reason)} Used anyway: enforcement is off, so trust is shown and recorded and nothing is held back.`,
    };
  }

  /**
   * The skill a message gets: the best match that may be used. Matches passed over (blocked, or
   * not trusted with enforcement on) are in `skipped`, so a trace can name them. The skill is
   * read after it is chosen and judged on what was read; the text it gives is that read's.
   * `record: false` (a preview: nothing is sent) leaves out the audit rows for using or passing over.
   */
  async pick(message: string, opts: { record?: boolean } = {}): Promise<SkillPick> {
    const record = opts.record !== false;
    const enforced = this.deps.enforcing();
    const refs = await this.refs();
    const bySlug = new Map(refs.map((r) => [r.slug, r]));
    const skipped: SkillUse[] = [];
    for (const meta of rankSkills(
      message,
      refs.map((r) => r.meta)
    )) {
      const ref = bySlug.get(meta.slug);
      if (!ref) continue;
      const view = await this.view(ref);
      if (!view) continue;
      const v = this.verdict(view, enforced);
      const use = this.useOf(view, v.used, v.note);
      if (!v.used) {
        if (record) this.noteUse('skill.skipped', view, enforced);
        if (skipped.length < MAX_SKIPPED_SHOWN) skipped.push(use);
        continue;
      }
      if (record && view.state !== 'trusted') this.noteUse('skill.used', view, enforced);
      return { use, view, skipped, enforced };
    }
    return { use: null, view: null, skipped, enforced };
  }

  /** The same judgement for a skill named outright (a context preview). */
  async use(slug: string): Promise<SkillPick> {
    const enforced = this.deps.enforcing();
    const view = await this.find(slug);
    if (!view) return { use: null, view: null, skipped: [], enforced };
    const v = this.verdict(view, enforced);
    const use = this.useOf(view, v.used, v.note);
    return v.used
      ? { use, view, skipped: [], enforced }
      : { use: null, view: null, skipped: [use], enforced };
  }

  // -------------------------------------------------------------------------
  // The user's decisions

  /**
   * Trust the skill `slug` as it is on disk now, if its checksum is `checksum`: the one the user
   * was shown. The files are read here and the decision is of what was read; a skill that is
   * not those files any more is `stale`.
   */
  async trust(slug: string, checksum: string, actor: string): Promise<SkillView> {
    const view = await this.decidable(slug);
    if (view.source.startsWith('plugin:')) {
      throw new SkillError(
        'not_trustable',
        `This skill comes with the plugin "${view.source.slice(7)}", and is approved with it. Approve or disable the plugin instead.`
      );
    }
    if (view.checksum === null) {
      throw new SkillError('not_trustable', view.problem ?? 'Its files could not be read.');
    }
    if (view.slug !== slug || view.checksum !== checksum) {
      throw new SkillError(
        'stale',
        'The skill changed after you looked at it. Nothing was trusted. Look at it again.'
      );
    }
    const record: TrustRecord = {
      source: view.source,
      slug: view.slug,
      status: 'trusted',
      checksum: view.checksum,
      name: view.name,
      version: view.meta.version ?? null,
      needs: view.needs,
      files: view.files.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
      decidedAt: new Date().toISOString(),
      decidedBy: actor,
    };
    saveTrust(record);
    auditSkill('skill.trusted', `${view.source}:${view.slug}`, actor, {
      checksum: view.checksum,
      version: record.version,
      needs: view.needs,
    });
    return this.judge(view, record);
  }

  /** Refuse the skill `slug`: it is never used, whatever else is set, until it is untrusted. */
  async block(slug: string, actor: string): Promise<SkillView> {
    const view = await this.decidable(slug);
    const record: TrustRecord = {
      source: view.source,
      slug: view.slug,
      status: 'blocked',
      checksum: view.checksum,
      name: view.name,
      version: view.meta.version ?? null,
      needs: view.needs,
      files: view.files.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
      decidedAt: new Date().toISOString(),
      decidedBy: actor,
    };
    saveTrust(record);
    auditSkill('skill.blocked', `${view.source}:${view.slug}`, actor, { checksum: view.checksum });
    return this.judge(view, record);
  }

  /** Forget what was decided: the skill is as it was when first seen. */
  async untrust(slug: string, actor: string): Promise<SkillView> {
    const view = await this.decidable(slug);
    const had = getTrust(view.source, view.slug);
    if (had) {
      deleteTrust(view.source, view.slug);
      auditSkill('skill.untrusted', `${view.source}:${view.slug}`, actor, {
        was: had.status,
        checksum: had.checksum,
      });
    }
    return this.judge(view, undefined);
  }

  private async decidable(slug: string): Promise<SkillView> {
    const ref = await this.refOf(slug);
    const view = ref ? await this.view(ref) : null;
    if (!view) throw new SkillError('not_found', `There is no skill "${slug}".`);
    return view;
  }

  // -------------------------------------------------------------------------
  // The record of what happened

  /** One audit row of a kind for a skill in each state, at most once a minute. */
  private noteUse(
    action: 'skill.used' | 'skill.skipped',
    view: SkillView,
    enforced: boolean
  ): void {
    this.once(
      `${action}:${view.source}:${view.slug}:${view.checksum}:${view.state}:${enforced}`,
      () =>
        auditSkill(action, `${view.source}:${view.slug}`, 'gateway', {
          state: view.state,
          enforced,
          checksum: view.checksum,
          reason: view.reason,
        })
    );
  }

  /** A trusted skill whose files are not the trusted ones, seen for the first time since this start. */
  private noteChange(view: SkillView, record: TrustRecord | undefined): void {
    if (view.state !== 'modified' || record?.status !== 'trusted') return;
    this.once(
      `changed:${view.source}:${view.slug}:${view.checksum}`,
      () =>
        auditSkill('skill.modified', `${view.source}:${view.slug}`, 'gateway', {
          trusted: record.checksum,
          now: view.checksum,
          files: view.changes?.files ?? null,
        }),
      Infinity
    );
  }

  private once(key: string, write: () => void, everyMs = 60_000): void {
    const now = Date.now();
    const last = this.noted.get(key);
    if (last !== undefined && now - last < everyMs) return;
    if (this.noted.size > 2_000) this.noted.clear();
    this.noted.set(key, now);
    try {
      write();
    } catch (e) {
      logger.warn('Could not record a skill event', { err: message(e) });
    }
  }
}

export { rankSkills };
