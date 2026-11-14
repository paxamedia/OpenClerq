/**
 * scripts/generate-updater-manifest.js and scripts/stage-release-files.js: which bundle answers
 * which updater key, what is left out, and how a build's files are named so that the builds of
 * one release never collide. The names are made up here (the real bundles come from Tauri on
 * each platform, in the release workflow).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string }>;
}
interface Generator {
  keysFor(file: string): string[];
  buildManifest(o: {
    version: string;
    baseUrl: string;
    files: string[];
    read: (name: string) => string;
    now?: Date;
  }): Manifest | null;
}
interface Stager {
  cpuName(nodeArch?: string): string | undefined;
  namesCpu(name: string, cpu: string): boolean;
  stageFiles(o: {
    bundleDir: string;
    outDir: string;
    cpu: string;
    version: string;
    productName: string;
  }): string[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const load = async <T>(name: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'scripts', name)).href)) as T;
const generator = await load<Generator>('generate-updater-manifest.js');
const stager = await load<Stager>('stage-release-files.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-manifest-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BASE = 'https://github.com/paxamedia/OpenClerq/releases/download/v1.0.0';
const sigOf = (name: string) => `signature-of-${name}`;

/** A release folder's file names, and the manifest the generator makes of them. */
function manifestOf(files: string[]) {
  return generator.buildManifest({
    version: '1.0.0',
    baseUrl: BASE,
    files,
    read: (name) => `${sigOf(name.replace(/\.sig$/, ''))}\n`,
    now: new Date('2026-11-14T00:00:00Z'),
  });
}

describe('the updater keys of a bundle', () => {
  it('maps each desktop bundle to the keys the Tauri updater looks up', () => {
    const keys = generator.keysFor;
    expect(keys('Clerq_1.0.0_aarch64.app.tar.gz')).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
    ]);
    expect(keys('Clerq_1.0.0_x86_64.app.tar.gz')).toEqual(['darwin-x86_64', 'darwin-x86_64-app']);
    expect(keys('Clerq_1.0.0_x64_en-US.msi')).toEqual(['windows-x86_64-msi']);
    expect(keys('Clerq_1.0.0_x64-setup.exe')).toEqual(['windows-x86_64', 'windows-x86_64-nsis']);
    expect(keys('Clerq_1.0.0_x86_64.AppImage')).toEqual(['linux-x86_64-appimage']);
    expect(keys('Clerq_1.0.0_aarch64.AppImage')).toEqual(['linux-aarch64-appimage']);
  });

  it('reads Tauri’s own spellings of the CPU too (amd64, arm64)', () => {
    expect(generator.keysFor('Clerq_1.0.0_amd64.AppImage')).toEqual(['linux-x86_64-appimage']);
    expect(generator.keysFor('Clerq_1.0.0_arm64.AppImage')).toEqual(['linux-aarch64-appimage']);
  });

  it('gives a .deb, a .rpm, a .dmg and anything else no key: only the AppImage updates itself', () => {
    for (const name of [
      'Clerq_1.0.0_amd64.deb',
      'Clerq_1.0.0_arm64.deb',
      'Clerq-1.0.0-1.x86_64.rpm',
      'Clerq-1.0.0-1.aarch64.rpm',
      'Clerq_1.0.0_aarch64.dmg',
      'SHA256SUMS',
      'Clerq.AppImage',
    ]) {
      expect(generator.keysFor(name), name).toEqual([]);
    }
  });
});

