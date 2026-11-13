import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssertionSyntaxError,
  diffFiles,
  evaluateAssertion,
  globToRegExp,
  parseAssertion,
  parseNumstat,
  type DiffFile,
} from './diff-assert.js';

function syntaxError(text: string): AssertionSyntaxError {
  try {
    parseAssertion(text);
  } catch (e) {
    if (e instanceof AssertionSyntaxError) return e;
    throw e;
  }
  throw new Error(`expected "${text}" to be refused`);
}

describe('parseAssertion', () => {
  it('reads comparisons with every operator', () => {
    expect(parseAssertion('diff.files_changed <= 5')).toEqual({
      kind: 'compare',
      metric: 'files_changed',
      op: '<=',
      value: 5,
    });
    for (const op of ['<', '>', '>=', '==', '!=']) {
      expect(parseAssertion(`diff.lines_added ${op} 100`)).toMatchObject({ op, value: 100 });
    }
    expect(parseAssertion('  diff.lines_removed<0  ')).toMatchObject({
      metric: 'lines_removed',
      op: '<',
      value: 0,
    });
  });

  it('reads glob lists, bare or quoted', () => {
    expect(parseAssertion('diff.touches_none_of [src/**, .github/**]')).toEqual({
      kind: 'touches_none_of',
      globs: ['src/**', '.github/**'],
    });
    expect(parseAssertion(`diff.touches_only ['docs/a, b.md', "x]y", lock.json]`)).toEqual({
      kind: 'touches_only',
      globs: ['docs/a, b.md', 'x]y', 'lock.json'],
    });
    expect(parseAssertion('diff.touches_only [pnpm-lock.yaml]')).toMatchObject({
      globs: ['pnpm-lock.yaml'],
    });
  });

  it('refuses anything else, pointing at where it went wrong', () => {
    const cases: Array<[string, RegExp, number]> = [
      ['pnpm test', /starts with diff/, 0],
      ['diff.files <= 1', /Unknown diff.files/, 5],
      ['diff.', /must be followed by one of/, 5],
      ['diff.files_changed 5', /must be compared/, 19],
      ['diff.files_changed => 5', /must be compared/, 19],
      ['diff.files_changed <= five', /needs a whole number/, 22],
      ['diff.files_changed <= -1', /needs a whole number/, 22],
      ['diff.files_changed <= 1.5', /Unexpected ".5"/, 23],
      ['diff.files_changed <= 1 and more', /Unexpected "and more"/, 24],
      ['diff.touches_only src/**', /list of globs in brackets/, 18],
      ['diff.touches_only []', /at least one glob/, 19],
      ['diff.touches_only [a b]', /Expected ","/, 21],
      ['diff.touches_only [a, b', /never closed with "\]"/, 23],
      ["diff.touches_only ['a]", /quote is never closed/, 19],
      ['diff.touches_only [a] extra', /Unexpected "extra"/, 22],
      ['diff.touches_only [../etc]', /leaves the repository/, 19],
      ["diff.touches_only ['']", /empty glob/, 19],
      ['diff.files_changed <= 1; rm -rf x', /Unexpected/, 23],
    ];
    for (const [text, message, offset] of cases) {
      const e = syntaxError(text);
      expect(e.message, text).toMatch(message);
      expect(e.offset, text).toBe(offset);
    }
  });
});

describe('globToRegExp', () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('matches from the repository root, one directory per *', () => {
    expect(matches('*.md', 'README.md')).toBe(true);
    expect(matches('*.md', 'docs/README.md')).toBe(false);
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(matches('a?.txt', 'ab.txt')).toBe(true);
    expect(matches('a?.txt', 'a/.txt')).toBe(false);
  });

  it('takes ** as any number of whole directories, and a trailing / as everything under it', () => {
    expect(matches('src/**', 'src/a.ts')).toBe(true);
    expect(matches('src/**', 'src/deep/er/a.ts')).toBe(true);
    expect(matches('src/**', 'srcs/a.ts')).toBe(false);
    expect(matches('**/*.md', 'README.md')).toBe(true);
    expect(matches('**/*.md', 'docs/guide/x.md')).toBe(true);
    expect(matches('docs/**/x.md', 'docs/x.md')).toBe(true);
    expect(matches('docs/**/x.md', 'docs/a/b/x.md')).toBe(true);
    expect(matches('.github/', '.github/workflows/ci.yml')).toBe(true);
    expect(matches('./src/**', 'src/a.ts')).toBe(true);
    expect(matches('/src/**', 'src/a.ts')).toBe(true);
  });

  it('takes every other character literally', () => {
    expect(matches('a.b', 'aXb')).toBe(false);
    expect(matches('(x)+[y]', '(x)+[y]')).toBe(true);
    expect(matches('a$', 'a$')).toBe(true);
  });
});

