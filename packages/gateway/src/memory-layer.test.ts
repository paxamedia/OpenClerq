import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  listMemory,
  getMemory,
  setMemory,
  deleteMemory,
  clearMemory,
  searchMemory,
} from './memory-layer.js';
import { initStore, closeStore } from './store.js';

beforeAll(async () => {
  // ':memory:' also skips the legacy JSON import, so tests never read or
  // archive the developer's real ~/.clerq files.
  await initStore(':memory:');
});

afterAll(() => {
  closeStore();
});

describe('memory-layer', () => {
  beforeEach(() => {
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
    expect(deleteMemory('x')).toBe(true);
    expect(getMemory('x')).toBeNull();
  });

  it('deleteMemory returns false for missing key', () => {
    expect(deleteMemory('nonexistent')).toBe(false);
  });

  it('clearMemory removes all entries', () => {
    setMemory('p', 1);
    setMemory('q', 2);
    expect(clearMemory()).toBe(2);
    expect(listMemory()).toEqual([]);
  });

  it('setMemory upserts rather than duplicating', () => {
    setMemory('k', 'first');
    setMemory('k', 'second');
    expect(listMemory()).toHaveLength(1);
    expect(getMemory('k')?.value).toBe('second');
  });

  it('preserves createdAt across an update but moves updatedAt', () => {
    setMemory('k', 1);
    const created = getMemory('k')?.createdAt;
    setMemory('k', 2);
    const after = getMemory('k');
    expect(after?.createdAt).toBe(created);
    expect(after?.updatedAt).toBeDefined();
  });

  it('round-trips values that are not objects', () => {
    setMemory('n', 42);
    setMemory('s', 'text');
    setMemory('b', true);
    setMemory('nul', null);
    expect(getMemory('n')?.value).toBe(42);
    expect(getMemory('s')?.value).toBe('text');
    expect(getMemory('b')?.value).toBe(true);
    expect(getMemory('nul')?.value).toBeNull();
  });

  it('searchMemory matches on key and on value', () => {
    setMemory('invoice-2026', { note: 'quarterly filing' });
    setMemory('unrelated', { note: 'nothing here' });
    expect(searchMemory('invoice').map((e) => e.key)).toEqual(['invoice-2026']);
    expect(searchMemory('quarterly').map((e) => e.key)).toEqual(['invoice-2026']);
    expect(searchMemory('zzz')).toEqual([]);
  });

  it('writes do not clobber each other', () => {
    // The JSON store this replaces was read-modify-write with no locking, so
    // interleaved writers each lost the other's entries.
    for (let i = 0; i < 50; i++) setMemory(`k${i}`, i);
    expect(listMemory()).toHaveLength(50);
  });
});
