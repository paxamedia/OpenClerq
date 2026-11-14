/**
 * The plugin lifecycle through a real gateway: the order of the hooks, upgrade on
 * a version change, stop (from `close()` and from disable), cleanup of everything
 * a plugin registered through its context, a failure in each hook, an engine the
 * gateway does not serve, and legacy modules beside plugins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from '../events.js';
import {
  auditRows,
  events,
  listPlugins,
  scratch,
  sleep,
  startGateway,
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

describe('the order of the hooks', () => {
  it('runs register then start, and no upgrade the first time', async () => {
    writePlugin(s.modules, { id: 'order' });
    const gw = await start();
    expect(events('order')).toEqual(['import', 'register', 'start']);
    expect(await (await gw.api('/api/modules/order/hi')).json()).toMatchObject({ ok: true });
    expect((await listPlugins(gw)).order).toMatchObject({ state: 'enabled', kind: 'plugin' });
  });

  it('runs the migrations before upgrade, upgrade before register, register before start', async () => {
    writePlugin(s.modules, {
      id: 'sequence',
      files: {
        'migrations/0001_things.sql': 'CREATE TABLE mod_sequence__things (id INTEGER PRIMARY KEY);',
      },
      hooks: `
  upgrade(ctx, { from }) {
    log.push('upgrade:' + from + ':table=' + (ctx.store.prepare("SELECT name FROM sqlite_master WHERE name = 'mod_sequence__things'").get() ? 'yes' : 'no'));
  },
  register(ctx) { log.push('register'); },
  start() { log.push('start'); },`,
    });
    await (await start()).close();
    // Same plugin, a new version: the table exists by the time upgrade runs.
    const manifest = path.join(s.modules, 'sequence', 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '1.1.0' })
    );
    events('sequence').length = 0;
    await start();
    // (The entry is the same file as before, so this process already has it: no second import.)
    expect(events('sequence')).toEqual(['upgrade:1.0.0:table=yes', 'register', 'start']);
  });

  it('calls upgrade only when the version changed since the last start', async () => {
    writePlugin(s.modules, { id: 'steady', version: '1.0.0' });
    await (await start()).close();
    events('steady').length = 0;
    await (running = await startGateway(s)).close();
    // Same version again: register and start, no upgrade.
    expect(events('steady').filter((e) => e.startsWith('upgrade'))).toEqual([]);

    const manifest = path.join(s.modules, 'steady', 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '2.0.0' })
    );
    events('steady').length = 0;
    await (running = await startGateway(s)).close();
    expect(events('steady').filter((e) => e.startsWith('upgrade'))).toEqual(['upgrade:1.0.0']);
  });

  it('gives upgrade another go when a later hook failed, so it must be safe to repeat', async () => {
    writePlugin(s.modules, { id: 'again' });
    await (await start()).close();
    const manifest = path.join(s.modules, 'again', 'manifest.json');
    const bump = (version: string) =>
      fs.writeFileSync(
        manifest,
        JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version })
      );
    bump('1.1.0');
    fs.writeFileSync(
      path.join(s.modules, 'again', 'dist', 'server.js'),
      `const log = ((globalThis.__plugins ??= {}).again ??= []);
export default {
  upgrade(_c, { from }) { log.push('upgrade:' + from); },
  register() { throw new Error('register broke'); },
};`
    );
    await (await start()).close();
    expect(events('again')).toContain('upgrade:1.0.0');
    events('again').length = 0;
    // The failed start did not count as having started 1.1.0.
    await start();
    expect(events('again')).toContain('upgrade:1.0.0');
  });
});

describe('stop', () => {
  it('runs from close(), while the store is still open', async () => {
    writePlugin(s.modules, {
      id: 'closer',
      hooks: `
  register(ctx) { log.push('register'); },
  stop(ctx) { ctx.audit.append('stopping'); log.push('stop'); },`,
    });
    const gw = await start();
    expect(events('closer')).not.toContain('stop');
    await gw.close();
    running = undefined;
    expect(events('closer')).toContain('stop');
  });

  it('runs on disable, and the plugin can enable again without a restart', async () => {
    writePlugin(s.modules, { id: 'toggle' });
    const gw = await start();
    const off = await gw.json<{ plugin: { state: string; switchedOff: boolean } }>(
      '/plugins/toggle/disable',
      { method: 'POST', body: '{}' }
    );
    expect(off.plugin).toMatchObject({ state: 'disabled', switchedOff: true });
    expect(events('toggle')).toEqual(['import', 'register', 'start', 'stop']);
    expect((await gw.api('/api/modules/toggle/hi')).status).toBe(404);
    // It is not in /modules (that lists what runs or failed), but is in /plugins.
    const { modules } = await gw.json<{ modules: Array<{ id: string }> }>('/modules');
    expect(modules.map((m) => m.id)).not.toContain('toggle');

    const on = await gw.json<{ plugin: { state: string } }>('/plugins/toggle/enable', {
      method: 'POST',
      body: '{}',
    });
    expect(on.plugin.state).toBe('enabled');
    expect(events('toggle')).toEqual(['import', 'register', 'start', 'stop', 'register', 'start']);
    expect((await gw.api('/api/modules/toggle/hi')).status).toBe(200);
  });

  it('keeps a plugin off across a restart, until it is turned on', async () => {
    writePlugin(s.modules, { id: 'stays-off' });
    await (await start()).api('/plugins/stays-off/disable', { method: 'POST', body: '{}' });
    await running?.close();
    events('stays-off').length = 0;
    const gw = await start();
    expect(events('stays-off')).toEqual([]);
    expect((await listPlugins(gw))['stays-off']).toMatchObject({ state: 'disabled' });
    // Not imported at all: a plugin that is off runs none of its code.
    expect(events('stays-off')).not.toContain('import');
  });

  it('runs the code on disk when it is enabled again, not what was loaded before', async () => {
    writePlugin(s.modules, { id: 'fresh', version: '1.0.0' });
    const gw = await start();
    await gw.api('/plugins/fresh/disable', { method: 'POST', body: '{}' });
    writePlugin(s.modules, {
      id: 'fresh',
      version: '1.0.1',
      hooks: `register(ctx) { ctx.routes.get('/hi', (_q, r) => r.json({ edition: 'new' })); },`,
    });
    await gw.api('/plugins/fresh/enable', { method: 'POST', body: '{}' });
    expect(await (await gw.api('/api/modules/fresh/hi')).json()).toEqual({ edition: 'new' });
  });

  it('finishes a slow start before a disable that came in the middle of it', async () => {
    writePlugin(s.modules, {
      id: 'slow',
      hooks: `
  register() { log.push('register'); },
  async start() { await new Promise((r) => setTimeout(r, 150)); log.push('start'); },
  stop() { log.push('stop'); },`,
    });
    const starting = start();
    await starting;
    const gw = running as Running;
    await gw.api('/plugins/slow/disable', { method: 'POST', body: '{}' });
    const enabling = gw.api('/plugins/slow/enable', { method: 'POST', body: '{}' });
    await sleep(20);
    const disabling = gw.api('/plugins/slow/disable', { method: 'POST', body: '{}' });
    await Promise.all([enabling, disabling]);
    expect(events('slow')).toEqual([
      'import',
      'register',
      'start',
      'stop',
      'register',
      'start',
      'stop',
    ]);
    expect((await listPlugins(gw)).slow.state).toBe('disabled');
  });
});

describe('everything a plugin registered through its context is removed', () => {
  const body = `
  register(ctx) {
    log.push('register');
    ctx.routes.get('/hi', (_q, r) => r.json({ ok: true }));
    ctx.routes.post('/item', (_q, r) => r.json(ctx.inbox.add({ kind: 'task', title: 'To do', externalId: 'one' })));
    ctx.triggers.register({ id: 'ping', kind: 'webhook', handler: () => ({ pong: true }) });
    ctx.events.subscribe('module.other.', () => { log.push('event'); });
    ctx.search.register(() => [{ ref: 'swept:thing:1', title: 'Swept thing' }]);
    ctx.inbox.onRespond(() => ({ answered: true }));
    globalThis.__swept = ctx;
  },
  start(ctx) {
    ctx.setInterval(() => { log.push('tick'); }, 10);
    ctx.setTimeout(() => { log.push('late'); }, 200);
  },`;

  it('takes routes, triggers, subscriptions, handlers and timers away after stop', async () => {
    writePlugin(s.modules, { id: 'swept', hooks: body });
    const gw = await start();
    const post = (p: string) => gw.api(p, { method: 'POST', body: '{}' });

    // While it runs, all of it works.
    await sleep(60);
    expect(events('swept')).toContain('tick');
    emit('module.other.one', {});
    expect(events('swept')).toContain('event');
    expect((await post('/api/modules/swept/triggers/ping')).status).toBe(202);
    expect(JSON.stringify(await gw.json('/search?q=thing'))).toContain('swept:thing:1');
    const item = (await (await post('/api/modules/swept/item')).json()) as { id: string };
    expect((await post(`/inbox/items/${item.id}/respond`)).status).toBe(200);

    const cleared = vi.spyOn(globalThis, 'clearInterval');
    await post('/plugins/swept/disable');
    // The context's own timers are cancelled, not left to notice they are stopped.
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
    const mark = () => events('swept').length;
    const at = mark();
    emit('module.other.two', {});
    await sleep(300);
    // No tick, no event, and the timer that was due in 200 ms never fired.
    expect(mark()).toBe(at);
    expect(events('swept')).not.toContain('late');

    expect((await gw.api('/api/modules/swept/hi')).status).toBe(404);
    expect((await post('/api/modules/swept/triggers/ping')).status).toBe(404);
    expect(JSON.stringify(await gw.json('/search?q=thing'))).not.toContain('swept:thing:1');
    // Its inbox item is still there, but nothing answers for it any more.
    const answer = await post(`/inbox/items/${item.id}/respond`);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(((await answer.json()) as { error: string }).error).toBe('no_handler');
  });

  it('refuses a registration from a task that outlives the plugin', async () => {
    writePlugin(s.modules, { id: 'swept', hooks: body });
    const gw = await start();
    await gw.api('/plugins/swept/disable', { method: 'POST', body: '{}' });
    const ctx = (globalThis as { __swept?: Record<string, any> }).__swept as Record<string, any>;
    expect(() => ctx.routes.get('/late', () => undefined)).toThrow('is stopped');
    expect(() => ctx.events.subscribe('*', () => undefined)).toThrow('is stopped');
    expect(() => ctx.setInterval(() => undefined, 10)).toThrow('is stopped');
    expect(() => ctx.triggers.register({ id: 'x', kind: 'webhook', handler: () => 1 })).toThrow(
      'is stopped'
    );
    await expect(ctx.exec('/bin/echo', ['x'])).rejects.toThrow('is stopped');
    await expect(ctx.fetch('https://example.com')).rejects.toThrow('is stopped');
  });

  it('logs and survives a timer callback that throws or rejects', async () => {
    writePlugin(s.modules, {
      id: 'timers',
      hooks: `
  register() {},
  start(ctx) {
    ctx.setInterval(() => { log.push('throw'); throw new Error('boom'); }, 10);
    ctx.setInterval(async () => { log.push('reject'); throw new Error('boom'); }, 10);
  },`,
    });
    const gw = await start();
    await sleep(80);
    expect(events('timers')).toEqual(expect.arrayContaining(['throw', 'reject']));
    // The gateway is still answering.
    expect((await gw.api('/plugins')).status).toBe(200);
  });

  it('skips a timer call that would overlap the last one, and refuses a bad interval', async () => {
    writePlugin(s.modules, {
      id: 'overlap',
      hooks: `
  register() {},
  start(ctx) {
    ctx.setInterval(async () => { log.push('call'); await new Promise((r) => setTimeout(r, 120)); }, 10);
    for (const bad of [0, -1, NaN, '5']) {
      try { ctx.setInterval(() => {}, bad); log.push('accepted'); } catch { log.push('refused'); }
    }
  },`,
    });
    await start();
    await sleep(100);
    const calls = events('overlap').filter((e) => e === 'call').length;
    expect(calls).toBe(1);
    expect(events('overlap').filter((e) => e === 'refused')).toHaveLength(4);
  });
});

describe('a hook that throws', () => {
  const failing = (hook: 'upgrade' | 'register' | 'start' | 'stop') => `
  upgrade(ctx, { from }) { ${hook === 'upgrade' ? "throw new Error('upgrade broke');" : "log.push('upgrade');"} },
  register(ctx) {
    ctx.routes.get('/hi', (_q, r) => r.json({ ok: true }));
    ctx.triggers.register({ id: 'ping', kind: 'webhook', handler: () => 1 });
    ctx.events.subscribe('*', () => { log.push('event'); });
    ctx.search.register(() => [{ ref: 'broke:thing:1', title: 'Broke thing' }]);
    ctx.inbox.onRespond(() => 1);
    ctx.setInterval(() => { log.push('tick'); }, 10);
    log.push('register');
    ${hook === 'register' ? "throw new Error('register broke');" : ''}
  },
  start(ctx) { log.push('start'); ${hook === 'start' ? "throw new Error('start broke');" : ''} },
  stop(ctx) { log.push('stop'); ${hook === 'stop' ? "throw new Error('stop broke');" : ''} },`;

  const upgraded = async () => {
    // upgrade only runs when the version changed since the last start.
    writePlugin(s.modules, {
      id: 'broke',
      version: '1.0.0',
      hooks: failing('start').replace("throw new Error('start broke');", ''),
    });
    await (await start()).close();
    events('broke').length = 0;
    const manifest = path.join(s.modules, 'broke', 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '1.1.0' })
    );
  };

  const removed = async (gw: Running) => {
    const ticks = events('broke').filter((e) => e === 'tick').length;
    await sleep(60);
    expect(events('broke').filter((e) => e === 'tick').length).toBe(ticks);
    expect((await gw.api('/api/modules/broke/hi')).status).toBe(404);
    expect(
      (await gw.api('/api/modules/broke/triggers/ping', { method: 'POST', body: '{}' })).status
    ).toBe(404);
    expect(JSON.stringify(await gw.json('/search?q=thing'))).not.toContain('broke:thing:1');
  };

  it.each(['register', 'start'] as const)(
    'marks the plugin failed with the error and removes what it had set up when %s throws',
    async (hook) => {
      writePlugin(s.modules, { id: 'broke', hooks: failing(hook) });
      const gw = await start();
      const p = (await listPlugins(gw)).broke;
      expect(p.state).toBe('failed');
      expect(p.reason).toBe(`${hook}() failed: ${hook} broke`);
      await removed(gw);
      // A failed start does not get a stop: nothing finished starting.
      expect(events('broke')).not.toContain('stop');
      const { modules } = await gw.json<{ modules: Array<{ id: string; status: string }> }>(
        '/modules'
      );
      expect(modules.find((m) => m.id === 'broke')?.status).toBe('failed');
      expect(auditRows('plugin.failed').some((r) => r.subject === 'broke')).toBe(true);
    }
  );

  it('marks the plugin failed when upgrade throws, before register ran', async () => {
    await upgraded();
    writePlugin(s.modules, { id: 'broke', version: '1.1.0', hooks: failing('upgrade') });
    const gw = await start();
    const p = (await listPlugins(gw)).broke;
    expect(p.state).toBe('failed');
    expect(p.reason).toBe('upgrade() failed: upgrade broke');
    expect(events('broke')).not.toContain('register');
    await removed(gw);
  });

  it('marks the plugin failed when stop throws, and still removes what it set up', async () => {
    writePlugin(s.modules, { id: 'broke', hooks: failing('stop') });
    const gw = await start();
    const off = await gw.json<{ plugin: { state: string; reason: string } }>(
      '/plugins/broke/disable',
      { method: 'POST', body: '{}' }
    );
    expect(off.plugin.state).toBe('failed');
    expect(off.plugin.reason).toBe('stop() failed: stop broke');
    await removed(gw);
    // It is still switched off: the next start does not run it.
    await running?.close();
    events('broke').length = 0;
    const again = await start();
    expect((await listPlugins(again)).broke.state).toBe('disabled');
    expect(events('broke')).toEqual([]);
  });

  it('gives a hook that never finishes a limit, and says so', async () => {
    writePlugin(s.modules, {
      id: 'hangs',
      hooks: `register() {}, start() { return new Promise(() => {}); },`,
    });
    const gw = await start({ plugins: { hookTimeoutMs: 100 } });
    expect((await listPlugins(gw)).hangs).toMatchObject({
      state: 'failed',
      reason: 'start() failed: start() did not finish in 100 milliseconds.',
    });
  });

  it('can be enabled again once it is fixed', async () => {
    writePlugin(s.modules, { id: 'broke', hooks: failing('register') });
    const gw = await start();
    expect((await listPlugins(gw)).broke.state).toBe('failed');
    writePlugin(s.modules, { id: 'broke', version: '1.0.1' });
    const fixed = await gw.json<{ plugin: { state: string } }>('/plugins/broke/enable', {
      method: 'POST',
      body: '{}',
    });
    expect(fixed.plugin.state).toBe('enabled');
  });

  it('stays a legacy module in how it reports an error: the message as it is', async () => {
    const dir = path.join(s.modules, 'old');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'old', slug: 'old', name: 'Old', version: '0.1.0' })
    );
    fs.writeFileSync(
      path.join(dir, 'dist', 'routes.js'),
      "export function register() { throw new Error('cannot start'); }\n"
    );
    const gw = await start();
    expect((await listPlugins(gw)).old).toMatchObject({
      state: 'failed',
      kind: 'legacy',
      reason: 'cannot start',
    });
  });
});

describe('the engine', () => {
  it('refuses a plugin that needs an API version this gateway does not serve, and says why', async () => {
    writePlugin(s.modules, { id: 'future', manifest: { engines: { api: 2 } } });
    const gw = await start();
    const p = (await listPlugins(gw)).future;
    expect(p.state).toBe('refused');
    expect(p.reason).toBe(
      'This plugin needs OpenClerq API version 2, and this OpenClerq serves version 1. Update OpenClerq, or use an older release of the plugin.'
    );
    // Nothing of it ran, and turning it on does not change that.
    expect(events('future')).toEqual([]);
    const on = await gw.json<{ plugin: { state: string } }>('/plugins/future/enable', {
      method: 'POST',
      body: '{}',
    });
    expect(on.plugin.state).toBe('refused');
    expect(events('future')).toEqual([]);
    expect(auditRows('plugin.refused').some((r) => r.subject === 'future')).toBe(true);
    const { modules } = await gw.json<{ modules: Array<{ id: string }> }>('/modules');
    expect(modules.map((m) => m.id)).not.toContain('future');
  });

  it('serves a plugin written for the version it does', async () => {
    writePlugin(s.modules, { id: 'now' });
    expect((await listPlugins(await start())).now.state).toBe('enabled');
  });
});

describe('manifests that are not valid', () => {
  it('lists a plugin with a bad manifest as failed, in plain words, and runs none of it', async () => {
    writePlugin(s.modules, {
      id: 'sloppy',
      manifest: { version: '1', permissions: { root: true }, engines: {} },
    });
    const gw = await start();
    const p = (await listPlugins(gw)).sloppy;
    expect(p.state).toBe('failed');
    expect(p.reason).toContain('The manifest is not valid.');
    expect(p.reason).toContain('"version" must be a semantic version');
    expect(p.reason).toContain('permissions.root is not a known permission.');
    expect(p.reason).not.toMatch(/line \d/);
    expect(events('sloppy')).toEqual([]);
    const row = await gw.api('/plugins/sloppy/approve', {
      method: 'POST',
      body: JSON.stringify({ permissionsHash: 'a', checksum: 'b' }),
    });
    expect(row.status).toBe(409);
    expect(((await row.json()) as { error: string }).error).toBe('not_approvable');
  });

  it('says when the server entry is missing or does not export register', async () => {
    writePlugin(s.modules, { id: 'missing', manifest: { entry: { server: 'dist/nope.js' } } });
    writePlugin(s.modules, { id: 'mute', hooks: 'start() {},' });
    const gw = await start();
    const all = await listPlugins(gw);
    expect(all.missing).toMatchObject({
      state: 'failed',
      reason: 'The server entry dist/nope.js does not exist.',
    });
    expect(all.mute.state).toBe('failed');
    expect(all.mute.reason).toContain('does not export register(ctx)');
  });

  it('serves a plugin that has only a UI and skills', async () => {
    writePlugin(s.modules, {
      id: 'ui-only',
      noServer: true,
      manifest: { entry: { ui: 'web' }, skills: 'prompts' },
      files: { 'web/index.html': '<h1>hi</h1>', 'prompts/one/SKILL.md': '---\nname: one\n---\nx' },
    });
    const gw = await start();
    expect((await listPlugins(gw))['ui-only'].state).toBe('enabled');
    const ui = await gw.api('/api/modules/ui-only/ui/', {}, null);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('<h1>hi</h1>');
  });
});

describe('legacy modules beside plugins', () => {
  it('loads a module without manifestVersion as before and labels it legacy', async () => {
    fs.cpSync(HELLO_WORLD, path.join(s.modules, 'hello-world'), { recursive: true });
    writePlugin(s.modules, { id: 'modern' });
    const gw = await start();
    const all = await listPlugins(gw);
    expect(all['hello-world']).toMatchObject({ kind: 'legacy', state: 'enabled' });
    expect(all.modern).toMatchObject({ kind: 'plugin', state: 'enabled' });
    const { modules } = await gw.json<{ modules: Array<{ id: string; kind: string }> }>('/modules');
    expect(modules.find((m) => m.id === 'hello-world')?.kind).toBe('legacy');
    expect(modules.find((m) => m.id === 'modern')?.kind).toBe('plugin');
    expect((await gw.api('/api/modules/hello-world/hello?name=Ada')).status).toBe(200);
  });

  it('gives a legacy module no hooks but register: its start, stop and upgrade are never called', async () => {
    const dir = path.join(s.modules, 'plain');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'plain', slug: 'plain', name: 'Plain', version: '0.1.0' })
    );
    fs.writeFileSync(
      path.join(dir, 'dist', 'routes.js'),
      `const log = ((globalThis.__plugins ??= {}).plain ??= []);
export function register() { log.push('register'); }
export function start() { log.push('start'); }
export function stop() { log.push('stop'); }
export function upgrade() { log.push('upgrade'); }
`
    );
    const gw = await start();
    await gw.api('/plugins/plain/disable', { method: 'POST', body: '{}' });
    await gw.api('/plugins/plain/enable', { method: 'POST', body: '{}' });
    expect(events('plain')).toEqual(['register', 'register']);
  });

  it('keeps the pre-0.6 contract: a routes array and a register that pushes onto it', async () => {
    const dir = path.join(s.modules, 'ancient');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'ancient', slug: 'ancient', name: 'A', version: '0.1.0' })
    );
    fs.writeFileSync(
      path.join(dir, 'dist', 'routes.js'),
      `export const routes = [{ method: 'GET', path: '/old', handler: async (_q, r) => r.json({ old: true }) }];`
    );
    const gw = await start();
    expect(await (await gw.api('/api/modules/ancient/old')).json()).toEqual({ old: true });
  });
});
