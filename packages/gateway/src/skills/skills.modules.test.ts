/**
 * Skills that come with a module or a plugin. A plugin's skills are approved with the plugin (its
 * checksum covers them and they are read from the copy that was approved); a legacy module's have
 * trust states of their own. A plugin that waits for approval contributes no skills with
 * enforcement on, and with it off its skills are listed as untrusted until it is approved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  listPlugins,
  scratch,
  seedEnforce,
  startGateway,
  writePlugin,
  type Running,
  type Scratch,
} from '../modules/plugins.harness.js';

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

const SKILL = (slug: string, text = 'Body.') =>
  `---\nname: ${slug}\nslug: ${slug}\ntriggers: ['${slug}']\ntools_required: [fs.read]\n---\n${text}`;

interface Info {
  slug: string;
  origin: string;
  trust: string;
  trustedBy: string | null;
  trustReason: string;
  computedChecksum: string | null;
}
const skillsOf = async (gw: Running) =>
  (await gw.json<{ skills: Info[] }>('/skills')).skills.filter((k) => k.slug !== 'example');

async function approve(gw: Running, id: string) {
  const p = (await listPlugins(gw))[id];
  const res = await gw.api(`/plugins/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
  });
  expect(res.status).toBe(200);
}

function legacyModule(id: string) {
  const dir = path.join(s.modules, id);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'one'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, name: id, version: '1.0.0' })
  );
  fs.writeFileSync(path.join(dir, 'dist', 'routes.js'), 'export function register() {}\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'skills', 'one', 'SKILL.md'), SKILL('legacy-one'));
  return dir;
}

describe('a plugin’s skills', () => {
  const plugin = () =>
    writePlugin(s.modules, {
      id: 'skilled',
      manifest: { skills: 'prompts' },
      files: { 'prompts/one/SKILL.md': SKILL('plugin-one') },
    });

  it('with enforcement off are listed as coming from the plugin, untrusted until it is approved, then trusted with it', async () => {
    plugin();
    const gw = await start();
    expect(await skillsOf(gw)).toEqual([
      expect.objectContaining({
        slug: 'plugin-one',
        origin: 'plugin:skilled',
        trust: 'untrusted',
        trustedBy: null,
        trustReason: 'It comes with a plugin that has not been approved.',
      }),
    ]);
    await approve(gw, 'skilled');
    expect(await skillsOf(gw)).toEqual([
      expect.objectContaining({
        slug: 'plugin-one',
        trust: 'trusted',
        trustedBy: 'plugin',
        trustReason: 'Approved with its plugin.',
      }),
    ]);
  });

  it('cannot be trusted on their own: the plugin is what is approved', async () => {
    plugin();
    const gw = await start();
    const sum = (await skillsOf(gw))[0].computedChecksum;
    const res = await gw.api('/skills/plugin-one/trust', {
      method: 'POST',
      body: JSON.stringify({ checksum: sum }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'not_trustable',
      message: expect.stringContaining('approved with it'),
    });
  });

  it('can be blocked, which holds whatever the plugin’s approval says, and unblocked', async () => {
    plugin();
    const gw = await start();
    await approve(gw, 'skilled');
    const b = await gw.api('/skills/plugin-one/block', { method: 'POST', body: '{}' });
    expect(b.status).toBe(200);
    expect((await skillsOf(gw))[0]).toMatchObject({ trust: 'blocked' });
    await gw.api('/skills/plugin-one/untrust', { method: 'POST', body: '{}' });
    expect((await skillsOf(gw))[0]).toMatchObject({ trust: 'trusted', trustedBy: 'plugin' });
  });

  it('with enforcement on, a plugin that waits for approval contributes none; approved, they are there and trusted', async () => {
    plugin();
    await seedEnforce(s);
    const gw = await start();
    expect((await listPlugins(gw)).skilled.state).toBe('awaiting_approval');
    expect(await skillsOf(gw)).toEqual([]);
    await approve(gw, 'skilled');
    expect(await skillsOf(gw)).toEqual([
      expect.objectContaining({ slug: 'plugin-one', origin: 'plugin:skilled', trust: 'trusted' }),
    ]);
  });

  it('with enforcement on, turning it on takes away the skills of a plugin that was never approved', async () => {
    plugin();
    const gw = await start();
    expect(await skillsOf(gw)).toHaveLength(1);
    const res = await gw.api('/plugins/settings', {
      method: 'PUT',
      body: JSON.stringify({ enforce: true }),
    });
    expect(res.status).toBe(200);
    expect(await skillsOf(gw)).toEqual([]);
  });
});

describe('a legacy module’s skills', () => {
  it('have trust states of their own, by module', async () => {
    legacyModule('old-module');
    const gw = await start();
    const [k] = await skillsOf(gw);
    expect(k).toMatchObject({
      slug: 'legacy-one',
      origin: 'module:old-module',
      trust: 'untrusted',
    });
    const res = await gw.api('/skills/legacy-one/trust', {
      method: 'POST',
      body: JSON.stringify({ checksum: k.computedChecksum }),
    });
    expect(res.status).toBe(200);
    expect((await skillsOf(gw))[0]).toMatchObject({ trust: 'trusted', trustedBy: 'user' });
  });

  it('with enforcement on and the module approved still need the skill to be trusted', async () => {
    legacyModule('old-module');
    await seedEnforce(s);
    const gw = await start();
    await approve(gw, 'old-module');
    expect((await skillsOf(gw))[0]).toMatchObject({ slug: 'legacy-one', trust: 'untrusted' });
  });
});