describe('latest.json', () => {
  it('covers every signed bundle of a four-platform release, including both Linux CPUs', () => {
    const bundles = [
      'Clerq_1.0.0_aarch64.app.tar.gz',
      'Clerq_1.0.0_aarch64.dmg',
      'Clerq_1.0.0_x64_en-US.msi',
      'Clerq_1.0.0_x64-setup.exe',
      'Clerq_1.0.0_x86_64.AppImage',
      'Clerq_1.0.0_aarch64.AppImage',
      'Clerq_1.0.0_amd64.deb',
      'Clerq_1.0.0_arm64.deb',
      'Clerq-1.0.0-1.x86_64.rpm',
      'Clerq-1.0.0-1.aarch64.rpm',
    ];
    // Tauri 2.10 signs the .deb and the .rpm as well; they are in the release with their .sig.
    const signed = bundles.filter((b) => /(tar\.gz|msi|exe|AppImage|deb|rpm)$/.test(b));
    const m = manifestOf([...bundles, ...signed.map((b) => `${b}.sig`)])!;
    expect(Object.keys(m.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'linux-aarch64-appimage',
      'linux-x86_64-appimage',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
    expect(m.platforms['linux-x86_64-appimage']).toEqual({
      url: `${BASE}/Clerq_1.0.0_x86_64.AppImage`,
      signature: sigOf('Clerq_1.0.0_x86_64.AppImage'),
    });
    expect(m.platforms['linux-aarch64-appimage'].url).toBe(`${BASE}/Clerq_1.0.0_aarch64.AppImage`);
    expect(m).toMatchObject({ version: '1.0.0', pub_date: '2026-11-14T00:00:00.000Z' });
    // The .deb and .rpm are in the release, signed, and in no entry: a choice (the updater would
    // install them as root), see generate-updater-manifest.js.
    expect(JSON.stringify(m)).not.toMatch(/\.deb|\.rpm/);
  });

  it('leaves out a bundle with no .sig, an AppImage included, and writes nothing when none is signed', () => {
    const m = manifestOf([
      'Clerq_1.0.0_x86_64.AppImage',
      'Clerq_1.0.0_aarch64.AppImage',
      'Clerq_1.0.0_aarch64.AppImage.sig',
    ])!;
    expect(Object.keys(m.platforms)).toEqual(['linux-aarch64-appimage']);
    expect(manifestOf(['Clerq_1.0.0_x86_64.AppImage', 'Clerq_1.0.0_amd64.deb'])).toBeNull();
    // A .sig whose bundle is missing answers nothing.
    expect(manifestOf(['Clerq_1.0.0_x86_64.AppImage.sig'])).toBeNull();
  });

  it('keeps the signature as the file holds it, trimmed, and encodes the file name in the address', () => {
    const m = manifestOf(['Clerq 1.0.0_x86_64.AppImage', 'Clerq 1.0.0_x86_64.AppImage.sig'])!;
    expect(m.platforms['linux-x86_64-appimage'].url).toBe(`${BASE}/Clerq%201.0.0_x86_64.AppImage`);
    expect(m.platforms['linux-x86_64-appimage'].signature).toBe(
      sigOf('Clerq 1.0.0_x86_64.AppImage')
    );
  });

  it('is what the command writes into release/, read the way a release job runs it', () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'job-'));
    fs.mkdirSync(path.join(cwd, 'release'));
    for (const name of ['Clerq_1.0.0_x86_64.AppImage', 'Clerq_1.0.0_amd64.deb']) {
      fs.writeFileSync(path.join(cwd, 'release', name), 'x');
    }
    fs.writeFileSync(path.join(cwd, 'release', 'Clerq_1.0.0_x86_64.AppImage.sig'), 'c2ln\n');
    const run = () =>
      spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'generate-updater-manifest.js'), 'v1.0.0', BASE],
        {
          cwd,
          encoding: 'utf8',
        }
      );
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('latest.json covers: linux-x86_64-appimage');
    const written = JSON.parse(
      fs.readFileSync(path.join(cwd, 'release', 'latest.json'), 'utf8')
    ) as Manifest;
    expect(written.version).toBe('1.0.0');
    expect(written.platforms['linux-x86_64-appimage'].signature).toBe('c2ln');
    // No arguments: usage, and a failure.
    const none = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'generate-updater-manifest.js')],
      { cwd, encoding: 'utf8' }
    );
    expect(none.status).toBe(1);
  });
});

