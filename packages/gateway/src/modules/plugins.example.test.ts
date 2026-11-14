/**
 * The example plugin, packages/plugin-sdk/examples/hello-plugin, loaded the way a
 * user would install it: copied into the modules folder. It uses a route, a
 * trigger, a declared secret, `ctx.fetch` to a declared host, and start and stop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@clerq/plugin-sdk/manifest';
import {
  auditRows,
  listPlugins,
  scratch,
  seedEnforce,
  startGateway,
  type Running,
  type Scratch,
} from './plugins.harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(__dirname, '../../../plugin-sdk/examples/hello-plugin');

let s: Scratch;
let running: Running | undefined;
const asked: string[] = [];

/** The host the example declares answers; nothing else is reached. */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  return new Response('Keep it logically awesome.\n', { status: 200 });
}) as typeof fetch;

beforeEach(() => {
  s = scratch();
  asked.length = 0;
  fs.cpSync(EXAMPLE, path.join(s.modules, 'hello-plugin'), { recursive: true });
});

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  s.cleanup();
});

const start = async () => (running = await startGateway(s, { plugins: { fetch: fakeFetch } }));

it('has a manifest that passes the version 1 rules, without a warning', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'manifest.json'), 'utf8'));
  const result = validateManifest(raw);
  expect(result).toMatchObject({ ok: true, warnings: [] });
});

describe('hello-plugin', () => {
  it('loads, serves its route, and answers from its config', async () => {
    const gw = await start();
    const p = (await listPlugins(gw))['hello-plugin'];
    expect(p).toMatchObject({ state: 'enabled', kind: 'plugin', warnings: [] });
    expect(p.permissions).toMatchObject({
      secrets: ['token'],
      net: ['api.github.com'],
      api: ['GET /runs'],
    });
    expect(await gw.json('/api/modules/hello-plugin/hello?name=Ada')).toEqual({
      message: 'Hello, Ada',
      version: '1.0.0',
    });
  });

  it('keeps a declared secret in the vault under the plugin’s own name', async () => {
    const gw = await start();
    expect(await gw.json('/api/modules/hello-plugin/token')).toEqual({ set: false });
    await gw.api('/api/modules/hello-plugin/token', {
      method: 'PUT',
      body: JSON.stringify({ value: 'abc' }),
    });
    expect(await gw.json('/api/modules/hello-plugin/token')).toEqual({ set: true });
    expect(await gw.json<{ secrets?: string[] }>('/secrets')).toBeDefined();
    expect(JSON.stringify(await gw.json('/secrets'))).toContain('hello-plugin/token');
  });

  it('calls its declared host through ctx.fetch', async () => {
    const gw = await start();
    expect(await gw.json('/api/modules/hello-plugin/zen')).toEqual({
      status: 200,
      zen: 'Keep it logically awesome.',
    });
    expect(asked).toEqual(['https://api.github.com/zen']);
    // Within its declaration: nothing for the audit log to say.
    expect(auditRows('plugin.permission')).toEqual([]);
  });

  it('fires its trigger, which is a run in run history', async () => {
    const gw = await start();
    const res = await gw.api('/api/modules/hello-plugin/triggers/ping', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect(runId).toBeTruthy();
    const { modules } = await gw.json<{
      modules: Array<{ id: string; triggers: Array<{ id: string }> }>;
    }>('/modules');
    expect(modules.find((m) => m.id === 'hello-plugin')?.triggers.map((t) => t.id)).toEqual([
      'ping',
    ]);
  });

  it('serves its UI, and hands the UI a token that reaches its routes and GET /runs', async () => {
    const gw = await start();
    const page = await gw.api('/api/modules/hello-plugin/ui/', {}, null);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Hello plugin');
    const { token, scopes } = (await (
      await gw.api('/modules/hello-plugin/token', { method: 'POST', body: '{}' })
    ).json()) as { token: string; scopes: string[] };
    expect(scopes).toEqual(['* /api/modules/hello-plugin/*', 'GET /runs']);
    expect((await gw.api('/api/modules/hello-plugin/hello', {}, token)).status).toBe(200);
    expect((await gw.api('/runs', {}, token)).status).toBe(200);
    expect((await gw.api('/automations', {}, token)).status).toBe(403);
    const ext = await gw.json<{ nav: Array<{ moduleId: string; title: string }> }>('/extensions');
    expect(ext.nav).toEqual([
      expect.objectContaining({ moduleId: 'hello-plugin', title: 'Hello plugin' }),
    ]);
  });

  it('stops: its stop hook writes to the audit log, and its timer and routes go', async () => {
    const gw = await start();
    await gw.api('/plugins/hello-plugin/disable', { method: 'POST', body: '{}' });
    const stopped = auditRows('module.hello-plugin.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ actor: 'module:hello-plugin', detail: { beats: 0 } });
    expect((await gw.api('/api/modules/hello-plugin/hello')).status).toBe(404);
  });

  it('is told its previous version when it is upgraded', async () => {
    await (await start()).close();
    const manifest = path.join(s.modules, 'hello-plugin', 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '1.1.0' })
    );
    await start();
    expect(auditRows('module.hello-plugin.upgraded').map((r) => r.detail)).toEqual([
      { from: '1.0.0', to: '1.1.0' },
    ]);
  });

  it('is told what it goes beyond: allowed and audited while enforcement is off', async () => {
    const gw = await start();
    expect(await gw.json('/api/modules/hello-plugin/undeclared')).toEqual({ set: false });
    expect(auditRows('plugin.permission.undeclared')).toHaveLength(1);
    expect(auditRows('plugin.permission.undeclared')[0].detail).toMatchObject({
      permission: 'secrets',
      subject: 'other',
      enforced: false,
    });
  });

  it('is refused, and audited, once enforcement is on and it has been approved', async () => {
    await seedEnforce(s);
    const gw = await start();
    expect((await listPlugins(gw))['hello-plugin'].state).toBe('awaiting_approval');
    const p = (await listPlugins(gw))['hello-plugin'];
    await gw.api('/plugins/hello-plugin/approve', {
      method: 'POST',
      body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
    });
    expect(await gw.json('/api/modules/hello-plugin/zen')).toMatchObject({ status: 200 });
    const out = await gw.api('/api/modules/hello-plugin/undeclared');
    expect(out.status).toBe(500);
    expect(await out.json()).toMatchObject({
      error: 'module_error',
      message: expect.stringContaining('may not read the secret "other"'),
    });
    expect(auditRows('plugin.permission.denied')[0]).toMatchObject({
      actor: 'plugin:hello-plugin',
      detail: { permission: 'secrets', subject: 'other', enforced: true },
    });
  });
});
