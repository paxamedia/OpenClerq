/**
 * The chat console as the reference plugin: shipped as a bundled plugin (a manifest, no server
 * code), approved by its bundled checksum, held to what it declares through a module UI token.
 * The real manifest from packages/plugin-chat, a real gateway, and the real client over the token.
 *
 * What the console's page does with each of these calls is in packages/plugin-chat's tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayClient } from '@clerq/gateway-client';
import { scopeAllows } from '../security/scoped-tokens.js';
import { BUNDLED_PLUGINS } from './bundled-plugins.js';
import {
  auditRows,
  listPlugins,
  scratch,
  seedEnforce,
  sleep,
  startGateway,
  TOKEN,
  type Running,
  type Scratch,
} from './plugins.harness.js';

const CHAT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugin-chat');
const MANIFEST_TEXT = fs.readFileSync(path.join(CHAT_DIR, 'manifest.json'), 'utf8');
const MANIFEST = JSON.parse(MANIFEST_TEXT) as { permissions: { api: string[] } };

let s: Scratch;
let running: Running | undefined;
let bundled: string;

beforeEach(() => {
  s = scratch();
  // What the app carries: a folder holding one folder, `chat`, with the manifest in it.
  bundled = path.join(s.home, 'bundled');
  fs.mkdirSync(path.join(bundled, 'chat'), { recursive: true });
  fs.writeFileSync(path.join(bundled, 'chat', 'manifest.json'), MANIFEST_TEXT);
});

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  s.cleanup();
});

const start = async (config = {}) =>
  (running = await startGateway(s, { bundledPluginsDir: bundled, ...config }));
const post = (gw: Running, p: string, body: unknown = {}, token?: string | null) =>
  gw.api(p, { method: 'POST', body: JSON.stringify(body) }, token);

async function scopedToken(gw: Running, ttlSeconds?: number) {
  const res = await post(gw, '/modules/chat/token', ttlSeconds ? { ttlSeconds } : {});
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; expiresAt: string; scopes: string[] };
}

/** A declared endpoint with an id that is not there: allowed (so not 403), and answered however the route answers. */
const concrete = (scope: string) => {
  const [method, p] = scope.split(' ');
  return {
    method,
    path: p.replace(':id', 'ses_none').replace(':draftId', 'drf_none'),
  };
};

describe('shipped as a bundled plugin', () => {
  it('is listed, enabled, and approved by its bundled checksum, with what it declares', async () => {
    const gw = await start();
    const chat = (await listPlugins(gw)).chat;
    expect(chat).toMatchObject({
      kind: 'plugin',
      state: 'enabled',
      checksum: BUNDLED_PLUGINS.chat,
      approval: { status: 'approved', approvedBy: 'bundled' },
    });
    expect(chat.permissions).toMatchObject({ api: MANIFEST.permissions.api, llm: true });
    expect((chat.permissions as { memory: { read: string[] } }).memory.read).toHaveLength(5);
    const approved = auditRows('plugin.approved').filter((r) => r.subject === 'chat');
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ actor: 'gateway', detail: { bundled: true } });
  });

  it('is approved again, not twice, when the gateway restarts', async () => {
    await start();
    await running?.close();
    const gw = await start();
    expect((await listPlugins(gw)).chat.approval.status).toBe('approved');
    expect(auditRows('plugin.approved').filter((r) => r.subject === 'chat')).toHaveLength(1);
  });

  it('is not found when the app carries no folder for it, and then nothing else changes', async () => {
    const gw = await start({ bundledPluginsDir: path.join(s.home, 'nothing-here') });
    expect((await listPlugins(gw)).chat).toBeUndefined();
    expect((await gw.api('/sessions')).status).toBe(200);
    expect((await gw.json<{ modules: unknown[] }>('/modules')).modules).toEqual([]);
  });

  it('keeps its id against a folder of the same name in the modules directory', async () => {
    fs.mkdirSync(path.join(s.modules, 'chat'));
    fs.writeFileSync(
      path.join(s.modules, 'chat', 'manifest.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'chat',
        name: 'Not the console',
        version: '9.9.9',
        description: 'Takes the id.',
        engines: { api: 1 },
        permissions: { api: ['GET /runs'] },
      })
    );
    const gw = await start();
    const { plugins } = await gw.json<{ plugins: Array<{ id: string; name: string }> }>('/plugins');
    expect(plugins.filter((p) => p.id === 'chat')).toEqual([
      expect.objectContaining({ name: 'Chat console' }),
    ]);
  });
});

