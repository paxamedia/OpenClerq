/**
 * The filesystem rules of the seatbelt profile, run for real on macOS, and the
 * container profile's lifecycle against a fake runtime: there is no Docker or
 * Podman where these tests run, so `docker` is a script that records what it
 * was asked and runs the command on the host. What a real engine does with the
 * arguments is not exercised here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  exec,
  buildSeatbeltProfile,
  buildContainerArgs,
  removeContainer,
  parseEgressLog,
  EGRESS_SIDECAR_SCRIPT,
  findStragglers,
  stopStragglers,
  type SandboxSpec,
} from './index.js';

const isMac = process.platform === 'darwin';
let root: string;

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-prof-')));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('seatbelt profile text', () => {
  it('denies reading listed paths, then gives back what the command was handed', () => {
    const home = path.join(root, 'home-a');
    const work = path.join(home, '.clerq', 'w');
    fs.mkdirSync(work, { recursive: true });
    const p = buildSeatbeltProfile({
      profile: 'seatbelt',
      cwd: work,
      denyRead: [path.join(home, '.clerq')],
    });
    const deny = p.indexOf(
      `(deny file-read* file-write* (subpath "${path.join(home, '.clerq')}"))`
    );
    const back = p.indexOf(`(allow file-read* (subpath "${work}"))`);
    expect(deny).toBeGreaterThan(0);
    // Later rules win: the exception must come after the denial.
    expect(back).toBeGreaterThan(deny);
  });

  it('resolves a path that does not exist yet through its nearest existing parent', () => {
    const p = buildSeatbeltProfile({
      profile: 'seatbelt',
      cwd: root,
      denyRead: [path.join(os.tmpdir(), 'clerq-no-such-dir', '.aws')],
    });
    expect(p).toContain(
      path.join(fs.realpathSync.native(os.tmpdir()), 'clerq-no-such-dir', '.aws')
    );
  });

  it('puts protected paths last, so no allow re-opens them', () => {
    const p = buildSeatbeltProfile({
      profile: 'seatbelt',
      cwd: root,
      protect: [path.join(root, '.git')],
    });
    const lines = p.split('\n');
    const at = lines.findIndex((l) => l.includes(`(deny file-write* (subpath "${root}/.git"))`));
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.includes(`(subpath "${root}")`)));
  });

  it('refuses a path it cannot write a rule for', () => {
    expect(() =>
      buildSeatbeltProfile({ profile: 'seatbelt', cwd: root, denyRead: ['/tmp/a"b'] })
    ).toThrow(/quote or line break/);
  });
});

describe.skipIf(!isMac)('seatbelt filesystem rules, run (macOS)', () => {
  let home: string;
  let work: string;
  let state: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(root, 'home-'));
    work = path.join(home, '.clerq', 'workspaces', 'run-1');
    state = path.join(home, '.agent');
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    fs.writeFileSync(path.join(home, '.clerq', 'gateway-token'), 'GATEWAY TOKEN');
    fs.writeFileSync(path.join(work, 'README.md'), 'readme');
    fs.writeFileSync(path.join(work, '.git'), 'gitdir: /somewhere\n');
  });

  const spec = (extra: Partial<SandboxSpec> = {}): SandboxSpec => ({
    profile: 'seatbelt',
    cwd: work,
    network: 'none',
    denyRead: [path.join(home, '.ssh'), path.join(home, '.clerq')],
    ...extra,
  });

  it('cannot read a denied credential store, or the gateway state around its own worktree', async () => {
    const key = await exec(spec(), 'cat', [path.join(home, '.ssh', 'id_ed25519')]);
    expect(key.code).not.toBe(0);
    expect(key.stdout).not.toContain('PRIVATE KEY');
    const token = await exec(spec(), 'cat', [path.join(home, '.clerq', 'gateway-token')]);
    expect(token.code).not.toBe(0);
    expect(token.stdout).not.toContain('GATEWAY TOKEN');
  });

  it('reads and writes its worktree even though it lies inside a denied directory', async () => {
    const r = await exec(spec(), 'sh', ['-c', 'cat README.md && echo new > NEW.md && cat NEW.md']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('readmenew\n');
  });

  it('can resolve its worktree’s real path through a denied directory, but not list it', async () => {
    // realpath stats every directory on the way down; git does it to find its repository.
    const r = await exec(spec(), process.execPath, [
      '-e',
      `const fs = require('node:fs');
       console.log(fs.realpathSync(process.cwd()) === ${JSON.stringify(work)});
       try { fs.readdirSync(${JSON.stringify(path.join(home, '.clerq'))}); console.log('listed'); }
       catch { console.log('not listed'); }`,
    ]);
    expect(r.stdout.trim().split('\n')).toEqual(['true', 'not listed']);
  });

  it('cannot change a protected file inside its worktree', async () => {
    const r = await exec(spec({ protect: [path.join(work, '.git')] }), 'sh', [
      '-c',
      'echo "gitdir: /tmp/evil" > .git',
    ]);
    expect(r.code).not.toBe(0);
    expect(fs.readFileSync(path.join(work, '.git'), 'utf8')).toBe('gitdir: /somewhere\n');
  });

  it('cannot replace a protected file by deleting and recreating it', async () => {
    const r = await exec(spec({ protect: [path.join(work, '.git')] }), 'sh', [
      '-c',
      'rm -f .git; mv README.md .git',
    ]);
    expect(r.code).not.toBe(0);
    expect(fs.readFileSync(path.join(work, '.git'), 'utf8')).toBe('gitdir: /somewhere\n');
  });

  it('writes an agent state directory it is given, and a config file by prefix', async () => {
    const config = path.join(home, '.agent.json');
    const r = await exec(spec({ allowWrite: [state], allowWritePrefix: [config] }), 'sh', [
      '-c',
      `echo s > ${state}/session && echo c > ${config}.tmp.1 && mv ${config}.tmp.1 ${config}`,
    ]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(config, 'utf8')).toBe('c\n');
    // The prefix is a prefix of a file name, not a directory to write into.
    const other = await exec(spec({ allowWritePrefix: [config] }), 'sh', [
      '-c',
      `echo x > ${path.join(home, 'other.json')}`,
    ]);
    expect(other.code).not.toBe(0);
  });

  it('keeps the worktree read-only when asked', async () => {
    const r = await exec(spec({ readOnlyCwd: true }), 'sh', [
      '-c',
      'cat README.md; echo x > NEW.md',
    ]);
    expect(r.stdout).toContain('readme');
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(work, 'NEW.md'))).toBe(false);
  });

  it('runs node, as an agent CLI would', async () => {
    const r = await exec(spec(), process.execPath, [
      '-e',
      "require('node:fs').writeFileSync('from-node.txt', 'ok'); console.log(process.version)",
    ]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(work, 'from-node.txt'), 'utf8')).toBe('ok');
  });
});

describe.skipIf(!isMac)('seatbelt: writable roots cannot be moved or swapped (macOS)', () => {
  let base: string;
  let work: string;
  let state: string;
  let admin: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(root, 'swap-'));
    work = path.join(base, 'wt');
    state = path.join(base, 'home', '.agent');
    admin = path.join(base, 'git', 'worktrees', 'wt');
    for (const d of [work, state, path.join(state, 'hooks'), admin])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(work, '.git'), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/b\n');
    fs.writeFileSync(path.join(state, 'hooks', 'h.sh'), 'trusted\n');
  });
  const spec = (): SandboxSpec => ({
    profile: 'seatbelt',
    cwd: work,
    network: 'none',
    allowWrite: [state, admin],
    protect: [path.join(work, '.git'), path.join(admin, 'HEAD'), path.join(state, 'hooks')],
  });
  const attempt = async (script: string) => (await exec(spec(), 'sh', ['-c', script])).code;

  it('cannot move its worktree away and put a link in its place', async () => {
    expect(await attempt(`mv ${work} ${admin}/moved`)).not.toBe(0);
    expect(await attempt(`rm -rf ${work}`)).not.toBe(0);
    expect(fs.lstatSync(work).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(work, '.git'), 'utf8')).toBe(`gitdir: ${admin}\n`);
  });

  it("cannot move an agent CLI's state directory and plant another", async () => {
    expect(await attempt(`mv ${state} ${work}/old && ln -s ${work}/evil ${state}`)).not.toBe(0);
    expect(fs.lstatSync(state).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(state, 'hooks', 'h.sh'), 'utf8')).toBe('trusted\n');
  });

  it('cannot move the git admin directory, or a directory above a protected path', async () => {
    expect(await attempt(`mv ${admin} ${work}/a`)).not.toBe(0);
    expect(await attempt(`mv ${state}/hooks ${state}/h2`)).not.toBe(0);
    expect(fs.existsSync(path.join(admin, 'HEAD'))).toBe(true);
  });

  it('cannot hard-link a protected file into its worktree and write through the link', async () => {
    expect(await attempt(`ln ${admin}/HEAD ${work}/h && echo x >> ${work}/h`)).not.toBe(0);
    expect(fs.readFileSync(path.join(admin, 'HEAD'), 'utf8')).toBe('ref: refs/heads/b\n');
  });

  it('still creates, renames and removes inside its worktree', async () => {
    expect(await attempt('mkdir d && echo x > d/f && mv d e && rm -r e && echo ok > done')).toBe(0);
    expect(fs.readFileSync(path.join(work, 'done'), 'utf8')).toBe('ok\n');
  });
});

describe.skipIf(!isMac)('seatbelt: local services (macOS)', () => {
  let work: string;
  let sock: string;
  let server: net.Server;
  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(root, 'svc-'));
    // A Unix-domain socket stands in for a local daemon (Docker's, ssh-agent's).
    sock = path.join(fs.mkdtempSync(path.join('/tmp', 'clerq-sock-')), 's');
    server = net.createServer((c) => c.end('daemon answered'));
    await new Promise<void>((r) => server.listen(sock, () => r()));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(path.dirname(sock), { recursive: true, force: true });
  });
  const connect = (network: SandboxSpec['network']) =>
    exec({ profile: 'seatbelt', cwd: work, network }, process.execPath, [
      '-e',
      `require('node:net').connect(${JSON.stringify(sock)})
         .on('data', (d) => { console.log(String(d)); process.exit(0); })
         .on('error', (e) => { console.log('refused ' + e.code); process.exit(1); });`,
    ]);

  it('refuses a Unix-socket connection even with network: all', async () => {
    const r = await connect('all');
    expect(r.stdout).not.toContain('daemon answered');
    expect(r.code).not.toBe(0);
  });

  it('refuses it with a host list and with no network', async () => {
    for (const network of [['example.com'], 'none'] as const) {
      const r = await connect(network as SandboxSpec['network']);
      expect(r.stdout).not.toContain('daemon answered');
    }
  });

  it('still reaches hosts over IP with network: all', async () => {
    const tcp = http.createServer((_q, res) => res.end('tcp ok'));
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const port = (tcp.address() as net.AddressInfo).port;
    try {
      const r = await exec({ profile: 'seatbelt', cwd: work, network: 'all' }, '/usr/bin/curl', [
        '-s',
        '--max-time',
        '5',
        `http://127.0.0.1:${port}/`,
      ]);
      expect(r.stdout).toBe('tcp ok');
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });

  it('cannot reach LaunchServices, so `open` cannot start an app outside the sandbox', async () => {
    // lsappinfo asks LaunchServices for the frontmost app; refused, it prints nothing useful.
    const r = await exec(
      { profile: 'seatbelt', cwd: work, network: 'none' },
      '/usr/bin/lsappinfo',
      ['front']
    );
    expect(r.stdout).not.toMatch(/ASN:/);
    // A bundle id is resolved through LaunchServices too: nothing is found, nothing starts.
    const open = await exec({ profile: 'seatbelt', cwd: work, network: 'none' }, '/usr/bin/open', [
      '-b',
      'com.apple.Terminal',
    ]);
    expect(`${open.stdout}${open.stderr}`).toMatch(/failed|Unable/i);
  });
});

// ---------------------------------------------------------------------------
// Container profile, against a fake runtime
// ---------------------------------------------------------------------------

/**
 * A stand-in for docker: records each call as a JSON line, and for `run` starts
 * the command on the host in a process group of its own, as a container is
 * outside the CLI's group. `kill` and `rm -f` stop it by name; nothing else
 * does, just as killing the real CLI leaves the container running.
 */
