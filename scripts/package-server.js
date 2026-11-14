#!/usr/bin/env node
/**
 * Build the server files for one platform and pack them into the release
 * tarball `openclerq-server-<version>-<os>-<arch>.tar.gz`.
 *
 *   node scripts/package-server.js --target linux-x64
 *   node scripts/package-server.js --target darwin-arm64 --out-dir server-files --json
 *
 * Options
 *   --target <t>     linux-x64, linux-arm64, darwin-arm64 or darwin-x64 (a Bun
 *                    name such as bun-linux-x64 is accepted too). Default: the
 *                    machine this runs on.
 *   --out-dir <dir>  Where the tarball goes. Default: dist/server.
 *   --skip-build     Do not build the workspace packages first (a caller that has).
 *   --json           Print one JSON object on stdout; progress is on stderr
 *                    either way.
 *
 * It compiles clerq-server (with clerq-calc beside it) and clerq through
 * scripts/build-binary.js, which needs a clerq-calc built for the target
 * (`cargo build --release [--target <triple>] --manifest-path
 * packages/calculation-core/Cargo.toml`) and fails without one. The binaries
 * stay where build-binary.js puts them (apps/server/dist/<bun target>/ and
 * apps/cli/dist/<bun target>/).
 *
 * The tarball has one top folder, openclerq-server-<version>-<os>-<arch>/, and
 * in it the three binaries, LICENSE, NOTICE, the two systemd units under
 * systemd/ and a short README.txt.
 *
 * The same files always give the same bytes: the archive is written here
 * rather than by the machine's `tar` (whose flavour and extended attributes
 * differ between macOS and Linux), entries are sorted, owner is root:root with
 * numeric ids 0, every mtime is the commit's time (SOURCE_DATE_EPOCH if set,
 * else `git log -1 --format=%ct`), and the gzip header carries no name or time
 * (what `gzip -n` leaves out) and the Unix OS byte. The compressed stream
 * itself comes from the zlib of the Node that runs this, so two machines with
 * different zlib builds can differ even for the same input; the same runner
 * image twice does not.
 *
 * On success it prints the tarball's path and its SHA-256.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { build, hostTarget, parseTarget } from './build-binary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SERVER_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'];

const log = (...m) => console.error('[package-server]', ...m);

/** `linux-x64` or `bun-linux-x64` -> { short, bun, os, arch }; throws on any other target. */
export function normaliseTarget(target) {
  const short = target.replace(/^bun-/, '');
  if (!SERVER_TARGETS.includes(short)) {
    throw new Error(
      `"${target}" is not a server target. Use one of: ${SERVER_TARGETS.join(', ')}.`
    );
  }
  const [os, arch] = short.split('-');
  return { short, bun: `bun-${short}`, os, arch };
}

export function parseOptions(argv) {
  const o = { skipBuild: false, json: false };
  const args = [...argv];
  const take = (flag) => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  while (args.length > 0) {
    const a = args.shift();
    if (a === '--target') o.target = take(a);
    else if (a === '--out-dir') o.outDir = take(a);
    else if (a === '--skip-build') o.skipBuild = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`Unknown argument "${a}".`);
  }
  o.target = normaliseTarget(o.target ?? hostTarget().replace(/^bun-/, ''));
  return o;
}

// ---------------------------------------------------------------- tar + gzip

const BLOCK = 512;

function octal(n, width) {
  const digits = n.toString(8);
  if (digits.length > width - 1) throw new Error(`${n} does not fit in a ${width}-byte tar field.`);
  return `${digits.padStart(width - 1, '0')}\0`;
}

function tarHeader({ name, mode, size, mtime, directory }) {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) throw new Error(`"${name}" is longer than 100 bytes.`);
  const b = Buffer.alloc(BLOCK);
  const put = (text, offset) => b.write(text, offset, 'utf8');
  nameBytes.copy(b, 0);
  put(octal(mode, 8), 100);
  put(octal(0, 8), 108); // uid
  put(octal(0, 8), 116); // gid
  put(octal(size, 12), 124);
  put(octal(mtime, 12), 136);
  b.fill(0x20, 148, 156); // the checksum is summed with this field as spaces
  b[156] = directory ? 0x35 : 0x30; // '5' or '0'
  put('ustar\0', 257);
  put('00', 263);
  put('root', 265); // uname
  put('root', 297); // gname
  let sum = 0;
  for (const byte of b) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return b;
}

/**
 * A ustar archive of `entries` ({ name, data, mode } for a file, { name, directory: true }
 * for a folder; names have no trailing slash), sorted by name, owned by root, all
 * stamped `mtime` (whole seconds since the epoch).
 */
