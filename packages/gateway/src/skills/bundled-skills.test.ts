import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillChecksum } from '@clerq/plugin-sdk/node';
import { BUNDLED_SKILLS } from './bundled-skills.js';

const repoSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../skills');

describe('the skills that ship with OpenClerq', () => {
  it('are the ones in the repository’s skills folder, each with its checksum', async () => {
    const shipped = fs
      .readdirSync(repoSkills, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(Object.keys(BUNDLED_SKILLS).sort()).toEqual(shipped);
    for (const name of shipped) {
      // Recomputed, so editing a bundled skill without updating the list fails here.
      expect(BUNDLED_SKILLS[name], name).toBe(await skillChecksum(path.join(repoSkills, name)));
    }
  });

  it('has the example skill, which declares nothing and so narrows nothing', async () => {
    expect(Object.keys(BUNDLED_SKILLS)).toEqual(['example']);
    const md = fs.readFileSync(path.join(repoSkills, 'example', 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^tools_required: \[\]$/m);
    expect(md).toMatch(/^network_domains: \[\]$/m);
    expect(md).toMatch(/^filesystem_scope: \[\]$/m);
  });
});
