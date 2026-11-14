/**
 * The first-party plugins that ship with OpenClerq: every line of BUNDLED_PLUGINS is the
 * checksum of the folder it names, computed again here. A plugin edited without its line being
 * updated (or the other way round) fails this test, so a bundled plugin is never approved for
 * files other than the ones it ships with.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarableApi, validateManifest } from '@clerq/plugin-sdk/manifest';
import { pluginChecksum } from '@clerq/plugin-sdk/node';
import { BUNDLED_PLUGINS } from './bundled-plugins.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Where each bundled plugin's folder is in the repository. Adding a line to BUNDLED_PLUGINS means adding one here. */
const FOLDERS: Record<string, string> = {
  chat: path.join(REPO, 'packages', 'plugin-chat'),
};

describe('BUNDLED_PLUGINS', () => {
  it('names exactly the plugins whose folders this test knows', () => {
    expect(Object.keys(BUNDLED_PLUGINS).sort()).toEqual(Object.keys(FOLDERS).sort());
  });

  it.each(Object.keys(BUNDLED_PLUGINS))(
    '%s: the listed checksum is the checksum of its folder',
    (id) => {
      expect(pluginChecksum(FOLDERS[id])).toBe(BUNDLED_PLUGINS[id]);
    }
  );

  it.each(Object.keys(BUNDLED_PLUGINS))(
    '%s: is the same when only its manifest is carried, which is what the app ships',
    (id) => {
      // The desktop carries manifest.json alone. If the folder had code the checksum covers
      // (a server entry, a UI folder, skills, migrations), that copy would hash differently.
      const shipped = fs.mkdtempSync(path.join(os.tmpdir(), `clerq-bundled-${id}-`));
      try {
        fs.copyFileSync(
          path.join(FOLDERS[id], 'manifest.json'),
          path.join(shipped, 'manifest.json')
        );
        expect(pluginChecksum(shipped)).toBe(BUNDLED_PLUGINS[id]);
      } finally {
        fs.rmSync(shipped, { recursive: true, force: true });
      }
    }
  );

  it.each(Object.keys(BUNDLED_PLUGINS))('%s: has a valid manifest of its own id', (id) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(FOLDERS[id], 'manifest.json'), 'utf8'));
    const result = validateManifest(manifest);
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
    expect(manifest.id).toBe(id);
    expect(manifest.manifestVersion).toBe(1);
    for (const scope of manifest.permissions.api ?? [])
      expect(declarableApi(scope), scope).toBe(true);
  });

  it('does not list a plugin whose files changed by a single byte', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-bundled-edit-'));
    try {
      const text = fs.readFileSync(path.join(FOLDERS.chat, 'manifest.json'), 'utf8');
      fs.writeFileSync(
        path.join(copy, 'manifest.json'),
        text.replace('"GET /providers",', '"GET /providers", ')
      );
      expect(pluginChecksum(copy)).not.toBe(BUNDLED_PLUGINS.chat);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('is carried by the desktop app: each plugin’s manifest is a resource the app puts where the gateway looks', () => {
    const conf = JSON.parse(
      fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8')
    ) as { bundle: { resources: Record<string, string> } };
    const confDir = path.join(REPO, 'apps', 'desktop', 'src-tauri');
    const carried = Object.fromEntries(
      Object.entries(conf.bundle.resources)
        .filter(([, to]) => to.startsWith('bundled-plugins/'))
        .map(([from, to]) => [to, path.resolve(confDir, from)])
    );
    expect(carried).toEqual(
      Object.fromEntries(
        Object.keys(BUNDLED_PLUGINS).map((id) => [
          `bundled-plugins/${id}/manifest.json`,
          path.join(FOLDERS[id], 'manifest.json'),
        ])
      )
    );
  });
});