describe('with plugin checks on, over its own token', () => {
  beforeEach(async () => {
    await seedEnforce(s);
  });

  it('runs without anyone approving it, and a token reaches its declared endpoints and its own routes', async () => {
    const gw = await start();
    expect((await listPlugins(gw)).chat.state).toBe('enabled');
    const minted = await scopedToken(gw);
    expect(minted.token).toMatch(/^clqm_/);
    expect(minted.scopes).toEqual(['* /api/modules/chat/*', ...MANIFEST.permissions.api]);
    // 15 minutes, as for any module's UI.
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it('answers every declared endpoint and refuses everything else with 403', async () => {
    const gw = await start();
    const { token, scopes } = await scopedToken(gw);
    for (const scope of MANIFEST.permissions.api) {
      const { method, path: p } = concrete(scope);
      const res = await gw.api(
        p,
        { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) },
        token
      );
      expect(res.status, scope).not.toBe(403);
      expect(res.status, scope).not.toBe(401);
      // The scope the gateway checks is the scope the manifest declared.
      expect(
        scopes.some((sc) => scopeAllows(sc, method, p)),
        scope
      ).toBe(true);
    }
    const refused: Array<[string, string]> = [
      ['GET', '/runs'],
      ['GET', '/automations'],
      ['POST', '/automations'],
      ['POST', '/kill'],
      ['GET', '/approvals'],
      ['GET', '/memory'],
      ['GET', '/sessions/ses_none/drafts'],
      ['POST', '/sessions/ses_none/drafts/drf_none/delete'],
      ['GET', '/secrets'],
      ['GET', '/plugins'],
      ['POST', '/plugins/chat/approve'],
      ['PUT', '/plugins/settings'],
      ['GET', '/skills'],
      ['POST', '/modules/chat/token'],
    ];
    for (const [method, p] of refused) {
      const res = await gw.api(p, { method, ...(method === 'GET' ? {} : { body: '{}' }) }, token);
      expect(res.status, `${method} ${p}`).toBe(403);
    }
  });

  it('is a client of its own: the console’s calls work through it, and an undeclared one is refused', async () => {
    const gw = await start();
    const { token } = await scopedToken(gw);
    const scoped = createGatewayClient({ baseUrl: gw.base, token });
    const session = await scoped.createSession({ mode: 'raw', title: 'Through a token' });
    expect((await scoped.sessions()).sessions.map((x) => x.id)).toContain(session.id);
    expect((await scoped.session(session.id)).title).toBe('Through a token');
    expect((await scoped.updateSession(session.id, { mode: 'managed' })).mode).toBe('managed');
    expect((await scoped.providers()).providers.length).toBeGreaterThan(0);
    expect((await scoped.modeDiff(session.id, { text: 'Hello' })).managed.system).toContain('');
    // Not declared: the same client, the same token.
    await expect(scoped.runs()).rejects.toMatchObject({ status: 403 });
    await expect(scoped.drafts(session.id)).rejects.toMatchObject({ status: 403 });
    await expect(scoped.plugins()).rejects.toMatchObject({ status: 403 });
    expect(await scoped.deleteSession(session.id)).toEqual({ ok: true });
  });

  it('is revoked when the plugin is switched off, and issued again when it is switched on', async () => {
    const gw = await start();
    const { token } = await scopedToken(gw);
    const scoped = createGatewayClient({ baseUrl: gw.base, token });
    await scoped.sessions();
    expect((await post(gw, '/plugins/chat/disable')).status).toBe(200);
    await expect(scoped.sessions()).rejects.toMatchObject({ status: 401 });
    expect((await post(gw, '/modules/chat/token')).status).toBe(404);
    expect((await post(gw, '/plugins/chat/enable')).status).toBe(200);
    const again = await scopedToken(gw);
    expect(again.token).not.toBe(token);
    await createGatewayClient({ baseUrl: gw.base, token: again.token }).sessions();
  });

  it('works for as long as a session lasts, when a new token is asked for before the old one ends', async () => {
    const gw = await start();
    const first = await scopedToken(gw, 2);
    const one = createGatewayClient({ baseUrl: gw.base, token: first.token });
    await one.sessions();
    // The renewal, as the app does it, comes before the end.
    await sleep(1300);
    const second = await scopedToken(gw, 2);
    expect(second.token).not.toBe(first.token);
    await sleep(1000);
    // Past the end of the first token: it is refused, the renewed one is not.
    await expect(one.sessions()).rejects.toMatchObject({ status: 401 });
    await createGatewayClient({ baseUrl: gw.base, token: second.token }).sessions();
  });
});

describe('a change to what it declares', () => {
  const widen = () => {
    const edited = JSON.parse(MANIFEST_TEXT) as { permissions: { api: string[] } };
    edited.permissions.api.push('GET /runs');
    fs.writeFileSync(path.join(bundled, 'chat', 'manifest.json'), JSON.stringify(edited, null, 2));
  };

  it('with plugin checks on, stops the plugin and issues no token until it is approved again', async () => {
    await seedEnforce(s);
    const first = await start();
    expect((await listPlugins(first)).chat.state).toBe('enabled');
    const { token } = await scopedToken(first);
    await first.close();
    widen();
    const gw = await start();
    const chat = (await listPlugins(gw)).chat;
    // No longer the bundled checksum, so no longer approved by it; the approval it has is for the old declaration.
    expect(chat).toMatchObject({
      state: 'awaiting_approval',
      approval: { status: 'changed', changes: { code: true, permissions: true } },
    });
    expect(chat.approval.permissionChanges.map((c) => c.text).join(' ')).toContain('GET /runs');
    expect((await post(gw, '/modules/chat/token')).status).toBe(404);
    // The token from before is not honoured: it was revoked when the plugin stopped.
    expect((await gw.api('/runs', {}, token)).status).toBe(401);
    // Approving names the hashes that were reviewed; then the token reaches the new endpoint, and only it.
    expect(
      (
        await post(gw, '/plugins/chat/approve', {
          permissionsHash: chat.permissionsHash,
          checksum: chat.checksum,
        })
      ).status
    ).toBe(200);
    const now = await scopedToken(gw);
    expect(now.scopes).toContain('GET /runs');
    expect((await gw.api('/runs', {}, now.token)).status).toBe(200);
    expect((await gw.api('/automations', {}, now.token)).status).toBe(403);
  });

  it('with plugin checks off, loads and says it changed, and the token already reaches the new endpoint', async () => {
    const first = await start();
    await first.close();
    widen();
    const gw = await start();
    const chat = (await listPlugins(gw)).chat;
    expect(chat.state).toBe('enabled');
    expect(chat.approval.status).toBe('changed');
    expect(auditRows('plugin.changed').some((r) => r.subject === 'chat')).toBe(true);
    const { scopes } = await scopedToken(gw);
    expect(scopes).toContain('GET /runs');
  });

  it('is judged by the gateway token only: a plugin’s own token cannot approve it', async () => {
    await seedEnforce(s);
    const gw = await start();
    const { token } = await scopedToken(gw);
    const chat = (await listPlugins(gw)).chat;
    const res = await post(
      gw,
      '/plugins/chat/approve',
      { permissionsHash: chat.permissionsHash, checksum: chat.checksum },
      token
    );
    expect(res.status).toBe(403);
    expect(TOKEN).not.toBe(token);
  });
});
