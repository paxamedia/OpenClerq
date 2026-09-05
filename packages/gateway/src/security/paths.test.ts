import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinRoot, readTextFileWithin, PathContainmentError } from './paths.js';

let tmp: string;
let root: string;
let sibling: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-paths-'));
  // "repo" and "repo-secrets" share a prefix — this is the shape the old
  // startsWith() check admitted.
  root = path.join(tmp, 'repo');
  sibling = path.join(tmp, 'repo-secrets');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });

  fs.writeFileSync(path.join(root, 'ok.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'nested', 'deep.txt'), 'deep');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(5000));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveWithinRoot', () => {
  it('resolves a file inside the root', () => {
    expect(resolveWithinRoot(root, 'ok.txt')).toBe(fs.realpathSync.native(path.join(root, 'ok.txt')));
  });

  it('resolves a nested file', () => {
    expect(resolveWithinRoot(root, 'nested/deep.txt')).toContain('deep.txt');
  });

  it('rejects the prefix-sibling escape that startsWith() allowed', () => {
    // path.resolve(root, '../repo-secrets/secret.txt') === "<tmp>/repo-secrets/secret.txt",
    // which startsWith("<tmp>/repo") — the original bug. It must be refused.
    expect(() => resolveWithinRoot(root, '../repo-secrets/secret.txt')).toThrow(PathContainmentError);
  });

  it('rejects plain traversal', () => {
    expect(() => resolveWithinRoot(root, '../../etc/passwd')).toThrow(PathContainmentError);
    expect(() => resolveWithinRoot(root, 'nested/../../../etc/passwd')).toThrow(PathContainmentError);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(/Absolute paths/);
  });

  it('rejects NUL bytes', () => {
    expect(() => resolveWithinRoot(root, 'ok.txt\0.png')).toThrow(/NUL/);
  });

  it('rejects an empty path', () => {
    expect(() => resolveWithinRoot(root, '')).toThrow(PathContainmentError);
  });

  it('rejects drive-qualified and UNC paths', () => {
    expect(() => resolveWithinRoot(root, 'C:secret')).toThrow(PathContainmentError);
    expect(() => resolveWithinRoot(root, '\\\\server\\share')).toThrow(PathContainmentError);
  });

  it('rejects a symlink pointing outside the root', () => {
    const link = path.join(root, 'escape-link');
    if (!fs.existsSync(link)) fs.symlinkSync(sibling, link, 'dir');
    expect(() => resolveWithinRoot(root, 'escape-link/secret.txt')).toThrow(/symbolic link/);
  });

  it('allows a symlink that stays inside the root', () => {
    const link = path.join(root, 'inside-link');
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, 'nested'), link, 'dir');
    expect(resolveWithinRoot(root, 'inside-link/deep.txt')).toContain('deep.txt');
  });

  it('permits a not-yet-existing path whose parent is inside the root', () => {
    expect(resolveWithinRoot(root, 'nested/new-file.txt')).toContain('new-file.txt');
  });

  it('rejects a not-yet-existing path outside the root', () => {
    expect(() => resolveWithinRoot(root, '../repo-secrets/new-file.txt')).toThrow(PathContainmentError);
  });
});

describe('readTextFileWithin', () => {
  it('reads a file and reports its size', async () => {
    const out = await readTextFileWithin(root, 'ok.txt', 1024);
    expect(out.content).toBe('hello');
    expect(out.bytes).toBe(5);
  });

  it('refuses a file over the byte limit without reading it', async () => {
    await expect(readTextFileWithin(root, 'big.txt', 1000)).rejects.toThrow(/over the 1000-byte limit/);
  });

  it('refuses a directory', async () => {
    await expect(readTextFileWithin(root, 'nested', 1024)).rejects.toThrow(/not a regular file/);
  });

  it('refuses to read through an escaping symlink', async () => {
    const link = path.join(root, 'escape-link');
    if (!fs.existsSync(link)) fs.symlinkSync(sibling, link, 'dir');
    await expect(readTextFileWithin(root, 'escape-link/secret.txt', 1024)).rejects.toThrow(PathContainmentError);
  });
});
