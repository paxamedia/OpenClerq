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
import { fileURLToPath } from 'node:url';

/** CPU names as the updater spells them; the file names carry any of these. */
const CPU = { aarch64: 'aarch64', arm64: 'aarch64', x86_64: 'x86_64', x64: 'x86_64', amd64: 'x86_64' };

/**
 * The updater keys a bundle answers to. Tauri looks for "<os>-<arch>-<installer>"
 * first and falls back to "<os>-<arch>", so an app installed from the MSI
 * updates from the MSI and one installed with the NSIS setup from the setup.
 *
 * Linux is the AppImage alone, under "linux-<arch>-appimage" and not the plain
 * "linux-<arch>": the updater (tauri-plugin-updater 2.10, checked in its source) asks a
 * .deb or .rpm install for "-deb" or "-rpm" and then for the plain key, and the plain key
 * would hand them an AppImage that cannot be installed over a package, after downloading
 * it. Tauri signs no .deb or .rpm, so those installs have no entry at all and the
 * update check says so; they update by installing the new package.
 */
export function keysFor(file) {
  const arch = /_(aarch64|x86_64|x64|amd64|arm64)[_.-]/.exec(file)?.[1];
  const cpu = arch && CPU[arch];
  if (!cpu) return [];
  if (file.endsWith('.app.tar.gz')) return [`darwin-${cpu}`, `darwin-${cpu}-app`];
  if (file.endsWith('.msi')) return [`windows-${cpu}-msi`];
  if (file.endsWith('-setup.exe')) return [`windows-${cpu}`, `windows-${cpu}-nsis`];
  if (file.endsWith('.AppImage')) return [`linux-${cpu}-appimage`];
  return [];
}

/**
 * The manifest for the files in a release folder, or null when nothing in it is signed.
 * `read(name)` returns a file's text; `files` are the folder's names.
 */
export function buildManifest({ version, baseUrl, files, read, now = new Date() }) {
  const platforms = {};
  for (const file of [...files].sort()) {
    if (file.endsWith('.sig') || !files.includes(`${file}.sig`)) continue;
    const signature = read(`${file}.sig`).trim();
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
  if (Object.keys(platforms).length === 0) return null;
  return {
    version,
    notes: `See https://github.com/paxamedia/OpenClerq/releases/tag/v${version}`,
    pub_date: now.toISOString(),
    platforms,
  };
}

function main() {
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

  const manifest = buildManifest({
    version,
    baseUrl,
    files: fs.readdirSync(releaseDir),
    read: (name) => fs.readFileSync(path.join(releaseDir, name), 'utf8'),
  });
  if (!manifest) {
    console.warn('No signed updater bundles in release/; latest.json not written.');
    process.exit(0);
  }
  fs.writeFileSync(path.join(releaseDir, 'latest.json'), JSON.stringify(manifest, null, 2));
  console.log(`latest.json covers: ${Object.keys(manifest.platforms).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
