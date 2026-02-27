import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSkillsFromDir } from './skills-loader.js';

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

  it('loadSkillsFromDir returns empty array for non-existent dir', async () => {
    const skills = await loadSkillsFromDir(path.join(__dirname, 'nonexistent-dir-xyz'));
    expect(skills).toEqual([]);
  });
});
