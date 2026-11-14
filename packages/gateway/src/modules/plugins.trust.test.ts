/**
 * Trust: a plugin is approved by naming the hashes of what was reviewed; a change
 * needs a new approval; with enforcement off the plugin loads anyway, and with it on
 * it is not loaded (its code is not even imported) until it is approved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginChecksum } from '@clerq/plugin-sdk/node';
import { issueToken, principalAllows } from '../security/scoped-tokens.js';
import { MOBILE_SCOPES } from '../remote/devices.js';
import {
  auditRows,
  events,
  listPlugins,
  scratch,
  seedEnforce,
  startGateway,
  TOKEN,
  writePlugin,
  type Running,
  type Scratch,
} from './plugins.harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELLO_WORLD = path.resolve(__dirname, '../../../module-sdk/examples/hello-world');

let s: Scratch;
let running: Running | undefined;

beforeEach(() => {
  s = scratch();
});

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  s.cleanup();
});

const start = async (config = {}) => (running = await startGateway(s, config));
const post = (gw: Running, p: string, body: unknown = {}) =>
  gw.api(p, { method: 'POST', body: JSON.stringify(body) });

/** Approve what the list shows now. */
async function approveListed(gw: Running, id: string) {
  const p = (await listPlugins(gw))[id];
  return post(gw, `/plugins/${id}/approve`, {
    permissionsHash: p.permissionsHash,
    checksum: p.checksum,
  });
}

describe('with enforcement off, which is the default', () => {
  it('loads a plugin nobody approved and says it is not approved', async () => {
    writePlugin(s.modules, { id: 'plain', permissions: { net: ['api.example.com'] } });
    const gw = await start();
    expect((await gw.json<{ enforce: boolean }>('/plugins/settings')).enforce).toBe(false);
    const p = (await listPlugins(gw)).plain;
    expect(p.state).toBe('enabled');
    expect(p.approval.status).toBe('not_approved');
    expect(p.permissions).toMatchObject({ net: ['api.example.com'], api: [] });
    expect(p.permissionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.checksum).toBe(pluginChecksum(path.join(s.modules, 'plain')));
    expect(events('plain')).toContain('start');
    // First sight is recorded in the audit log, as it always was.
    expect(auditRows('module.installed').some((r) => r.subject === 'plain')).toBe(true);
  });

  it('shows "changed since you approved it" with what the plugin can do now that it could not', async () => {
    writePlugin(s.modules, { id: 'grows', permissions: { net: ['a.example.com'] } });
    const gw = await start();
    expect((await approveListed(gw, 'grows')).status).toBe(200);
    expect((await listPlugins(gw)).grows.approval).toMatchObject({
      status: 'approved',
      approvedBy: 'operator',
      approvedVersion: '1.0.0',
    });
    await gw.close();

    // A new release asks for more.
    writePlugin(s.modules, {
      id: 'grows',
      version: '1.1.0',
      permissions: { net: ['a.example.com', 'b.example.com'], exec: ['/usr/bin/git'], llm: true },
    });
    const next = await start();
    const p = (await listPlugins(next)).grows;
    // It still loads: nothing is blocked while enforcement is off.
    expect(p.state).toBe('enabled');
    expect(p.approval.status).toBe('changed');
    expect(p.approval.changes).toEqual({ code: true, permissions: true, version: true });
    expect(p.approval.permissionChanges.map((c) => c.text)).toEqual([
      'Can now run /usr/bin/git',
      'Can now connect to b.example.com',
      'Can now use AI models',
    ]);
    // The change is in the audit log.
    const changed = auditRows('plugin.changed').filter((r) => r.subject === 'grows');
    expect(changed).toHaveLength(1);
    expect(changed[0].detail).toMatchObject({ to: { version: '1.1.0' } });
    expect(auditRows('module.permissions.changed').some((r) => r.subject === 'grows')).toBe(true);
  });

  it('shows what was removed, too, and no difference when only the code changed', async () => {
    writePlugin(s.modules, {
      id: 'shrinks',
      permissions: { secrets: ['token'], net: ['a.example.com'] },
    });
    const gw = await start();
    await approveListed(gw, 'shrinks');
    await gw.close();
    writePlugin(s.modules, {
      id: 'shrinks',
      version: '1.0.1',
      permissions: { net: ['a.example.com'] },
    });
    const next = await start();
    expect((await listPlugins(next)).shrinks.approval.permissionChanges.map((c) => c.text)).toEqual(
      ['Can no longer use the secret token']
    );
    await next.close();
    // Same declarations, other code.
    writePlugin(s.modules, {
      id: 'shrinks',
      version: '1.0.1',
      permissions: { secrets: ['token'], net: ['a.example.com'] },
    });
    const third = await start();
    await approveListed(third, 'shrinks');
    fs.appendFileSync(path.join(s.modules, 'shrinks', 'dist', 'server.js'), '\n// edited\n');
    const p = (await listPlugins(third)).shrinks;
    expect(p.approval.status).toBe('changed');
    expect(p.approval.changes).toMatchObject({ code: true, permissions: false });
    expect(p.approval.permissionChanges).toEqual([]);
    // It is running the code it was approved with, and says the files on disk are other.
    expect(p.state).toBe('enabled');
    expect(p.needsRestart).toBe(true);
  });

  it('counts the memory and api declarations as part of what is approved', async () => {
    writePlugin(s.modules, { id: 'memo', permissions: { memory: { read: ['fact'] } } });
    const gw = await start();
    await approveListed(gw, 'memo');
    await gw.close();
    writePlugin(s.modules, {
      id: 'memo',
      permissions: { memory: { read: ['fact'], write: ['note'] }, api: ['GET /runs/:id'] },
    });
    const next = await start();
    const p = (await listPlugins(next)).memo;
    expect(p.approval.status).toBe('changed');
    expect(p.approval.permissionChanges.map((c) => c.text)).toEqual([
      'Can now call GET /runs/:id',
      'Can now write memory notes of type note',
    ]);
  });
});