describe('staging a build’s files', () => {
  /** Tauri's bundle folders, with the names it gives on each platform. */
  function bundles(layout: Record<string, string[]>) {
    const dir = fs.mkdtempSync(path.join(tmp, 'bundle-'));
    for (const [folder, names] of Object.entries(layout)) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (const n of names) fs.writeFileSync(path.join(dir, folder, n), `bytes of ${n}`);
    }
    return dir;
  }
  const stage = (bundleDir: string, cpu: string) => {
    const outDir = fs.mkdtempSync(path.join(tmp, 'out-'));
    const staged = stager.stageFiles({
      bundleDir,
      outDir,
      cpu,
      version: '1.0.0',
      productName: 'Clerq',
    });
    return { outDir, staged };
  };

  it('stages an x86_64 Linux build: the AppImage renamed, the .deb and .rpm as they are, each with its signature', () => {
    const dir = bundles({
      appimage: ['Clerq_1.0.0_amd64.AppImage', 'Clerq_1.0.0_amd64.AppImage.sig'],
      // Tauri 2.10 signs the .deb and .rpm too, so each comes with its .sig.
      deb: ['Clerq_1.0.0_amd64.deb', 'Clerq_1.0.0_amd64.deb.sig'],
      rpm: ['Clerq-1.0.0-1.x86_64.rpm', 'Clerq-1.0.0-1.x86_64.rpm.sig'],
    });
    const { outDir, staged } = stage(dir, 'x86_64');
    expect(staged.sort()).toEqual([
      'Clerq-1.0.0-1.x86_64.rpm',
      'Clerq-1.0.0-1.x86_64.rpm.sig',
      'Clerq_1.0.0_amd64.deb',
      'Clerq_1.0.0_amd64.deb.sig',
      'Clerq_1.0.0_x86_64.AppImage',
      'Clerq_1.0.0_x86_64.AppImage.sig',
    ]);
    expect(fs.readdirSync(outDir).sort()).toEqual(staged.sort());
    // The renamed file is the AppImage's bytes, and its .sig is the AppImage's .sig.
    expect(fs.readFileSync(path.join(outDir, 'Clerq_1.0.0_x86_64.AppImage'), 'utf8')).toBe(
      'bytes of Clerq_1.0.0_amd64.AppImage'
    );
    expect(fs.readFileSync(path.join(outDir, 'Clerq_1.0.0_x86_64.AppImage.sig'), 'utf8')).toBe(
      'bytes of Clerq_1.0.0_amd64.AppImage.sig'
    );
  });

  it('stages an arm64 Linux build, and the two Linux builds of a release never share a name', () => {
    const arm = bundles({
      appimage: ['Clerq_1.0.0_aarch64.AppImage', 'Clerq_1.0.0_aarch64.AppImage.sig'],
      deb: ['Clerq_1.0.0_arm64.deb'],
      rpm: ['Clerq-1.0.0-1.aarch64.rpm'],
    });
    const x64 = bundles({
      appimage: ['Clerq_1.0.0_amd64.AppImage', 'Clerq_1.0.0_amd64.AppImage.sig'],
      deb: ['Clerq_1.0.0_amd64.deb'],
      rpm: ['Clerq-1.0.0-1.x86_64.rpm'],
    });
    const a = stage(arm, 'aarch64').staged;
    const b = stage(x64, 'x86_64').staged;
    expect(a.filter((n) => b.includes(n))).toEqual([]);
    expect(a).toContain('Clerq_1.0.0_aarch64.AppImage');
  });

  it('refuses a .deb or .rpm that does not say which CPU it is for, or says the other one', () => {
    for (const [folder, name] of [
      ['deb', 'Clerq_1.0.0.deb'],
      ['rpm', 'Clerq-1.0.0-1.noarch.rpm'],
      ['deb', 'Clerq_1.0.0_arm64.deb'],
    ] as const) {
      const dir = bundles({ appimage: ['Clerq_1.0.0_amd64.AppImage'], [folder]: [name] });
      expect(() => stage(dir, 'x86_64'), name).toThrow(/does not say it is for x86_64/);
    }
  });

  it('keeps naming the other platforms’ files as before', () => {
    const mac = bundles({
      dmg: ['Clerq_1.0.0_aarch64.dmg'],
      macos: ['Clerq.app.tar.gz', 'Clerq.app.tar.gz.sig'],
    });
    expect(stage(mac, 'aarch64').staged.sort()).toEqual([
      'Clerq_1.0.0_aarch64.app.tar.gz',
      'Clerq_1.0.0_aarch64.app.tar.gz.sig',
      'Clerq_1.0.0_aarch64.dmg',
    ]);
    const win = bundles({
      msi: ['Clerq_1.0.0_x64_en-US.msi', 'Clerq_1.0.0_x64_en-US.msi.sig'],
      nsis: ['Clerq_1.0.0_x64-setup.exe', 'Clerq_1.0.0_x64-setup.exe.sig'],
    });
    expect(stage(win, 'x86_64').staged).toHaveLength(4);
  });

  it('fails when the folder holds no installer, and for a name collision inside one build', () => {
    expect(() => stage(bundles({ appimage: [] }), 'x86_64')).toThrow(/No installers found/);
    const twice = bundles({ appimage: ['a_amd64.AppImage', 'b_amd64.AppImage'] });
    expect(() => stage(twice, 'x86_64')).toThrow(/already staged/);
  });

  it('knows its CPU spellings', () => {
    expect(stager.cpuName('arm64')).toBe('aarch64');
    expect(stager.cpuName('x64')).toBe('x86_64');
    expect(stager.cpuName('ia32')).toBeUndefined();
    expect(stager.namesCpu('Clerq_1.0.0_amd64.deb', 'x86_64')).toBe(true);
    expect(stager.namesCpu('Clerq-1.0.0-1.x86_64.rpm', 'x86_64')).toBe(true);
    expect(stager.namesCpu('Clerq_1.0.0_arm64.deb', 'x86_64')).toBe(false);
    expect(stager.namesCpu('Clerq-1.0.0-1.aarch64.rpm', 'aarch64')).toBe(true);
    expect(stager.namesCpu('Clerq_1.0.0_amd640.deb', 'x86_64')).toBe(false);
  });
});
