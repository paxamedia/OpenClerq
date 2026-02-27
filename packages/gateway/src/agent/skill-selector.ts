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
 * Select a skill for the given message.
 * Matching: message (lowercased) contains any of the skill's triggers.
 * Skills without triggers use slug/name/description.
 */
export function selectSkill(message: string, skills: SkillMeta[]): SkillSelection {
  const trimmed = message.trim();
  if (!trimmed || skills.length === 0) {
    return { fallbackToExplain: true };
  }

  const lower = trimmed.toLowerCase();
  let best: { skill: SkillMeta; score: number } | null = null;

  for (const skill of skills) {
    let score = 0;

    if (skill.triggers?.length) {
      for (const t of skill.triggers) {
        if (lower.includes(t.toLowerCase())) {
          score += 2;
          break;
        }
      }
      if (score === 0) continue;
    } else {
      const slug = skill.slug.toLowerCase().replace(/-/g, ' ');
      const name = (skill.name ?? '').toLowerCase();
      if (lower.includes(skill.slug) || lower.includes(slug) || lower.includes(name)) {
        score += 1;
      } else {
        continue;
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { skill, score };
    }
  }

  if (best) {
    return {
      skillSlug: best.skill.slug,
      skill: best.skill,
      fallbackToExplain: false,
    };
  }

  return { fallbackToExplain: true };
}