export function makeTar(entries, mtime) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
  );
  const parts = [];
  for (const e of sorted) {
    if (e.directory) {
      parts.push(tarHeader({ name: `${e.name}/`, mode: 0o755, size: 0, mtime, directory: true }));
      continue;
    }
    parts.push(tarHeader({ name: e.name, mode: e.mode, size: e.data.length, mtime }));
    parts.push(e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end of archive
  const tar = Buffer.concat(parts);
  const record = 10240; // GNU tar's default blocking: pad to a whole record
  const padded = Math.ceil(tar.length / record) * record;
  return padded === tar.length ? tar : Buffer.concat([tar, Buffer.alloc(padded - tar.length)]);
}

/** gzip without a file name or a time, as `gzip -n` writes it, for any OS. */
export function gzipReproducibly(data) {
  const out = zlib.gzipSync(data, { level: 9 });
  out.fill(0, 4, 8); // MTIME
  out[9] = 3; // OS: Unix, whatever the zlib was built for
  return out;
}

/** The commit's time in whole seconds, or SOURCE_DATE_EPOCH. */
export function sourceEpoch(env = process.env, cwd = ROOT) {
  const fromEnv = env.SOURCE_DATE_EPOCH;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!/^\d+$/.test(fromEnv)) throw new Error('SOURCE_DATE_EPOCH must be whole seconds.');
    return Number(fromEnv);
  }
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+$/.test(out)) return Number(out);
  } catch {
    /* handled below */
  }
  throw new Error(
    'Cannot tell the commit time: this is not a git checkout. Set SOURCE_DATE_EPOCH to the commit time in seconds.'
  );
}

// ------------------------------------------------------------------ contents

export function readmeText(version, short) {
  const docs = `https://github.com/paxamedia/OpenClerq/blob/v${version}/docs`;
  return `OpenClerq server ${version} (${short})

This folder holds the OpenClerq gateway as a headless server, and its tools:

  clerq-server   the server: run it in a terminal or under systemd
  clerq          the command line: login, repo add, automation apply, run, logs, approve
  clerq-calc     the calculation engine; clerq-server looks for it next to itself,
                 so keep the two together
  systemd/       two example units for Linux: openclerq.service (a system service with
                 its own account) and openclerq-user.service (a user service)
  LICENSE, NOTICE

Install by hand (the installer does no more than this):

  sudo install -m 0755 clerq-server clerq clerq-calc /usr/local/bin/

Then:

  clerq-server version    the release, the API version, the store schema
  clerq-server            runs until Ctrl-C; its first lines say where the data lives
  clerq status            talks to the server on this computer

Settings, systemd, upgrading, security notes and reverse-proxy examples:
  ${docs}/SERVER.md
The command line:
  ${docs}/CLI.md

These files are not signed. Check the download against SHA256SUMS on the release
page. A file downloaded in a browser to a Mac may need
"xattr -d com.apple.quarantine <file>" before it runs; curl does not set that mark.
`;
}

/** The tarball's entries, from the built files; every path under the top folder. */
export function tarEntries({ top, binaries, files, readme }) {
  const entries = [{ name: top, directory: true }];
  const add = (rel, data, mode) => entries.push({ name: `${top}/${rel}`, data, mode });
  for (const f of binaries) add(path.basename(f), fs.readFileSync(f), 0o755);
  for (const [rel, file] of Object.entries(files)) add(rel, fs.readFileSync(file), 0o644);
  add('README.txt', Buffer.from(readme, 'utf8'), 0o644);
  for (const dir of new Set(Object.keys(files).map((rel) => path.posix.dirname(rel)))) {
    if (dir !== '.') entries.push({ name: `${top}/${dir}`, directory: true });
  }
  return entries;
}

// ---------------------------------------------------------------------- main

export function packageServer(options) {
  const t = options.target;
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const epoch = sourceEpoch();
  const outDir = path.resolve(ROOT, options.outDir ?? path.join('dist', 'server'));

  if (!options.skipBuild) {
    log('building the workspace packages');
    execFileSync('pnpm', ['--filter', '@clerq/server...', '--filter', '@clerq/cli...', 'build'], {
      cwd: ROOT,
      stdio: ['ignore', 2, 2],
    });
  }
  const server = build({
    entry: 'apps/server/src/main.ts',
    name: 'clerq-server',
    target: t.bun,
    calc: 'auto',
    requireCalc: true,
    skipBuild: true,
  });
  const cli = build({
    entry: 'apps/cli/src/main.ts',
    name: 'clerq',
    target: t.bun,
    calc: 'none',
    requireCalc: false,
    skipBuild: true,
  });

  // A binary this machine can run must say the version the tarball is named for.
  const host = parseTarget(hostTarget());
  const target = parseTarget(t.bun);
  if (host.os === target.os && host.arch === target.arch) {
    for (const [file, args] of [
      [server.binary, ['version']],
      [cli.binary, ['--version']],
    ]) {
      const said = execFileSync(file, args, { encoding: 'utf8' });
      if (!said.includes(version)) {
        throw new Error(`${path.basename(file)} ${args[0]} says "${said.trim()}", not ${version}.`);
      }
    }
  }

  const top = `openclerq-server-${version}-${t.short}`;
  const tar = makeTar(
    tarEntries({
      top,
      binaries: [server.binary, server.calc, cli.binary],
      files: {
        LICENSE: path.join(ROOT, 'LICENSE'),
        NOTICE: path.join(ROOT, 'NOTICE'),
        'systemd/openclerq.service': path.join(ROOT, 'apps/server/systemd/openclerq.service'),
        'systemd/openclerq-user.service': path.join(
          ROOT,
          'apps/server/systemd/openclerq-user.service'
        ),
      },
      readme: readmeText(version, t.short),
    }),
    epoch
  );
  const gz = gzipReproducibly(tar);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${top}.tar.gz`);
  fs.writeFileSync(file, gz);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  log(`wrote ${file} (${(gz.length / 1e6).toFixed(1)} MB)`);
  return { target: t.short, version, file, sha256, size: gz.length, mtime: epoch };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = packageServer(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`${result.file}\nsha256 ${result.sha256}\n`);
  } catch (e) {
    console.error(`[package-server] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
