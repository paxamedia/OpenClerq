import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  findSkillDir,
  listSkillDirs,
  loadSkillContent,
  loadSkillContentFrom,
  loadSkillsFromDir,
  parseFrontmatter,
  parseSkillMd,
  saveSkillFrontmatter,
} from './skills-loader.js';

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

const md = (front: string[], body = 'Body.') => ['---', ...front, '---', '', body, ''].join('\n');

describe('the frontmatter of files that load today still reads as it did', () => {
  it('reads quoting, JSON lists and objects the way it always did', () => {
    const fm = parseFrontmatter(
      md([
        "name: 'Single Quoted'",
        'slug: "double-quoted"',
        'version: 2026.10',
        "triggers: ['a', 'b']",
        'dependsOn: ["x", "y"]',
        'inputSchema: {"type":"object","required":["a"]}',
        'description: Plain text: with a colon # and a hash',
      ])
    );
    expect(fm).toMatchObject({
      name: 'Single Quoted',
      slug: 'double-quoted',
      version: '2026.10',
      triggers: ['a', 'b'],
      dependsOn: ['x', 'y'],
      inputSchema: { type: 'object', required: ['a'] },
      description: 'Plain text: with a colon # and a hash',
    });
  });

  it('keeps reading a list of bare words under another key as text, as it always did', () => {
    // A YAML parser would make this a list and start routing by it; here it stays what it was.
    const fm = parseFrontmatter(md(['triggers: [alpha, beta]', 'dependsOn: [x]']));
    expect(fm?.triggers).toBe('[alpha, beta]');
    expect(fm?.dependsOn).toBe('[x]');
    expect(parseSkillMd(md(['triggers: [alpha, beta]']), 'dir')?.meta.triggers).toBeUndefined();
  });

  it('takes the folder name for a slug and a name the file does not give, and reads CRLF', () => {
    const parsed = parseSkillMd(md(['description: d']).replace(/\n/g, '\r\n'), 'folder-name');
    expect(parsed?.meta).toMatchObject({
      slug: 'folder-name',
      name: 'folder-name',
      description: 'd',
    });
    expect(parsed?.body).toBe('Body.');
  });

  it('takes a slug, name or version that came out as a list or an object for no value', () => {
    const parsed = parseSkillMd(
      md(['slug: ["a", "b"]', 'name: {"x": 1}', 'version: ["1"]', 'description: ["d"]']),
      'folder'
    );
    expect(parsed?.meta).toMatchObject({ slug: 'folder', name: 'folder' });
    expect(parsed?.meta.version).toBeUndefined();
    expect(parsed?.meta.description).toBeUndefined();
    // An empty slug is the folder's name too.
    expect(parseSkillMd(md(["slug: ''"]), 'folder')?.meta.slug).toBe('folder');
  });

  it('is not a skill without frontmatter, and a file with none of the new keys declares nothing', () => {
    expect(parseSkillMd('# Just text', 'x')).toBeNull();
    const parsed = parseSkillMd(md(["name: 'Old'"]), 'old');
    expect(parsed?.meta.needs).toEqual({ tools: [], domains: [], paths: [] });
    expect(parsed?.meta.warnings).toBeUndefined();
    expect(parsed?.meta.checksum).toBeUndefined();
  });

  it('reads the fixture skills as before, with nothing declared', async () => {
    const skills = await loadSkillsFromDir(fixturesDir);
    for (const s of skills) {
      expect(s.needs).toEqual({ tools: [], domains: [], paths: [] });
      expect(s.warnings).toBeUndefined();
    }
  });
});

