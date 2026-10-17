#!/usr/bin/env node
/**
 * Write latest.json, the Tauri updater manifest, from the signed bundles in ./release/.
 *
 *   node scripts/generate-updater-manifest.js <version> <release-base-url>
 *
 * Expects the flat, architecture-named files stage-release-files.js produces.
 * A bundle without a .sig is left out: the app refuses an unsigned update. With
 * nothing signed, no manifest is written, so an unsigned release still ships
 * its installers and simply offers no in-app update.
 */
import fs from 'node:fs';
import path from 'node:path';

const version = (process.argv[2] || process.env.VERSION || '').replace(/^v/, '');
const baseUrl = process.argv[3] || process.env.RELEASE_URL;
if (!version || !baseUrl) {
  console.error('Usage: node scripts/generate-updater-manifest.js <version> <release-base-url>');
  process.exit(1);
}

const releaseDir = path.join(process.cwd(), 'release');
if (!fs.existsSync(releaseDir)) {
  console.error('release/ directory not found');
  process.exit(1);
}

const files = fs.readdirSync(releaseDir);

/**
 * The updater keys a bundle answers to. Tauri looks for "<os>-<arch>-<installer>"
 * first and falls back to "<os>-<arch>", so an app installed from the MSI
 * updates from the MSI and one installed with the NSIS setup from the setup.
 */
function keysFor(file) {
  const arch = /_(aarch64|x86_64|x64)[_.-]/.exec(file)?.[1];
  const cpu = arch === 'x64' ? 'x86_64' : arch;
  if (!cpu) return [];
  if (file.endsWith('.app.tar.gz')) return [`darwin-${cpu}`, `darwin-${cpu}-app`];
  if (file.endsWith('.msi')) return [`windows-${cpu}-msi`];
  if (file.endsWith('-setup.exe')) return [`windows-${cpu}`, `windows-${cpu}-nsis`];
  return [];
}

const platforms = {};
for (const file of files.sort()) {
  if (file.endsWith('.sig') || !files.includes(`${file}.sig`)) continue;
  const signature = fs.readFileSync(path.join(releaseDir, `${file}.sig`), 'utf8').trim();
  for (const key of keysFor(file)) {
    platforms[key] = { url: `${baseUrl}/${encodeURIComponent(file)}`, signature };
  }
}
// An MSI-only build still answers the plain Windows key.
for (const cpu of ['x86_64', 'aarch64']) {
  if (!platforms[`windows-${cpu}`] && platforms[`windows-${cpu}-msi`]) {
    platforms[`windows-${cpu}`] = platforms[`windows-${cpu}-msi`];
  }
}

if (Object.keys(platforms).length === 0) {
  console.warn('No signed updater bundles in release/; latest.json not written.');
  process.exit(0);
}

const manifest = {
  version,
  notes: `See https://github.com/paxamedia/OpenClerq/releases/tag/v${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync(path.join(releaseDir, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`latest.json covers: ${Object.keys(platforms).join(', ')}`);
