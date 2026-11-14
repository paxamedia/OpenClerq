/**
 * What runs is what was approved: a plugin's server entry is copied to a path named
 * by its hash and imported from there, and a legacy module is loaded once per start.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pluginChecksumDetail } from '@clerq/plugin-sdk/node';
import { discoverOne } from '../module-loader.js';
import { readMigrations, stageEntry, stageRoot } from './host.js';
import {
  events,
  listPlugins,
  scratch,
  startGateway,
  writePlugin,
  type Running,
  type Scratch,
} from './plugins.harness.js';

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

const start = async () => (running = await startGateway(s));
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

const factsOf = (dir: string) => ({
  files: pluginChecksumDetail(dir).files,
});

describe('staging a plugin’s entry', () => {
  it('copies the entry to a path named by its hash, and imports that copy', async () => {
    writePlugin(s.modules, {
      id: 'staged',
      hooks: `register() { log.push(import.meta.url); },`,
    });
    await start();
    const original = path.join(s.modules, 'staged', 'dist', 'server.js');
    const digest = sha(fs.readFileSync(original)).slice(0, 32);
    const copy = path.join(stageRoot(), 'staged', digest, 'server.js');
    expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(original));
    expect(events('staged')[1]).toBe(`file://${fs.realpathSync(copy)}`);
    // Private to the user, like the rest of ~/.clerq.
    expect(fs.statSync(copy).mode & 0o077).toBe(0);
  });

  it('answers changed when the file is not the one that was read when the decision was made', () => {
    const dir = writePlugin(s.modules, { id: 'swapped' });
    const d = discoverOne(dir);
    expect(d).toBeTruthy();
    const facts = factsOf(dir);
    // The file is replaced after it was hashed and before it is imported.
    fs.writeFileSync(
      path.join(dir, 'dist', 'server.js'),
      'export default { register() { /* other */ } };'
    );
    expect(stageEntry(d as never, facts)).toEqual({ changed: true });
    expect(fs.existsSync(path.join(stageRoot(), 'swapped'))).toBe(false);
  });

  it('copies exactly the bytes that were hashed, and runs them though the original changes after', () => {
    const dir = writePlugin(s.modules, { id: 'exact' });
    const d = discoverOne(dir);
    const facts = factsOf(dir);
    const before = fs.readFileSync(path.join(dir, 'dist', 'server.js'));
    const staged = stageEntry(d as never, facts) as { path: string };
    fs.writeFileSync(path.join(dir, 'dist', 'server.js'), 'export default {};');
    expect(fs.readFileSync(staged.path)).toEqual(before);
  });

  it('repairs a staged copy that was changed on disk, and removes copies of other versions', () => {
    const dir = writePlugin(s.modules, { id: 'repair' });
    const d = discoverOne(dir);
    const first = stageEntry(d as never, factsOf(dir)) as { path: string };
    fs.writeFileSync(first.path, 'export default { evil: true };');
    const again = stageEntry(d as never, factsOf(dir)) as { path: string };
    expect(again.path).toBe(first.path);
    expect(fs.readFileSync(again.path, 'utf8')).not.toContain('evil');

    fs.appendFileSync(path.join(dir, 'dist', 'server.js'), '\n// v2\n');
    const next = stageEntry(discoverOne(dir) as never, factsOf(dir)) as { path: string };
    expect(next.path).not.toBe(first.path);
    expect(fs.readdirSync(path.join(stageRoot(), 'repair'))).toEqual([
      path.basename(path.dirname(next.path)),
    ]);
  });

  it('says there is nothing to stage for a plugin with no server, or a file that is gone', () => {
    const none = writePlugin(s.modules, { id: 'no-server', noServer: true });
    expect(stageEntry(discoverOne(none) as never, { files: [] })).toEqual({ path: undefined });
    const gone = writePlugin(s.modules, { id: 'gone' });
    const d = discoverOne(gone);
    fs.rmSync(path.join(gone, 'dist', 'server.js'));
    expect(stageEntry(d as never, { files: [] })).toEqual({ path: undefined });
  });

  it('runs a new version of a plugin when it is enabled again, from a new copy', async () => {
    writePlugin(s.modules, { id: 'again', hooks: `register() { log.push('v1'); },` });
    const gw = await start();
    await gw.api('/plugins/again/disable', { method: 'POST', body: '{}' });
    writePlugin(s.modules, {
      id: 'again',
      version: '1.0.1',
      hooks: `register() { log.push('v2'); },`,
    });
    await gw.api('/plugins/again/enable', { method: 'POST', body: '{}' });
    expect(events('again').filter((e) => /^v\d/.test(e))).toEqual(['v1', 'v2']);
    expect(fs.readdirSync(path.join(stageRoot(), 'again'))).toHaveLength(1);
  });

  it('cannot load a plugin that imports a neighbour: one self-contained file is the contract', async () => {
    writePlugin(s.modules, {
      id: 'chunky',
      hooks: `register() {},`,
      top: `import { helper } from './helper.js'; log.push(String(helper));`,
      files: { 'dist/helper.js': 'export const helper = 1;' },
    });
    const gw = await start();
    const p = (await listPlugins(gw)).chunky;
    expect(p.state).toBe('failed');
    expect(p.reason).toContain('must be one self-contained file');
  });
});