describe('the manifest keys', () => {
  it('reads a list written with plain words, with quotes, and with commas in quotes', () => {
    const parsed = parseSkillMd(
      md([
        'tools_required: [fs.read, group:git, "fs.search"]',
        "network_domains: ['api.example.com', *.example.org]",
        'filesystem_scope: ["src/**", \'docs/, notes\', ~/Notes]',
      ]),
      'x'
    );
    expect(parsed?.meta.needs).toEqual({
      tools: ['fs.read', 'group:git', 'fs.search'],
      domains: ['api.example.com', '*.example.org'],
      paths: ['src/**', 'docs/, notes', '~/Notes'],
    });
    expect(parsed?.meta.warnings).toBeUndefined();
  });

  it('reads a list written as lines, quoted or not, and an empty list as nothing', () => {
    const parsed = parseSkillMd(
      md([
        'tools_required:',
        '  - fs.read',
        '  - "group:git"',
        '  -   runtime.shell  ',
        'network_domains:',
        '  - api.example.com',
        'filesystem_scope: []',
        'name: After',
      ]),
      'x'
    );
    expect(parsed?.meta.needs).toEqual({
      tools: ['fs.read', 'group:git', 'runtime.shell'],
      domains: ['api.example.com'],
      paths: [],
    });
    expect(parsed?.meta.name).toBe('After');
  });

  it('reads CRLF files, and tolerates a trailing comma and spaces in the brackets', () => {
    const text = md([
      'tools_required: [ fs.read , fs.list , ]',
      'network_domains:',
      '  - a.example.com',
    ]).replace(/\n/g, '\r\n');
    expect(parseSkillMd(text, 'x')?.meta.needs).toMatchObject({
      tools: ['fs.read', 'fs.list'],
      domains: ['a.example.com'],
    });
  });

  it('warns about what it cannot read, and still reads the rest', () => {
    const parsed = parseSkillMd(
      md([
        'tools_required: fs.read',
        'network_domains: {"a": 1}',
        'filesystem_scope:',
        'checksum: sha256:short',
      ]),
      'x'
    );
    expect(parsed?.meta.needs).toEqual({ tools: ['fs.read'], domains: [], paths: [] });
    expect(parsed?.meta.warnings).toEqual([
      'tools_required should be a list, like tools_required: [fs.read]. It was read as one entry.',
      'network_domains should be a list; it was ignored.',
      'checksum should look like sha256: followed by 64 hexadecimal digits; it was ignored.',
    ]);
  });

  it('reads the author’s checksum in lower case and drops a malformed one', () => {
    const hex = 'AB'.repeat(32);
    expect(parseSkillMd(md([`checksum: sha256:${hex}`]), 'x')?.meta.checksum).toBe(
      `sha256:${hex.toLowerCase()}`
    );
    expect(parseSkillMd(md(['checksum: md5:abc']), 'x')?.meta.checksum).toBeUndefined();
  });

  it('is in what loadSkillContent returns, with the body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-skill-load-'));
    try {
      fs.mkdirSync(path.join(dir, 'demo'));
      fs.writeFileSync(
        path.join(dir, 'demo', 'SKILL.md'),
        md(["slug: 'demo'", 'tools_required: [fs.read]'], 'Do it.')
      );
      const loaded = await loadSkillContent(dir, 'demo');
      expect(loaded?.body).toBe('Do it.');
      expect(loaded?.meta.needs?.tools).toEqual(['fs.read']);
      expect(await findSkillDir(dir, 'demo')).toBe('demo');
      expect((await listSkillDirs(dir)).map((s) => s.dirName)).toEqual(['demo']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists folders by name, so equal matches do not depend on the file system', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-skill-order-'));
    try {
      for (const n of ['zeta', 'alpha', 'mid']) {
        fs.mkdirSync(path.join(dir, n));
        fs.writeFileSync(path.join(dir, n, 'SKILL.md'), md([`slug: ${n}`]));
      }
      expect((await listSkillDirs(dir)).map((s) => s.dirName)).toEqual(['alpha', 'mid', 'zeta']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('saving schemas and dependencies keeps the manifest', () => {
  it('keeps tools_required, network_domains, filesystem_scope, checksum and every other key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-skill-save-'));
    try {
      fs.mkdirSync(path.join(dir, 'demo'));
      const sum = `sha256:${'c'.repeat(64)}`;
      fs.writeFileSync(
        path.join(dir, 'demo', 'SKILL.md'),
        md(
          [
            "name: 'Demo'",
            "slug: 'demo'",
            'tools_required:',
            '  - fs.read',
            '  - "group:git"',
            'network_domains: [api.example.com]',
            'filesystem_scope: ["src/**"]',
            `checksum: ${sum}`,
            'jurisdiction: []',
            'moduleType: calc',
          ],
          'Do it.'
        )
      );
      expect(await saveSkillFrontmatter(dir, 'demo', { dependsOn: ['other'] })).toBe(true);
      const parsed = parseSkillMd(
        fs.readFileSync(path.join(dir, 'demo', 'SKILL.md'), 'utf8'),
        'demo'
      );
      expect(parsed?.meta.needs).toEqual({
        tools: ['fs.read', 'group:git'],
        domains: ['api.example.com'],
        paths: ['src/**'],
      });
      expect(parsed?.meta.checksum).toBe(sum);
      expect(parsed?.meta.dependsOn).toEqual(['other']);
      expect(parsed?.frontmatter).toMatchObject({
        jurisdiction: [],
        moduleType: 'calc',
        name: 'Demo',
      });
      expect(parsed?.body).toBe('Do it.');
      expect(await saveSkillFrontmatter(dir, 'nope', {})).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
