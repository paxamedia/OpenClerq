#!/usr/bin/env node
/**
 * Build sidecar binaries for the desktop app (download-and-run).
 * Produces: clerq-gateway (Bun-compiled), clerq-calc (copied from Rust build).
 * Requires: pnpm build:gateway, pnpm build:core run first. Bun for gateway compile.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'binaries');

function run(cmd, opts = {}) {
  console.log('[build-sidecars]', cmd);
  return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

// Resolve target triple and Bun target
const platform = process.platform;
const arch = process.arch;
let rustTarget, bunTarget, exeExt;
if (platform === 'darwin') {
  exeExt = '';
  rustTarget = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  bunTarget = arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
} else if (platform === 'win32') {
  exeExt = '.exe';
  rustTarget = 'x86_64-pc-windows-msvc';
  bunTarget = 'bun-windows-x64';
} else {
  console.error('[build-sidecars] Only macOS and Windows are supported for sidecar build.');
  process.exit(1);
}

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

const gatewayOut = path.join(BINARIES_DIR, `clerq-gateway-${rustTarget}${exeExt}`);
run(`${bun} build packages/gateway/src/cli.ts --compile --target=${bunTarget} --outfile=${gatewayOut}`);

// 3. Copy clerq-calc
const calcSrc = path.join(ROOT, 'packages', 'calculation-core', 'target', 'release', `clerq-calc${exeExt}`);
if (!fs.existsSync(calcSrc)) {
  console.error('[build-sidecars] clerq-calc not found at', calcSrc);
  process.exit(1);
}
const calcOut = path.join(BINARIES_DIR, `clerq-calc-${rustTarget}${exeExt}`);
fs.copyFileSync(calcSrc, calcOut);

console.log('[build-sidecars] Done. Binaries:', gatewayOut, calcOut);