describe('approving', () => {
  it('needs both hashes, as the list shows them now', async () => {
    writePlugin(s.modules, { id: 'review' });
    const gw = await start();
    const p = (await listPlugins(gw)).review;
    const url = '/plugins/review/approve';

    expect((await post(gw, url, {})).status).toBe(400);
    expect((await post(gw, url, { permissionsHash: p.permissionsHash })).status).toBe(400);
    expect(
      (await post(gw, '/plugins/nobody/approve', { permissionsHash: 'a', checksum: 'b' })).status
    ).toBe(404);

    for (const wrong of [
      { permissionsHash: p.permissionsHash, checksum: 'f'.repeat(64) },
      { permissionsHash: 'f'.repeat(64), checksum: p.checksum },
      { permissionsHash: 'a', checksum: 'b' },
    ]) {
      const res = await post(gw, url, wrong);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('approval_stale');
    }
    expect((await listPlugins(gw)).review.approval.status).toBe('not_approved');

    const ok = await post(gw, url, {
      permissionsHash: p.permissionsHash,
      checksum: p.checksum,
    });
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { plugin: { approval: { status: string } } }).plugin.approval.status
    ).toBe('approved');
    const rows = auditRows('plugin.approved').filter((r) => r.subject === 'review');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'operator', detail: { checksum: p.checksum } });
  });

  it('cannot cover a change made after it was reviewed', async () => {
    writePlugin(s.modules, { id: 'swap' });
    const gw = await start();
    const seen = (await listPlugins(gw)).swap;
    // What was reviewed is replaced before the click.
    fs.appendFileSync(path.join(s.modules, 'swap', 'dist', 'server.js'), '\n// swapped\n');
    const res = await post(gw, '/plugins/swap/approve', {
      permissionsHash: seen.permissionsHash,
      checksum: seen.checksum,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain(
      'changed since you reviewed'
    );
    expect((await listPlugins(gw)).swap.approval.status).toBe('not_approved');
    // Review it again, and it goes through.
    expect((await approveListed(gw, 'swap')).status).toBe(200);
  });

  it('cannot approve what cannot run', async () => {
    writePlugin(s.modules, { id: 'future', manifest: { engines: { api: 2 } } });
    const gw = await start();
    const res = await approveListed(gw, 'future');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string; message: string }).message).toContain(
      'needs OpenClerq API version 2'
    );
  });

  it('restarts a running plugin on the code that was just approved', async () => {
    writePlugin(s.modules, {
      id: 'moves',
      hooks: `register() { log.push('register v1'); }, stop() { log.push('stop'); },`,
    });
    const gw = await start();
    await approveListed(gw, 'moves');
    writePlugin(s.modules, {
      id: 'moves',
      version: '1.1.0',
      hooks: `register() { log.push('register v2'); },`,
    });
    expect((await listPlugins(gw)).moves.needsRestart).toBe(true);
    await approveListed(gw, 'moves');
    expect(events('moves')).toEqual(['import', 'register v1', 'stop', 'import', 'register v2']);
    expect((await listPlugins(gw)).moves).toMatchObject({
      state: 'enabled',
      needsRestart: false,
      approval: { status: 'approved' },
    });
  });
});

