import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_PERMISSIONS } from './manifest.js';
import {
  codePaths,
  permissionsHash,
  PluginFilesError,
  pluginChecksum,
  pluginChecksumDetail,
  readManifestFile,
} from './node.js';

let dir = '';

const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  id: 'sum',
  name: 'Sum',
  version: '1.0.0',
  description: 'x',
  engines: { api: 1 },
  entry: { server: 'dist/server.js', ui: 'dist/ui' },
  skills: 'skills',
  permissions: {},
  ...over,
});

const write = (rel: string, text: string) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sum-'));
  write('manifest.json', JSON.stringify(manifest(), null, 2));
  write('dist/server.js', 'export default {};\n');
  write('dist/ui/index.html', '<!doctype html>');
  write('dist/ui/app.js', 'console.log(1)');
  write('skills/one/SKILL.md', '# one');
  write('README.md', 'not code');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the checksum of a plugin', () => {
  it('is stable: the same files give the same value, wherever the folder is', () => {
    const a = pluginChecksum(dir);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pluginChecksum(dir)).toBe(a);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sum-copy-'));
    try {
      fs.cpSync(dir, copy, { recursive: true });
      expect(pluginChecksum(copy)).toBe(a);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it('covers the manifest, the entries, the skills and the migrations, sorted by path', () => {
    const { files } = pluginChecksumDetail(dir);
    expect(files.map((f) => f.path)).toEqual([
      'dist/server.js',
      'dist/ui/app.js',
      'dist/ui/index.html',
      'manifest.json',
      'skills/one/SKILL.md',
    ]);
    expect(files.some((f) => f.path === 'README.md')).toBe(false);
  });

  it.each([
    ['the server entry', () => write('dist/server.js', 'export default { evil: true };\n')],
    ['a UI file', () => write('dist/ui/app.js', 'console.log(2)')],
    ['a skill', () => write('skills/one/SKILL.md', '# one, changed')],
    ['the manifest', () => write('manifest.json', JSON.stringify(manifest({ version: '1.0.1' })))],
    ['the manifest, by a space', () => write('manifest.json', JSON.stringify(manifest()) + ' ')],
    ['a new file under a UI path', () => write('dist/ui/extra.js', '1')],
    ['a new skill', () => write('skills/two/SKILL.md', '# two')],
    ['a migration', () => write('migrations/0001_x.sql', 'CREATE TABLE mod_sum__x (a);')],
    ['a removed file', () => fs.rmSync(path.join(dir, 'dist/ui/app.js'))],
    [
      'a renamed file',
      () => fs.renameSync(path.join(dir, 'dist/ui/app.js'), path.join(dir, 'dist/ui/app2.js')),
    ],
  ])('changes when %s changes', (_what, change) => {
    const before = pluginChecksum(dir);
    change();
    expect(pluginChecksum(dir)).not.toBe(before);
  });

  it('does not change for a file outside the code paths, or for what the system adds', () => {
    const before = pluginChecksum(dir);
    write('README.md', 'edited');
    write('notes/todo.txt', 'x');
    write('dist/ui/.DS_Store', 'junk');
    write('dist/ui/._app.js', 'junk');
    write('skills/Thumbs.db', 'junk');
    expect(pluginChecksum(dir)).toBe(before);
  });

  it('tells a file moved from one path to another from the same bytes', () => {
    write('dist/ui/a.js', 'same');
    write('dist/ui/b.js', '');
    const one = pluginChecksum(dir);
    write('dist/ui/a.js', '');
    write('dist/ui/b.js', 'same');
    expect(pluginChecksum(dir)).not.toBe(one);
  });

  it('notices an entry that was missing and then appears', () => {
    fs.rmSync(path.join(dir, 'dist/server.js'));
    const missing = pluginChecksumDetail(dir);
    expect(missing.files.some((f) => f.path === 'dist/server.js')).toBe(false);
    write('dist/server.js', 'export default {};\n');
    expect(pluginChecksum(dir)).not.toBe(missing.checksum);
  });

  it('follows a link to a file, so a change behind the link changes it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sum-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'x.js'), 'one');
      fs.symlinkSync(path.join(outside, 'x.js'), path.join(dir, 'dist/ui/linked.js'));
      const before = pluginChecksum(dir);
      fs.writeFileSync(path.join(outside, 'x.js'), 'two');
      expect(pluginChecksum(dir)).not.toBe(before);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('survives a link back to a folder it is already in', () => {
    fs.symlinkSync(path.join(dir, 'dist'), path.join(dir, 'dist/ui/loop'));
    expect(pluginChecksum(dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('can be told the manifest text it should use', () => {
    const text = JSON.stringify(manifest({ description: 'other' }));
    const own = pluginChecksum(dir);
    expect(pluginChecksumDetail(dir, { manifestText: text }).checksum).not.toBe(own);
    expect(
      pluginChecksumDetail(dir, {
        manifestText: fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
      }).checksum
    ).toBe(own);
  });

  it('refuses a path that leaves the folder, and says so', () => {
    write('manifest.json', JSON.stringify(manifest({ skills: '../elsewhere' })));
    expect(() => pluginChecksum(dir)).toThrow(PluginFilesError);
    expect(() => pluginChecksum(dir)).toThrow('outside the plugin directory');
  });

  it('says plainly when there is no manifest, or it is not JSON', () => {
    fs.rmSync(path.join(dir, 'manifest.json'));
    expect(() => readManifestFile(dir)).toThrow('There is no manifest.json');
    write('manifest.json', '{ nope');
    expect(() => readManifestFile(dir)).toThrow('manifest.json is not valid JSON.');
    write('manifest.json', '[]');
    expect(() => readManifestFile(dir)).toThrow('must be a JSON object');
  });

  it('covers the whole folder the entry is in, the UI, the skills and the migrations', () => {
    expect(codePaths(manifest())).toEqual(['dist', 'dist/ui', 'skills', 'migrations']);
    // The entry's folder is the tree; at the root only the entry file itself is code.
    expect(codePaths(manifest({ entry: { server: 'server.js' } }))).toEqual([
      'server.js',
      'skills',
      'migrations',
    ]);
    expect(codePaths(manifest({ entry: { server: 'build/server/main.js', ui: 'web' } }))).toEqual([
      'build/server',
      'web',
      'skills',
      'migrations',
    ]);
  });

  it('reads a legacy module by its entry points’ folders, its UI and its skills', () => {
    expect(codePaths({ id: 'x' })).toEqual(['dist', 'build', 'dist/ui', 'skills', 'migrations']);
    expect(codePaths({ id: 'x', entryPoints: { routes: ['./lib/main.js'] } })).toEqual([
      'lib',
      'dist/ui',
      'skills',
      'migrations',
    ]);
  });

  it('changes when a file the entry imports from its own folder changes, but not for one outside it', () => {
    write('dist/lib/helper.js', 'export const x = 1;');
    const before = pluginChecksum(dir);
    write('dist/lib/helper.js', 'export const x = 2;');
    const edited = pluginChecksum(dir);
    expect(edited).not.toBe(before);
    write('dist/other.js', 'export const y = 1;');
    expect(pluginChecksum(dir)).not.toBe(edited);
    // Not under the entry's folder, the UI, the skills or the migrations: not code.
    const now = pluginChecksum(dir);
    write('lib/outside.js', 'export const z = 1;');
    write('server-notes.md', 'x');
    expect(pluginChecksum(dir)).toBe(now);
  });

  it('covers only the file for an entry at the plugin’s root', () => {
    write('manifest.json', JSON.stringify(manifest({ entry: { server: 'server.js' } })));
    write('server.js', 'export default {};');
    const { files } = pluginChecksumDetail(dir);
    expect(files.map((f) => f.path)).toEqual(['manifest.json', 'server.js', 'skills/one/SKILL.md']);
  });
});

describe('the hash of what a plugin declares', () => {
  it('is the same for permissions that mean the same, in any order', () => {
    const a = permissionsHash({ ...EMPTY_PERMISSIONS, net: ['b.example.com', 'a.example.com'] });
    const b = permissionsHash({
      ...EMPTY_PERMISSIONS,
      net: ['a.example.com', 'b.example.com', 'a.example.com'],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when anything declared changes', () => {
    const base = permissionsHash(EMPTY_PERMISSIONS);
    const changes = [
      { ...EMPTY_PERMISSIONS, exec: ['/bin/ls'] },
      { ...EMPTY_PERMISSIONS, fs: { read: ['/a'], write: [] } },
      { ...EMPTY_PERMISSIONS, fs: { read: [], write: ['/a'] } },
      { ...EMPTY_PERMISSIONS, net: ['a.example.com'] },
      { ...EMPTY_PERMISSIONS, secrets: ['t'] },
      { ...EMPTY_PERMISSIONS, services: ['l'] },
      { ...EMPTY_PERMISSIONS, llm: true },
      { ...EMPTY_PERMISSIONS, api: ['GET /runs'] },
      { ...EMPTY_PERMISSIONS, memory: { read: ['fact'], write: [] } },
      { ...EMPTY_PERMISSIONS, memory: { read: [], write: ['fact'] } },
    ].map(permissionsHash);
    expect(new Set([base, ...changes]).size).toBe(changes.length + 1);
  });
});
