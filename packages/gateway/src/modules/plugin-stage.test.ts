/**
 * What runs is what was approved: a plugin, or a legacy module, is copied (exactly the files that
 * were hashed) to a folder named by its checksum, and imported, served and read from there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pluginChecksumDetail } from '@clerq/plugin-sdk/node';
import { discoverOne } from '../module-loader.js';
import { readMigrations } from './host.js';
import { stagePlugin, stageRoot } from './plugin-stage.js';
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

const detail = (dir: string) => pluginChecksumDetail(dir);
const stage = (dir: string, d = discoverOne(dir)) => {
  const facts = detail(dir);
  return stagePlugin(d as never, facts);
};

describe('staging a plugin', () => {
  it('copies exactly the hashed files to a folder named by the checksum, and imports from there', async () => {
    writePlugin(s.modules, {
      id: 'staged',
      hooks: `register() { log.push(import.meta.url); },`,
      files: { 'README.md': 'not code', 'dist/lib/a.js': 'export const a = 1;' },
    });
    await start();
    const dir = path.join(s.modules, 'staged');
    const { checksum, files } = detail(dir);
    const copy = path.join(stageRoot(), 'staged', checksum.slice(0, 32));
    for (const f of files) {
      expect(fs.readFileSync(path.join(copy, f.path)).toString('hex')).toBe(
        f.path === 'manifest.json'
          ? Buffer.from(fs.readFileSync(path.join(dir, f.path))).toString('hex')
          : fs.readFileSync(path.join(dir, f.path)).toString('hex')
      );
    }
    // Nothing else came: the readme is not code.
    expect(fs.existsSync(path.join(copy, 'README.md'))).toBe(false);
    expect(events('staged')[1]).toBe(
      `file://${fs.realpathSync(path.join(copy, 'dist', 'server.js'))}`
    );
    // Private to the user, like the rest of ~/.clerq.
    expect(fs.statSync(path.join(copy, 'dist', 'server.js')).mode & 0o077).toBe(0);
    expect(fs.statSync(copy).mode & 0o077).toBe(0);
  });

  it('answers changed when a file is not the one that was read when the decision was made', () => {
    const dir = writePlugin(s.modules, {
      id: 'swapped',
      files: { 'dist/lib/a.js': 'export const a = 1;' },
    });
    const d = discoverOne(dir);
    const facts = detail(dir);
    fs.writeFileSync(path.join(dir, 'dist', 'lib', 'a.js'), 'export const a = 2;');
    expect(stagePlugin(d as never, facts)).toEqual({ changed: true });
    // A file that is gone is a change as well.
    fs.rmSync(path.join(dir, 'dist', 'lib', 'a.js'));
    expect(stagePlugin(d as never, facts)).toEqual({ changed: true });
    // Nothing half-written is left behind.
    expect(fs.readdirSync(path.join(stageRoot(), 'swapped'))).toEqual([]);
  });

  it('copies the bytes that were hashed, and runs them though the original changes after', () => {
    const dir = writePlugin(s.modules, {
      id: 'exact',
      files: { 'dist/lib/a.js': 'export const a = 1;' },
    });
    const before = fs.readFileSync(path.join(dir, 'dist', 'lib', 'a.js'));
    const staged = stage(dir) as { dir: string };
    fs.writeFileSync(path.join(dir, 'dist', 'lib', 'a.js'), 'export const a = 2;');
    expect(fs.readFileSync(path.join(staged.dir, 'dist', 'lib', 'a.js'))).toEqual(before);
  });

  it('writes the manifest as it was validated, not as it is on disk now', () => {
    const dir = writePlugin(s.modules, { id: 'manifest' });
    const d = discoverOne(dir) as { manifestText: string };
    const facts = detail(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ "changed": true }');
    const staged = stagePlugin(d as never, facts) as { dir: string };
    expect(fs.readFileSync(path.join(staged.dir, 'manifest.json'), 'utf8')).toBe(d.manifestText);
  });

  it('repairs a copy that was altered or has a stray file, and removes other versions', () => {
    const dir = writePlugin(s.modules, { id: 'repair' });
    const first = stage(dir) as { dir: string };
    fs.writeFileSync(path.join(first.dir, 'dist', 'server.js'), 'export default { evil: true };');
    fs.writeFileSync(path.join(first.dir, 'dist', 'extra.js'), 'export const extra = 1;');
    const again = stage(dir) as { dir: string };
    expect(again.dir).toBe(first.dir);
    expect(fs.readFileSync(path.join(again.dir, 'dist', 'server.js'), 'utf8')).not.toContain(
      'evil'
    );
    expect(fs.existsSync(path.join(again.dir, 'dist', 'extra.js'))).toBe(false);

    fs.appendFileSync(path.join(dir, 'dist', 'server.js'), '\n// v2\n');
    const next = stage(dir) as { dir: string };
    expect(next.dir).not.toBe(first.dir);
    expect(fs.readdirSync(path.join(stageRoot(), 'repair'))).toEqual([path.basename(next.dir)]);
  });

  it('keeps an executable bit the file had, and nothing for group or others', () => {
    const dir = writePlugin(s.modules, {
      id: 'modes',
      files: { 'dist/bin/tool': '#!/bin/sh\necho x\n' },
    });
    fs.chmodSync(path.join(dir, 'dist', 'bin', 'tool'), 0o755);
    const staged = stage(dir) as { dir: string };
    expect(fs.statSync(path.join(staged.dir, 'dist', 'bin', 'tool')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(staged.dir, 'dist', 'server.js')).mode & 0o777).toBe(0o600);
  });

  it('has nothing to say for a checksum it was not given', () => {
    const dir = writePlugin(s.modules, { id: 'nosum' });
    expect(stagePlugin(discoverOne(dir) as never, { checksum: null, files: [] })).toMatchObject({
      error: expect.stringContaining('no checksum'),
    });
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

  it('lets a plugin import its neighbours, so one file is no longer the contract', async () => {
    writePlugin(s.modules, {
      id: 'chunky',
      hooks: `register() {},`,
      top: `import { helper } from './helper.js'; log.push('helper:' + helper);`,
      files: { 'dist/helper.js': 'export const helper = 1;' },
    });
    const gw = await start();
    expect((await listPlugins(gw)).chunky.state).toBe('enabled');
    expect(events('chunky')).toContain('helper:1');
  });

  it('serves a plugin that has only a UI folder and skills from the copy', async () => {
    writePlugin(s.modules, {
      id: 'ui-only',
      noServer: true,
      manifest: { entry: { ui: 'web' }, skills: 'prompts' },
      files: { 'web/index.html': '<h1>hi</h1>', 'prompts/one/SKILL.md': '---\nname: one\n---\nx' },
    });
    const gw = await start();
    expect((await listPlugins(gw))['ui-only'].state).toBe('enabled');
    expect(await (await gw.api('/api/modules/ui-only/ui/', {}, null)).text()).toBe('<h1>hi</h1>');
  });
});

describe('a plugin’s migrations', () => {
  it('are the staged copy’s: a migration that changes after approval is a change, not run', () => {
    const dir = writePlugin(s.modules, {
      id: 'migrating',
      files: { 'migrations/0001_a.sql': 'CREATE TABLE mod_migrating__a (id INTEGER);' },
    });
    const d = discoverOne(dir);
    const facts = detail(dir);
    fs.writeFileSync(path.join(dir, 'migrations', '0001_a.sql'), 'DROP TABLE runs;');
    expect(stagePlugin(d as never, facts)).toEqual({ changed: true });
    // What is read for a module is read from where it is told: the staged copy.
    const fresh = writePlugin(s.modules, {
      id: 'migrating2',
      files: { 'migrations/0001_a.sql': 'CREATE TABLE mod_migrating2__a (id INTEGER);' },
    });
    const approved = detail(fresh).files.find((f) => f.path === 'migrations/0001_a.sql')?.sha256;
    const staged = stage(fresh) as { dir: string };
    fs.writeFileSync(path.join(fresh, 'migrations', '0001_a.sql'), 'DROP TABLE runs;');
    const sql = readMigrations(staged.dir).map((m) => m.sql);
    expect(sql).toEqual(['CREATE TABLE mod_migrating2__a (id INTEGER);']);
    expect(sha(sql[0])).toBe(approved);
  });
});

describe('a legacy module is staged too', () => {
  const legacy = (code: string, extra: Record<string, string> = {}) => {
    const dir = path.join(s.modules, 'old');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'old', slug: 'old', name: 'Old', version: '0.1.0' })
    );
    fs.writeFileSync(path.join(dir, 'dist', 'routes.js'), code);
    for (const [rel, text] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  };

  it('runs again as it was after a disable and an enable', async () => {
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

  it('runs the new code when it is enabled again after its files changed: the copy is refreshed with the hash', async () => {
    legacy(`export function register(ctx) { ctx.routes.get('/x', (_q, r) => r.json({ v: 1 })); }`);
    const gw = await start();
    await gw.api('/plugins/old/disable', { method: 'POST', body: '{}' });
    legacy(`export function register(ctx) { ctx.routes.get('/x', (_q, r) => r.json({ v: 2 })); }`);
    const on = await gw.api('/plugins/old/enable', { method: 'POST', body: '{}' });
    expect(((await on.json()) as { plugin: { state: string } }).plugin.state).toBe('enabled');
    expect(await (await gw.api('/api/modules/old/x')).json()).toEqual({ v: 2 });
    expect(fs.readdirSync(path.join(stageRoot(), 'old'))).toHaveLength(1);
  });

  it('stages the entry’s whole folder, and keeps its own folder as ctx.dir', async () => {
    legacy(
      `import { n } from './n.js'; export function register(ctx) { ctx.routes.get('/n', (_q, r) => r.json({ n, dir: ctx.dir })); }`,
      { 'dist/n.js': 'export const n = 7;', 'unrelated/data.txt': 'x' }
    );
    const gw = await start();
    const out = (await (await gw.api('/api/modules/old/n')).json()) as { n: number; dir: string };
    expect(out.n).toBe(7);
    // A legacy module keeps its folder as ctx.dir, as it always had.
    expect(fs.realpathSync(out.dir)).toBe(fs.realpathSync(path.join(s.modules, 'old')));
    const { checksum } = detail(path.join(s.modules, 'old'));
    const copy = path.join(stageRoot(), 'old', checksum.slice(0, 32));
    expect(fs.existsSync(path.join(copy, 'dist', 'n.js'))).toBe(true);
    expect(fs.existsSync(path.join(copy, 'unrelated'))).toBe(false);
  });
});
