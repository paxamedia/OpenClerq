/**
 * Memory on a SQLite without FTS5: the documented fallback. Writes and reads
 * work as ever, and search is by substring, in the same order every time.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('@clerq/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@clerq/store')>();
  // This SQLite has no FTS5: nothing is searchable by index, and nothing is indexed.
  return { ...real, memorySearchable: () => false };
});

import {
  addRecord,
  clearMemory,
  consolidate,
  deleteRecord,
  listMemory,
  searchRecords,
  updateRecord,
} from './memory-layer.js';
import { retrieveMemory } from './memory-context.js';
import { closeStore, initStore } from './store.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => {
  closeStore();
});

beforeEach(() => {
  clearMemory();
});

describe('memory without FTS5', () => {
  it('searches by substring, every word needed, newest first', async () => {
    addRecord({ key: 'a', value: 'quarterly filing for the shop' });
    await new Promise((resolve) => setTimeout(resolve, 3));
    addRecord({ key: 'b', value: 'quarterly review of the shop' });
    addRecord({ key: 'c', value: 'nothing' });
    const found = searchRecords('quarterly shop');
    expect(found.mode).toBe('substring');
    expect(found.hits.map((h) => h.key)).toEqual(['b', 'a']);
    // Words inside words, which an index of whole words would miss.
    expect(searchRecords('uarter').hits).toHaveLength(2);
    expect(searchRecords('quarterly filing').hits.map((h) => h.key)).toEqual(['a']);
    expect(searchRecords('').hits).toEqual([]);
  });

  it('keeps writing, editing, deleting and summarising', async () => {
    const r = addRecord({ key: 'k', value: 'alpha' });
    updateRecord(r.id, { value: 'beta' });
    expect(searchRecords('alpha').hits).toEqual([]);
    expect(searchRecords('beta').hits).toHaveLength(1);
    addRecord({ key: 'k', value: 'gamma' });
    const { record } = await consolidate({ key: 'k' }, async () => ({ text: 'beta and gamma' }));
    expect(searchRecords('gamma').hits.map((h) => h.id)).toEqual([record.id]);
    deleteRecord(record.id);
    expect(listMemory()).toEqual([]);
  });

  it('still retrieves for a prompt, under policy', () => {
    addRecord({ key: 'tone', value: 'short answers', type: 'preference' });
    addRecord({ key: 'vat', value: 'the quarterly vat filing is due on the 20th' });
    addRecord({
      key: 'how',
      value: 'file the quarterly vat return in the portal',
      type: 'procedure',
    });
    const got = retrieveMemory('When is the quarterly vat filing due?', {
      allow: ['memory.read.preference', 'memory.read.fact'],
    });
    expect(got.records.map((r) => r.key).sort()).toEqual(['tone', 'vat']);
  });
});
