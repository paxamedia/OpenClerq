/**
 * The container profile on a real engine, Docker or Podman.
 *
 * profiles.test.ts runs the profile against a fake `docker` that records its
 * arguments; this file runs it against the engine itself, and asserts what
 * SECURITY.md says the profile does by looking from inside the container and
 * at what the engine reports about it. It runs only when
 * CLERQ_TEST_CONTAINER_RUNTIME names a runtime (`docker` or `podman`, or a path
 * to one), which is what the `container-profile` job in ci.yml sets. Without it
 * the whole suite is skipped, so `pnpm test` needs no engine. The images are
 * pulled first (alpine for the commands, node for the ones that need node and
 * for the egress proxy). The egress tests are hermetic: the hosts the proxy
 * allows and refuses are two small servers this file starts on the engine's
 * default network, named in the allowlist by address. One test (and only
 * one) reaches example.com, and says so.
 *
 * Everything the code asks of the runtime goes through a small wrapper script
 * that appends the call's arguments (never its environment) to
 * `$CLERQ_TEST_DEBUG_DIR/docker-calls.log` and then runs the real runtime. When
 * a test fails, `scripts/container-debug.sh` prints that log, every container
 * and network labelled `clerq.run` with its state, and the egress proxies' logs
 * (not a command's: it could hold a secret), so a CI log is enough to see what
 * happened.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exec,
  listLabelled,
  removeContainer,
  resolveRuntime,
  runtimeCall,
  DEFAULT_EGRESS_IMAGE,
  EGRESS_PORT,
  type ExecResult,
  type SandboxSpec,
} from './index.js';

const WANTED = process.env.CLERQ_TEST_CONTAINER_RUNTIME;
const COMMAND_IMAGE = 'docker.io/library/alpine:3.20';
const NODE_IMAGE = DEFAULT_EGRESS_IMAGE;
/** What an allowlist names in the tests that never connect to it. */
const LISTED_HOST = 'example.com';
const INTERNET_HOST = 'example.com';
const INTERNET_REFUSED = 'example.org';
/** A server on the engine's default network that answers on two ports. */
const UPSTREAM_SCRIPT =
  "for (const p of [8080, 8081]) require('node:http').createServer((q, s) => s.end('upstream ' + q.url))" +
  ".listen(p, () => console.log('listening ' + p));";
const SUITE = WANTED
  ? 'the container profile on a real engine'
  : 'the container profile on a real engine (skipped: set CLERQ_TEST_CONTAINER_RUNTIME=docker or podman to run it)';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_SCRIPT = path.resolve(here, '../../../scripts/container-debug.sh');
const DEBUG_DIR =
  process.env.CLERQ_TEST_DEBUG_DIR || path.join(os.tmpdir(), 'clerq-container-debug');
const CALLS_LOG = path.join(DEBUG_DIR, 'docker-calls.log');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

let runtime = '';
/** The runtime as the code under test sees it: a wrapper that records each call. */
let shim = '';
let seq = 0;

/** A run id for one test: it labels everything the test makes, so leftovers can be told apart. */
const runId = (what: string) => `real-${what}-${process.pid}-${++seq}`;

function writeShim(dir: string, real: string, log: string): string {
  const file = path.join(dir, 'runtime-shim');
  fs.writeFileSync(
    file,
    [
      '#!/bin/bash',
      '# Appends the arguments of each call, never its environment, then runs the real runtime.',
      `{ printf '%s %s' "$(date -u +%H:%M:%S)" "$$"; for a in "$@"; do a=\${a//$'\\n'/ }; [ \${#a} -gt 400 ] && a="\${a:0:400}...[+$((\${#a} - 400))]"; printf ' %s' "$a"; done; printf '\\n'; } >> ${quote(log)} 2>/dev/null`,
      `exec ${quote(real)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return file;
}

/** What the engine holds, as text for a log. Never throws. */
function dump(why: string, callsFrom = 0): string {
  let text = `\n##### Engine state after a failure: ${why}\n`;
  try {
    const r = spawnSync('sh', [DEBUG_SCRIPT, runtime, CALLS_LOG, String(callsFrom)], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    text += `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } catch (e) {
    text += `(could not run ${DEBUG_SCRIPT}: ${e instanceof Error ? e.message : e})\n`;
  }
  try {
    fs.appendFileSync(path.join(DEBUG_DIR, 'failures.txt'), text);
  } catch {
    /* only a copy for the artifact */
  }
  return text;
}

/** A test that prints the engine's state when it fails, and has a time limit of its own. */
function real(name: string, fn: () => Promise<void>, ms = 120_000): void {
  it(
    name,
    async () => {
      // The log is shared by every test: a failure shows only what its own test asked of the engine.
      const callsFrom = fs.existsSync(CALLS_LOG) ? fs.statSync(CALLS_LOG).size : 0;
      try {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms.`)), ms);
          }),
        ]).finally(() => clearTimeout(timer));
      } catch (e) {
        console.error(
          dump(`${name}: ${e instanceof Error ? e.message.slice(0, 600) : String(e)}`, callsFrom)
        );
        throw e;
      }
    },
    ms + 30_000
  );
}

