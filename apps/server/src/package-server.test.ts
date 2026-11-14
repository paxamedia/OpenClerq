/**
 * The archive writer of scripts/package-server.js: the tarball must be valid for
 * the machine's own `tar`, the same on every run, and carry no names, owners or
 * times of the machine that made it. Building the real binaries is the job of
 * the release workflow and of CI's server-linux job.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

interface Entry {
  name: string;
  data?: Buffer;
  mode?: number;
  directory?: boolean;
}
interface Script {
  SERVER_TARGETS: string[];
  normaliseTarget(t: string): { short: string; bun: string; os: string; arch: string };
  parseOptions(argv: string[]): { target: { short: string }; skipBuild: boolean; json: boolean };
  makeTar(entries: Entry[], mtime: number): Buffer;
  gzipReproducibly(data: Buffer): Buffer;
  sourceEpoch(env: Record<string, string | undefined>): number;
  readmeText(version: string, short: string): string;
}

const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'package-server.js'
);
const script = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Script;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-pack-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const hasTar = spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;
const top = 'openclerq-server-9.9.9-linux-x64';
const entries = (): Entry[] => [
  { name: top, directory: true },
  { name: `${top}/clerq-server`, data: Buffer.from('#!/bin/sh\necho server\n'), mode: 0o755 },
  { name: `${top}/LICENSE`, data: Buffer.alloc(1500, 'l'), mode: 0o644 },
  { name: `${top}/systemd`, directory: true },
  { name: `${top}/systemd/openclerq.service`, data: Buffer.from('[Unit]\n'), mode: 0o644 },
  { name: `${top}/clerq`, data: Buffer.alloc(0), mode: 0o755 },
];

describe('normaliseTarget', () => {
  it('takes the short and the Bun spelling and refuses the rest', () => {
    expect(script.normaliseTarget('linux-arm64')).toMatchObject({
      short: 'linux-arm64',
      bun: 'bun-linux-arm64',
      os: 'linux',
      arch: 'arm64',
    });
    expect(script.normaliseTarget('bun-darwin-x64').short).toBe('darwin-x64');
    for (const bad of ['windows-x64', 'linux-x64-musl', 'bun-linux-x64-baseline', 'linux', '']) {
      expect(() => script.normaliseTarget(bad)).toThrow(/not a server target/);
    }
  });

  it('defaults to this machine and knows its options', () => {
    const o = script.parseOptions(['--skip-build', '--json', '--target', 'darwin-arm64']);
    expect(o).toMatchObject({ skipBuild: true, json: true, target: { short: 'darwin-arm64' } });
    expect(() => script.parseOptions(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => script.parseOptions(['--out-dir'])).toThrow(/needs a value/);
  });
});

describe('sourceEpoch', () => {
  it('prefers SOURCE_DATE_EPOCH and refuses nonsense', () => {
    expect(script.sourceEpoch({ SOURCE_DATE_EPOCH: '1700000000' })).toBe(1700000000);
    expect(() => script.sourceEpoch({ SOURCE_DATE_EPOCH: 'yesterday' })).toThrow(/whole seconds/);
  });

  it('otherwise reads the commit time of this checkout', () => {
    // CI and the pristine clone are git checkouts; a source archive is not.
    const inGit = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0;
    if (!inGit) return;
    expect(script.sourceEpoch({})).toBeGreaterThan(1_700_000_000);
  });
});

describe('the archive', () => {
  const tar = script.makeTar(entries(), 1_700_000_000);
  const gz = script.gzipReproducibly(tar);

  it('is the same bytes every time and whatever order the entries come in', () => {
    const again = script.gzipReproducibly(script.makeTar(entries().reverse(), 1_700_000_000));
    expect(again.equals(gz)).toBe(true);
    const later = script.gzipReproducibly(script.makeTar(entries(), 1_700_000_001));
    expect(later.equals(gz)).toBe(false);
  });

  it('has a gzip header without a name or a time, as gzip -n writes it', () => {
    expect([gz[0], gz[1], gz[2]]).toEqual([0x1f, 0x8b, 8]); // magic, deflate
    expect(gz[3]).toBe(0); // no flags: no file name, no comment, no extra field
    expect(gz.subarray(4, 8).equals(Buffer.alloc(4))).toBe(true); // mtime 0
    expect(gz[9]).toBe(3); // Unix
    expect(zlib.gunzipSync(gz).equals(tar)).toBe(true);
  });

  it('is a whole number of tar records with every entry stamped, owned by root', () => {
    expect(tar.length % 10240).toBe(0);
    const names: string[] = [];
    for (let at = 0; at + 512 <= tar.length; ) {
      const header = tar.subarray(at, at + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
      names.push(name);
      expect(header.subarray(257, 263).toString()).toBe('ustar\0');
      expect(parseInt(header.subarray(108, 115).toString(), 8)).toBe(0); // uid
      expect(parseInt(header.subarray(116, 123).toString(), 8)).toBe(0); // gid
      expect(header.subarray(265, 269).toString()).toBe('root');
      expect(parseInt(header.subarray(136, 147).toString(), 8)).toBe(1_700_000_000);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
      expect(parseInt(header.subarray(148, 154).toString(), 8)).toBe(sum);
      const size = parseInt(header.subarray(124, 135).toString(), 8);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual([
      `${top}/`,
      `${top}/LICENSE`,
      `${top}/clerq`,
      `${top}/clerq-server`,
      `${top}/systemd/`,
      `${top}/systemd/openclerq.service`,
    ]);
  });

  it.skipIf(!hasTar)('is read by this machine’s tar: names, owner, modes and contents', () => {
    const archive = path.join(tmp, 'a.tar.gz');
    fs.writeFileSync(archive, gz);
    const listing = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toMatch(/\broot\b.*\broot\b/); // GNU: root/root, bsdtar: root  root
    const out = path.join(tmp, 'x');
    fs.mkdirSync(out);
    const extract = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' });
    expect(extract.status, extract.stderr).toBe(0);
    const root = path.join(out, top);
    expect(fs.readFileSync(path.join(root, 'clerq-server'), 'utf8')).toBe(
      '#!/bin/sh\necho server\n'
    );
    expect(fs.readFileSync(path.join(root, 'LICENSE')).length).toBe(1500);
    expect(fs.readFileSync(path.join(root, 'clerq')).length).toBe(0);
    expect(fs.statSync(path.join(root, 'clerq-server')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(root, 'LICENSE')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(root, 'systemd')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, 'LICENSE')).mtimeMs).toBe(1_700_000_000_000);
  });

  it('refuses a name too long for a ustar header', () => {
    expect(() =>
      script.makeTar([{ name: 'x'.repeat(101), data: Buffer.alloc(0), mode: 0o644 }], 0)
    ).toThrow(/longer than 100 bytes/);
  });
});

describe('README.txt', () => {
  it('names the release and points at the docs of that release', () => {
    const text = script.readmeText('1.2.3', 'linux-arm64');
    expect(text).toContain('OpenClerq server 1.2.3 (linux-arm64)');
    expect(text).toContain('blob/v1.2.3/docs/SERVER.md');
    expect(text).toContain('install -m 0755 clerq-server clerq clerq-calc');
  });
});
