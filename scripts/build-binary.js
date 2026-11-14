#!/usr/bin/env node
/**
 * Compile a TypeScript entry point of this repository to one standalone binary
 * with Bun, for one target, into a fixed place.
 *
 *   node scripts/build-binary.js --entry apps/server/src/main.ts --name clerq-server
 *   node scripts/build-binary.js --entry apps/server/src/main.ts --name clerq-server \
 *        --target bun-linux-arm64 --require-calc --json
 *
 * Options
 *   --entry <file>     The entry point. Relative paths are from the repository root.
 *   --name <name>      The binary's name, without an extension (".exe" is added
 *                      for Windows targets).
 *   --target <target>  A Bun target: bun-linux-x64, bun-linux-arm64,
 *                      bun-darwin-arm64, bun-darwin-x64, bun-windows-x64, the
 *                      -musl forms of the Linux ones, and -baseline / -modern
 *                      variants. Default: the machine this runs on.
 *   --out-dir <dir>    Where targets go. Default: `dist` in the entry's package.
 *   --calc <file>      Put this clerq-calc next to the binary.
 *   --no-calc          Put no clerq-calc there.
 *   --require-calc     Fail when there is no clerq-calc for the target.
 *                      Without --calc/--no-calc the script looks for one built for
 *                      the target (packages/calculation-core/target/<triple>/release,
 *                      and, for the host's own target, target/release) and copies it
 *                      when it is there.
 *   --skip-build       Do not build the workspace packages first (a caller that has).
 *   --json             Print one JSON object describing the result on stdout (all
 *                      progress goes to stderr either way).
 *
 * Output: <out-dir>/<target>/<name>[.exe] and, when there is one,
 * <out-dir>/<target>/clerq-calc[.exe]. That directory is emptied first, so what
 * is in it is what this run made. The same arguments always give the same paths;
 * the script never prompts, and exits non-zero on any failure.
 *
 * Bun runs from this repository's devDependency, so the compile needs no global
 * install. Compiling for another operating system or CPU makes Bun fetch that
 * target's runtime, which needs network access the first time.
 *
 * The binary is compiled without Bun's automatic loading of `.env` and
 * `bunfig.toml` from the working directory: a program built here reads the
 * settings it documents and nothing that happens to sit beside where it is run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUST_OS = {
  linux: (arch, musl) =>
    `${arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-${musl ? 'musl' : 'gnu'}`,
  darwin: (arch) => `${arch === 'x64' ? 'x86_64' : 'aarch64'}-apple-darwin`,
  windows: (arch) => `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`,
};

/** `bun-linux-x64-musl` -> { os, arch, musl, rustTarget, exe }; null when it is not one. */
export function parseTarget(target) {
  const m = /^bun-(linux|darwin|windows)-(x64|arm64)(?:-(baseline|modern))?(-musl)?$/.exec(target);
  if (!m) return null;
  const [, os, arch, , musl] = m;
  if (musl && os !== 'linux') return null;
  return {
    os,
    arch,
    musl: Boolean(musl),
    rustTarget: RUST_OS[os](arch, Boolean(musl)),
    exe: os === 'windows' ? '.exe' : '',
  };
}

/** The Bun target of the machine this runs on. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!['linux', 'darwin', 'windows'].includes(os) || !cpu) {
    throw new Error(`No Bun target for ${platform}/${arch}; pass --target.`);
  }
  return `bun-${os}-${cpu}`;
}

/** Parse argv into options; throws a message-bearing Error on anything unusable. */
export function parseOptions(argv) {
  const o = { calc: 'auto', requireCalc: false, skipBuild: false, json: false };
  const args = [...argv];
  const take = (flag) => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  while (args.length > 0) {
    const a = args.shift();
    if (a === '--entry') o.entry = take(a);
    else if (a === '--name') o.name = take(a);
    else if (a === '--target') o.target = take(a);
    else if (a === '--out-dir') o.outDir = take(a);
    else if (a === '--calc') o.calc = { file: take(a) };
    else if (a === '--no-calc') o.calc = 'none';
    else if (a === '--require-calc') o.requireCalc = true;
    else if (a === '--skip-build') o.skipBuild = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`Unknown argument "${a}".`);
  }
  if (!o.entry) throw new Error('--entry is required.');
  if (!o.name) throw new Error('--name is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.name)) {
    throw new Error(`--name "${o.name}" must be a plain file name (letters, digits, . _ -).`);
  }
  if (o.calc === 'none' && o.requireCalc)
    throw new Error('--no-calc and --require-calc contradict.');
  o.target ??= hostTarget();
  if (!parseTarget(o.target))
    throw new Error(`"${o.target}" is not a Bun target this script knows.`);
  return o;
}

