#!/usr/bin/env node
/**
 * Keep one version across the repository.
 *
 *   node scripts/sync-version.js 0.5.0   set every file to 0.5.0
 *   node scripts/sync-version.js         re-sync every file to package.json's version
 *   node scripts/sync-version.js --check report drift and exit 1, writing nothing (CI)
 *
 * Every package under packages/ and apps/ is found by looking rather than
 * listed by hand, so a new package cannot be left behind.
 *
 * Versions are edited in place as text. Re-serialising JSON would reformat
 * whole files — expanding arrays prettier keeps on one line, rewriting
 * escapes — and bury a one-field change in noise.
 * packages/calculation-core is a separate Rust crate with its own semver and
 * is deliberately not touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const args = process.argv.slice(2);
const check = args.includes('--check');
const versionArg = args.find((a) => !a.startsWith('--'));

if (versionArg && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(versionArg)) {
  console.error(`"${versionArg}" is not a semantic version (expected e.g. 0.5.0).`);
  process.exit(1);
}

const rootPkgPath = path.join(root, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const version = versionArg || rootPkg.version;

/** Every package.json one level under packages/ and apps/, plus the root. */
function packageJsonFiles() {
  const found = [rootPkgPath];
  for (const dir of ['packages', 'apps']) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name, 'package.json');
      if (fs.existsSync(file)) found.push(file);
    }
  }
  return found;
}

/** The top-level "version" field: the first one in a package or Tauri config. */
const JSON_VERSION = {
  pattern: /("version"\s*:\s*)"[^"]*"/,
  replace: (v) => `$1"${v}"`,
  current: (m) => m[0].match(/"([^"]*)"$/)[1],
};

/** Every file with a version, and how to find it. */
const targets = [
  ...packageJsonFiles().map((file) => ({ file: path.relative(root, file), ...JSON_VERSION })),
  { file: 'apps/desktop/src-tauri/tauri.conf.json', ...JSON_VERSION },
  {
    file: 'apps/desktop/src-tauri/Cargo.toml',
    pattern: /^version\s*=\s*"[^"]+"/m,
    replace: (v) => `version = "${v}"`,
  },
  {
    // The lockfile records the desktop crate's own version too.
    file: 'apps/desktop/src-tauri/Cargo.lock',
    pattern: /(name = "clerq-desktop"\nversion = )"[^"]+"/,
    replace: (v) => `$1"${v}"`,
    current: (m) => m[0].match(/"([^"]+)"$/)[1],
  },
  {
    // The version reported by /health and /metrics.
    file: 'packages/gateway/src/gateway.ts',
    pattern: /export const GATEWAY_VERSION = '[^']+';/,
    replace: (v) => `export const GATEWAY_VERSION = '${v}';`,
    current: (m) => m[0].match(/'([^']+)'/)[1],
  },
];

const drift = [];

for (const t of targets) {
  const file = path.join(root, t.file);
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  const match = content.match(t.pattern);
  if (!match) {
    console.error(`No version found in ${t.file}; the pattern needs updating.`);
    process.exitCode = 1;
    continue;
  }
  const found = t.current ? t.current(match) : match[0].match(/"([^"]+)"/)[1];
  if (found !== version) drift.push(`${t.file}: ${found} (expected ${version})`);
  if (!check && found !== version) {
    fs.writeFileSync(file, content.replace(t.pattern, t.replace(version)));
    console.log('Updated', t.file);
  }
}

if (check) {
  if (drift.length) {
    console.error(`Version drift from ${version}:\n  ${drift.join('\n  ')}`);
    console.error('Run: node scripts/sync-version.js ' + version);
    process.exit(1);
  }
  console.log(`All versions match ${version}.`);
} else {
  console.log('Synced version to', version);
}
