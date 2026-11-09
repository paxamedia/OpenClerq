/**
 * Remote mode and pairing end to end, against a gateway on loopback with an
 * in-memory store and a scratch HOME.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('refuses wrong codes, and stops answering after too many', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await pair({ code: 'AAAAA-AAAAA', deviceName: 'x', platform: 'ios' })).status;
    }
    expect(last).toBe(429);
  });
});
