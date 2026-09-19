import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSkillsFromDir, loadSkillContentFrom } from './skills-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '__fixtures__', 'skills');

describe('skills-loader', () => {
  it('loadSkillsFromDir returns skills from fixture dir', async () => {
    const skills = await loadSkillsFromDir(fixturesDir);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const fixture = skills.find((s) => s.slug === 'fixture-skill');
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBe('Fixture Skill');
    expect(fixture?.triggers).toEqual(['test', 'fixture']);
  });

  it('parses single-quoted frontmatter as well as double-quoted', async () => {
    const skills = await loadSkillsFromDir(fixturesDir);
    const quoted = skills.find((s) => s.slug === 'quoted-skill');
    expect(quoted).toBeDefined();
    expect(quoted?.name).toBe('Single Quoted Skill');
    expect(quoted?.triggers).toEqual(['quoted', 'yaml']);
  });

  it('loadSkillsFromDir returns empty array for non-existent dir', async () => {
    const skills = await loadSkillsFromDir(path.join(__dirname, 'nonexistent-dir-xyz'));
    expect(skills).toEqual([]);
  });

  it('loads a skill body from the first directory that has the skill', async () => {
    const missing = path.join(__dirname, 'nonexistent-dir-xyz');
    const content = await loadSkillContentFrom([missing, fixturesDir], 'fixture-skill');
    expect(content?.meta.name).toBe('Fixture Skill');
    expect(content?.body).toContain('Answer in one sentence.');
    expect(content?.body).not.toContain('slug:');
    expect(await loadSkillContentFrom([fixturesDir], 'no-such-skill')).toBeNull();
  });
});
