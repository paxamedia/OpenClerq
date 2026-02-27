#!/usr/bin/env node
/**
 * Generate latest.json for Tauri updater from release artifacts.
 * Run from repo root; expects artifacts in ./release/ with .sig files.
 * Usage: node scripts/generate-updater-manifest.js <version> <release-base-url>
 */
import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2] || process.env.VERSION || '0.1.0';
const baseUrl = process.argv[3] || process.env.RELEASE_URL || 'https://github.com/officeworkersforfree/clerq/releases/download/v' + version;

const releaseDir = path.join(process.cwd(), 'release');
if (!fs.existsSync(releaseDir)) {
  console.error('release/ directory not found');
  process.exit(1);
}

const platforms = {};
const files = fs.readdirSync(releaseDir);

for (const file of files) {
  if (file.endsWith('.sig') || file === 'latest.json') continue;
  if (file.endsWith('.dmg') || file.endsWith('.app')) continue; // Skip raw .app
  const sigFile = file + '.sig';
  if (!files.includes(sigFile)) continue;

  const sig = fs.readFileSync(path.join(releaseDir, sigFile), 'utf8');
  const url = `${baseUrl}/${file}`;

  let key;
  if (file.includes('aarch64') || file.includes('arm64')) key = 'darwin-aarch64';
  else if (file.includes('x86_64') && file.includes('darwin')) key = 'darwin-x86_64';
  else if (file.includes('x64') && (file.endsWith('.msi') || file.endsWith('.exe'))) key = 'windows-x86_64';
  else if (file.includes('i686')) key = 'windows-i686';
  else if (file.endsWith('.tar.gz')) {
    key = file.includes('aarch64') ? 'darwin-aarch64' : 'darwin-x86_64';
  } else continue;

  platforms[key] = { url, signature: sig };
}

const manifest = {
  version: version.replace(/^v/, ''),
  notes: `Release v${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync(path.join(releaseDir, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log('Generated latest.json for', Object.keys(platforms).length, 'platforms');
console.log(JSON.stringify(manifest, null, 2));