const FAKE_DOCKER = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const file = (n) => path.join(dir, 'state-' + n.replace(/[^\w.-]/g, '_'));
const fail = (what) => fs.existsSync(path.join(dir, 'fail-' + what));
const cmd = args[0];
if (cmd === 'run') {
  const name = args[args.indexOf('--name') + 1];
  if (args[1] === '-d') {
    if (fail('sidecar')) { process.stderr.write('no such image\n'); process.exit(125); }
    fs.writeFileSync(file(name + '.log'),
      '{"event":"listening","port":3128}\n{"event":"allowed","host":"registry.npmjs.org","port":443}\n' +
      '{"event":"denied","host":"evil.example","port":443,"at":"2026-01-01T00:00:00.000Z"}\n');
    process.stdout.write('0123abcd\n');
    process.exit(0);
  }
  const at = args.indexOf('fake-image');
  const w = args[args.indexOf('-w') + 1];
  const child = spawn(args[at + 1], args.slice(at + 2), { cwd: w, stdio: 'inherit', detached: true });
  fs.writeFileSync(file(name + '.pid'), String(child.pid));
  if (fs.existsSync(path.join(dir, 'stubborn'))) process.on('SIGTERM', () => {});
  child.on('exit', (code) => process.exit(code === null ? 137 : code));
} else if (cmd === 'kill' || cmd === 'rm') {
  for (const n of args.slice(1).filter((a) => !a.startsWith('-'))) {
    try { process.kill(-Number(fs.readFileSync(file(n + '.pid'), 'utf8')), 'SIGKILL'); } catch {}
  }
} else if (cmd === 'logs') {
  try { process.stdout.write(fs.readFileSync(file(args[1] + '.log'), 'utf8')); } catch {}
} else if (cmd === 'network') {
  if (args[1] === 'create' && fail('network')) { process.stderr.write('permission denied\n'); process.exit(1); }
}
`;

describe('container profile, against a fake runtime', () => {
  let bin: string;
  let work: string;
  const calls = (): string[][] =>
    fs.existsSync(path.join(bin, 'calls.jsonl'))
      ? fs
          .readFileSync(path.join(bin, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
  const spec = (extra: Partial<SandboxSpec> = {}): SandboxSpec => ({
    profile: 'container',
    cwd: work,
    image: 'fake-image',
    runtime: path.join(bin, 'docker'),
    containerName: 'clerq-run_abc',
    ...extra,
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(root, 'bin-'));
    work = fs.mkdtempSync(path.join(root, 'work-'));
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  });

  it('names the container, reports it on spawn, and removes it when the command exits', async () => {
    let spawned: { pid: number; container?: { runtime: string; name: string } } | undefined;
    const r = await exec(spec(), 'sh', ['-c', 'echo inside'], { onSpawn: (p) => (spawned = p) });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('inside');
    const name = spawned?.container?.name as string;
    expect(name).toMatch(/^clerq-run_abc-[0-9a-f]{8}$/);
    expect(spawned?.container?.runtime).toBe(path.join(bin, 'docker'));
    const all = calls();
    expect(all[0][0]).toBe('run');
    expect(all[0]).toEqual(expect.arrayContaining(['--name', name, '--init', '--network', 'none']));
    expect(all).toContainEqual(['rm', '-f', name, `${name}-egress`]);
    expect(all).toContainEqual(['network', 'rm', `${name}-net`]);
  });

  it('stops the container by name on cancel, even when the runtime CLI ignores signals', async () => {
    fs.writeFileSync(path.join(bin, 'stubborn'), '');
    const controller = new AbortController();
    let name = '';
    const pending = exec(spec(), 'sh', ['-c', 'sleep 30'], {
      signal: controller.signal,
      onSpawn: (p) => (name = p.container?.name ?? ''),
    });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(bin, `state-${name}.pid`)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const inner = Number(fs.readFileSync(path.join(bin, `state-${name}.pid`), 'utf8'));
    expect(alive(inner)).toBe(true);
    const asked = Date.now();
    controller.abort();
    const r = await pending;
    expect(r.cancelled).toBe(true);
    // Not the 2s escalation of a signal: the runtime was told to kill it at once.
    expect(Date.now() - asked).toBeLessThan(1_900);
    expect(calls()).toContainEqual(['kill', name]);
    expect(alive(inner)).toBe(false);
  });

  it('stops the container by name when the time limit passes', async () => {
    let name = '';
    const r = await exec(spec({ limits: { wallMs: 300 } }), 'sh', ['-c', 'sleep 30'], {
      onSpawn: (p) => (name = p.container?.name ?? ''),
    });
    expect(r.timedOut).toBe(true);
    expect(calls()).toContainEqual(['kill', name]);
    expect(calls()).toContainEqual(['rm', '-f', name, `${name}-egress`]);
  });

  it('mounts what it is given at the same paths, protected paths read-only over them', () => {
    const git = path.join(work, '.git');
    fs.writeFileSync(git, 'gitdir: x\n');
    const ro = path.join(root, 'common');
    const a = buildContainerArgs(
      { cwd: work, image: 'img', readOnly: [ro], protect: [git, path.join(work, 'missing')] },
      'true',
      []
    );
    const mounts = a.flatMap((x, i) => (a[i - 1] === '--mount' ? [x] : []));
    expect(mounts).toEqual([
      `type=bind,source=${work},target=${work}`,
      `type=bind,source=${ro},target=${ro},readonly`,
      `type=bind,source=${git},target=${git},readonly`,
    ]);
  });

  it('runs as the host user and does not carry host-only variables in', () => {
    const a = buildContainerArgs(
      { cwd: work, image: 'img', env: { PATH: '/host/bin', HOME: '/Users/x', LANG: 'C' } },
      'true',
      [],
      { user: '501:20' }
    );
    expect(a).toEqual(
      expect.arrayContaining(['--user', '501:20', '-e', 'HOME=/tmp', '-e', 'LANG'])
    );
    expect(a).not.toContain('PATH');
  });

  it('refuses a path a mount cannot express', () => {
    expect(() => buildContainerArgs({ cwd: '/tmp/a,b', image: 'img' }, 'true', [])).toThrow(
      /comma/
    );
  });

  it('puts an allowlist behind an egress proxy container on an internal network', async () => {
    const r = await exec(spec({ network: ['registry.npmjs.org'] }), 'sh', [
      '-c',
      'echo "$HTTPS_PROXY"',
    ]);
    expect(r.code).toBe(0);
    const all = calls();
    const cmd = (x: string[]) => x.slice(0, 2).join(' ');
    const create = all.find((c) => cmd(c) === 'network create') as string[];
    const name = (create[create.length - 1] as string).replace(/-net$/, '');
    expect(create).toContain('--internal');
    const sidecar = all.find((c) => cmd(c) === 'run -d') as string[];
    expect(sidecar).toEqual(expect.arrayContaining(['--name', `${name}-egress`, 'node', '-e']));
    expect(JSON.parse(sidecar[sidecar.length - 1])).toEqual({
      rules: [{ host: 'registry.npmjs.org' }],
      port: 3128,
    });
    expect(all).toContainEqual(['network', 'connect', `${name}-net`, `${name}-egress`]);
    const run = all.find((c) => c[0] === 'run' && c[1] !== '-d') as string[];
    expect(run).toEqual(expect.arrayContaining(['--network', `${name}-net`, '-e', 'HTTPS_PROXY']));
    // The order matters: the proxy listens before the command starts.
    expect(all.indexOf(run)).toBeGreaterThan(all.findIndex((c) => c[0] === 'logs'));
    expect(r.stdout.trim()).toBe(`http://${name}-egress:3128`);
    expect(r.egress).toEqual({
      allowed: 1,
      denied: [{ host: 'evil.example', port: 443, at: '2026-01-01T00:00:00.000Z' }],
    });
    expect(all).toContainEqual(['rm', '-f', name, `${name}-egress`]);
    expect(all).toContainEqual(['network', 'rm', `${name}-net`]);
  });

  it('removes what it created when the egress proxy cannot start, and says why', async () => {
    fs.writeFileSync(path.join(bin, 'fail-sidecar'), '');
    await expect(
      exec(spec({ network: ['registry.npmjs.org'] }), 'sh', ['-c', 'true'])
    ).rejects.toThrow(/start the egress proxy, which the egress allowlist needs: no such image/);
    const all = calls();
    expect(all.some((c) => c[0] === 'run' && c[1] !== '-d')).toBe(false);
    expect(all.some((c) => c[0] === 'rm')).toBe(true);
    expect(all.some((c) => c[0] === 'network' && c[1] === 'rm')).toBe(true);
  });

  it('refuses a runtime it was told to use that does not exist', async () => {
    await expect(exec(spec({ runtime: path.join(bin, 'nope') }), 'true')).rejects.toThrow(
      /was not found/
    );
  });

  it('removeContainer removes the container, its proxy and its network', async () => {
    await removeContainer(path.join(bin, 'docker'), 'clerq-x-1');
    expect(calls()).toEqual([
      ['rm', '-f', 'clerq-x-1', 'clerq-x-1-egress'],
      ['network', 'rm', 'clerq-x-1-net'],
    ]);
  });
});

