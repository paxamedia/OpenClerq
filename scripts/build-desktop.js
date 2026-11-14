#!/usr/bin/env node
/**
 * Run tauri build. When UNSET_CI=1, unsets CI and sets TAURI_CI=false
 * so tools (e.g. DMG bundler) don't assume headless/CI mode.
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.join(__dirname, '..', 'apps', 'desktop');

const env = { ...process.env };

// GitHub Actions passes a secret that is not configured as an empty string, not
// as nothing. Tauri then signs with the identity "" and fails ("no identity
// found"), so an unsigned release build broke on every tag. Empty means unset.
for (const name of [
  'APPLE_SIGNING_IDENTITY',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
]) {
  if (typeof env[name] === 'string' && env[name].trim() === '') delete env[name];
}

// Linux: the AppImage is made by linuxdeploy, which Tauri runs and whose own output it hides unless
// asked for (`failed to run linuxdeploy` and nothing else), so the Linux build is verbose.
// NO_STRIP: linuxdeploy's bundled `strip` cannot read binaries made by newer toolchains (.relr.dyn
// sections), which broke the AppImage of the first Linux builds, and a strip would also cut off the
// code a Bun-compiled sidecar keeps appended to its file. APPIMAGE_EXTRACT_AND_RUN: run linuxdeploy's
// own AppImages unpacked, with no FUSE (a build machine often has none). Set already, they are kept.
const linuxArgs = process.platform === 'linux' ? ['--verbose'] : [];
if (process.platform === 'linux') {
  env.NO_STRIP ??= 'true';
  env.APPIMAGE_EXTRACT_AND_RUN ??= '1';
}

if (process.env.UNSET_CI === '1') {
  delete env.CI;
  env.TAURI_CI = 'false';
} else {
  // Tauri expects CI/TAURI_CI to be "true" or "false", not "1"
  if (env.CI) {
    env.CI = 'true';
    env.TAURI_CI = 'true';
  } else {
    env.TAURI_CI = 'false';
  }
}

const rootDir = path.join(__dirname, '..');
const execOpts = { cwd: rootDir, stdio: 'inherit' };
// On Windows, use shell so pnpm/npm scripts resolve correctly (pnpm.cmd)
if (process.platform === 'win32') execOpts.shell = true;

// Desktop depends on @clerq/gateway-client and @clerq/module-schema, and its web screens on
// @clerq/plugin-sdk (which needs the client's protocol): build them first
execSync('pnpm --filter @clerq/gateway-client build', execOpts);
execSync('pnpm --filter @clerq/plugin-sdk build', execOpts);
execSync('pnpm --filter @clerq/module-schema build', execOpts);

// Skip updater artifacts (.sig) when private key is not available (build workflow, local test)
// Use a temp config file to avoid CLI encoding issues on Windows
const skipUpdater = !env.TAURI_SIGNING_PRIVATE_KEY;
let tauriArgs = ['exec', 'tauri', 'build', ...linuxArgs];
if (skipUpdater) {
  const overridePath = path.join(os.tmpdir(), `tauri-override-${Date.now()}.json`);
  fs.writeFileSync(overridePath, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }), 'utf8');
  tauriArgs = ['exec', 'tauri', 'build', '-c', overridePath, ...linuxArgs];
  const spawnOpts = { cwd: desktopDir, stdio: 'inherit', env };
  if (process.platform === 'win32') spawnOpts.shell = true;
  try {
    const result = spawnSync('pnpm', tauriArgs, spawnOpts);
    fs.unlinkSync(overridePath);
    if (result.status !== 0) process.exit(result.status ?? 1);
  } catch (e) {
    try { fs.unlinkSync(overridePath); } catch (_) {}
    throw e;
  }
} else {
  const spawnOpts = { cwd: desktopDir, stdio: 'inherit', env };
  if (process.platform === 'win32') spawnOpts.shell = true;
  const result = spawnSync('pnpm', tauriArgs, spawnOpts);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