describe('a plugin’s migrations', () => {
  it('are refused when a file is not what was approved', () => {
    const dir = writePlugin(s.modules, {
      id: 'migrating',
      files: { 'migrations/0001_a.sql': 'CREATE TABLE mod_migrating__a (id INTEGER);' },
    });
    const verify = new Map(factsOf(dir).files.map((f) => [f.path, f.sha256]));
    expect(readMigrations(dir, verify).map((m) => m.name)).toEqual(['a']);
    fs.writeFileSync(path.join(dir, 'migrations', '0001_a.sql'), 'DROP TABLE runs;');
    expect(() => readMigrations(dir, verify)).toThrow('changed while the plugin was being loaded');
    // Without a list to check against (a legacy module), they are read as they always were.
    expect(readMigrations(dir)).toHaveLength(1);
  });
});

describe('a legacy module’s code is loaded once per start', () => {
  const legacy = (code: string) => {
    const dir = path.join(s.modules, 'old');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'old', slug: 'old', name: 'Old', version: '0.1.0' })
    );
    fs.writeFileSync(path.join(dir, 'dist', 'routes.js'), code);
  };

  it('is run again as it was after a disable and an enable', async () => {
    legacy(
      `const log = ((globalThis.__plugins ??= {}).old ??= []); log.push('import');
export function register(ctx) { log.push('register'); ctx.routes.get('/x', (_q, r) => r.json({ v: 1 })); }`
    );
    const gw = await start();
    await gw.api('/plugins/old/disable', { method: 'POST', body: '{}' });
    await gw.api('/plugins/old/enable', { method: 'POST', body: '{}' });
    expect(events('old')).toEqual(['import', 'register', 'register']);
    expect((await gw.api('/api/modules/old/x')).status).toBe(200);
  });

  it('waits for a restart when its files changed, and says so', async () => {
    legacy(`export function register(ctx) { ctx.routes.get('/x', (_q, r) => r.json({ v: 1 })); }`);
    const gw = await start();
    await gw.api('/plugins/old/disable', { method: 'POST', body: '{}' });
    legacy(`export function register(ctx) { ctx.routes.get('/x', (_q, r) => r.json({ v: 2 })); }`);
    const on = await gw.api('/plugins/old/enable', { method: 'POST', body: '{}' });
    const { plugin } = (await on.json()) as { plugin: { state: string; reason: string } };
    expect(plugin.state).toBe('failed');
    expect(plugin.reason).toBe(
      'Its files changed since OpenClerq started. Restart OpenClerq to run the new version.'
    );
    expect((await gw.api('/api/modules/old/x')).status).toBe(404);
  });
});