/** The directory of the package.json that owns `file`, and its name. */
function owningPackage(file) {
  for (
    let dir = path.dirname(file);
    dir.startsWith(ROOT) && dir !== path.dirname(dir);
    dir = path.dirname(dir)
  ) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) return { dir, name: JSON.parse(fs.readFileSync(pj, 'utf8')).name };
  }
  throw new Error(`${file} is not inside a package of this repository.`);
}

/** Where a clerq-calc for `target` might be, in the order to look. */
export function calcCandidates(target, host = hostTarget()) {
  const t = parseTarget(target);
  const exe = `clerq-calc${t.exe}`;
  const base = path.join(ROOT, 'packages', 'calculation-core', 'target');
  const found = [path.join(base, t.rustTarget, 'release', exe)];
  // A plain `cargo build --release` writes to target/release: that is for the
  // host's own target only.
  if (target === host || parseTarget(host)?.rustTarget === t.rustTarget)
    found.push(path.join(base, 'release', exe));
  return found;
}

const log = (...m) => console.error('[build-binary]', ...m);

function run(file, args, opts = {}) {
  log([file, ...args].join(' '));
  // Everything the tools print is progress; stdout is for --json alone.
  return execFileSync(file, args, { cwd: ROOT, stdio: ['ignore', 2, 2], ...opts });
}

/** A way to run Bun from this repository, installing its binary if pnpm skipped that. */
function bunCommand() {
  const probe = (cmd, args) => {
    try {
      execFileSync(cmd, [...args, '--version'], { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (probe('pnpm', ['exec', 'bun'])) return ['pnpm', ['exec', 'bun']];
  const install = path.join(ROOT, 'node_modules', 'bun', 'install.js');
  if (fs.existsSync(install)) {
    // pnpm does not run Bun's postinstall by default.
    try {
      execFileSync('node', [install], { cwd: ROOT, stdio: ['ignore', 2, 2] });
    } catch {
      /* the probe below says whether it worked */
    }
    if (probe('pnpm', ['exec', 'bun'])) return ['pnpm', ['exec', 'bun']];
  }
  if (probe('bun', [])) return ['bun', []];
  throw new Error(
    'Bun is not available. Run `pnpm install`, then `cd node_modules/bun && node install.js`.'
  );
}

export function build(o) {
  const entry = path.resolve(ROOT, o.entry);
  if (!fs.existsSync(entry)) throw new Error(`Entry point not found: ${entry}`);
  const pkg = owningPackage(entry);
  const t = parseTarget(o.target);
  const outDir = path.resolve(
    ROOT,
    o.outDir ?? path.join(path.relative(ROOT, pkg.dir), 'dist'),
    o.target
  );
  const binary = path.join(outDir, `${o.name}${t.exe}`);

  // The entry imports workspace packages by name, which resolve to their built output.
  if (!o.skipBuild) run('pnpm', ['--filter', `${pkg.name}...`, 'build']);

  // Which clerq-calc goes along, decided before anything is deleted or compiled.
  let calc = null;
  if (o.calc !== 'none') {
    const candidates = o.calc === 'auto' ? calcCandidates(o.target) : [path.resolve(o.calc.file)];
    calc = candidates.find((f) => fs.existsSync(f)) ?? null;
    if (!calc && (o.requireCalc || o.calc !== 'auto')) {
      throw new Error(
        `No clerq-calc for ${o.target}. Looked in:\n  ${candidates.join('\n  ')}\nBuild it with: cargo build --release --target ${t.rustTarget} --manifest-path packages/calculation-core/Cargo.toml`
      );
    }
    if (!calc) log(`No clerq-calc built for ${o.target}; the binary is made without one.`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const [cmd, base] = bunCommand();
  run(cmd, [
    ...base,
    'build',
    entry,
    '--compile',
    `--target=${o.target}`,
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    `--outfile=${binary}`,
  ]);
  if (!fs.existsSync(binary)) throw new Error(`Bun reported success but ${binary} does not exist.`);
  fs.chmodSync(binary, 0o755);
  const files = [binary];
  if (calc) {
    const target = path.join(outDir, `clerq-calc${t.exe}`);
    fs.copyFileSync(calc, target);
    fs.chmodSync(target, 0o755);
    files.push(target);
  }
  for (const f of files) log(`wrote ${f} (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`);
  return {
    target: o.target,
    rustTarget: t.rustTarget,
    outDir,
    binary,
    calc: calc ? files[1] : null,
    files,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = build(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (e) {
    console.error(`[build-binary] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