describe('egress proxy script for the container profile', () => {
  it('reads its own log lines and nothing else', () => {
    expect(
      parseEgressLog(
        'npm notice\n{"event":"listening","port":3128}\n{"event":"allowed","host":"a","port":443}\n' +
          '{"event":"denied","host":"b","port":80,"at":"t"}\n{not json\n'
      )
    ).toEqual({ allowed: 1, denied: [{ host: 'b', port: 80, at: 't' }] });
  });

  it('allows a listed host and refuses another, as node runs it in the proxy container', async () => {
    const upstream = http.createServer((_q, res) => res.end('upstream body'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upPort = (upstream.address() as net.AddressInfo).port;
    const proxy = spawn(
      process.execPath,
      [
        '-e',
        EGRESS_SIDECAR_SCRIPT,
        JSON.stringify({
          rules: [{ host: '127.0.0.1', port: upPort }],
          port: 0,
          host: '127.0.0.1',
        }),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let out = '';
    proxy.stdout.on('data', (c: Buffer) => (out += c.toString()));
    try {
      for (let i = 0; i < 200 && !out.includes('listening'); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const port = (JSON.parse(out.split('\n')[0]) as { port: number }).port;
      const get = (target: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port, path: target, headers: { host: new URL(target).host } },
            (res) => {
              let body = '';
              res.on('data', (c: Buffer) => (body += c.toString()));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }
          );
          req.on('error', reject);
          req.end();
        });
      expect(await get(`http://127.0.0.1:${upPort}/`)).toEqual({
        status: 200,
        body: 'upstream body',
      });
      expect((await get('http://127.0.0.2:9/')).status).toBe(403);
      // CONNECT, as a TLS client asks.
      const refused = await new Promise<string>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () =>
          s.write('CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n')
        );
        let text = '';
        s.on('data', (c: Buffer) => (text += c.toString()));
        s.on('close', () => resolve(text));
      });
      expect(refused).toMatch(/^HTTP\/1\.1 403/);
      const seen = parseEgressLog(out);
      expect(seen.allowed).toBe(1);
      expect(seen.denied.map((d) => `${d.host}:${d.port}`)).toEqual([
        '127.0.0.2:9',
        'evil.example:443',
      ]);
    } finally {
      proxy.kill();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

describe('what a command leaves behind', () => {
  let work: string;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(root, 'left-'));
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('has stopped the rest of the group by the time exec returns', async () => {
    const r = await exec({ profile: 'native', cwd: work }, 'sh', ['-c', 'sleep 30 & echo $!'], {
      reapGroup: true,
    });
    expect(alive(Number(r.stdout.trim()))).toBe(false);
  });

  it('passes input on standard input', async () => {
    const r = await exec({ profile: 'native', cwd: work }, 'sh', ['-c', 'cat > got.txt'], {
      input: 'line one\nline two\n',
    });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(work, 'got.txt'), 'utf8')).toBe('line one\nline two\n');
  });

  // perl is in macOS and most Linux base systems; it calls setsid() without a helper.
  const SETSID = (body: string) =>
    `/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); close STDOUT; close STDERR; close STDIN; ${body}' & sleep 1; echo started`;

  it.skipIf(process.platform === 'win32')(
    'finds a process that left the group with setsid and the directories, by its tag file, and stops it',
    async () => {
      const tagFile = path.join(fs.mkdtempSync(path.join(root, 'tag-')), 'run.tag');
      fs.writeFileSync(tagFile, '');
      const r = await exec(
        { profile: isMac ? 'seatbelt' : 'native', cwd: work, network: 'none', tagFile },
        '/bin/sh',
        ['-c', SETSID('chdir "/"; sleep 4; open F, ">", "' + work + '/survivor.txt"; close F')],
        { reapGroup: true }
      );
      expect(r.stdout.trim()).toBe('started');
      // Not by the worktree (it left it), but by the descriptor it inherited.
      expect(await findStragglers({ dirs: [work] })).toEqual([]);
      const found = (await findStragglers({ tagFile, dirs: [work] })) ?? [];
      expect(found).toHaveLength(1);
      const done = await stopStragglers({ tagFile, dirs: [work] });
      expect(done?.stopped.map((s) => s.pid)).toEqual(found.map((s) => s.pid));
      expect(done?.remaining).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      expect(fs.existsSync(path.join(work, 'survivor.txt'))).toBe(false);
    },
    15_000
  );

  it.skipIf(process.platform === 'win32')(
    'finds one that closed its descriptors by its working directory',
    async () => {
      await exec({ profile: 'native', cwd: work }, '/bin/sh', ['-c', SETSID('sleep 20')], {
        reapGroup: true,
      });
      const done = await stopStragglers({ dirs: [work] });
      expect(done?.stopped).toHaveLength(1);
      expect(done?.remaining).toEqual([]);
      expect(alive((done?.stopped ?? [])[0].pid)).toBe(false);
    },
    15_000
  );
});

describe.skipIf(!isMac)(
  'seatbelt: a writable file is that file and its dotted siblings only (macOS)',
  () => {
    it('does not let a file rule cover longer names or paths below it', async () => {
      const dir = fs.mkdtempSync(path.join(root, 'pref-'));
      const work = path.join(dir, 'w');
      fs.mkdirSync(work);
      const file = path.join(dir, 'state.json');
      const spec: SandboxSpec = {
        profile: 'seatbelt',
        cwd: work,
        network: 'none',
        allowWritePrefix: [file],
      };
      const tryWrite = async (p: string) =>
        (
          await exec(spec, 'sh', [
            '-c',
            `mkdir -p "$(dirname "${p}")" 2>/dev/null; echo x > "${p}"`,
          ])
        ).code;
      expect(await tryWrite(file)).toBe(0);
      expect(await tryWrite(`${file}.tmp.12`)).toBe(0);
      expect(await tryWrite(`${file}X`)).not.toBe(0);
      expect(await tryWrite(`${file}.d/evil`)).not.toBe(0);
    });
  }
);
