/**
 * Skill-based routing — select which skill (if any) should handle a message.
 * Uses triggers for matching. OSS: no country/jurisdiction filtering.
 */

import type { SkillMeta } from '../skills-loader.js';

export interface SkillSelection {
  skillSlug?: string;
  skill?: SkillMeta;
  fallbackToExplain: boolean;
}

/**
 * How well a skill matches a message already trimmed and lower-cased: 0 for no match, 2 for one
 * of its triggers, 1 for its slug or name when it has no triggers.
 */
function score(lower: string, skill: SkillMeta): number {
  if (skill.triggers?.length) {
    for (const t of skill.triggers) {
      if (lower.includes(t.toLowerCase())) return 2;
    }
    return 0;
  }
  const slug = skill.slug.toLowerCase().replace(/-/g, ' ');
  const name = (skill.name ?? '').toLowerCase();
  return lower.includes(skill.slug) || lower.includes(slug) || lower.includes(name) ? 1 : 0;
}

/**
 * Every skill that matches the message, best first; among equals, in the order given. The first
 * is what `selectSkill` returns. A caller that may not use the best (it is blocked, or not
 * trusted) goes on to the next.
 */
export function rankSkills(message: string, skills: SkillMeta[]): SkillMeta[] {
  const lower = message.trim().toLowerCase();
  if (!lower) return [];
  return skills
    .map((skill, i) => ({ skill, i, score: score(lower, skill) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.skill);
}

/**
 * Select a skill for the given message.
 * Matching: message (lowercased) contains any of the skill's triggers.
 * Skills without triggers use slug/name/description.
 */
export function selectSkill(message: string, skills: SkillMeta[]): SkillSelection {
  const best = rankSkills(message, skills)[0];
  return best
    ? { skillSlug: best.slug, skill: best, fallbackToExplain: false }
    : { fallbackToExplain: true };
}
