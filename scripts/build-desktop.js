#!/usr/bin/env node
/**
 * Run tauri build. When UNSET_CI=1, unsets CI and sets TAURI_CI=false
 * so tools (e.g. DMG bundler) don't assume headless/CI mode.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.join(__dirname, '..', 'apps', 'desktop');

const env = { ...process.env };
if (process.env.UNSET_CI === '1') {
  delete env.CI;
  env.TAURI_CI = 'false';
}

execSync('pnpm exec tauri build', {
  cwd: desktopDir,
  stdio: 'inherit',
  env,
});
