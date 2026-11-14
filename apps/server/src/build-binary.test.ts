/**
 * The interface of scripts/build-binary.js, which the release and the CLI
 * build use: what it accepts, and where it puts things. The compile itself is
 * exercised by building the real binary (scripts/smoke.mjs).
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Target {
  os: string;
  arch: string;
  musl: boolean;
  rustTarget: string;
  exe: string;
}
interface Options {
  entry: string;
  name: string;
  target: string;
  outDir?: string;
  calc: 'auto' | 'none' | { file: string };
  requireCalc: boolean;
  skipBuild: boolean;
  json: boolean;
}
interface Script {
  parseTarget(target: string): Target | null;
  hostTarget(platform?: string, arch?: string): string;
  parseOptions(argv: string[]): Options;
  calcCandidates(target: string, host?: string): string[];
}

const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'build-binary.js'
);
const script = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Script;

describe('parseTarget', () => {
  it('maps every Bun target to the Rust triple clerq-calc is built for', () => {
    const triples: Record<string, string> = {
      'bun-linux-x64': 'x86_64-unknown-linux-gnu',
      'bun-linux-arm64': 'aarch64-unknown-linux-gnu',
      'bun-linux-x64-musl': 'x86_64-unknown-linux-musl',
      'bun-linux-arm64-musl': 'aarch64-unknown-linux-musl',
      'bun-linux-x64-baseline': 'x86_64-unknown-linux-gnu',
      'bun-darwin-arm64': 'aarch64-apple-darwin',
      'bun-darwin-x64': 'x86_64-apple-darwin',
      'bun-windows-x64': 'x86_64-pc-windows-msvc',
    };
    for (const [target, triple] of Object.entries(triples)) {
      expect(script.parseTarget(target)?.rustTarget).toBe(triple);
    }
  });

  it('gives Windows targets an .exe and no other', () => {
    expect(script.parseTarget('bun-windows-x64')?.exe).toBe('.exe');
    expect(script.parseTarget('bun-linux-x64')?.exe).toBe('');
  });

  it('refuses what is not a target', () => {
    for (const bad of [
      '',
      'linux-x64',
      'bun-linux',
      'bun-freebsd-x64',
      'bun-darwin-x64-musl',
      'node',
    ]) {
      expect(script.parseTarget(bad)).toBeNull();
    }
  });
});

describe('hostTarget', () => {
  it("names the machine it runs on in Bun's words", () => {
    expect(script.hostTarget('darwin', 'arm64')).toBe('bun-darwin-arm64');
    expect(script.hostTarget('darwin', 'x64')).toBe('bun-darwin-x64');
    expect(script.hostTarget('linux', 'x64')).toBe('bun-linux-x64');
    expect(script.hostTarget('linux', 'arm64')).toBe('bun-linux-arm64');
    expect(script.hostTarget('win32', 'x64')).toBe('bun-windows-x64');
  });

  it('says so when there is none', () => {
    expect(() => script.hostTarget('freebsd', 'x64')).toThrow(/--target/);
    expect(() => script.hostTarget('linux', 'riscv64')).toThrow(/--target/);
  });
});

describe('parseOptions', () => {
  const base = ['--entry', 'apps/server/src/main.ts', '--name', 'clerq-server'];

  it('needs an entry point and a name, and defaults to the host target', () => {
    const o = script.parseOptions(base);
    expect(o).toMatchObject({
      entry: 'apps/server/src/main.ts',
      name: 'clerq-server',
      calc: 'auto',
      requireCalc: false,
      skipBuild: false,
      json: false,
    });
    expect(o.target).toBe(script.hostTarget());
    expect(() => script.parseOptions(['--name', 'x'])).toThrow('--entry is required');
    expect(() => script.parseOptions(['--entry', 'x.ts'])).toThrow('--name is required');
  });

  it('takes the target, output directory and calc options', () => {
    const o = script.parseOptions([
      ...base,
      '--target',
      'bun-linux-arm64',
      '--out-dir',
      'out',
      '--require-calc',
      '--skip-build',
      '--json',
    ]);
    expect(o).toMatchObject({
      target: 'bun-linux-arm64',
      outDir: 'out',
      requireCalc: true,
      skipBuild: true,
      json: true,
    });
    expect(script.parseOptions([...base, '--no-calc']).calc).toBe('none');
    expect(script.parseOptions([...base, '--calc', '/x/clerq-calc']).calc).toEqual({
      file: '/x/clerq-calc',
    });
  });

  it('refuses unknown arguments, missing values, odd names and contradictions', () => {
    expect(() => script.parseOptions([...base, '--fast'])).toThrow('Unknown argument "--fast"');
    expect(() => script.parseOptions([...base, '--target'])).toThrow('--target needs a value');
    expect(() => script.parseOptions([...base, '--target', '--json'])).toThrow('needs a value');
    expect(() => script.parseOptions([...base, '--target', 'bun-beos-x64'])).toThrow(
      'not a Bun target'
    );
    expect(() => script.parseOptions(['--entry', 'a.ts', '--name', '../evil'])).toThrow(
      'plain file name'
    );
    expect(() => script.parseOptions([...base, '--no-calc', '--require-calc'])).toThrow(
      'contradict'
    );
  });
});

describe('calcCandidates', () => {
  it("looks in the target's own build directory first", () => {
    const [first] = script.calcCandidates('bun-linux-arm64', 'bun-darwin-arm64');
    expect(first).toMatch(
      /calculation-core\/target\/aarch64-unknown-linux-gnu\/release\/clerq-calc$/
    );
  });

  it("adds the plain `cargo build --release` output for the host's own target only", () => {
    const host = script.calcCandidates('bun-darwin-arm64', 'bun-darwin-arm64');
    expect(host).toHaveLength(2);
    expect(host[1]).toMatch(/calculation-core\/target\/release\/clerq-calc$/);
    expect(script.calcCandidates('bun-linux-x64', 'bun-darwin-arm64')).toHaveLength(1);
  });

  it('names the Windows binary clerq-calc.exe', () => {
    expect(script.calcCandidates('bun-windows-x64', 'bun-linux-x64')[0]).toMatch(
      /clerq-calc\.exe$/
    );
  });
});
