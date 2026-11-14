import { describe, expect, it } from 'vitest';
import { folderScope, pathInScope, scopePath, scopeReaches, scopeToRegExp } from './index.js';

describe('path scope', () => {
  it('reads the same globs the diff gates read', () => {
    expect(pathInScope(['src/**'], 'src/a.ts')).toBe(true);
    expect(pathInScope(['src/**'], 'src/deep/er/a.ts')).toBe(true);
    expect(pathInScope(['src/**'], 'srcs/a.ts')).toBe(false);
    expect(pathInScope(['src/**'], 'lib/src/a.ts')).toBe(false);
    expect(pathInScope(['*.md'], 'README.md')).toBe(true);
    expect(pathInScope(['*.md'], 'docs/README.md')).toBe(false);
    expect(pathInScope(['**/*.md'], 'docs/a/README.md')).toBe(true);
    expect(pathInScope(['**/*.md'], 'README.md')).toBe(true);
    expect(pathInScope(['src/?.ts'], 'src/a.ts')).toBe(true);
    expect(pathInScope(['src/?.ts'], 'src/ab.ts')).toBe(false);
    expect(pathInScope(['src/*.ts'], 'src/a/b.ts')).toBe(false);
  });

  it('takes a trailing slash or a bare name to be the folder and everything under it', () => {
    for (const entry of ['docs/', 'docs']) {
      expect(pathInScope([entry], 'docs/a.md'), entry).toBe(true);
      expect(pathInScope([entry], 'docs/x/y.md'), entry).toBe(true);
      expect(pathInScope([entry], 'docs2/a.md'), entry).toBe(false);
      expect(pathInScope([entry], 'other/docs/a.md'), entry).toBe(false);
    }
    expect(pathInScope(['docs'], 'docs')).toBe(true);
    expect(pathInScope(['README.md'], 'README.md')).toBe(true);
    expect(pathInScope(['README.md'], 'README.md.bak')).toBe(false);
  });

  it('takes `.` and `**` to be the whole folder, and nothing to be nothing', () => {
    expect(pathInScope(['.'], 'a/b.txt')).toBe(true);
    expect(pathInScope(['./'], 'a')).toBe(true);
    expect(pathInScope(['**'], 'a/b/c')).toBe(true);
    expect(pathInScope([], 'a')).toBe(false);
  });

  it('is of any entry, with `./` and backslashes tidied in the path', () => {
    expect(pathInScope(['docs/', 'src/**'], './src/a.ts')).toBe(true);
    expect(pathInScope(['docs/'], 'docs\\a.md')).toBe(true);
    expect(scopePath('./a//b/')).toBe('a/b');
    expect(scopePath('.')).toBe('');
  });

  it('never matches an entry that names the home folder', () => {
    expect(pathInScope(['~/Notes'], 'Notes/a.md')).toBe(false);
    expect(pathInScope(['~'], 'a')).toBe(false);
    expect(pathInScope(['~/Notes', 'src/'], 'src/a')).toBe(true);
    expect(folderScope(['~/Notes', ' src/ ', '~'])).toEqual(['src/']);
  });

  it('covers a name with a newline in it as any other', () => {
    expect(pathInScope(['src/**'], 'src/a\nb.ts')).toBe(true);
    expect(pathInScope(['src'], 'src/a\nb/c')).toBe(true);
    expect(pathInScope(['src'], 'src\n/x')).toBe(false);
    expect(pathInScope(['*.md'], 'a\nb.md')).toBe(true);
    expect(pathInScope(['*.md'], 'a/b\n.md')).toBe(false);
  });

  it('does not let regular-expression characters in a name mean anything', () => {
    expect(pathInScope(['a.b'], 'axb')).toBe(false);
    expect(pathInScope(['a.b'], 'a.b')).toBe(true);
    expect(pathInScope(['(x)+[y]$/**'], '(x)+[y]$/z')).toBe(true);
    expect(scopeToRegExp('a|b').test('a')).toBe(false);
  });

  it('knows which folders are on the way to something in scope', () => {
    const scope = ['src/app/**', 'docs/', '*.md'];
    for (const dir of ['', '.', 'src', 'src/app', 'src/app/deep', 'docs', 'docs/a']) {
      expect(scopeReaches(scope, dir), dir).toBe(true);
    }
    for (const dir of ['lib', 'src/other', 'node_modules/x']) {
      expect(scopeReaches(scope, dir), dir).toBe(false);
    }
    expect(scopeReaches(['~/Notes'], '')).toBe(false);
    expect(scopeReaches([], '')).toBe(false);
    // A wildcard in the middle: the folders before it are worth looking into.
    expect(scopeReaches(['packages/*/src/**'], 'packages')).toBe(true);
    expect(scopeReaches(['packages/*/src/**'], 'packages/a/src')).toBe(true);
    expect(scopeReaches(['packages/*/src/**'], 'apps')).toBe(false);
  });
});
