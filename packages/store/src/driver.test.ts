import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from './driver.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-driver-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('close()', () => {
  it('folds the write-ahead log into the database file, so the file alone is the database', async () => {
    const file = path.join(dir, 'a.db');
    const db = await openDatabase(file);
    db.exec('CREATE TABLE t (n INTEGER)');
    for (let n = 0; n < 50; n++) db.prepare('INSERT INTO t VALUES (?)').run(n);
    // Another connection that is still open keeps SQLite from doing this by
    // itself when the first one closes (and Bun's close never does, while a
    // statement is alive).
    const other = await openDatabase(file);
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

    db.close();
    expect(fs.statSync(`${file}-wal`).size).toBe(0);

    // A copy of the main file by itself has every row.
    const copy = path.join(dir, 'copy.db');
    fs.copyFileSync(file, copy);
    other.close();
    const restored = await openDatabase(copy);
    expect(restored.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 50 });
    restored.close();
  });

  it('is fine for an in-memory database', async () => {
    const db = await openDatabase(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    expect(() => db.close()).not.toThrow();
  });
});
