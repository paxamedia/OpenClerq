import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStore, closeStore } from '../store.js';
import { listRuns } from '../runs.js';
import { ModuleTriggers, TriggerError } from './triggers.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => closeStore());

describe('module triggers', () => {
  it('refuses a bad definition', () => {
    const t = new ModuleTriggers();
    const handler = () => undefined;
    expect(() => t.register('m', { id: 'Bad Id', kind: 'webhook', handler })).toThrow(TriggerError);
    expect(() => t.register('m', { id: 'c', kind: 'cron', schedule: 'nope', handler })).toThrow(
      /valid cron/
    );
    expect(() => t.register('m', { id: 'f', kind: 'file', handler })).toThrow(/path/);
    t.register('m', { id: 'w', kind: 'webhook', handler });
    expect(() => t.register('m', { id: 'w', kind: 'webhook', handler })).toThrow(/already/);
  });

  it('fires a file trigger as a run once the file goes quiet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-modtrig-'));
    const file = path.join(dir, 'watched.txt');
    fs.writeFileSync(file, 'a');
    const seen: Array<string | undefined> = [];
    const t = new ModuleTriggers();
    t.register('watcher', {
      id: 'on-change',
      kind: 'file',
      path: file,
      handler: (e) => {
        seen.push(e.path);
      },
    });
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the watcher settle
      fs.writeFileSync(file, 'b');
      fs.writeFileSync(file, 'c');
      for (let i = 0; i < 60 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual([file]);
      const run = listRuns(10).find((r) => r.moduleId === 'watcher');
      expect(run).toMatchObject({ trigger: 'event', triggerId: 'on-change' });
    } finally {
      t.pause();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
