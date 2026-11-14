/**
 * What an approval covers is what runs. A person with a text editor (or a plugin that writes to its
 * own folder) edits a file the approval was supposed to cover; the plugin is run and served from a
 * copy of exactly the files that were hashed, and an edit shows as a change.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
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

async function approve(gw: Running, id: string) {
  const p = (await listPlugins(gw))[id];
  const res = await gw.api(`/plugins/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
  });
  expect(res.status).toBe(200);
}

const get = async (gw: Running, p: string, token: string | null = TOKEN) =>
  (await gw.api(p, {}, token)).text();
const word = async (gw: Running, id: string) =>
  JSON.parse(await get(gw, `/api/modules/${id}/word`)) as { word?: string };

const edit = (rel: string, text: string) => fs.writeFileSync(path.join(s.modules, rel), text);

/** A legacy module whose entry imports a neighbour: dist/routes.js -> dist/helper.js. */
function legacySibling(id = 'legacy-sib') {
  const dir = path.join(s.modules, id);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, name: 'Legacy sibling', version: '1.0.0' })
  );
  fs.writeFileSync(
    path.join(dir, 'dist', 'routes.js'),
    `import { word } from './helper.js';\nexport function register(ctx) { ctx.routes.get('/word', (_q, res) => res.json({ word })); }\n`
  );
  fs.writeFileSync(path.join(dir, 'dist', 'helper.js'), `export const word = 'approved-helper';\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  return dir;
}

describe('what an approval covers is what runs', () => {
  it('a legacy module’s helper file: editing it is a change, and the edit does not run', async () => {
    legacySibling();
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'legacy-sib');
    expect(await word(gw, 'legacy-sib')).toEqual({ word: 'approved-helper' });
    const before = (await listPlugins(gw))['legacy-sib'].checksum;

    edit('legacy-sib/dist/helper.js', `export const word = 'EDITED-helper';\n`);

    // The checksum moved, though only the neighbour changed.
    const after = (await listPlugins(gw))['legacy-sib'];
    expect(after.checksum).not.toBe(before);
    expect(after.approval.status).toBe('changed');
    expect(after.approval.changes.code).toBe(true);
    // The running module keeps what was approved: it runs from the copy.
    expect(await word(gw, 'legacy-sib')).toEqual({ word: 'approved-helper' });

    // After a restart the change waits for a person.
    await gw.close();
    const next = await start();
    const p = (await listPlugins(next))['legacy-sib'];
    expect(p).toMatchObject({ state: 'awaiting_approval', approval: { status: 'changed' } });
    expect((await next.api('/api/modules/legacy-sib/word')).status).toBe(404);
    await approve(next, 'legacy-sib');
    expect(await word(next, 'legacy-sib')).toEqual({ word: 'EDITED-helper' });
  });

  it('a plugin’s own folder is covered: its helpers load, and an edit needs approval', async () => {
    writePlugin(s.modules, {
      id: 'folder',
      top: `import { word } from './lib/util.js'; log.push('util:' + word);`,
      files: { 'dist/lib/util.js': `export const word = 'util-v1';` },
      hooks: `register(ctx) { ctx.routes.get('/word', (_q, r) => r.json({ word: 'ok' })); },`,
    });
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'folder');
    expect(events('folder')).toContain('util:util-v1');
    const checksum = (await listPlugins(gw)).folder.checksum;
    edit('folder/dist/lib/util.js', `export const word = 'util-EDITED';`);
    expect((await listPlugins(gw)).folder.checksum).not.toBe(checksum);
    expect((await listPlugins(gw)).folder.approval.status).toBe('changed');
    await gw.close();
    events('folder').length = 0;
    const next = await start();
    expect((await listPlugins(next)).folder.state).toBe('awaiting_approval');
    expect(events('folder')).toEqual([]);
  });

  it('a file outside the entry’s folder is not covered, so it is not copied and cannot be imported', async () => {
    writePlugin(s.modules, {
      id: 'outside',
      top: `import { x } from '../lib/outside.js'; log.push(x);`,
      files: { 'lib/outside.js': `export const x = 'unhashed';` },
      hooks: `register() {},`,
    });
    const gw = await start();
    const p = (await listPlugins(gw)).outside;
    expect(p.state).toBe('failed');
    expect(p.reason).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
    expect(events('outside')).not.toContain('unhashed');
  });

  it('serves the UI from the copy: an edit after approval is not served, and shows as changed', async () => {
    writePlugin(s.modules, {
      id: 'ui',
      manifest: { entry: { server: 'dist/server.js', ui: 'ui' } },
      files: { 'ui/index.html': '<p>approved ui</p>' },
    });
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'ui');
    expect(await get(gw, '/api/modules/ui/ui/', null)).toBe('<p>approved ui</p>');

    edit('ui/ui/index.html', '<p>CHANGED ui, never approved</p>');

    expect(await get(gw, '/api/modules/ui/ui/', null)).toBe('<p>approved ui</p>');
    const p = (await listPlugins(gw)).ui;
    expect(p).toMatchObject({
      state: 'enabled',
      needsRestart: true,
      approval: { status: 'changed' },
    });
    // Not even after the plugin is turned off and on: it needs the new approval first.
    await gw.api('/plugins/ui/disable', { method: 'POST', body: '{}' });
    await gw.api('/plugins/ui/enable', { method: 'POST', body: '{}' });
    expect((await listPlugins(gw)).ui.state).toBe('awaiting_approval');
    expect((await gw.api('/api/modules/ui/ui/', {}, null)).status).toBe(404);
    await approve(gw, 'ui');
    expect(await get(gw, '/api/modules/ui/ui/', null)).toBe('<p>CHANGED ui, never approved</p>');
  });

  it('serves a legacy module’s UI from the copy too, with enforcement off', async () => {
    const dir = legacySibling('legacy-ui');
    fs.mkdirSync(path.join(dir, 'dist', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'ui', 'index.html'), '<p>v1</p>');
    const gw = await start();
    expect(await get(gw, '/api/modules/legacy-ui/ui/', null)).toBe('<p>v1</p>');
    fs.writeFileSync(path.join(dir, 'dist', 'ui', 'index.html'), '<p>v2</p>');
    // Behaviour is as before, with the copy refreshed when the hash changes: on the next enable.
    expect(await get(gw, '/api/modules/legacy-ui/ui/', null)).toBe('<p>v1</p>');
    await gw.api('/plugins/legacy-ui/disable', { method: 'POST', body: '{}' });
    await gw.api('/plugins/legacy-ui/enable', { method: 'POST', body: '{}' });
    expect(await get(gw, '/api/modules/legacy-ui/ui/', null)).toBe('<p>v2</p>');
  });

  it('reads a plugin’s skills from the copy', async () => {
    writePlugin(s.modules, {
      id: 'skilled',
      manifest: { skills: 'prompts' },
      files: {
        'prompts/probe/SKILL.md':
          '---\nname: Probe\nslug: probe-skill\ndescription: approved description\n---\nBody.',
      },
    });
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'skilled');
    const description = async () =>
      (
        await gw.json<{ skills: Array<{ slug: string; description?: string }> }>('/skills')
      ).skills.find((k) => k.slug === 'probe-skill')?.description;
    expect(await description()).toBe('approved description');
    edit(
      'skilled/prompts/probe/SKILL.md',
      '---\nname: Probe\nslug: probe-skill\ndescription: EDITED description\n---\nBody.'
    );
    expect(await description()).toBe('approved description');
    // A plugin that waits for approval contributes no skills at all.
    await gw.close();
    const next = await start();
    expect((await listPlugins(next)).skilled.state).toBe('awaiting_approval');
    const skills = await next.json<{ skills: Array<{ slug: string }> }>('/skills');
    expect(skills.skills.map((k) => k.slug)).not.toContain('probe-skill');
  });

  it('gives a plugin the copy as ctx.dir: only what was hashed is there', async () => {
    writePlugin(s.modules, {
      id: 'dir',
      files: { 'notes/unhashed.txt': 'not covered', 'dist/covered.txt': 'covered' },
      hooks: `register(ctx) {
        ctx.routes.get('/ls', async (_q, r) => {
          const fs = await import('node:fs');
          r.json({
            dir: ctx.dir,
            covered: fs.existsSync(ctx.dir + '/dist/covered.txt'),
            unhashed: fs.existsSync(ctx.dir + '/notes/unhashed.txt'),
            manifest: fs.existsSync(ctx.dir + '/manifest.json'),
          });
        });
      },`,
    });
    const gw = await start();
    const out = (await gw.json('/api/modules/dir/ls')) as Record<string, unknown>;
    expect(out).toMatchObject({ covered: true, unhashed: false, manifest: true });
    expect(String(out.dir)).toContain(path.join('.clerq', 'plugin-cache', 'dir'));
    expect(fs.existsSync(path.join(s.modules, 'dir', 'notes', 'unhashed.txt'))).toBe(true);
  });
});
