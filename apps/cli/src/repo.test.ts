import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { targetOf } from './cmd/repo.js';

const cwd = path.resolve('/work/tree');
const home = path.resolve('/home/ana');

describe('targetOf', () => {
  it('passes a remote through as typed', () => {
    for (const t of [
      'github:acme/app',
      'gitlab:g/sub/app',
      'https://github.com/acme/app.git',
      'github:acme/app#dev',
    ]) {
      expect(targetOf(t, cwd, home, true)).toEqual({ target: t, local: false });
    }
  });

  it('leaves another kind of address for the gateway to explain', () => {
    for (const t of ['git@github.com:acme/app.git', 'ssh://git@github.com/acme/app', 'ftp://x/y']) {
      expect(targetOf(t, cwd, home, true)).toEqual({ target: t, local: false });
    }
  });

  it('makes a folder absolute from where the command is run, with or without local:', () => {
    expect(targetOf('.', cwd, home, true)).toEqual({ target: `local:${cwd}`, local: true });
    expect(targetOf('../other', cwd, home, true).target).toBe(
      `local:${path.resolve(cwd, '../other')}`
    );
    expect(targetOf('local:app', cwd, home, true).target).toBe(`local:${path.join(cwd, 'app')}`);
    expect(targetOf(path.resolve('/srv/app'), cwd, home, true).target).toBe(
      `local:${path.resolve('/srv/app')}`
    );
  });

  it('keeps a #branch after the folder', () => {
    expect(targetOf('app#develop', cwd, home, true).target).toBe(
      `local:${path.join(cwd, 'app')}#develop`
    );
  });

  it('expands ~ for a gateway on this computer and leaves it for a gateway elsewhere', () => {
    expect(targetOf('~/code/app', cwd, home, true).target).toBe(
      `local:${path.join(home, 'code', 'app')}`
    );
    expect(targetOf('~/code/app', cwd, home, false).target).toBe('local:~/code/app');
  });

  it('refuses nothing and nothing-but-a-prefix', () => {
    expect(() => targetOf('  ', cwd, home, true)).toThrow(/folder, or something like github/);
    expect(() => targetOf('local:', cwd, home, true)).toThrow(/needs a folder/);
  });
});