describe('with enforcement on', () => {
  beforeEach(async () => {
    await seedEnforce(s);
  });

  it('does not load a plugin nobody approved, and does not run any of its code', async () => {
    writePlugin(s.modules, { id: 'unseen', permissions: { exec: ['/bin/ls'] } });
    const gw = await start();
    expect((await gw.json<{ enforce: boolean }>('/plugins/settings')).enforce).toBe(true);
    const p = (await listPlugins(gw)).unseen;
    expect(p.state).toBe('awaiting_approval');
    expect(p.reason).toContain('has not been approved yet');
    expect(events('unseen')).toEqual([]);
    expect((await gw.api('/api/modules/unseen/hi')).status).toBe(404);
    const { modules } = await gw.json<{ modules: Array<{ id: string }> }>('/modules');
    expect(modules.map((m) => m.id)).not.toContain('unseen');
    expect((await gw.api('/modules/unseen/token', { method: 'POST', body: '{}' })).status).toBe(
      404
    );
    expect(auditRows('plugin.awaiting_approval').some((r) => r.subject === 'unseen')).toBe(true);
  });

  it('starts it, without a restart, when it is approved', async () => {
    writePlugin(s.modules, { id: 'waits' });
    const gw = await start();
    expect((await listPlugins(gw)).waits.state).toBe('awaiting_approval');
    const res = await approveListed(gw, 'waits');
    expect(((await res.json()) as { plugin: { state: string } }).plugin.state).toBe('enabled');
    expect(events('waits')).toEqual(['import', 'register', 'start']);
    expect((await gw.api('/api/modules/waits/hi')).status).toBe(200);
  });

  it('remembers an approval across a restart, and runs the plugin at the start', async () => {
    writePlugin(s.modules, { id: 'again' });
    const first = await start();
    await approveListed(first, 'again');
    await first.close();
    events('again').length = 0;
    const gw = await start();
    expect((await listPlugins(gw)).again.state).toBe('enabled');
    expect(events('again')).toContain('start');
  });

  it('does not run a changed plugin until it is approved again, and shows what changed', async () => {
    writePlugin(s.modules, { id: 'drift', permissions: { net: ['a.example.com'] } });
    const first = await start();
    await approveListed(first, 'drift');
    await first.close();
    events('drift').length = 0;

    writePlugin(s.modules, {
      id: 'drift',
      version: '1.1.0',
      permissions: { net: ['a.example.com', 'evil.example.net'] },
      hooks: `register() { log.push('NEW CODE'); },`,
    });
    const gw = await start();
    const p = (await listPlugins(gw)).drift;
    expect(p.state).toBe('awaiting_approval');
    expect(p.reason).toContain('changed since you approved it');
    expect(p.approval.status).toBe('changed');
    expect(p.approval.permissionChanges.map((c) => c.text)).toEqual([
      'Can now connect to evil.example.net',
    ]);
    // Neither the old code nor the new ran.
    expect(events('drift')).toEqual([]);

    await approveListed(gw, 'drift');
    expect(events('drift')).toEqual(['import', 'NEW CODE']);
    expect((await listPlugins(gw)).drift.state).toBe('enabled');
  });

  it('does not let disable and enable slip a changed plugin past the approval', async () => {
    writePlugin(s.modules, { id: 'slip' });
    const gw = await start();
    await approveListed(gw, 'slip');
    await post(gw, '/plugins/slip/disable');
    writePlugin(s.modules, { id: 'slip', hooks: `register() { log.push('NEW CODE'); },` });
    events('slip').length = 0;
    const on = await post(gw, '/plugins/slip/enable');
    expect(((await on.json()) as { plugin: { state: string } }).plugin.state).toBe(
      'awaiting_approval'
    );
    expect(events('slip')).toEqual([]);
  });

  it('applies to a legacy module as well', async () => {
    fs.cpSync(HELLO_WORLD, path.join(s.modules, 'hello-world'), { recursive: true });
    const gw = await start();
    const p = (await listPlugins(gw))['hello-world'];
    expect(p).toMatchObject({ kind: 'legacy', state: 'awaiting_approval' });
    expect((await gw.api('/api/modules/hello-world/hello')).status).toBe(404);
    await approveListed(gw, 'hello-world');
    expect((await gw.api('/api/modules/hello-world/hello')).status).toBe(200);
  });
});

