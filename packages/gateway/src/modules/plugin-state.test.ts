import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeStore, getStore, initStore } from '../store.js';
import { enforcing, setEnforcing } from './plugin-state.js';

beforeEach(async () => {
  await initStore(':memory:');
});

afterEach(() => {
  closeStore();
});

const put = (value: string) =>
  getStore()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('plugins.enforce', ?, 'now')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(value);

describe('whether enforcement is on', () => {
  it('is off until the person turns it on, and follows the setting', () => {
    expect(enforcing()).toBe(false);
    setEnforcing(true);
    expect(enforcing()).toBe(true);
    setEnforcing(false);
    expect(enforcing()).toBe(false);
  });

  it('is on when it cannot be told: a value that is neither true nor false, a store that is shut', () => {
    for (const value of ['TRUE', '1', 'yes', '', 'null']) {
      put(value);
      expect(enforcing(), value).toBe(true);
    }
    closeStore();
    expect(enforcing()).toBe(true);
  });

  it('is on when the store cannot be read', () => {
    getStore().exec('DROP TABLE settings');
    expect(enforcing()).toBe(true);
  });
});
