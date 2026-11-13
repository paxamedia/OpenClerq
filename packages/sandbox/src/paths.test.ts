import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinRoot, PathContainmentError } from './paths.js';

const isWindows = process.platform === 'win32';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-paths-')));
  root = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe.skipIf(isWindows)('resolveWithinRoot and symbolic links', () => {
  it('refuses a dangling link whose target would be created outside the root', () => {
    fs.symlinkSync('../outside/pwned', path.join(root, 'link'));
    expect(() => resolveWithinRoot(root, 'link')).toThrow(PathContainmentError);
    expect(() => resolveWithinRoot(root, 'link')).toThrow(/symbolic link/);
  });

  it('refuses a path under a dangling directory link that leads out', () => {
    fs.symlinkSync('../outside/newdir', path.join(root, 'dir'));
    expect(() => resolveWithinRoot(root, 'dir/file.txt')).toThrow(/symbolic link/);
  });

  it('follows a chain of dangling links to where it ends', () => {
    fs.symlinkSync('b', path.join(root, 'a'));
    fs.symlinkSync('../outside/c', path.join(root, 'b'));
    expect(() => resolveWithinRoot(root, 'a')).toThrow(/symbolic link/);
  });

  it('allows a dangling link that stays inside the root', () => {
    fs.symlinkSync('later.txt', path.join(root, 'link'));
    expect(resolveWithinRoot(root, 'link')).toBe(path.join(root, 'later.txt'));
  });

  it('gives up on a link loop instead of spinning', () => {
    fs.symlinkSync('loop2', path.join(root, 'loop1'));
    fs.symlinkSync('loop1', path.join(root, 'loop2'));
    expect(() => resolveWithinRoot(root, 'loop1/x')).toThrow(PathContainmentError);
  });
});
