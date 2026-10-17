import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importLegacyJson } from '@clerq/store';
import { initStore, closeStore, getStore } from './store.js';
import { logger } from './logger.js';
import {
  saveTriggers,
  getTriggers,
  startTriggers,
  stopTriggers,
  getWebhookMessage,
  markTriggerFired,
  validateTriggers,
  TriggerConfigError,
  FILE_DEBOUNCE_MS,
} from './triggers.js';

// Watchers and schedules are faked so a test can fire them exactly when it wants.
const fakes = vi.hoisted(() => ({
  watcher: null as EventEmitter | null,
  ticks: [] as Array<() => unknown>,
}));

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: {
      watch: () => {
        fakes.watcher = Object.assign(new EventEmitter(), { close: async () => undefined });
        return fakes.watcher;
      },
    },
  };
});

vi.mock('node-cron', async (importOriginal) => {
  const real = (await importOriginal()) as { default: Record<string, unknown> };
  return {
    default: {
      ...real.default,
      schedule: (_schedule: string, fn: () => unknown) => {
        fakes.ticks.push(fn);
        return { stop: () => undefined };
      },
    },
  };
});

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => {
  closeStore();
});

afterEach(() => {
  stopTriggers();
  saveTriggers({});
  fakes.watcher = null;
  fakes.ticks.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe('trigger firing', () => {
  /** A runner whose runs stay in flight until released. */
  function heldRunner() {
    const release: Array<() => void> = [];
    const runner = vi.fn(() => new Promise<void>((resolve) => release.push(resolve)));
    return { runner, release: () => release.splice(0).forEach((r) => r()) };
  }

  const inbox = { id: 'inbox', path: '/tmp/clerq-inbox', message: 'new file' };

  it('coalesces a burst of file events into one run', async () => {
    vi.useFakeTimers();
    saveTriggers({ file: [inbox, { id: 'outbox', path: '/tmp/clerq-outbox', message: 'sent' }] });
    const runner = vi.fn(async () => undefined);
    startTriggers(runner);

    fakes.watcher!.emit('all', 'add', inbox.path);
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS / 2);
    fakes.watcher!.emit('all', 'change', inbox.path);
    fakes.watcher!.emit('all', 'change', '/tmp/clerq-outbox');
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS - 1);
    expect(runner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // One run per trigger, not one per event.
    expect(runner.mock.calls).toEqual([
      ['new file', 'file'],
      ['sent', 'file'],
    ]);
  });

  it('drops a pending file firing when triggers stop', async () => {
    vi.useFakeTimers();
    saveTriggers({ file: [inbox] });
    const runner = vi.fn(async () => undefined);
    startTriggers(runner);

    fakes.watcher!.emit('all', 'change', inbox.path);
    stopTriggers();
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS * 2);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips a file firing while the previous run is in flight', async () => {
    vi.useFakeTimers();
    saveTriggers({ file: [inbox] });
    const { runner, release } = heldRunner();
    startTriggers(runner);

    fakes.watcher!.emit('all', 'change', inbox.path);
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS);
    fakes.watcher!.emit('all', 'change', inbox.path);
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS);
    expect(runner).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    fakes.watcher!.emit('all', 'change', inbox.path);
    await vi.advanceTimersByTimeAsync(FILE_DEBOUNCE_MS);
    expect(runner).toHaveBeenCalledTimes(2);
    release();
  });

  it('skips a cron firing while the previous run is in flight, and logs it', async () => {
    saveTriggers({ cron: [{ id: 'often', schedule: '* * * * *', message: 'tick' }] });
    const { runner, release } = heldRunner();
    const warn = vi.spyOn(logger, 'warn');
    startTriggers(runner);
    const [tick] = fakes.ticks;

    tick();
    tick();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Trigger skipped: its previous run is still in flight', {
      source: 'cron',
      id: 'often',
    });

    release();
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    expect(runner).toHaveBeenCalledTimes(2);
    release();
  });
});
