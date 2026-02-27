#!/usr/bin/env node
/**
 * Sync version from root package.json to desktop package, tauri.conf, and Cargo.toml.
 * Run from repo root: node scripts/sync-version.js [version]
 * If no version given, reads from package.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const versionArg = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = versionArg || pkg.version;

const updates = [
  { file: path.join(root, 'apps/desktop/package.json'), get: (j) => j.version, set: (j, v) => { j.version = v; return j; } },
  { file: path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), get: (j) => j.version, set: (j, v) => { j.version = v; return j; } },
  { file: path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), raw: true },
];

for (const u of updates) {
  if (u.raw) {
    const content = fs.readFileSync(u.file, 'utf8');
    const updated = content.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
    fs.writeFileSync(u.file, updated);
    console.log('Updated', u.file);
  } else {
    const j = JSON.parse(fs.readFileSync(u.file, 'utf8'));
    u.set(j, version);
    fs.writeFileSync(u.file, JSON.stringify(j, null, 2) + '\n');
    console.log('Updated', u.file);
  }
}

if (versionArg) {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  rootPkg.version = version;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');
  console.log('Updated package.json');
}

console.log('Synced version to', version);
