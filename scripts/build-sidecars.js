#!/usr/bin/env node
/**
 * Build sidecar binaries for the desktop app (download-and-run).
 * Produces: clerq-gateway (Bun-compiled), clerq-calc (copied from Rust build).
 * Requires: pnpm build:gateway, pnpm build:core run first. Bun for gateway compile.
 *
 * The binaries are built for the machine this runs on (macOS, Windows and Linux; Apple
 * Silicon and Intel, x64 and arm64) and named for the Rust target Tauri looks them up by
 * (`clerq-gateway-<triple>`). x64 on macOS and Linux is Bun's baseline build, which runs on
 * a CPU without AVX2; the default one dies with SIGILL there. The compile is
 * scripts/build-binary.js, the one the server and the CLI use.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build-binary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'binaries');

/**
 * Which Bun target and Rust target a machine's sidecars are for, or null for a machine with no
 * desktop build. Windows stays on Bun's default x64 build.
 */
export function sidecarTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { bunTarget: 'bun-darwin-arm64', rustTarget: 'aarch64-apple-darwin', exeExt: '' }
      : { bunTarget: 'bun-darwin-x64-baseline', rustTarget: 'x86_64-apple-darwin', exeExt: '' };
  }
  if (platform === 'win32' && arch === 'x64') {
    return { bunTarget: 'bun-windows-x64', rustTarget: 'x86_64-pc-windows-msvc', exeExt: '.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'x64') {
      return { bunTarget: 'bun-linux-x64-baseline', rustTarget: 'x86_64-unknown-linux-gnu', exeExt: '' };
    }
    if (arch === 'arm64') {
      return { bunTarget: 'bun-linux-arm64', rustTarget: 'aarch64-unknown-linux-gnu', exeExt: '' };
    }
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
  const { bunTarget, rustTarget, exeExt } = target;
  fs.mkdirSync(BINARIES_DIR, { recursive: true });

  // 1. Build gateway (TypeScript) and core (Rust)
  run('pnpm build:gateway');
  run('pnpm build:core');

  // 2. Compile the gateway to a binary with Bun (from the devDependency, which build-binary
  //    finds, or fixes when pnpm skipped its install script). The packages are built, so skip that.
  const staging = path.join(BINARIES_DIR, '.build');
  let compiled;
  try {
    compiled = build({
      entry: 'packages/gateway/src/cli.ts',
      name: 'clerq-gateway',
      target: bunTarget,
      outDir: staging,
      calc: 'none',
      requireCalc: false,
      skipBuild: true,
      json: false,
    });
  } catch (e) {
    console.error(`[build-sidecars] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const gatewayOut = path.join(BINARIES_DIR, `clerq-gateway-${rustTarget}${exeExt}`);
  fs.copyFileSync(compiled.binary, gatewayOut);
  fs.chmodSync(gatewayOut, 0o755);
  fs.rmSync(staging, { recursive: true, force: true });

  // 3. Copy clerq-calc
  const calcSrc = path.join(ROOT, 'packages', 'calculation-core', 'target', 'release', `clerq-calc${exeExt}`);
  if (!fs.existsSync(calcSrc)) {
    console.error('[build-sidecars] clerq-calc not found at', calcSrc);
    process.exit(1);
  }
  const calcOut = path.join(BINARIES_DIR, `clerq-calc-${rustTarget}${exeExt}`);
  fs.copyFileSync(calcSrc, calcOut);

  console.log('[build-sidecars] Done. Binaries:', gatewayOut, calcOut);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
