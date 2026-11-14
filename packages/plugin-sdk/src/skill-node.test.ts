import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSkillDir, SkillFilesError, skillChecksum, writeSkillChecksum } from './node.js';
import { parseChecksum } from './skill.js';

let dir = '';
const write = (rel: string, text: string | Buffer) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const SKILL = `---\nname: 'Demo'\nslug: 'demo'\ntools_required: [fs.read]\n---\n\nDo the thing.\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sum-'));
  write('SKILL.md', SKILL);
  write('templates/a.md', 'template a');
  write('rules/b.txt', 'rule b');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the checksum of a skill', () => {
  it('is sha256: and 64 hex digits, and is the same twice', async () => {
    const a = await skillChecksum(dir);
    expect(parseChecksum(a)).toBe(a);
    expect(await skillChecksum(dir)).toBe(a);
  });

  it('does not depend on the order files were written in', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sum-order-'));
    try {
      for (const [rel, text] of [
        ['rules/b.txt', 'rule b'],
        ['templates/a.md', 'template a'],
        ['SKILL.md', SKILL],
      ] as const) {
        fs.mkdirSync(path.dirname(path.join(other, rel)), { recursive: true });
        fs.writeFileSync(path.join(other, rel), text);
      }
      expect(await skillChecksum(other)).toBe(await skillChecksum(dir));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('changes with one byte of SKILL.md, of another file, a new file, a removed file or a rename', async () => {
    const base = await skillChecksum(dir);
    const seen = new Set([base]);
    const check = async (label: string) => {
      const now = await skillChecksum(dir);
      expect(seen.has(now), label).toBe(false);
      seen.add(now);
    };
    write('SKILL.md', SKILL.replace('thing', 'thinG'));
    await check('one byte of SKILL.md');
    write('SKILL.md', SKILL);
    expect(await skillChecksum(dir)).toBe(base);
    write('templates/a.md', 'template b');
    await check('one byte of a template');
    write('templates/a.md', 'template a');
    write('extra.txt', '');
    await check('an empty new file');
    fs.rmSync(path.join(dir, 'extra.txt'));
    fs.renameSync(path.join(dir, 'rules/b.txt'), path.join(dir, 'rules/c.txt'));
    await check('a renamed file');
    fs.renameSync(path.join(dir, 'rules/c.txt'), path.join(dir, 'rules/b.txt'));
    fs.rmSync(path.join(dir, 'rules/b.txt'));
    await check('a removed file');
  });

  it('leaves the checksum line out, and only that line', async () => {
    const base = await skillChecksum(dir);
    write('SKILL.md', SKILL.replace('slug: ', `checksum: sha256:${'f'.repeat(64)}\nslug: `));
    expect(await skillChecksum(dir)).toBe(base);
    write('SKILL.md', SKILL.replace('slug: ', `checksum: sha256:${'0'.repeat(64)}\nslug: `));
    expect(await skillChecksum(dir)).toBe(base);
    // A checksum-looking line in the body is the body.
    write('SKILL.md', `${SKILL}checksum: sha256:${'f'.repeat(64)}\n`);
    expect(await skillChecksum(dir)).not.toBe(base);
  });

  it('leaves out the files the operating system and git add on their own', async () => {
    const base = await skillChecksum(dir);
    write('.DS_Store', 'x');
    write('templates/.DS_Store', 'x');
    write('._SKILL.md', 'x');
    write('.git/config', 'x');
    write('.git/objects/ab/cd', 'x');
    expect(await skillChecksum(dir)).toBe(base);
  });

  it('refuses a link inside the folder, to a file or to a folder, and says which', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
      await expect(skillChecksum(dir)).rejects.toThrow(/"link\.txt" is a link/);
      fs.rmSync(path.join(dir, 'link.txt'));
      fs.symlinkSync(outside, path.join(dir, 'templates/linked'));
      await expect(readSkillDir(dir)).rejects.toThrow(/"templates\/linked" is a link/);
      fs.rmSync(path.join(dir, 'templates/linked'));
      // SKILL.md itself.
      fs.rmSync(path.join(dir, 'SKILL.md'));
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'SKILL.md'));
      await expect(readSkillDir(dir)).rejects.toThrow(/"SKILL\.md" is a link/);
      await expect(readSkillDir(dir)).rejects.toBeInstanceOf(SkillFilesError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('may be given a path that is itself a link to the folder, as a command line is', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hold-'));
    try {
      const link = path.join(holder, 'linked-skill');
      fs.symlinkSync(dir, link);
      expect(await skillChecksum(link)).toBe(await skillChecksum(dir));
    } finally {
      fs.rmSync(holder, { recursive: true, force: true });
    }
  });

  it('refuses something that is not a folder, and names with control characters', async () => {
    await expect(skillChecksum(path.join(dir, 'SKILL.md'))).rejects.toThrow(/is not a folder/);
    await expect(skillChecksum(path.join(dir, 'missing'))).rejects.toThrow(/is not a folder/);
    if (process.platform !== 'win32') {
      write('bad\nname.txt', 'x');
      await expect(skillChecksum(dir)).rejects.toThrow(/control character/);
    }
  });

  it('hands back the SKILL.md it read, byte for byte, with the files it hashed', async () => {
    const read = await readSkillDir(dir);
    expect(read.skillMd?.toString('utf8')).toBe(SKILL);
    expect(read.files.map((f) => f.path)).toEqual(['SKILL.md', 'rules/b.txt', 'templates/a.md']);
    expect(read.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it('is of a folder with no SKILL.md too, and says there is none', async () => {
    fs.rmSync(path.join(dir, 'SKILL.md'));
    const read = await readSkillDir(dir);
    expect(read.skillMd).toBeNull();
    await expect(writeSkillChecksum(dir)).rejects.toThrow(/no SKILL\.md/);
  });

  it('keeps binary files and non-UTF-8 text exactly', async () => {
    const odd = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a]);
    write('data.bin', odd);
    const a = await skillChecksum(dir);
    write('data.bin', Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x0d, 0x0a]));
    expect(await skillChecksum(dir)).not.toBe(a);
  });

  it('counts line endings: a file with CRLF is not the file with LF', async () => {
    const a = await skillChecksum(dir);
    write('templates/a.md', 'template a\r\n');
    const b = await skillChecksum(dir);
    write('templates/a.md', 'template a\n');
    expect(new Set([a, b, await skillChecksum(dir)]).size).toBe(3);
  });
});

describe('writing the checksum into SKILL.md', () => {
  it('puts the line in the frontmatter without changing the value, and again is no change', async () => {
    const before = await skillChecksum(dir);
    expect(await writeSkillChecksum(dir)).toBe(before);
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(text).toBe(SKILL.replace('---\n\nDo', `checksum: ${before}\n---\n\nDo`));
    expect(await skillChecksum(dir)).toBe(before);
    expect(await writeSkillChecksum(dir)).toBe(before);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(text);
  });

  it('replaces a wrong line', async () => {
    write('SKILL.md', SKILL.replace('slug: ', `checksum: sha256:${'1'.repeat(64)}\nslug: `));
    const sum = await writeSkillChecksum(dir);
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(text.match(/^checksum:/gm)).toHaveLength(1);
    expect(text).toContain(`checksum: ${sum}`);
  });

  it('keeps the bytes of a file that is not UTF-8 and the line endings of one that is CRLF', async () => {
    const raw = Buffer.concat([
      Buffer.from('---\r\nname: X\r\n---\r\nBody '),
      Buffer.from([0xe9, 0xff]),
      Buffer.from('\r\n'),
    ]);
    write('SKILL.md', raw);
    const sum = await writeSkillChecksum(dir);
    const out = fs.readFileSync(path.join(dir, 'SKILL.md'));
    expect(out.toString('latin1')).toBe(
      `---\r\nname: X\r\nchecksum: ${sum}\r\n---\r\nBody \xe9\xff\r\n`
    );
    expect(await skillChecksum(dir)).toBe(sum);
  });

  it('refuses a SKILL.md with no frontmatter, and writes nothing', async () => {
    write('SKILL.md', '# Just text\n');
    await expect(writeSkillChecksum(dir)).rejects.toThrow(/no frontmatter/);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe('# Just text\n');
  });
});
