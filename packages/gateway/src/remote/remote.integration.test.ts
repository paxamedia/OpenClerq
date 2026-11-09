/**
 * Remote mode and pairing end to end, against a gateway on loopback with an
 * in-memory store and a scratch HOME.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pushFor } from './push.js';
import { resetPairingLimiter } from './devices.js';
import { createGateway } from '../gateway.js';

const TOKEN = 'remote-test-token-0123456789';
let baseUrl = '';
let home = '';
let savedHome: string | undefined;
let server: { close: (cb?: () => void) => void };

const api = (p: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
const pair = (body: unknown) =>
  fetch(`${baseUrl}/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-remote-'));
  process.env.HOME = home;
  const gw = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    skillsDir: path.join(home, 'skills'),
    modulesDir: path.join(home, 'no-modules'),
  });
  server = gw.server;
  await gw.ready;
  const addr = gw.server.address();
  baseUrl = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('remote mode', () => {
  it('is off until turned on with an https address', async () => {
    expect(await (await api('/remote')).json()).toMatchObject({ enabled: false, publicUrl: null });
    expect((await api('/devices/pairing', { method: 'POST' })).status).toBe(409);
    const plain = await api('/remote', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, publicUrl: 'http://clerq.example.com' }),
    });
    expect(plain.status).toBe(400);
    expect(
      (await api('/remote', { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status
    ).toBe(400);
    const on = await api('/remote', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, publicUrl: 'https://clerq.example.com/' }),
    });
    expect(await on.json()).toEqual({
      enabled: true,
      publicUrl: 'https://clerq.example.com',
      ntfyServer: 'https://ntfy.sh',
    });
  });
});

describe('pairing', () => {
  let device: { id: string; push: { topic: string } };
  let token = '';

  it('trades a single-use code for a scoped device token', async () => {
    const created = await api('/devices/pairing', { method: 'POST' });
    expect(created.status).toBe(201);
    const { code, url, expiresAt, qr } = (await created.json()) as Record<string, string>;
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(url).toBe('https://clerq.example.com');
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(JSON.parse(qr)).toEqual({ url, code, expires: expiresAt });

    const res = await pair({ code: code.toLowerCase(), deviceName: 'Test phone', platform: 'ios' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      device: typeof device;
      scopes: string[];
    };
    token = body.token;
    device = body.device;
    expect(token).toMatch(/^clqd_/);
    expect(token).not.toBe(TOKEN);
    expect(device.push.topic).toMatch(/^clerq-[0-9a-f]{32}$/);

    // Single use.
    expect((await pair({ code, deviceName: 'Other', platform: 'android' })).status).toBe(401);
  });

  it('reaches the mobile API set and nothing else', async () => {
    expect((await api('/runs', {}, token)).status).toBe(200);
    expect((await api('/approvals', {}, token)).status).toBe(200);
    expect((await api('/inbox', {}, token)).status).toBe(200);
    expect((await api('/devices/me', {}, token)).status).toBe(200);
    expect((await api('/secrets', {}, token)).status).toBe(403);
    expect((await api('/devices', {}, token)).status).toBe(403);
    expect((await api('/devices/pairing', { method: 'POST' }, token)).status).toBe(403);
    expect((await api('/remote', {}, token)).status).toBe(403);
    expect((await api('/tools/run', { method: 'POST', body: '{}' }, token)).status).toBe(403);
  });

  it('lists devices with last-seen, and revokes at once', async () => {
    const { devices } = (await (await api('/devices')).json()) as {
      devices: Array<{ id: string; lastSeenAt: string | null; revokedAt: string | null }>;
    };
    expect(devices).toMatchObject([{ id: device.id, revokedAt: null }]);
    expect(devices[0].lastSeenAt).not.toBeNull();
    const revoked = await api(`/devices/${device.id}`, { method: 'DELETE' });
    expect(((await revoked.json()) as { revokedAt: string | null }).revokedAt).not.toBeNull();
    expect((await api('/runs', {}, token)).status).toBe(401);
  });

  it('turns devices away while remote mode is off', async () => {
    const { code } = (await (await api('/devices/pairing', { method: 'POST' })).json()) as {
      code: string;
    };
    const { token: t } = (await (
      await pair({ code, deviceName: 'Second', platform: 'android' })
    ).json()) as { token: string };
    await api('/remote', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect((await api('/runs', {}, t)).status).toBe(403);
    await api('/remote', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect((await api('/runs', {}, t)).status).toBe(200);
    // A phone can unpair itself.
    expect((await api('/devices/me', { method: 'DELETE' }, t)).status).toBe(200);
    expect((await api('/runs', {}, t)).status).toBe(401);
  });

  it('ends an open event stream when its device is revoked or remote mode goes off', async () => {
    const pairOne = async (name: string) => {
      const { code } = (await (await api('/devices/pairing', { method: 'POST' })).json()) as {
        code: string;
      };
      return (await (await pair({ code, deviceName: name, platform: 'ios' })).json()) as {
        token: string;
        device: { id: string };
      };
    };
    /** Resolves when the stream ends, or false after two seconds. */
    const ends = async (res: Response) => {
      const reader = res.body!.getReader();
      const timer = setTimeout(() => void reader.cancel(), 2000);
      let ended = false;
      for (;;) {
        const { done } = await reader.read().catch(() => ({ done: true }));
        if (done) {
          ended = true;
          break;
        }
      }
      clearTimeout(timer);
      return ended;
    };
    const t0 = Date.now();
    const a = await pairOne('Streamer A');
    const streamA = await api('/events/stream', {}, a.token);
    expect(streamA.status).toBe(200);
    const endedA = ends(streamA);
    await api(`/devices/${a.device.id}`, { method: 'DELETE' });
    expect(await endedA).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1900);

    const b = await pairOne('Streamer B');
    const streamB = await api('/events/stream', {}, b.token);
    const endedB = ends(streamB);
    const t1 = Date.now();
    await api('/remote', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(await endedB).toBe(true);
    expect(Date.now() - t1).toBeLessThan(1900);
    await api('/remote', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  });

  it('refuses wrong codes, and stops answering after too many', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await pair({ code: 'AAAAA-AAAAA', deviceName: 'x', platform: 'ios' })).status;
    }
    expect(last).toBe(429);
    resetPairingLimiter();
  });
});

