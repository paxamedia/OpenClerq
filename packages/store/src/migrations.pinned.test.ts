/**
 * Core migrations are append-only, and this test is what keeps them so.
 *
 * Each migration runs once, on each database, and is then recorded as done.
 * A database that already ran the old text never sees an edit to it, so an
 * edited migration leaves old databases and new ones with different tables.
 * Fix a mistake in a migration that has shipped with a new migration.
 *
 * Every migration is pinned here by a SHA-256 of its id, name and SQL. A new migration is added to
 * this list in the same commit that adds it; the failure message prints the line to add. (The list
 * has no names: a line that pairs a hash with a word such as "tokens" is taken by secret scanners
 * for a credential.)
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, type Migration } from './index.js';

const sha = (m: Migration) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([m.id, m.name, m.sql]))
    .digest('hex');

const PINNED: Array<[id: number, sha256: string]> = [
  [1, '0ddb7a8499e97b1821042c86d7ed637e850bcd7c31c524d71c06729d4acc4705'],
  [2, '8647d04d9bb7e1d9a6bca42caff2dac0c39805d8711c642191560d3647a940b1'],
  [3, '529776df699bd69b1d4c951446b015f9b33c2292654a2b5a21de03de8564432b'],
  [4, 'c75b58b128e5ab0e9266c40bbe03bf2a58d3bc20e989a6913ae047ad7b2943e3'],
  [5, '33cc87b1bfc88539471c8d77fe4ccf4623db294bb00ea598cd1744b7a5488b36'],
  [6, 'c2f159b732a6f35fe7768cc157ba2aaf3d78840c3faf17741068c7aa7ad0e1d2'],
  [7, '9b1b5380513b1b2f1cda33a53a955351fd9959ca3b8d8cc29a84b6dcec27c952'],
  [8, 'f5a20ed4de7e7c1a94e6b903abf3441079397e0ad99c6a938d5143e79c0da0a6'],
  [9, 'de85871ec4376c1c38c5924f7433feff3435dec433c74135e00167fca3d147c6'],
  [10, 'dc025a4dcee0046028d92fbe2e50f884eed4e9b0ffa6636e2eda1ecee8468988'],
  [11, 'd88192494bbacc30ccdb321c7b7ee294ce387295bd48fa24dc42c07786b6a78e'],
  [12, '7542d84aabefc3698e0ddf1d62c6b97d422e65d0d25869511db9113e2ba6d676'],
  [13, 'ef419d4f67f7a4140529bc9ea2d1b2f48d655b9af253d2c01e8e5871e5a3a74d'],
  [14, '380ec5487b5dafe8b7daf58e0c015bcf045aa041b244834c393d1ad3be6bcbe3'],
  [15, '805f03eaf229a174fb81cee1b354d58ba9a6cad837065d5849309b7fa6acd5c5'],
  [16, '00f4a358980c6a01ca84719e7ca7a6d37e99743f92edc55ee20ca93529166672'],
  [17, 'ec1873743552721f8bad4aa42a86fbecdc07f70ae61b7a676f8823e5359118ce'],
  [18, 'fd63e3fc3c9f9b3073cb3c9e5420dc56e25213ed56bcfa46fd3f0528f2fd3079'],
  [19, 'a8c4db0af1718387dc460145a3ef95f8df99a417a135dad30abefb7ed1d99dd2'],
  [20, '6eae6541d691acc6d344d0392de6efdc6a385e206d8b9220df91a4840b41c34c'],
  [21, 'e009721cfef388c541f90fb5593acf99b80faec61a8776ae86ffc2993ba10b7c'],
  [22, 'ec258e42ecf97847291ac21fd1d2ae54dfc0abfd595e0d51ec4e5f8a6c7c1eec'],
];

const WHY =
  'Core migrations are append-only: a database that already ran the old text would never see the edit, ' +
  'so it would differ from a new one. Put the change in a new migration instead.';

describe('core migrations are append-only', () => {
  it('numbers them 1, 2, 3... with no gap and no repeat', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it.each(PINNED)('keeps migration %i as it shipped', (id, pinned) => {
    const m = MIGRATIONS.find((x) => x.id === id);
    expect(m, `Migration ${id} is gone. ${WHY}`).toBeDefined();
    // The hash covers the name as well as the SQL, so a rename fails here too.
    expect(sha(m as Migration), `Migration ${id} (${m?.name}) was edited or renamed. ${WHY}`).toBe(
      pinned
    );
  });

  it('pins every migration there is', () => {
    const unpinned = MIGRATIONS.filter((m) => !PINNED.some(([id]) => id === m.id));
    expect(
      unpinned.map((m) => `  [${m.id}, '${sha(m)}'],`),
      'A new migration is added to PINNED in the same commit. Add these lines:'
    ).toEqual([]);
  });
});