describe('evaluateAssertion', () => {
  const files: DiffFile[] = [
    { path: 'src/a.ts', added: 10, removed: 2 },
    { path: 'docs/new.md', oldPath: 'docs/old.md', added: 1, removed: 1 },
    { path: 'logo.png', added: null, removed: null },
  ];

  it('measures files and lines, with binary files counting no lines', () => {
    expect(evaluateAssertion(parseAssertion('diff.files_changed <= 3'), files)).toMatchObject({
      passed: true,
      actual: 3,
    });
    const r = evaluateAssertion(parseAssertion('diff.lines_added < 11'), files);
    expect(r).toMatchObject({ passed: false, actual: 11 });
    expect(r.detail).toBe('diff.lines_added is 11, not < 11.');
    expect(evaluateAssertion(parseAssertion('diff.lines_removed == 3'), files).passed).toBe(true);
  });

  it('counts both paths of a rename as touched', () => {
    const none = evaluateAssertion(parseAssertion('diff.touches_none_of [docs/old.md]'), files);
    expect(none).toMatchObject({ passed: false, offending: ['docs/old.md'] });
    const only = evaluateAssertion(
      parseAssertion('diff.touches_only [src/**, docs/new.md]'),
      files
    );
    expect(only).toMatchObject({ passed: false, offending: ['docs/old.md', 'logo.png'] });
    expect(only.detail).toMatch(/2 touched paths are outside/);
    expect(
      evaluateAssertion(parseAssertion('diff.touches_only [src/, docs/, *.png]'), files).passed
    ).toBe(true);
  });

  it('passes an empty diff for every set rule', () => {
    expect(evaluateAssertion(parseAssertion('diff.touches_only [x]'), []).passed).toBe(true);
    expect(evaluateAssertion(parseAssertion('diff.touches_none_of [**]'), []).passed).toBe(true);
  });
});

describe('parseNumstat', () => {
  it('reads git diff --numstat -z, renames and binary files included', () => {
    const out = [
      '3\t1\tsrc/a.ts',
      '0\t0\t',
      'old name.md',
      'new\tname.md',
      '-\t-\timg.png',
      '',
    ].join('\0');
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'new\tname.md', oldPath: 'old name.md', added: 0, removed: 0 },
      { path: 'img.png', added: null, removed: null },
    ]);
    expect(parseNumstat('')).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('diffFiles', () => {
  it('reads a real repository, with spaces, newlines and renames in paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-diff-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      }).trim();
    try {
      git('init', '-q', '-b', 'main');
      const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'docs', 'old name.md'), body);
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');

      git('mv', 'docs/old name.md', 'docs/new name.md');
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'a\nb\nc\n');
      fs.writeFileSync(path.join(dir, 'odd\nname\twith tab.txt'), 'x\n');
      fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0, 1, 2, 0, 255, 0]));
      git('add', '.');
      git('commit', '-q', '-m', 'change');

      const files = await diffFiles(dir, base);
      const byPath = new Map(files.map((f) => [f.path, f]));
      expect(files).toHaveLength(4);
      expect(byPath.get('docs/new name.md')).toEqual({
        path: 'docs/new name.md',
        oldPath: 'docs/old name.md',
        added: 0,
        removed: 0,
      });
      expect(byPath.get('keep.txt')).toMatchObject({ added: 2, removed: 0 });
      expect(byPath.get('odd\nname\twith tab.txt')).toMatchObject({ added: 1, removed: 0 });
      expect(byPath.get('logo.png')).toMatchObject({ added: null, removed: null });

      expect(evaluateAssertion(parseAssertion('diff.files_changed == 4'), files).passed).toBe(true);
      expect(
        evaluateAssertion(parseAssertion("diff.touches_none_of ['docs/old name.md']"), files)
      ).toMatchObject({ passed: false, offending: ['docs/old name.md'] });
      expect(
        evaluateAssertion(parseAssertion('diff.touches_only [docs/, keep.txt, *.png, odd*]'), files)
          .passed
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
