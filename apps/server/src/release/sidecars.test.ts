/**
 * scripts/build-sidecars.js: which Bun build and which Rust target the desktop app's gateway
 * and engine are made for, on each machine a desktop release is built on. Compiling them is
 * done by the installer build itself (`pnpm build:installers`, in CI and the pristine check).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Target {
  bunTarget: string;
  rustTarget: string;
  exeExt: string;
  gatewayFile: string;
  calcFile: string;
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const load = async <T>(name: string) =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'scripts', name)).href)) as T;
const sidecars = await load<{ sidecarTarget(p?: string, a?: string): Target | null }>(
  'build-sidecars.js'
);
const binary = await load<{ parseTarget(t: string): { rustTarget: string; exe: string } | null }>(
  'build-binary.js'
);

describe('the sidecar target of each build machine', () => {
  const cases: [string, string, string, string][] = [
    ['darwin', 'arm64', 'bun-darwin-arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'bun-darwin-x64-baseline', 'x86_64-apple-darwin'],
    ['linux', 'x64', 'bun-linux-x64-baseline', 'x86_64-unknown-linux-gnu'],
    ['linux', 'arm64', 'bun-linux-arm64', 'aarch64-unknown-linux-gnu'],
    ['win32', 'x64', 'bun-windows-x64', 'x86_64-pc-windows-msvc'],
  ];
  it.each(cases)('%s/%s compiles %s and names its files for %s', (platform, arch, bun, rust) => {
    const t = sidecars.sidecarTarget(platform, arch)!;
    expect(t.bunTarget).toBe(bun);
    expect(t.rustTarget).toBe(rust);
    // The compile (build-binary.js) accepts the target and agrees about the Rust triple.
    expect(binary.parseTarget(t.bunTarget)).toMatchObject({ rustTarget: rust, exe: t.exeExt });
  });

  it('uses Bun’s baseline build for x64 on the Mac and on Linux, which run without AVX2', () => {
    expect(sidecars.sidecarTarget('darwin', 'x64')!.bunTarget).toMatch(/-baseline$/);
    expect(sidecars.sidecarTarget('linux', 'x64')!.bunTarget).toMatch(/-baseline$/);
  });

  it('has no target for a machine the desktop is not built on', () => {
    expect(sidecars.sidecarTarget('win32', 'arm64')).toBeNull();
    expect(sidecars.sidecarTarget('linux', 'ia32')).toBeNull();
    expect(sidecars.sidecarTarget('freebsd', 'x64')).toBeNull();
  });

  it('writes the names Tauri looks the sidecars up by: externalBin plus the target triple', () => {
    const conf = JSON.parse(
      fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
    ) as { bundle: { externalBin: string[] } };
    expect(conf.bundle.externalBin).toEqual(['binaries/clerq-gateway', 'binaries/clerq-calc']);
    // macOS and Windows: both are sidecars, named for the Rust target.
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['win32', 'x64'],
    ] as const) {
      const t = sidecars.sidecarTarget(platform, arch)!;
      expect(t.gatewayFile).toBe(`clerq-gateway-${t.rustTarget}${t.exeExt}`);
      expect(t.calcFile).toBe(`clerq-calc-${t.rustTarget}${t.exeExt}`);
    }
  });

  it('on Linux, writes the gateway under one name for both CPUs, and the calculation engine as a sidecar', () => {
    // The gateway is not a sidecar there (tauri.linux.conf.json puts it in /usr/share/clerq): one
    // name, so the config can name it whatever the CPU. The engine stays a sidecar.
    const x64 = sidecars.sidecarTarget('linux', 'x64')!;
    const arm = sidecars.sidecarTarget('linux', 'arm64')!;
    expect(x64.gatewayFile).toBe('clerq-gateway-linux');
    expect(arm.gatewayFile).toBe('clerq-gateway-linux');
    expect(x64.calcFile).toBe('clerq-calc-x86_64-unknown-linux-gnu');
    expect(arm.calcFile).toBe('clerq-calc-aarch64-unknown-linux-gnu');
  });
});
