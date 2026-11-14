import { describe, expect, it } from 'vitest';
import {
  canonicalNeeds,
  declaresNothing,
  declaredChecksumIn,
  describeSkillNeeds,
  diffSkillNeeds,
  hostProblem,
  nearestName,
  parseChecksum,
  readSkillNeeds,
  scopeProblem,
  withChecksumLine,
  withoutChecksumLine,
  type SkillNeeds,
} from './skill.js';

const HEX = 'a'.repeat(64);

describe('the checksum line', () => {
  const file = `---\nname: 'X'\nchecksum: sha256:${HEX}\ntriggers: ['a']\n---\n\nBody.\n`;

  it('is taken out whole, and nothing else changes', () => {
    expect(withoutChecksumLine(file)).toBe(`---\nname: 'X'\ntriggers: ['a']\n---\n\nBody.\n`);
  });

  it('is taken out when it is the last line of the frontmatter', () => {
    const last = `---\nname: X\nchecksum: sha256:${HEX}\n---\nBody\n`;
    expect(withoutChecksumLine(last)).toBe('---\nname: X\n---\nBody\n');
  });

  it('is taken out of CRLF text with its line ending', () => {
    const crlf = `---\r\nname: X\r\nchecksum: sha256:${HEX}\r\n---\r\nBody\r\n`;
    expect(withoutChecksumLine(crlf)).toBe('---\r\nname: X\r\n---\r\nBody\r\n');
  });

  it('leaves text that has no frontmatter, and indented or later `checksum:` lines, alone', () => {
    expect(withoutChecksumLine('checksum: sha256:x\n')).toBe('checksum: sha256:x\n');
    const nested = `---\nname: X\ndescription: |\n  checksum: sha256:${HEX}\n---\nchecksum: in the body\n`;
    expect(withoutChecksumLine(nested)).toBe(nested);
  });

  it('drops every top-level checksum line, malformed or repeated', () => {
    const odd = `---\nchecksum: nope\nname: X\nchecksum:   \n---\n`;
    expect(withoutChecksumLine(odd)).toBe('---\nname: X\n---\n');
  });

  it('writing a line and taking it out again gives the original, with the line in either state', () => {
    const plain = `---\nname: X\n---\n\nBody\n`;
    const written = withChecksumLine(plain, `sha256:${HEX}`) as string;
    expect(written).toBe(`---\nname: X\nchecksum: sha256:${HEX}\n---\n\nBody\n`);
    expect(withoutChecksumLine(written)).toBe(plain);
    // Writing over a line that is there replaces it.
    const again = withChecksumLine(written, `sha256:${'b'.repeat(64)}`) as string;
    expect(again.match(/checksum:/g)).toHaveLength(1);
    expect(withoutChecksumLine(again)).toBe(plain);
  });

  it('writes with the file’s own line endings, and refuses text with no frontmatter', () => {
    expect(withChecksumLine('---\r\nname: X\r\n---\r\nB', 'sha256:x')).toBe(
      '---\r\nname: X\r\nchecksum: sha256:x\r\n---\r\nB'
    );
    expect(withChecksumLine('# no frontmatter', 'sha256:x')).toBeNull();
  });

  it('agrees with the frontmatter reader about where the block ends', () => {
    // The closing `---` is the first `\n---` after the opening, even when the first line of the
    // block itself starts with dashes.
    const tricky = `---\n---x\nchecksum: sha256:${HEX}\n---\nBody\n`;
    expect(withoutChecksumLine(tricky)).toBe('---\n---x\n---\nBody\n');
  });

  it('finds the checksum a file declares, the last one when there are two', () => {
    expect(declaredChecksumIn(file)).toBe(`sha256:${HEX}`);
    expect(declaredChecksumIn(`---\nchecksum: "sha256:${HEX.toUpperCase()}"\n---\nB`)).toBe(
      `sha256:${HEX}`
    );
    const two = `---\nchecksum: sha256:${'1'.repeat(64)}\nchecksum: sha256:${HEX}\n---\n`;
    expect(declaredChecksumIn(two)).toBe(`sha256:${HEX}`);
    expect(declaredChecksumIn('---\nchecksum: nope\n---\n')).toBeNull();
    expect(declaredChecksumIn('---\nname: X\n---\n')).toBeNull();
    expect(declaredChecksumIn(`checksum: sha256:${HEX}`)).toBeNull();
    expect(declaredChecksumIn(`---\ndescription: |\n  checksum: sha256:${HEX}\n---\n`)).toBeNull();
  });

  it('reads a declared value in one form only, lower-cased', () => {
    expect(parseChecksum(`sha256:${HEX.toUpperCase()}`)).toBe(`sha256:${HEX}`);
    expect(parseChecksum(` sha256:${HEX} `)).toBe(`sha256:${HEX}`);
    expect(parseChecksum('sha256:abc')).toBeNull();
    expect(parseChecksum(HEX)).toBeNull();
    expect(parseChecksum(42)).toBeNull();
  });
});