describe('push', () => {
  it('maps events to generic titles and an id only', () => {
    const base = { id: 'e-1', at: 't', context: {} };
    expect(
      pushFor({ ...base, name: 'approval.requested', payload: { id: 7, reason: 'secret stuff' } })
    ).toEqual({
      title: 'Approval needed',
      id: 'approval:7',
      priority: 4,
    });
    expect(
      pushFor({
        ...base,
        name: 'notify.posted',
        payload: { id: 'ntf_1', moduleId: 'crm', title: 'Call Ada' },
      })
    ).toEqual({ title: 'Notification from crm', id: 'notify:ntf_1', priority: 3 });
    expect(pushFor({ ...base, name: 'run.started', payload: {} })).toBeNull();
  });

  it('publishes to each paired device on its ntfy topic, and stops once revoked', async () => {
    const received: Array<{ auth?: string; body: Record<string, unknown> }> = [];
    const ntfy = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', () => resolve()));
    const ntfyUrl = `http://127.0.0.1:${(ntfy.address() as { port: number }).port}`;
    try {
      await api('/remote', { method: 'PUT', body: JSON.stringify({ ntfyServer: ntfyUrl }) });
      const { code } = (await (await api('/devices/pairing', { method: 'POST' })).json()) as {
        code: string;
      };
      const { device } = (await (
        await pair({ code, deviceName: 'Pushy', platform: 'android' })
      ).json()) as { device: { id: string; push: { server: string; topic: string } } };
      expect(device.push.server).toBe(ntfyUrl);

      const item = (await (
        await api('/inbox/items', {
          method: 'POST',
          body: JSON.stringify({ kind: 'alert', title: 'Ada Lovelace owes 300 EUR' }),
        })
      ).json()) as { id: string };
      for (let i = 0; i < 50 && received.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(received).toEqual([
        {
          auth: undefined,
          body: {
            topic: device.push.topic,
            title: 'New alert',
            message: `inbox:${item.id}`,
            priority: 4,
          },
        },
      ]);
      expect(JSON.stringify(received)).not.toContain('Ada');

      await api(`/devices/${device.id}`, { method: 'DELETE' });
      await api('/inbox/items', {
        method: 'POST',
        body: JSON.stringify({ kind: 'task', title: 'x' }),
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(received).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => ntfy.close(() => resolve()));
    }
  });
});
