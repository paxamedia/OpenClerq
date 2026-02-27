import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listMemory, getMemory, setMemory, deleteMemory, clearMemory } from './memory-layer.js';

const TEST_HOME = path.join(os.tmpdir(), `clerq-memory-test-${Date.now()}`);

describe('memory-layer', () => {
  beforeEach(() => {
    process.env.HOME = TEST_HOME;
    if (process.platform === 'win32') process.env.USERPROFILE = TEST_HOME;
    clearMemory();
  });

  it('listMemory returns empty when no entries', () => {
    expect(listMemory()).toEqual([]);
  });

  it('setMemory and getMemory round-trip', () => {
    setMemory('foo', { bar: 42 });
    const entry = getMemory('foo');
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe('foo');
    expect(entry?.value).toEqual({ bar: 42 });
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('listMemory returns all entries', () => {
    setMemory('a', 1);
    setMemory('b', 'two');
    const entries = listMemory();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.key).sort()).toEqual(['a', 'b']);
  });

  it('deleteMemory removes entry and returns true', () => {
    setMemory('x', 1);
    expect(getMemory('x')).not.toBeNull();
    const ok = deleteMemory('x');
    expect(ok).toBe(true);
    expect(getMemory('x')).toBeNull();
  });

  it('deleteMemory returns false for missing key', () => {
    expect(deleteMemory('nonexistent')).toBe(false);
  });

  it('clearMemory removes all entries', () => {
    setMemory('p', 1);
    setMemory('q', 2);
    const count = clearMemory();
    expect(count).toBe(2);
    expect(listMemory()).toEqual([]);
  });
});
