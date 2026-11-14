import { describe, it, expect } from 'vitest';
import { rankSkills, selectSkill } from './skill-selector.js';
import type { SkillMeta } from '../skills-loader.js';

const skills: SkillMeta[] = [
  { slug: 'r1-vat', name: 'Region1 VAT', triggers: ['vat', 'rate-standard', 'region1', 'r1'] },
  { slug: 'r2-vat', name: 'Region2 VAT', triggers: ['vat', 'region2', 'r2'] },
  { slug: 'r3-tax', name: 'Region3 Tax', triggers: ['vat', 'sales tax', 'region3', 'r3'] },
  { slug: 'r1-payroll', name: 'Region1 Payroll', triggers: ['payroll', 'wage', 'region1', 'r1'] },
];

describe('selectSkill', () => {
  it('returns r1-vat for VAT Region1 message', () => {
    const r = selectSkill('What is VAT for Region1?', skills);
    expect(r.fallbackToExplain).toBe(false);
    expect(r.skillSlug).toBe('r1-vat');
  });

  it('returns r1-vat for VAT calculation message', () => {
    const r = selectSkill('Calculate VAT on 100 units', skills);
    expect(r.fallbackToExplain).toBe(false);
    expect(r.skillSlug).toBe('r1-vat');
  });

  it('returns r2-vat for Region2-specific message', () => {
    const r = selectSkill('Region2 rules', skills);
    expect(r.skillSlug).toBe('r2-vat');
  });

  it('returns r1-payroll for payroll message', () => {
    const r = selectSkill('Payroll gross amount', skills);
    expect(r.skillSlug).toBe('r1-payroll');
  });

  it('falls back to explain when no match', () => {
    const r = selectSkill('What is the weather?', skills);
    expect(r.fallbackToExplain).toBe(true);
    expect(r.skillSlug).toBeUndefined();
  });

  it('returns fallback for empty message', () => {
    const r = selectSkill('', skills);
    expect(r.fallbackToExplain).toBe(true);
  });

  it('returns fallback for empty skills', () => {
    const r = selectSkill('VAT Region1', []);
    expect(r.fallbackToExplain).toBe(true);
  });
});

describe('rankSkills', () => {
  it('lists every match, best first, and in the order given among equals', () => {
    const list: SkillMeta[] = [
      { slug: 'plain', name: 'Plain' },
      { slug: 'a', name: 'A', triggers: ['report'] },
      { slug: 'b', name: 'B', triggers: ['report', 'plain'] },
      { slug: 'c', name: 'C', triggers: ['nothing'] },
    ];
    expect(rankSkills('the plain report', list).map((s) => s.slug)).toEqual(['a', 'b', 'plain']);
    expect(rankSkills('the report', list).map((s) => s.slug)).toEqual(['a', 'b']);
  });

  it('agrees with selectSkill on the first, and is empty when nothing matches or the message is', () => {
    for (const m of ['What is VAT for Region1?', 'Region2 rules', 'Payroll gross amount']) {
      expect(rankSkills(m, skills)[0]?.slug).toBe(selectSkill(m, skills).skillSlug);
    }
    expect(rankSkills('weather', skills)).toEqual([]);
    expect(rankSkills('   ', skills)).toEqual([]);
    expect(rankSkills('vat', [])).toEqual([]);
  });
});