async function ensureImage(image: string): Promise<void> {
  if ((await runtimeCall(runtime, ['image', 'inspect', image])).code === 0) return;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await runtimeCall(runtime, ['pull', image], 300_000);
    if (r.code === 0) return;
    last = (r.stderr || r.stdout).trim().slice(-400);
    await sleep(attempt * 3_000);
  }
  throw new Error(`Could not pull ${image}: ${last}`);
}

async function waitFor(what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(200);
  }
}

interface Inspected {
  State?: { Running?: boolean; Status?: string };
  Config?: { User?: string; Env?: string[]; Labels?: Record<string, string> };
  HostConfig?: {
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    Init?: boolean | null;
    NetworkMode?: string;
    Tmpfs?: Record<string, string>;
  };
  Mounts?: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  NetworkSettings?: { Networks?: Record<string, unknown> };
  Internal?: boolean;
  Labels?: Record<string, string>;
}

async function inspectContainer(name: string): Promise<Inspected | undefined> {
  const r = await runtimeCall(runtime, ['container', 'inspect', name]);
  return r.code === 0 ? (JSON.parse(r.stdout) as Inspected[])[0] : undefined;
}

async function inspectNetwork(name: string): Promise<Inspected | undefined> {
  const r = await runtimeCall(runtime, ['network', 'inspect', name]);
  return r.code === 0 ? (JSON.parse(r.stdout) as Inspected[])[0] : undefined;
}

/** Containers and networks still labelled for a run. A run that is over has none. */
async function leftovers(id: string): Promise<{ containers: string[]; networks: string[] }> {
  const label = `label=clerq.run=${id}`;
  const containers = await runtimeCall(runtime, [
    'ps',
    '-a',
    '--filter',
    label,
    '--format',
    '{{.Names}}',
  ]);
  const networks = await runtimeCall(runtime, [
    'network',
    'ls',
    '--filter',
    label,
    '--format',
    '{{.Name}}',
  ]);
  // A listing that failed would look like an empty one.
  expect([containers.code, networks.code], containers.stderr + networks.stderr).toEqual([0, 0]);
  return { containers: lines(containers.stdout), networks: lines(networks.stdout) };
}

const NOTHING_LEFT = { containers: [], networks: [] };

