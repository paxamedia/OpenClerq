#!/usr/bin/env node
/**
 * Build sidecar binaries for the desktop app (download-and-run).
 * Produces: clerq-gateway (Bun-compiled), clerq-calc (copied from Rust build).
 * Requires: pnpm build:gateway, pnpm build:core run first. Bun for gateway compile.
 *
 * The binaries are built for the machine this runs on (macOS on Apple Silicon or Intel,
 * Windows x64, Linux x64 or arm64) and named for the Rust target Tauri looks them up by
 * (`clerq-gateway-<triple>`). x64 on macOS and Linux is Bun's baseline build, which runs on a
 * CPU without AVX2; the default one dies with SIGILL there.
 *
 * On Linux the gateway is not a Tauri sidecar: it is `clerq-gateway-linux` (the same name for both
 * CPUs, so that tauri.linux.conf.json can name it), which the .deb, the .rpm and the AppImage put in
 * /usr/share/clerq. linuxdeploy, which makes the AppImage, runs `ldd` on every ELF file in usr/bin
 * (where a sidecar goes) and usr/lib, and that fails on a program Bun compiled. The calculation
 * engine is an ordinary program and stays a sidecar.
 *
 * This compiles with `bun build --compile` itself and not through scripts/build-binary.js (the
 * server's and the CLI's compile): that script starts pnpm without a shell, which does not work
 * for pnpm.cmd on Windows, where this runs on a release.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'binaries');

/**
 * Which Bun target and Rust target a machine's sidecars are for, or null for a machine with no
 * desktop build. Windows stays on Bun's default x64 build.
 */
export function sidecarTarget(platform = process.platform, arch = process.arch) {
  const target = (bunTarget, rustTarget, exeExt = '') => ({
    bunTarget,
    rustTarget,
    exeExt,
    // The files written to src-tauri/binaries.
    gatewayFile: platform === 'linux' ? 'clerq-gateway-linux' : `clerq-gateway-${rustTarget}${exeExt}`,
    calcFile: `clerq-calc-${rustTarget}${exeExt}`,
  });
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? target('bun-darwin-arm64', 'aarch64-apple-darwin')
      : target('bun-darwin-x64-baseline', 'x86_64-apple-darwin');
  }
  if (platform === 'win32' && arch === 'x64') {
    return target('bun-windows-x64', 'x86_64-pc-windows-msvc', '.exe');
  }
  if (platform === 'linux') {
    if (arch === 'x64') return target('bun-linux-x64-baseline', 'x86_64-unknown-linux-gnu');
    if (arch === 'arm64') return target('bun-linux-arm64', 'aarch64-unknown-linux-gnu');
  }
  return null;
}

function run(cmd, opts = {}) {
  console.log('[build-sidecars]', cmd);
  return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function main() {
  const target = sidecarTarget();
  if (!target) {
    console.error(
      `[build-sidecars] No desktop build for ${process.platform}/${process.arch} (macOS, Windows x64, Linux x64 and arm64).`
    );
    process.exit(1);
  }
  const { bunTarget, exeExt, gatewayFile, calcFile } = target;
  fs.mkdirSync(BINARIES_DIR, { recursive: true });

  // 1. Build gateway (TypeScript) and core (Rust)
  run('pnpm build:gateway');
  run('pnpm build:core');

  // 2. Compile gateway to binary with Bun (from devDependency or PATH)
  let bun = 'pnpm exec bun';
  try {
    execSync('pnpm exec bun --version', { stdio: 'ignore' });
  } catch {
    // Bun's postinstall may not run under pnpm; try to fix and retry
    const bunInstall = path.join(ROOT, 'node_modules', 'bun', 'install.js');
    if (fs.existsSync(bunInstall)) {
      try {
        execSync(`node "${bunInstall}"`, { cwd: ROOT, stdio: 'inherit' });
        execSync('pnpm exec bun --version', { stdio: 'ignore' });
      } catch {
        console.error('[build-sidecars] Run: cd node_modules/bun && node install.js');
        process.exit(1);
      }
    } else {
      try {
        execSync('bun --version', { stdio: 'ignore' });
        bun = 'bun';
      } catch {
        console.error('[build-sidecars] Bun is required. Run: pnpm add -D bun -w');
        process.exit(1);
      }
    }
  }

  const gatewayOut = path.join(BINARIES_DIR, gatewayFile);
  run(
    `${bun} build packages/gateway/src/cli.ts --compile --target=${bunTarget} --outfile=${gatewayOut}`
  );

  // 3. Copy clerq-calc
  const calcSrc = path.join(
    ROOT,
    'packages',
    'calculation-core',
    'target',
    'release',
    `clerq-calc${exeExt}`
  );
  if (!fs.existsSync(calcSrc)) {
    console.error('[build-sidecars] clerq-calc not found at', calcSrc);
    process.exit(1);
  }
  const calcOut = path.join(BINARIES_DIR, calcFile);
  fs.copyFileSync(calcSrc, calcOut);

  console.log('[build-sidecars] Done. Binaries:', gatewayOut, calcOut);
}

/** Was this file started as the program, and not imported? (Real paths, so case and links do not matter.) */
function isMain() {
  try {
    return (
      fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) main();