describe('turning enforcement on and off while plugins run', () => {
  it('stops a plugin that was never approved, keeps one that was, and starts them again when it is off', async () => {
    writePlugin(s.modules, { id: 'trusted' });
    writePlugin(s.modules, { id: 'stranger' });
    const gw = await start();
    await approveListed(gw, 'trusted');
    expect((await listPlugins(gw)).stranger.state).toBe('enabled');

    const on = await gw.api('/plugins/settings', {
      method: 'PUT',
      body: JSON.stringify({ enforce: true }),
    });
    expect(await on.json()).toEqual({ enforce: true });
    const all = await listPlugins(gw);
    expect(all.trusted.state).toBe('enabled');
    expect(all.stranger.state).toBe('awaiting_approval');
    expect(events('stranger')).toEqual(['import', 'register', 'start', 'stop']);
    expect((await gw.api('/api/modules/stranger/hi')).status).toBe(404);
    expect((await gw.api('/api/modules/trusted/hi')).status).toBe(200);
    expect(events('trusted')).not.toContain('stop');

    await gw.api('/plugins/settings', { method: 'PUT', body: JSON.stringify({ enforce: false }) });
    expect((await listPlugins(gw)).stranger.state).toBe('enabled');
    expect((await gw.api('/api/modules/stranger/hi')).status).toBe(200);

    const rows = auditRows('plugins.enforce.changed');
    expect(rows.map((r) => r.detail.enforce)).toEqual([true, false]);
  });

  it('is remembered across a restart', async () => {
    const gw = await start();
    await gw.api('/plugins/settings', { method: 'PUT', body: JSON.stringify({ enforce: true }) });
    await gw.close();
    const next = await start();
    expect(await next.json('/plugins/settings')).toEqual({ enforce: true });
  });

  it('wants a true or false', async () => {
    const gw = await start();
    for (const body of [{}, { enforce: 'yes' }, { enforce: 1 }, null]) {
      const res = await gw.api('/plugins/settings', { method: 'PUT', body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    expect(await gw.json('/plugins/settings')).toEqual({ enforce: false });
  });
});

describe('first-party plugins that ship with the gateway', () => {
  it('are approved when first seen, if they are exactly what shipped', async () => {
    await seedEnforce(s);
    writePlugin(s.modules, { id: 'first-party' });
    const checksum = pluginChecksum(path.join(s.modules, 'first-party'));
    const gw = await start({ plugins: { bundled: { 'first-party': checksum } } });
    const p = (await listPlugins(gw))['first-party'];
    expect(p.state).toBe('enabled');
    expect(p.approval).toMatchObject({ status: 'approved', approvedBy: 'bundled' });
    expect(auditRows('plugin.approved')[0]).toMatchObject({
      actor: 'gateway',
      detail: { bundled: true },
    });
  });

  it('are treated like any other once a file is changed', async () => {
    await seedEnforce(s);
    writePlugin(s.modules, { id: 'first-party' });
    const checksum = pluginChecksum(path.join(s.modules, 'first-party'));
    fs.appendFileSync(path.join(s.modules, 'first-party', 'dist', 'server.js'), '\n// tampered\n');
    const gw = await start({ plugins: { bundled: { 'first-party': checksum } } });
    expect((await listPlugins(gw))['first-party']).toMatchObject({
      state: 'awaiting_approval',
      approval: { status: 'not_approved' },
    });
  });

  it('are not approved by their id alone', async () => {
    await seedEnforce(s);
    writePlugin(s.modules, { id: 'impostor' });
    const gw = await start({ plugins: { bundled: { other: 'a'.repeat(64) } } });
    expect((await listPlugins(gw)).impostor.state).toBe('awaiting_approval');
  });
});

describe('who may reach it', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/plugins'],
    ['GET', '/plugins/settings'],
    ['PUT', '/plugins/settings', { enforce: true }],
    ['POST', '/plugins/p/enable', {}],
    ['POST', '/plugins/p/disable', {}],
    ['POST', '/plugins/p/approve', { permissionsHash: 'a', checksum: 'b' }],
  ];

  it('needs the gateway token, with and without /v1', async () => {
    writePlugin(s.modules, { id: 'p' });
    const gw = await start();
    for (const prefix of ['', '/v1']) {
      for (const [method, p, body] of routes) {
        const res = await gw.api(
          `${prefix}${p}`,
          { method, body: body ? JSON.stringify(body) : undefined },
          null
        );
        expect([method, prefix + p, res.status]).toEqual([method, prefix + p, 401]);
      }
    }
    expect((await gw.api('/v1/plugins')).status).toBe(200);
  });

  it('is for the gateway token only: a phone, a module and another tenant get 403', async () => {
    writePlugin(s.modules, { id: 'p' });
    const gw = await start();
    const phone = issueToken({
      kind: 'device',
      subject: 'dev_1',
      scopes: MOBILE_SCOPES,
      ttlMs: 60_000,
    });
    // A module given every scope there is: /plugins is out of reach whatever it says, so a
    // plugin's own token can never approve the plugin.
    const module = issueToken({ kind: 'module', subject: 'p', scopes: ['* /*'], ttlMs: 60_000 });
    const tenant = issueToken({
      kind: 'module',
      subject: 'p',
      scopes: ['* /*'],
      ttlMs: 60_000,
      tenantId: 'acme',
    });
    for (const { token } of [phone, module, tenant]) {
      for (const prefix of ['', '/v1']) {
        for (const [method, p, body] of routes) {
          const res = await gw.api(
            `${prefix}${p}`,
            { method, body: body ? JSON.stringify(body) : undefined },
            token
          );
          expect([method, prefix + p, res.status]).toEqual([method, prefix + p, 403]);
        }
      }
    }
    // The enforcement setting did not change, and nothing was approved.
    expect(await gw.json('/plugins/settings')).toEqual({ enforce: false });
    expect(TOKEN).toBeTruthy();
  });

  it('is in none of the scopes a phone is given', async () => {
    const gw = await start();
    expect(gw).toBeDefined();
    const phone = { kind: 'device' as const, scopes: MOBILE_SCOPES };
    for (const [method, p] of routes) {
      expect(principalAllows(phone, method, p)).toBe(false);
    }
  });

  it('is case-insensitive about the path, as the router is', async () => {
    const gw = await start();
    const module = issueToken({ kind: 'module', subject: 'p', scopes: ['* /*'], ttlMs: 60_000 });
    for (const p of ['/PLUGINS', '/Plugins/settings', '/plugins/%73ettings']) {
      expect([p, (await gw.api(p, {}, module.token)).status]).toEqual([p, 403]);
    }
  });
});

describe('what a plugin UI token reaches', () => {
  it('is the plugin’s own routes and the core endpoints it lists under permissions.api', async () => {
    writePlugin(s.modules, {
      id: 'ui',
      permissions: { api: ['GET /runs/:id', 'POST /records/resolve'] },
    });
    const gw = await start();
    const res = await post(gw, '/modules/ui/token');
    const { scopes, token } = (await res.json()) as { scopes: string[]; token: string };
    expect(scopes).toEqual(['* /api/modules/ui/*', 'GET /runs/:id', 'POST /records/resolve']);
    expect((await gw.api('/api/modules/ui/hi', {}, token)).status).toBe(200);
    expect((await gw.api('/runs/none', {}, token)).status).toBe(404);
    expect((await gw.api('/automations', {}, token)).status).toBe(403);
    // The plugin cannot approve itself, whatever the manifest says.
    expect((await gw.api('/plugins', {}, token)).status).toBe(403);
  });

  it('is revoked when the plugin stops', async () => {
    writePlugin(s.modules, { id: 'ui' });
    const gw = await start();
    const { token } = (await (await post(gw, '/modules/ui/token')).json()) as { token: string };
    expect((await gw.api('/api/modules/ui/hi', {}, token)).status).toBe(200);
    await post(gw, '/plugins/ui/disable');
    expect((await gw.api('/api/modules/ui/hi', {}, token)).status).toBe(401);
  });

  it('still reads coreEndpoints for a legacy module, with permissions.api alongside', async () => {
    const dir = path.join(s.modules, 'legacy-ui');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'legacy-ui',
        slug: 'legacy-ui',
        name: 'L',
        version: '0.1.0',
        coreEndpoints: ['GET /runs'],
        permissions: { api: ['GET /runs/:id'] },
      })
    );
    const gw = await start();
    const { scopes } = (await (await post(gw, '/modules/legacy-ui/token')).json()) as {
      scopes: string[];
    };
    expect(scopes).toEqual(['* /api/modules/legacy-ui/*', 'GET /runs/:id', 'GET /runs']);
    expect((await listPlugins(gw))['legacy-ui'].permissions).toMatchObject({
      api: ['GET /runs/:id', 'GET /runs'],
    });
  });
});