describe('hosts and paths a skill may declare', () => {
  it.each(['api.example.com', '*.example.com', 'localhost', '127.0.0.1', 'a-b.c_d.example'])(
    'accepts the host %s',
    (h) => expect(hostProblem(h)).toBeNull()
  );

  it.each([
    ['https://api.example.com', 'URL'],
    ['api.example.com/v1', 'path'],
    ['api.example.com:443', 'port'],
    ['user@example.com', 'user'],
    ['*', 'only "*."'],
    ['*.*.example.com', 'only "*."'],
    ['exa*mple.com', 'only "*."'],
    ['has space.com', 'space'],
    ['', 'empty'],
  ])('refuses the host %j', (h, why) => expect(hostProblem(h)).toContain(why));

  it.each(['src/**', 'docs/', 'README.md', '~', '~/Notes', './src', 'a/b c/d'])(
    'accepts the path %s',
    (p) => expect(scopeProblem(p)).toBeNull()
  );

  it.each([
    ['/', 'whole'],
    ['/etc/passwd', 'absolute'],
    ['C:\\Users', 'backslash'],
    ['C:/Users', 'absolute'],
    ['../up', '..'],
    ['a/../../b', '..'],
    ['~root/x', 'another user'],
    ['~/', 'whole'],
    ['a\\b', 'backslash'],
    ['a\0b', 'NUL'],
    ['', 'empty'],
  ])('refuses the path %j', (p, why) => expect(scopeProblem(p)).toContain(why));
});