function base(id: string, extra: Partial<SandboxSpec> & { cwd: string }): SandboxSpec {
  return {
    profile: 'container',
    image: COMMAND_IMAGE,
    runtime: shim,
    containerName: `clerq-${id}`,
    labels: { 'clerq.run': id },
    limits: { wallMs: 90_000 },
    ...extra,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

interface Fixture {
  parent: string;
  /** The worktree. */
  wt: string;
  /** The repository's git directory. */
  common: string;
  /** The worktree's entry in it. */
  admin: string;
  gitFile: string;
}

/** A repository with a linked worktree: the layout the gateway gives a run. */
function fixture(parent: string): Fixture {
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const wt = path.join(parent, 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  const common = path.join(repo, '.git');
  const admin = path.join(common, 'worktrees', 'wt');
  // As the gateway does before a container run: an empty one, which can then be mounted read-only.
  fs.writeFileSync(path.join(admin, 'config.worktree'), '');
  return { parent, wt, common, admin, gitFile: path.join(wt, '.git') };
}

/** The sandbox settings the gateway gives a run's commands (`isolationFor`), for this fixture. */
function isolated(id: string, fx: Fixture, extra: Partial<SandboxSpec> = {}): SandboxSpec {
  return base(id, {
    cwd: fx.wt,
    readOnly: [fx.common],
    allowWrite: [fx.admin],
    protect: [
      fx.gitFile,
      path.join(fx.admin, 'commondir'),
      path.join(fx.admin, 'gitdir'),
      path.join(fx.admin, 'HEAD'),
      path.join(fx.admin, 'config.worktree'),
    ],
    ...extra,
  });
}

/** `key=value` lines, and the `mount=` lines apart. */
function parseKeys(stdout: string): { keys: Record<string, string>; mounts: string[] } {
  const keys: Record<string, string> = {};
  const mounts: string[] = [];
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at);
    if (key === 'mount') mounts.push(line.slice(at + 1));
    else keys[key] = line.slice(at + 1);
  }
  return { keys, mounts };
}

/** What a command in the container finds out about its own container. */
const FS_PROBE = String.raw`
t() { n=$1; shift; if "$@" >/dev/null 2>&1; then echo "$n=yes"; else echo "$n=no"; fi; }
w() { n=$1; f=$2; if ( : >> "$f" ) 2>/dev/null; then echo "$n=yes"; else echo "$n=no"; fi; }
echo "uid=$(id -u)"
echo "gid=$(id -g)"
echo "home=$HOME"
echo "cwd=$(pwd)"
echo "by_name=$(printenv CLERQ_REAL_BY_NAME || echo unset)"
echo "host_only=$(printenv LOGNAME SHELL | tr '\n' ',')"
w write_worktree "$PWD/clerq-new.txt"
w write_rootfs /etc/clerq-probe
w write_usr /usr/clerq-probe
w write_tmp /tmp/clerq-probe
w write_common "$COMMON/clerq-probe"
t read_common test -r "$COMMON/HEAD"
t read_objects test -d "$COMMON/objects"
w write_admin "$ADMIN/index.lock"
w write_admin_head "$ADMIN/HEAD"
w write_admin_commondir "$ADMIN/commondir"
w write_admin_gitdir "$ADMIN/gitdir"
w write_admin_config_worktree "$ADMIN/config.worktree"
w write_gitfile "$PWD/.git"
t rm_head rm -f "$ADMIN/HEAD"
t mv_over_head sh -c 'echo x > "$0.new" && mv "$0.new" "$0"' "$ADMIN/HEAD"
t rm_gitfile rm -f "$PWD/.git"
t mv_over_gitfile sh -c 'echo x > "$0.new" && mv "$0.new" "$0"' "$PWD/.git"
t mv_admin mv "$ADMIN" "$ADMIN.moved"
t read_marker cat "$MARKER"
echo "home_exists=$([ -e "$HOSTHOME" ] && echo yes || echo no)"
echo "home_entries=$(ls -A "$HOSTHOME" 2>/dev/null | tr '\n' ',')"
echo "capbnd=$(awk '/^CapBnd/ {print $2}' /proc/self/status)"
echo "nonewprivs=$(awk '/^NoNewPrivs/ {print $2}' /proc/self/status)"
echo "tmpfs=$(grep -E '^tmpfs /tmp ' /proc/mounts | head -n 1)"
echo "init=$(tr '\0' ' ' < /proc/1/cmdline | cut -c1-80)"
echo "ifaces=$(ls /sys/class/net | tr '\n' ',')"
awk -v root="$ROOT/" 'index($5, root) == 1 { split($6, o, ","); print "mount=" $5 " " o[1] }' /proc/self/mountinfo
`;

/**
 * Runs in the node image, as the command: tries to leave the container by the
 * proxy and by every other way it can think of, and prints one RESULT line.
 * PROBE says where: { listed, unlisted } are { host, connect, http, tls }:
 * CONNECT to host:connect (then TLS and HEAD when `tls`, else a plain GET
 * through the tunnel), and an absolute-form GET to http://host:http/.
 */
const NET_PROBE = String.raw`
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const dns = require('node:dns');
const fs = require('node:fs');
const targets = JSON.parse(process.env.PROBE);
const proxyUrl = process.env.HTTPS_PROXY || '';
const proxy = proxyUrl ? new URL(proxyUrl) : null;
const code = (e) => (e && (e.code || (e.errors && e.errors[0] && e.errors[0].code))) || String(e);
const statusOf = (text) => Number((/^HTTP\/1\.[01] (\d{3})/.exec(text) || [])[1]);
const lookup = (host) => new Promise((r) => dns.lookup(host, (e, a) => r(e ? { error: code(e) } : { address: a })));

// CONNECT through the proxy, then a request through the tunnel.
function viaConnect(t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const authority = t.host + ':' + t.connect;
    const s = net.connect(Number(proxy.port), proxy.hostname);
    s.setTimeout(15000, () => { s.destroy(); finish({ error: 'timeout' }); });
    s.on('error', (e) => finish({ error: code(e) }));
    s.on('connect', () => s.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n'));
    let head = '';
    const onData = (c) => {
      head += c.toString('latin1');
      if (head.indexOf('\r\n\r\n') === -1) return;
      s.removeListener('data', onData);
      const status = statusOf(head);
      if (status !== 200) { s.destroy(); finish({ status }); return; }
      const request = 'HEAD / HTTP/1.1\r\nHost: ' + t.host + '\r\nConnection: close\r\n\r\n';
      const through = t.tls ? tls.connect({ socket: s, servername: t.host }) : s;
      let body = '';
      if (t.tls) through.on('secureConnect', () => through.write(request));
      else through.write(request);
      through.on('data', (d) => { body += d.toString('latin1'); });
      through.on('close', () => finish({ status, httpStatus: statusOf(body) }));
      through.on('error', (e) => finish({ status, error: code(e) }));
    };
    s.on('data', onData);
  });
}

// Plain HTTP through the proxy: an absolute-form request line.
function viaHttp(t) {
  return new Promise((resolve) => {
    const url = 'http://' + t.host + ':' + t.http + '/';
    const req = http.request({ host: proxy.hostname, port: proxy.port, method: 'GET', path: url, headers: { host: t.host + ':' + t.http }, timeout: 15000 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: code(e) }));
    req.end();
  });
}

// Not through the proxy at all.
function direct(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(5000, () => { s.destroy(); resolve({ error: 'timeout' }); });
    s.on('connect', () => { s.destroy(); resolve({ connected: true }); });
    s.on('error', (e) => resolve({ error: code(e) }));
  });
}

(async () => {
  const out = { proxyEnv: proxyUrl || null, ifaces: fs.readdirSync('/sys/class/net').sort() };
  const jobs = {
    directIp: direct('1.1.1.1', 443),
    directListed: direct(targets.listed.host, targets.listed.connect),
  };
  if (proxy) {
    jobs.dns = lookup(proxy.hostname);
    jobs.listedConnect = viaConnect(targets.listed);
    jobs.listedHttp = viaHttp(targets.listed);
    jobs.unlistedConnect = viaConnect(targets.unlisted);
    jobs.unlistedHttp = viaHttp(targets.unlisted);
  }
  for (const [k, p] of Object.entries(jobs)) out[k] = await p;
  console.log('RESULT ' + JSON.stringify(out));
})();
`;

interface Target {
  host: string;
  connect: number;
  http: number;
  tls: boolean;
}

interface Reach {
  status?: number;
  httpStatus?: number;
  error?: string;
}

interface Probe {
  proxyEnv: string | null;
  ifaces: string[];
  directIp: { connected?: boolean; error?: string };
  directListed: { connected?: boolean; error?: string };
  dns?: { address?: string; error?: string };
  listedConnect?: Reach;
  listedHttp?: Reach;
  unlistedConnect?: Reach;
  unlistedHttp?: Reach;
}

async function probe(
  id: string,
  network: SandboxSpec['network'],
  wt: string,
  targets: { listed: Target; unlisted: Target }
): Promise<{ result: ExecResult; probe: Probe; container: string }> {
  let container = '';
  const result = await exec(
    base(id, {
      cwd: wt,
      image: NODE_IMAGE,
      network,
      env: { PROBE: JSON.stringify(targets) },
    }),
    'node',
    ['-e', NET_PROBE],
    { onSpawn: (p) => (container = p.container?.name ?? '') }
  );
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  expect(line, `no RESULT line in: ${result.stdout}\n${result.stderr}`).toBeDefined();
  return {
    result,
    probe: JSON.parse((line as string).slice('RESULT '.length)) as Probe,
    container,
  };
}

describe.skipIf(!WANTED || process.platform === 'win32')(SUITE, () => {
  let root: string;
  /** A file in the real home directory, which no container may see. */
  let marker: string;
  const made: string[] = [];
  /** The servers the egress tests reach and refuse: containers on the default network, by address. */
  let allowedUp = '';
  let refusedUp = '';
  /** What this run made carries a run label ending in this process's id and a number. */
  const mine = new RegExp(`^real-.*-${process.pid}-\\d+$`);

  /** A server answering on 8080 and 8081, on the engine's default network. Returns its address. */
  async function startUpstream(): Promise<string> {
    const id = runId('upstream');
    const name = `clerq-${id}`;
    const r = await runtimeCall(runtime, [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `clerq.run=${id}`,
      NODE_IMAGE,
      'node',
      '-e',
      UPSTREAM_SCRIPT,
    ]);
    expect(r.code, r.stderr).toBe(0);
    await waitFor(`${name} to listen`, async () => {
      const logs = await runtimeCall(runtime, ['logs', name]);
      return /listening 8080/.test(logs.stdout) && /listening 8081/.test(logs.stdout);
    });
    const ip = await runtimeCall(runtime, [
      'container',
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      name,
    ]);
    const address = ip.stdout.trim().split(/\s+/)[0];
    expect(address, `no address for ${name}: ${ip.stderr}`).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    return address;
  }

  beforeAll(async () => {
    const found = resolveRuntime(WANTED);
    if (!found) {
      throw new Error(
        `CLERQ_TEST_CONTAINER_RUNTIME=${WANTED} is set, but no such runtime was found on PATH.`
      );
    }
    runtime = found;
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    shim = writeShim(DEBUG_DIR, runtime, CALLS_LOG);
    const version = await runtimeCall(runtime, ['version']);
    expect(version.code, version.stderr).toBe(0);
    console.info(`Container runtime: ${runtime}\n${version.stdout.trim()}`);
    await ensureImage(COMMAND_IMAGE);
    await ensureImage(NODE_IMAGE);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-real-')));
    made.push(root);
    marker = path.join(os.homedir(), `.clerq-real-marker-${process.pid}`);
    fs.writeFileSync(marker, 'a file in the real home directory\n');
    allowedUp = await startUpstream();
    refusedUp = await startUpstream();
  }, 15 * 60_000);

  afterAll(async () => {
    // What this run made and a failure left behind, and only that: other containers on a
    // machine that is kept (a developer's own, another run's) are not ours to remove.
    const left = await listLabelled(runtime, 'clerq.run');
    for (const c of left.containers.filter((x) => mine.test(x.value))) {
      await removeContainer(runtime, c.name);
    }
    for (const n of left.networks.filter((x) => mine.test(x.value))) {
      await removeContainer(runtime, n.name.replace(/-net$/, ''));
    }
    fs.rmSync(marker, { force: true });
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  }, 120_000);

  describe('a command in the container', () => {
    for (const layout of ['tmp', 'home'] as const) {
      real(
        layout === 'tmp'
          ? 'sees only its mounts, runs as the host user and is held down (worktree under the temp directory, which is a tmpfs in the container)'
          : 'sees nothing else of the home directory when the worktree lies under it',
        async () => {
          const parent = fs.realpathSync(
            fs.mkdtempSync(
              layout === 'tmp'
                ? path.join(os.tmpdir(), 'clerq-real-fs-')
                : path.join(os.homedir(), '.clerq-real-fs-')
            )
          );
          made.push(parent);
          const fx = fixture(parent);
          const id = runId('fs');
          const head = fs.readFileSync(path.join(fx.admin, 'HEAD'), 'utf8');
          const pointer = fs.readFileSync(fx.gitFile, 'utf8');
          const seen: { name?: string } = {};
          const r = await exec(
            isolated(id, fx, {
              network: 'none',
              env: {
                COMMON: fx.common,
                ADMIN: fx.admin,
                ROOT: parent,
                MARKER: marker,
                HOSTHOME: os.homedir(),
                CLERQ_REAL_BY_NAME: 'passed-by-name',
                // Host-only: must not reach the container.
                LOGNAME: 'host-only-name',
                SHELL: '/host-only/shell',
              },
            }),
            'sh',
            ['-c', FS_PROBE],
            {
              onSpawn: (p) => {
                seen.name = p.container?.name;
              },
            }
          );
          expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
          expect(seen.name).toMatch(new RegExp(`^clerq-${id}-[0-9a-f]{8}$`));
          const { keys: k, mounts } = parseKeys(r.stdout);

          // Who it runs as, and where.
          expect(k.uid).toBe(String(process.getuid?.()));
          expect(k.gid).toBe(String(process.getgid?.()));
          expect(k.home).toBe('/tmp');
          expect(k.cwd).toBe(fx.wt);
          expect(k.by_name).toBe('passed-by-name');
          expect(k.host_only).toBe('');

          // What it can write: the worktree and its own git entry, /tmp, nothing else.
          expect(k.write_worktree).toBe('yes');
          expect(k.write_tmp).toBe('yes');
          expect(k.write_rootfs).toBe('no');
          expect(k.write_usr).toBe('no');
          expect(k.write_common).toBe('no');
          expect(k.write_admin).toBe('yes');
          // What it reads: the history.
          expect(k.read_common).toBe('yes');
          expect(k.read_objects).toBe('yes');
          // What git trusts afterwards, outside the sandbox: read-only, and not to be replaced.
          for (const key of [
            'write_admin_head',
            'write_admin_commondir',
            'write_admin_gitdir',
            'write_admin_config_worktree',
            'write_gitfile',
          ]) {
            expect(k[key], key).toBe('no');
          }
          expect(k.rm_head).toBe('no');
          expect(k.mv_over_head).toBe('no');
          expect(k.rm_gitfile).toBe('no');
          expect(k.mv_over_gitfile).toBe('no');
          expect(k.mv_admin).toBe('no');
          expect(fs.readFileSync(path.join(fx.admin, 'HEAD'), 'utf8')).toBe(head);
          expect(fs.readFileSync(fx.gitFile, 'utf8')).toBe(pointer);
          expect(fs.readFileSync(path.join(fx.admin, 'config.worktree'), 'utf8')).toBe('');
          // What it writes belongs to the host user.
          const created = fs.statSync(path.join(fx.wt, 'clerq-new.txt'));
          expect(created.uid).toBe(process.getuid?.());

          // Nothing of the home directory: not the marker, and no other entry.
          expect(k.read_marker).toBe('no');
          if (layout === 'tmp') {
            expect(k.home_exists).toBe('no');
          } else {
            expect(k.home_entries).toBe(`${path.basename(parent)},`);
          }

          // The mounts are exactly these, each at its host path, with these modes.
          expect([...mounts].sort()).toEqual(
            [
              `${fx.wt} rw`,
              `${fx.common} ro`,
              `${fx.admin} rw`,
              `${fx.gitFile} ro`,
              `${path.join(fx.admin, 'commondir')} ro`,
              `${path.join(fx.admin, 'gitdir')} ro`,
              `${path.join(fx.admin, 'HEAD')} ro`,
              `${path.join(fx.admin, 'config.worktree')} ro`,
            ].sort()
          );

          // Privileges.
          expect(k.capbnd).toBe('0000000000000000');
          expect(k.nonewprivs).toBe('1');
          expect(k.tmpfs).toMatch(/^tmpfs \/tmp tmpfs /);
          expect(k.tmpfs).toContain('nosuid');
          expect(k.tmpfs).toContain('size=524288k');
          expect(k.tmpfs).not.toContain('noexec');
          expect(k.init).toMatch(/init|tini|catatonit/);
          expect(k.ifaces).toBe('lo,');

          // It is over when exec says so.
          expect(await leftovers(id)).toEqual(NOTHING_LEFT);
        }
      );
    }

    real(
      'passes input, the exit code and secrets, and keeps secrets out of what it says',
      async () => {
        const dir = fs.mkdtempSync(path.join(root, 'io-'));
        const id = runId('io');
        const secret = 'sekrit-value-0123456789';
        const r = await exec(
          base(id, { cwd: dir, secrets: { CLERQ_REAL_SECRET: secret } }),
          'sh',
          [
            '-c',
            // The value is not in this command line: it arrives in the environment, by name.
            'cat > from-stdin.txt; printf %s "$CLERQ_REAL_SECRET" | wc -c; ' +
              'echo "the value: $CLERQ_REAL_SECRET"; echo to-stderr >&2; exit 7',
          ],
          { input: 'hello through stdin\n' }
        );
        expect(r.code).toBe(7);
        expect(fs.readFileSync(path.join(dir, 'from-stdin.txt'), 'utf8')).toBe(
          'hello through stdin\n'
        );
        // It arrived whole, and what exec returns has it redacted.
        expect(r.stdout.split('\n')[0].trim()).toBe(String(secret.length));
        expect(r.stdout).toContain('the value: «redacted»');
        expect(r.stdout).not.toContain(secret);
        expect(r.stderr).toContain('to-stderr');
        // No command line the code ran, here or in the log, has the value.
        expect(fs.readFileSync(CALLS_LOG, 'utf8')).not.toContain(secret);
        expect(await leftovers(id)).toEqual(NOTHING_LEFT);
      }
    );

    real('says so, and leaves nothing, when the image cannot be found', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'img-'));
      const id = runId('noimage');
      // `localhost` is a registry nothing listens on: it fails at once, without the internet.
      const r = await exec(
        base(id, { cwd: dir, image: 'localhost/clerq-no-such-image:0' }),
        'true',
        []
      );
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(
        /unable to find image|no such image|not found|pull access denied|connection refused/i
      );
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });
  });

  describe('egress', () => {
    /** The hermetic targets: a listed upstream and a second one the allowlist does not name. */
    const hermetic = (listed: string, unlisted: Target) => ({
      listed: { host: listed, connect: 8080, http: 8080, tls: false },
      unlisted,
    });
    const upstream = (host: string, port: number): Target => ({
      host,
      connect: port,
      http: port,
      tls: false,
    });

    real('reaches a listed host through the proxy container, and nothing else', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'egress-'));
      const id = runId('egress');
      const {
        result,
        probe: p,
        container,
      } = await probe(
        id,
        [`${allowedUp}:8080`],
        dir,
        hermetic(allowedUp, upstream(refusedUp, 8080))
      );

      // The only way out is the proxy, which has a name on the internal network.
      expect(p.proxyEnv).toBe(`http://${container}-egress:${EGRESS_PORT}`);
      expect(p.dns?.address, JSON.stringify(p.dns)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(p.ifaces).toEqual(['eth0', 'lo']);
      // Listed: through a CONNECT tunnel, and as a plain request to the proxy.
      expect(p.listedConnect, JSON.stringify(p.listedConnect)).toEqual({
        status: 200,
        httpStatus: 200,
      });
      expect(p.listedHttp, JSON.stringify(p.listedHttp)).toEqual({ status: 200 });
      // A second server on the same network, not on the list: refused by the proxy, with a 403.
      expect(p.unlistedConnect).toEqual({ status: 403 });
      expect(p.unlistedHttp).toEqual({ status: 403 });
      // And there is no other route: the listed server itself, and the internet, by address.
      expect(p.directListed.connected).toBeUndefined();
      expect(p.directListed.error).toBeTruthy();
      expect(p.directIp.connected).toBeUndefined();
      expect(p.directIp.error).toBeTruthy();

      // The run's record: what the proxy allowed and what it turned away.
      expect(result.egress?.allowed).toBe(2);
      expect((result.egress?.denied ?? []).map((d) => `${d.host}:${d.port}`)).toEqual([
        `${refusedUp}:8080`,
        `${refusedUp}:8080`,
      ]);
      expect(result.warnings.join(' ')).toMatch(/proxy container/);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    real('limits a host to its port when the entry names one', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'egress-port-'));
      const id = runId('egress-port');
      // The same address, another port: the entry names 8080 only.
      const { result, probe: p } = await probe(
        id,
        [`${allowedUp}:8080`],
        dir,
        hermetic(allowedUp, upstream(allowedUp, 8081))
      );
      expect(p.listedConnect, JSON.stringify(p.listedConnect)).toEqual({
        status: 200,
        httpStatus: 200,
      });
      expect(p.unlistedConnect).toEqual({ status: 403 });
      expect(p.unlistedHttp).toEqual({ status: 403 });
      expect(result.egress?.allowed).toBe(2);
      expect((result.egress?.denied ?? []).map((d) => `${d.host}:${d.port}`)).toEqual([
        `${allowedUp}:8081`,
        `${allowedUp}:8081`,
      ]);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    real('has no network at all with network: none', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'none-'));
      const id = runId('none');
      const { result, probe: p } = await probe(
        id,
        'none',
        dir,
        hermetic(allowedUp, upstream(refusedUp, 8080))
      );
      expect(p.proxyEnv).toBeNull();
      expect(p.ifaces).toEqual(['lo']);
      expect(p.directListed.error).toBeTruthy();
      expect(p.directIp.error).toBeTruthy();
      expect(result.egress).toBeUndefined();
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    // The one test that needs the internet, so it asks little of it: it needs example.com to
    // answer at all (any status but the proxy's own 403, a 502 from a broken upstream included),
    // and it tries twice. What it adds to the tests above is that the proxy container reaches out
    // by name, through the engine's own DNS and routes.
    real(`reaches ${INTERNET_HOST} on the internet, by name (needs the internet)`, async () => {
      const dir = fs.mkdtempSync(path.join(root, 'internet-'));
      const targets = {
        listed: { host: INTERNET_HOST, connect: 443, http: 80, tls: true },
        unlisted: { host: INTERNET_REFUSED, connect: 443, http: 80, tls: true },
      };
      const answered = (p: Probe) =>
        p.listedConnect?.status !== undefined && p.listedHttp?.status !== undefined;
      let id = runId('internet');
      let out = await probe(id, [INTERNET_HOST], dir, targets);
      if (!answered(out.probe)) {
        // One more try: a runner's network is not ours to promise.
        expect(await leftovers(id)).toEqual(NOTHING_LEFT);
        id = runId('internet-again');
        out = await probe(id, [INTERNET_HOST], dir, targets);
      }
      expect(answered(out.probe), JSON.stringify(out.probe)).toBe(true);
      expect(out.probe.listedConnect?.status).not.toBe(403);
      expect(out.probe.listedHttp?.status).not.toBe(403);
      expect(out.probe.unlistedConnect).toEqual({ status: 403 });
      expect(out.probe.unlistedHttp).toEqual({ status: 403 });
      expect(out.result.egress?.allowed).toBe(2);
      expect((out.result.egress?.denied ?? []).map((d) => d.host)).toEqual([
        INTERNET_REFUSED,
        INTERNET_REFUSED,
      ]);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    real('is set up as SECURITY.md says: the command, its proxy and the network', async () => {
      const parent = fs.mkdtempSync(path.join(root, 'setup-git-'));
      const fx = fixture(parent);
      const id = runId('setup');
      const controller = new AbortController();
      const ref: { name?: string } = {};
      const pending = exec(
        isolated(id, fx, { network: [LISTED_HOST], limits: { wallMs: 120_000 } }),
        'sh',
        ['-c', 'trap "" TERM INT; sleep 120'],
        {
          signal: controller.signal,
          onSpawn: (p) => {
            ref.name = p.container?.name;
          },
        }
      );
      // exec starts the proxy before it starts the command, so both exist once the command runs.
      await waitFor('the command to run', async () =>
        ref.name ? (await inspectContainer(ref.name))?.State?.Running === true : false
      );
      const name = ref.name as string;
      const command = (await inspectContainer(name)) as Inspected;
      const proxy = (await inspectContainer(`${name}-egress`)) as Inspected;
      const network = (await inspectNetwork(`${name}-net`)) as Inspected;
      expect(command, 'the command container').toBeDefined();
      expect(proxy, 'the proxy container').toBeDefined();
      expect(network, 'the internal network').toBeDefined();

      const uid = process.getuid?.();
      const gid = process.getgid?.();
      expect(command.Config?.User).toBe(`${uid}:${gid}`);
      expect(command.HostConfig?.ReadonlyRootfs).toBe(true);
      expect(command.HostConfig?.CapDrop).toContain('ALL');
      expect(command.HostConfig?.SecurityOpt?.some((o) => o.startsWith('no-new-privileges'))).toBe(
        true
      );
      expect(command.HostConfig?.Init).toBe(true);
      expect(command.HostConfig?.NetworkMode).toBe(`${name}-net`);
      expect(command.HostConfig?.Tmpfs?.['/tmp']).toContain('size=512m');
      expect(command.Config?.Labels?.['clerq.run']).toBe(id);
      expect(command.Config?.Env).toEqual(
        expect.arrayContaining(['HOME=/tmp', `HTTPS_PROXY=http://${name}-egress:${EGRESS_PORT}`])
      );
      const binds = (command.Mounts ?? [])
        .filter((m) => m.Type === 'bind')
        .map((m) => `${m.Source} ${m.Destination} ${m.RW ? 'rw' : 'ro'}`)
        .sort();
      const at = (p: string, mode: string) => `${p} ${p} ${mode}`;
      expect(binds).toEqual(
        [
          at(fx.wt, 'rw'),
          at(fx.common, 'ro'),
          at(fx.admin, 'rw'),
          at(fx.gitFile, 'ro'),
          at(path.join(fx.admin, 'commondir'), 'ro'),
          at(path.join(fx.admin, 'gitdir'), 'ro'),
          at(path.join(fx.admin, 'HEAD'), 'ro'),
          at(path.join(fx.admin, 'config.worktree'), 'ro'),
        ].sort()
      );

      expect(proxy.Config?.User).toBe('65534:65534');
      expect(proxy.HostConfig?.ReadonlyRootfs).toBe(true);
      expect(proxy.HostConfig?.CapDrop).toContain('ALL');
      expect(proxy.Config?.Labels?.['clerq.run']).toBe(id);
      // On the internal network, and on a second one that has a route out.
      expect(Object.keys(proxy.NetworkSettings?.Networks ?? {})).toHaveLength(2);
      expect(Object.keys(proxy.NetworkSettings?.Networks ?? {})).toContain(`${name}-net`);
      expect(network.Internal).toBe(true);
      expect(network.Labels?.['clerq.run']).toBe(id);

      // A command that ignores SIGTERM is stopped at once by the runtime, and exec waits for all of it.
      const asked = Date.now();
      controller.abort();
      const r = await pending;
      expect(r.cancelled).toBe(true);
      expect(Date.now() - asked).toBeLessThan(15_000);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
      expect(await inspectContainer(name)).toBeUndefined();
      expect(await inspectContainer(`${name}-egress`)).toBeUndefined();
      expect(await inspectNetwork(`${name}-net`)).toBeUndefined();
    });
  });

  describe('stopping', () => {
    real('removes the command, its proxy and its network when the time limit passes', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'timeout-'));
      const id = runId('timeout');
      const ref: { name?: string } = {};
      const started = Date.now();
      const r = await exec(
        base(id, { cwd: dir, network: [LISTED_HOST], limits: { wallMs: 4_000 } }),
        'sh',
        ['-c', 'trap "" TERM INT; sleep 120'],
        {
          onSpawn: (p) => {
            ref.name = p.container?.name;
          },
        }
      );
      expect(r.timedOut).toBe(true);
      expect(r.cancelled).toBe(false);
      expect(Date.now() - started).toBeLessThan(60_000);
      // exec resolved: so everything is already gone.
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
      expect(ref.name).toBeDefined();
      expect(await inspectContainer(ref.name as string)).toBeUndefined();
    });

    real('removes its containers when the caller cancels, with no proxy as well', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'cancel-'));
      const id = runId('cancel');
      const controller = new AbortController();
      const ref: { name?: string } = {};
      const pending = exec(
        base(id, { cwd: dir, network: 'none' }),
        'sh',
        ['-c', 'trap "" TERM INT; sleep 120'],
        {
          signal: controller.signal,
          onSpawn: (p) => {
            ref.name = p.container?.name;
          },
        }
      );
      await waitFor('the command to run', async () =>
        ref.name ? (await inspectContainer(ref.name))?.State?.Running === true : false
      );
      controller.abort();
      const r = await pending;
      expect(r.cancelled).toBe(true);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    real('is stopped by a cancel that comes while the egress proxy is starting', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'cancel-start-'));
      const id = runId('cancel-start');
      const controller = new AbortController();
      const asked: string[] = [];
      const started = Date.now();
      const r = await exec(
        base(id, {
          cwd: dir,
          network: [LISTED_HOST],
          limits: { wallMs: 120_000 },
          // The proxy takes a second or two to start: the cancel lands in the middle of it.
          onProgress: (m) => {
            asked.push(m);
            if (/^Starting the egress proxy/.test(m)) setTimeout(() => controller.abort(), 300);
          },
        }),
        'sh',
        ['-c', 'sleep 100'],
        { signal: controller.signal }
      );
      expect(r.cancelled).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(asked[0]).toMatch(/^Starting the egress proxy/);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    real('counts the egress proxy start in the time limit', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'limit-start-'));
      const id = runId('limit-start');
      const started = Date.now();
      // One second is less than the proxy takes to start: nothing is left of it for the command.
      const r = await exec(
        base(id, { cwd: dir, network: [LISTED_HOST], limits: { wallMs: 1_000 } }),
        'sh',
        ['-c', 'sleep 100']
      );
      expect(r.timedOut).toBe(true);
      expect(r.cancelled).toBe(false);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
    });

    real('leaves nothing when the egress proxy cannot start', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'noproxy-'));
      // An image with no node in it: the engine cannot start the proxy's command.
      const wrong = runId('wrong-egress-image');
      await expect(
        exec(
          base(wrong, { cwd: dir, network: [LISTED_HOST], egressImage: COMMAND_IMAGE }),
          'true',
          []
        )
      ).rejects.toThrow(/start the egress proxy/);
      expect(await leftovers(wrong)).toEqual(NOTHING_LEFT);
      // An image that does not exist.
      const missing = runId('missing-egress-image');
      await expect(
        exec(
          base(missing, {
            cwd: dir,
            network: [LISTED_HOST],
            egressImage: 'localhost/clerq-no-such-image:0',
          }),
          'true',
          []
        )
      ).rejects.toThrow(/start the egress proxy/);
      expect(await leftovers(missing)).toEqual(NOTHING_LEFT);
    });
  });

  describe('what a restarted gateway finds', () => {
    real('lists by label what a crash left, and removes it by name', async () => {
      const id = runId('orphan');
      const name = `clerq-${id}-0000aaaa`;
      const label = ['--label', `clerq.run=${id}`];
      const made1 = await runtimeCall(runtime, [
        'network',
        'create',
        '--internal',
        ...label,
        `${name}-net`,
      ]);
      expect(made1.code, made1.stderr).toBe(0);
      for (const n of [name, `${name}-egress`]) {
        const r = await runtimeCall(runtime, [
          'run',
          '-d',
          '--name',
          n,
          ...label,
          COMMAND_IMAGE,
          'sleep',
          '300',
        ]);
        expect(r.code, r.stderr).toBe(0);
      }
      const otherId = runId('someone-else');
      const other = `clerq-${otherId}`;
      const unlabelled = await runtimeCall(runtime, [
        'run',
        '-d',
        '--name',
        other,
        '--label',
        `clerq.run=${otherId}`,
        COMMAND_IMAGE,
        'sleep',
        '300',
      ]);
      expect(unlabelled.code, unlabelled.stderr).toBe(0);

      const listed = await listLabelled(runtime, 'clerq.run');
      expect(listed.containers).toEqual(
        expect.arrayContaining([
          { name, value: id },
          { name: `${name}-egress`, value: id },
          { name: other, value: otherId },
        ])
      );
      expect(listed.networks).toContainEqual({ name: `${name}-net`, value: id });

      await removeContainer(runtime, name);
      expect(await leftovers(id)).toEqual(NOTHING_LEFT);
      // The other run's container is not touched by removing this one.
      expect((await inspectContainer(other))?.State?.Running).toBe(true);
      await removeContainer(runtime, other);
      expect(await inspectContainer(other)).toBeUndefined();
      // Twice is fine.
      await removeContainer(runtime, name);
    });
  });
});
