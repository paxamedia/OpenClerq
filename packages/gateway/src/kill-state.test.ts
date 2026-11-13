import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeStore, initStore } from './store.js';
import { readKillPause, writeKillPause } from './kill-state.js';
import { createGateway } from './gateway.js';
import { scheduledAutomationIds } from './automations/scheduler.js';

const TOKEN = 'kill-state-test-token-0123456789';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-kill-'));
const dbFile = path.join(root, 'clerq.db');

afterAll(() => {
  closeStore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the kill switch across a restart', () => {
  it('is kept in the store', async () => {
    await initStore(dbFile);
    expect(readKillPause()).toBeNull();
    writeKillPause('2026-11-13T10:00:00.000Z');
    closeStore();
    await initStore(dbFile);
    expect(readKillPause()).toBe('2026-11-13T10:00:00.000Z');
    closeStore();
  });

  it('holds triggers and schedules in a gateway that starts while it is engaged, until resumed', async () => {
    process.env.CLERQ_KEYCHAIN = 'off';
    const { server, ready } = createGateway({
      port: 0,
      authToken: TOKEN,
      dbPath: dbFile,
      modulesDir: '/nonexistent-modules-dir-xyz',
    });
    await ready;
    try {
      const addr = server.address() as { port: number };
      const api = (p: string, method = 'GET') =>
        fetch(`http://127.0.0.1:${addr.port}${p}`, {
          method,
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        });
      expect(await (await api('/kill')).json()).toMatchObject({
        triggersPaused: true,
        since: '2026-11-13T10:00:00.000Z',
      });
      expect(scheduledAutomationIds()).toEqual([]);

      expect((await api('/resume', 'POST')).status).toBe(200);
      expect(await (await api('/kill')).json()).toMatchObject({ triggersPaused: false });
      expect(readKillPause()).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
