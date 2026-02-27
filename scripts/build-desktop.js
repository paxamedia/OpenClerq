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

// Desktop depends on @clerq/gateway-client and @clerq/module-schema; build them first
execSync('pnpm --filter @clerq/gateway-client build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
execSync('pnpm --filter @clerq/module-schema build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });

// Skip updater artifacts (.sig) when private key is not available (build workflow, local test)
// Use a temp config file to avoid CLI encoding issues on Windows
const skipUpdater = !env.TAURI_SIGNING_PRIVATE_KEY;
let tauriArgs = ['exec', 'tauri', 'build'];
if (skipUpdater) {
  const overridePath = path.join(os.tmpdir(), `tauri-override-${Date.now()}.json`);
  fs.writeFileSync(overridePath, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }), 'utf8');
  tauriArgs = ['exec', 'tauri', 'build', '-c', overridePath];
  try {
    const result = spawnSync('pnpm', tauriArgs, { cwd: desktopDir, stdio: 'inherit', env });
    fs.unlinkSync(overridePath);
    if (result.status !== 0) process.exit(result.status ?? 1);
  } catch (e) {
    try { fs.unlinkSync(overridePath); } catch (_) {}
    throw e;
  }
} else {
  const result = spawnSync('pnpm', tauriArgs, { cwd: desktopDir, stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
