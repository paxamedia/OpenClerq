#!/usr/bin/env node
/**
 * Copy this platform's installers and updater bundles into one flat directory
 * for the release, with the CPU architecture in every name.
 *
 *   node scripts/stage-release-files.js <out-dir>
 *
 * Tauri writes each bundle type to its own folder, and names the macOS updater
 * bundle Clerq.app.tar.gz — nothing in it says which CPU it is for, so the
 * manifest could not tell an Apple Silicon build from an Intel one. The AppImage
 * is renamed the same way (Clerq_<version>_x86_64.AppImage), because Tauri spells
 * its CPU "amd64" there and "aarch64" for arm64, which no other name here uses. The
 * .deb and .rpm keep Tauri's names (Debian's amd64/arm64, RPM's x86_64/aarch64): they
 * already carry the CPU, which is checked, because every build job of a release
 * stages into the same release and two with one name would silently replace each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CONF = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
const DEFAULT_BUNDLE_DIR = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle');

/** The CPU of a Node arch, in the updater's spelling. */
export function cpuName(nodeArch = process.arch) {
  return { arm64: 'aarch64', x64: 'x86_64' }[nodeArch];
}

/** Every spelling of one CPU that a Tauri bundle name may use. */
const SPELLINGS = { aarch64: ['aarch64', 'arm64'], x86_64: ['x86_64', 'x64', 'amd64'] };

/** Does a file name carry this machine's CPU, in any of its spellings? */
export function namesCpu(name, cpu) {
  return SPELLINGS[cpu].some((s) => new RegExp(`[_.-]${s}(?![A-Za-z0-9])`).test(name));
}

/**
 * Copy each bundle (and its .sig, when there is one) into `outDir`. Returns the staged names,
 * or throws when a bundle's name does not say which CPU it is for.
 */
export function stageFiles({ bundleDir, outDir, cpu, version, productName }) {
  fs.mkdirSync(outDir, { recursive: true });
  const staged = [];

  /** Copy each file in a bundle folder that passes the filter, with its .sig. */
  function stage(folder, accept, rename = (name) => name) {
    const dir = path.join(bundleDir, folder);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!accept(name)) continue;
      const to = rename(name);
      for (const suffix of ['', '.sig']) {
        const from = path.join(dir, name + suffix);
        if (!fs.existsSync(from)) continue;
        if (suffix === '' && staged.includes(to)) {
          throw new Error(`${to} is already staged: two bundles would have the same name.`);
        }
        fs.copyFileSync(from, path.join(outDir, to + suffix));
        staged.push(to + suffix);
      }
    }
  }

  /** A package name that must say which CPU it is for. */
  const named = (name) => {
    if (!namesCpu(name, cpu)) {
      throw new Error(
        `${name} does not say it is for ${cpu}; the release would not tell this build's file from another's.`
      );
    }
    return name;
  };

  stage('dmg', (n) => n.endsWith('.dmg'));
  stage(
    'macos',
    (n) => n.endsWith('.app.tar.gz'),
    (n) => `${n.slice(0, -'.app.tar.gz'.length)}_${version}_${cpu}.app.tar.gz`
  );
  stage('msi', (n) => n.endsWith('.msi'));
  stage('nsis', (n) => n.endsWith('.exe'));
  stage('appimage', (n) => n.endsWith('.AppImage'), () => `${productName}_${version}_${cpu}.AppImage`);
  stage('deb', (n) => n.endsWith('.deb'), named);
  stage('rpm', (n) => n.endsWith('.rpm'), named);

  if (!staged.some((n) => !n.endsWith('.sig'))) {
    throw new Error(`No installers found under ${bundleDir}.`);
  }
  return staged;
}

function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node scripts/stage-release-files.js <out-dir>');
    process.exit(1);
  }
  const cpu = cpuName();
  if (!cpu) {
    console.error(`Unsupported architecture: ${process.arch}`);
    process.exit(1);
  }
  const { version, productName } = JSON.parse(fs.readFileSync(TAURI_CONF, 'utf8'));
  try {
    const staged = stageFiles({ bundleDir: DEFAULT_BUNDLE_DIR, outDir, cpu, version, productName });
    console.log(`Staged in ${outDir}:\n  ${staged.join('\n  ')}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
