/**
 * What a skill choice becomes for the callers that use it: a managed chat's `SkillChoice`, and the
 * lines `/task` adds to its trace. Words only; nothing here reads a file or decides trust.
 */

import type { SkillNeeds } from '@clerq/plugin-sdk/skill';
import type { TaskStep } from '../agent/task.js';
import type { SkillPick, SkillTrust, SkillUse } from './catalog.js';

/** The skill a message got, as the managed chat and `/task` take it. */
export interface SkillChoice {
  slug?: string;
  name?: string;
  instructions?: string;
  /** How it was judged. Absent when no skill was chosen. */
  trust?: SkillTrust;
  /** Whether enforcement was on when it was chosen. */
  enforced?: boolean;
  needs?: SkillNeeds;
  checksum?: string | null;
  source?: string;
  /** The warning that goes with using it though it is not trusted. */
  note?: string | null;
  /** Skills that matched and were passed over, best first. */
  skipped?: SkillUse[];
}

export function skillChoiceOf(pick: SkillPick): SkillChoice {
  const { use, view, skipped, enforced } = pick;
  if (!use || !view) return skipped.length > 0 ? { skipped, enforced } : {};
  return {
    slug: use.slug,
    name: use.name,
    instructions: view.body,
    trust: use.trust,
    enforced,
    needs: use.needs,
    checksum: use.checksum,
    source: use.source,
    note: use.note,
    skipped,
  };
}

const list = (xs: readonly string[]) => xs.join(', ');

/** What a skill declares, in one line; empty when it declares nothing. */
export function declaresLine(needs: SkillNeeds): string {
  return [
    needs.tools.length > 0 && `tools ${list(needs.tools)}`,
    needs.domains.length > 0 && `hosts ${list(needs.domains)}`,
    needs.paths.length > 0 && `paths ${list(needs.paths)}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/** A skill that was passed over, in a sentence. */
export function skippedLine(s: SkillUse): string {
  return `The skill "${s.slug}" (${s.trust}) matched but was not used. ${s.note ?? ''}`.trim();
}

/**
 * What `/task` adds to its trace about the skill: the ones it passed over and why, the trust state
 * when it is not `trusted`, and what the skill declares. `/task` gives the model no tools and
 * reaches no files or hosts, so a declaration has nothing to narrow there; it is shown.
 */
export function skillTaskTrace(pick: SkillPick): TaskStep[] {
  const out: TaskStep[] = [];
  for (const s of pick.skipped) {
    out.push({ step: 'skill_skipped', detail: skippedLine(s) });
  }
  const { use } = pick;
  if (!use) return out;
  if (use.trust !== 'trusted') {
    out.push({
      step: 'skill_trust',
      detail: `${use.slug} is ${use.trust}. ${use.note ?? ''}`.trim(),
    });
  }
  const declared = declaresLine(use.needs);
  if (declared) {
    out.push({
      step: 'skill_needs',
      detail: `${use.slug} declares ${declared}. /task gives the model no tools and reaches no files or hosts of its own, so nothing is narrowed or limited here.`,
    });
  }
  return out;
}
