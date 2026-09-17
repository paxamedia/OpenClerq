import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importLegacyJson } from '@clerq/store';
import { initStore, closeStore, getStore } from './store.js';
import {
  saveTriggers,
  getTriggers,
  startTriggers,
  stopTriggers,
  getWebhookMessage,
  markTriggerFired,
  validateTriggers,
  TriggerConfigError,
} from './triggers.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => {
  closeStore();
});

afterEach(() => {
  stopTriggers();
  saveTriggers({});
});

const sample = {
  cron: [{ id: 'daily', schedule: '0 9 * * *', message: 'morning summary' }],
  file: [{ id: 'inbox', path: '/tmp/clerq-inbox', message: 'new file' }],
  webhooks: { deploy: { message: 'deploy finished' } },
};

describe('trigger storage', () => {
  it('round-trips every kind through the store', () => {
    saveTriggers(sample);
    expect(getTriggers()).toEqual(sample);
  });

  it('replaces the stored set, deleting triggers left out', () => {
    saveTriggers(sample);
    saveTriggers({ cron: sample.cron });
    expect(getTriggers()).toEqual({ cron: sample.cron, file: [], webhooks: {} });
  });

  it('keeps last-fired history for a trigger that survives a save', () => {
    saveTriggers(sample);
    markTriggerFired('daily');
    saveTriggers({ cron: [{ ...sample.cron[0], message: 'edited' }] });

    const row = getStore()
      .prepare("SELECT message, last_fired FROM triggers WHERE id = 'daily'")
      .get();
    expect(row?.message).toBe('edited');
    expect(row?.last_fired).toBeTruthy();
  });

  it('finds triggers imported from a pre-0.5 triggers.json', () => {
    // The regression: the store imported triggers.json and archived it, while
    // this module kept reading the JSON file — so every trigger vanished on the
    // first restart after upgrading.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-legacy-triggers-'));
    try {
      fs.writeFileSync(path.join(dir, 'triggers.json'), JSON.stringify(sample));
      importLegacyJson(getStore(), dir);

      expect(fs.existsSync(path.join(dir, 'triggers.json'))).toBe(false);
      expect(getTriggers()).toEqual(sample);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves webhooks from the store once started', () => {
    saveTriggers(sample);
    startTriggers(async () => undefined);
    expect(getWebhookMessage('deploy')).toBe('deploy finished');

    saveTriggers({});
    startTriggers(async () => undefined);
    expect(getWebhookMessage('deploy')).toBeNull();
  });
});

describe('validateTriggers', () => {
  const reject = (config: unknown, pattern: RegExp) => {
    expect(() => validateTriggers(config)).toThrow(TriggerConfigError);
    expect(() => validateTriggers(config)).toThrow(pattern);
  };

  it('accepts an empty config', () => {
    expect(validateTriggers({})).toEqual({ cron: [], file: [], webhooks: {} });
  });

  it('rejects a schedule cron cannot parse, instead of never firing it', () => {
    reject({ cron: [{ id: 'x', schedule: 'every tuesday', message: 'm' }] }, /invalid schedule/);
  });

  it('rejects an id used by two triggers, even of different kinds', () => {
    reject(
      {
        cron: [{ id: 'dup', schedule: '* * * * *', message: 'm' }],
        webhooks: { dup: { message: 'm' } },
      },
      /used more than once/
    );
  });

  it('rejects missing messages and paths', () => {
    reject({ cron: [{ id: 'x', schedule: '* * * * *' }] }, /message must be a non-empty string/);
    reject({ file: [{ id: 'x', message: 'm' }] }, /path must be a non-empty string/);
    reject({ webhooks: { x: {} } }, /message must be a non-empty string/);
  });

  it('rejects the wrong shapes', () => {
    reject(null, /must be an object/);
    reject([], /must be an object/);
    reject({ cron: {} }, /cron must be a list/);
    reject({ webhooks: [] }, /webhooks must be an object/);
  });
});
