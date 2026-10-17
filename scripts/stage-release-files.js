#!/usr/bin/env node
/**
 * Copy this platform's installers and updater bundles into one flat directory
 * for the release, with the CPU architecture in every name.
 *
 *   node scripts/stage-release-files.js <out-dir>
 *
 * Tauri writes each bundle type to its own folder, and names the macOS updater
 * bundle Clerq.app.tar.gz — nothing in it says which CPU it is for, so the
 * manifest could not tell an Apple Silicon build from an Intel one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const bundleDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle');

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/stage-release-files.js <out-dir>');
  process.exit(1);
}

const ARCH = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
if (!ARCH) {
  console.error(`Unsupported architecture: ${process.arch}`);
  process.exit(1);
}

const { version } = JSON.parse(
  fs.readFileSync(path.join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8')
);

fs.mkdirSync(outDir, { recursive: true });
const staged = [];

/** Copy each file in a bundle folder that passes the filter, with its .sig. */
function stage(folder, accept, rename = (name) => name) {
  const dir = path.join(bundleDir, folder);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!accept(name)) continue;
    for (const suffix of ['', '.sig']) {
      const from = path.join(dir, name + suffix);
      if (!fs.existsSync(from)) continue;
      const to = rename(name) + suffix;
      fs.copyFileSync(from, path.join(outDir, to));
      staged.push(to);
    }
  }
}

stage('dmg', (n) => n.endsWith('.dmg'));
stage(
  'macos',
  (n) => n.endsWith('.app.tar.gz'),
  (n) => `${n.slice(0, -'.app.tar.gz'.length)}_${version}_${ARCH}.app.tar.gz`
);
stage('msi', (n) => n.endsWith('.msi'));
stage('nsis', (n) => n.endsWith('.exe'));

if (!staged.some((n) => !n.endsWith('.sig'))) {
  console.error(`No installers found under ${path.relative(root, bundleDir)}.`);
  process.exit(1);
}
console.log(`Staged in ${outDir}:\n  ${staged.join('\n  ')}`);