describe('reading the declarations', () => {
  it('reads nothing from a file that declares nothing', () => {
    const r = readSkillNeeds({ name: 'X', slug: 'x', triggers: ['a'] });
    expect(r.needs).toEqual({ tools: [], domains: [], paths: [] });
    expect(r.warnings).toEqual([]);
    expect(declaresNothing(r.needs)).toBe(true);
  });

  it('reads each key, tidies it and drops repeats', () => {
    const r = readSkillNeeds({
      tools_required: ['fs.read', ' group:fs ', 'fs.read'],
      network_domains: ['API.Example.com', '*.example.org', 'api.example.com'],
      filesystem_scope: ['./src/**', 'docs/', '~/Notes', 'src/**'],
    });
    expect(r.needs).toEqual({
      tools: ['fs.read', 'group:fs'],
      domains: ['api.example.com', '*.example.org'],
      paths: ['src/**', 'docs/', '~/Notes'],
    });
    expect(r.warnings).toEqual([]);
  });

  it('asks the tool check about each tool, and keeps a name it does not know', () => {
    const r = readSkillNeeds({ tools_required: ['fs.read', 'shell.exec'] }, (t) =>
      t === 'shell.exec' ? 'is not a tool. Did you mean runtime.shell?' : null
    );
    expect(r.needs.tools).toEqual(['fs.read', 'shell.exec']);
    expect(r.warnings).toEqual([
      'tools_required: "shell.exec" is not a tool. Did you mean runtime.shell?',
    ]);
  });

  it('drops hosts and paths it cannot understand, and says so', () => {
    const r = readSkillNeeds({
      network_domains: ['https://a.example.com/x', 'ok.example.com'],
      filesystem_scope: ['/', '../x', 'ok/**', '/etc'],
    });
    expect(r.needs.domains).toEqual(['ok.example.com']);
    expect(r.needs.paths).toEqual(['ok/**']);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings[0]).toContain('network_domains: "https://a.example.com/x" is a URL');
    expect(r.warnings.join('\n')).toContain('filesystem_scope: "/" is the whole file system');
  });

  it('reads a bare string as one entry and a non-list as nothing, with a warning each', () => {
    const one = readSkillNeeds({ tools_required: 'fs.read' });
    expect(one.needs.tools).toEqual(['fs.read']);
    expect(one.warnings[0]).toContain('should be a list');
    const nope = readSkillNeeds({ network_domains: { a: 1 }, filesystem_scope: 7 });
    expect(nope.needs).toEqual({ tools: [], domains: [], paths: [] });
    expect(nope.warnings).toHaveLength(2);
  });

  it('counts entries that are not text, and an empty string as nothing declared', () => {
    const r = readSkillNeeds({ tools_required: ['fs.read', 3, null, ''], network_domains: '' });
    expect(r.needs).toEqual({ tools: ['fs.read'], domains: [], paths: [] });
    expect(r.warnings).toEqual(['tools_required has 3 entries that are not text; ignored.']);
  });

  it('warns about a checksum that is not in the form', () => {
    expect(readSkillNeeds({ checksum: 'abc' }).warnings[0]).toContain('checksum should look like');
    expect(readSkillNeeds({ checksum: `sha256:${HEX}` }).warnings).toEqual([]);
  });
});

describe('saying them in words', () => {
  const needs: SkillNeeds = {
    tools: ['fs.read', 'group:git'],
    domains: ['api.example.com'],
    paths: ['src/**'],
  };

  it('describes each declaration, and nothing for one left out', () => {
    const lines = describeSkillNeeds(needs);
    expect(lines.map((l) => l.key)).toEqual(['tools', 'domains', 'paths']);
    expect(lines[0]).toMatchObject({ label: 'Use tools', items: ['fs.read', 'group:git'] });
    expect(describeSkillNeeds({ tools: [], domains: ['a.example.com'], paths: [] })).toHaveLength(
      1
    );
    expect(describeSkillNeeds({ tools: [], domains: [], paths: [] })).toEqual([]);
  });

  it('says what a new version added and dropped', () => {
    const after: SkillNeeds = {
      tools: ['fs.read', 'runtime.shell'],
      domains: ['api.example.com', 'evil.example.net'],
      paths: [],
    };
    expect(diffSkillNeeds(needs, after).map((c) => c.text)).toEqual([
      'Now says it uses the tool runtime.shell',
      'No longer says it uses the tool group:git',
      'Now says it reaches evil.example.net',
      'No longer says it uses the path src/**',
    ]);
    expect(
      diffSkillNeeds(needs, canonicalNeeds({ ...needs, tools: [...needs.tools].reverse() }))
    ).toEqual([]);
  });
});

describe('suggesting a name', () => {
  const known = ['fs.read', 'fs.write', 'runtime.shell', 'git.push', 'memory.read.fact'];
  it('finds a near miss', () => {
    expect(nearestName('fs.reed', known)).toBe('fs.read');
    expect(nearestName('FS_READ', known)).toBe('fs.read');
    expect(nearestName('git.pus', known)).toBe('git.push');
  });
  it('does not guess when nothing is near', () => {
    expect(nearestName('browser.open', known)).toBeUndefined();
  });
});
