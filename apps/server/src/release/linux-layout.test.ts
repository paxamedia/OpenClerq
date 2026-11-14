/**
 * Where the Linux packages put the gateway, and what has to agree for the desktop to find it.
 *
 * linuxdeploy, which makes the AppImage, runs `ldd` on every ELF file it finds in usr/bin and
 * usr/lib (recursively), and it fails on the gateway, a program compiled by Bun: "Failed to run
 * ldd: exited with code 1", and the AppImage is not made. So on Linux the gateway is not a Tauri
 * sidecar (those go to usr/bin) and not a resource (those go to usr/lib/<product>): the .deb, the
 * .rpm and the AppImage each put it in /usr/share/clerq, which nothing scans, and the desktop starts
 * it from there. Four files say so, and this test holds them together; scripts/check-linux-packages.sh
 * checks the result in the real packages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

const linux = json('apps/desktop/src-tauri/tauri.linux.conf.json');
const base = json('apps/desktop/src-tauri/tauri.conf.json');
const DEST = '/usr/share/clerq/clerq-gateway';

describe('the gateway in the Linux packages', () => {
  it('is no sidecar on Linux (usr/bin is scanned), and the calculation engine still is', () => {
    expect(linux.bundle.externalBin).toEqual(['binaries/clerq-calc']);
    // Only what the base config already names: the platform file takes one out.
    for (const bin of linux.bundle.externalBin) expect(base.bundle.externalBin).toContain(bin);
    expect(linux.bundle.externalBin).not.toContain('binaries/clerq-gateway');
  });

  it('is put by every Linux package in /usr/share/clerq, from the file build-sidecars.js writes', () => {
    for (const format of ['appimage', 'deb', 'rpm']) {
      expect(linux.bundle.linux[format].files, format).toEqual({
        [DEST]: 'binaries/clerq-gateway-linux',
      });
    }
    // The name build-sidecars.js writes on Linux, for either CPU.
    expect(read('scripts/build-sidecars.js')).toContain("'clerq-gateway-linux'");
    // Never usr/bin or usr/lib: linuxdeploy runs ldd on what it finds there.
    expect(DEST).not.toMatch(/^\/usr\/(bin|lib)(\/|$)/);
  });

  it('is started by the desktop from the same place, next to usr/bin', () => {
    const rust = read('apps/desktop/src-tauri/src/main.rs');
    const relative = /const LINUX_GATEWAY: &str = "([^"]+)";/.exec(rust)?.[1];
    expect(relative).toBeDefined();
    // usr/bin + that = the destination in the packages.
    expect(path.posix.normalize(path.posix.join('/usr/bin', relative as string))).toBe(DEST);
    // Only on Linux; macOS and Windows still start the sidecar.
    expect(rust).toContain('app.shell().sidecar("clerq-gateway")');
  });

  it('is looked for where the packages check says it is, and nowhere linuxdeploy looks', () => {
    const check = read('scripts/check-linux-packages.sh');
    expect(check).toContain('usr/share/clerq/clerq-gateway');
    expect(check).toMatch(/usr\/bin\/clerq-gateway|usr\/lib/);
  });

  it('does not change the other platforms: the base config still has both sidecars', () => {
    expect(base.bundle.externalBin).toEqual(['binaries/clerq-gateway', 'binaries/clerq-calc']);
    expect(base.bundle.linux).toBeUndefined();
  });
});
