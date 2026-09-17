import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  exec,
  redact,
  buildSeatbeltProfile,
  buildContainerArgs,
  availableProfiles,
  defaultProfile,
  SandboxError,
  type SandboxSpec,
} from './index.js';

let work: string;
let outside: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-sbx-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const isMac = process.platform === 'darwin';

describe('redact', () => {
  it('removes secret values wherever they appear', () => {
    const fake = 'NOT-A-REAL-SECRET-0000';
    const out = redact(`value=${fake} and again ${fake}`, { T: fake });
    expect(out).not.toContain(fake);
    expect(out).toBe('value=«redacted» and again «redacted»');
  });

  it('leaves text alone when there are no secrets', () => {
    expect(redact('hello', undefined)).toBe('hello');
    expect(redact('hello', {})).toBe('hello');
  });

  it('skips very short values, which would blank unrelated text', () => {
    expect(redact('a cat sat', { S: 'at' })).toBe('a cat sat');
  });
});

describe('profile construction', () => {
  it('seatbelt denies by default and only grants writes inside the workspace', () => {
    const p = buildSeatbeltProfile({ profile: 'seatbelt', cwd: work, network: 'none' });
    expect(p).toContain('(deny default)');
    expect(p).toContain('(deny network*)');
    // Compared against the canonical path: macOS tmpdirs are symlinks, and a
    // rule built from the unresolved path would not match the actual write.
    expect(p).toContain(
      `(allow file-write* (subpath ${JSON.stringify(fs.realpathSync.native(work))}))`
    );
    expect(p).not.toContain(
      `(allow file-write* (subpath ${JSON.stringify(fs.realpathSync.native(outside))}))`
    );
  });

  it('seatbelt opens the network only when that is what was asked for', () => {
    const on = buildSeatbeltProfile({ profile: 'seatbelt', cwd: work, network: 'all' });
    expect(on).toContain('(allow network*)');
    expect(on).not.toContain('(deny network*)');
  });

  it('seatbelt opens exactly one port when an egress proxy is in use', () => {
    const p = buildSeatbeltProfile(
      { profile: 'seatbelt', cwd: work, network: ['example.com'] },
      { egressProxyPort: 51234 }
    );
    expect(p).toContain('(allow network-outbound (remote ip "localhost:51234"))');
    expect(p).not.toContain('(allow network*)');
  });

  it('container args drop capabilities, go read-only and disable the network', () => {
    const a = buildContainerArgs({ profile: 'container', cwd: work, network: 'none' }, 'echo', [
      'x',
    ]);
    expect(a).toContain('--rm');
    expect(a).toContain('--read-only');
    expect(a).toEqual(expect.arrayContaining(['--cap-drop', 'ALL']));
    expect(a).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges']));
    expect(a).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(a).toEqual(expect.arrayContaining(['-w', '/workspace']));
    expect(a[a.length - 2]).toBe('echo');
    expect(a[a.length - 1]).toBe('x');
  });

  it('container args carry the configured resource caps', () => {
    const a = buildContainerArgs(
      { profile: 'container', cwd: work, limits: { memoryMb: 512, cpus: 2, processes: 64 } },
      'true',
      []
    );
    expect(a).toEqual(expect.arrayContaining(['--memory', '512m']));
    expect(a).toEqual(expect.arrayContaining(['--cpus', '2']));
    expect(a).toEqual(expect.arrayContaining(['--pids-limit', '64']));
  });

  it('passes secrets by name, never by value, in the argument list', () => {
    const a = buildContainerArgs(
      { profile: 'container', cwd: work, secrets: { API_KEY: 'super-secret-value' } },
      'true',
      []
    );
    expect(a).toEqual(expect.arrayContaining(['-e', 'API_KEY']));
    expect(a.join(' ')).not.toContain('super-secret-value');
  });
});

describe('host capabilities', () => {
  it('always offers native, and seatbelt on macOS', () => {
    const p = availableProfiles();
    expect(p).toContain('native');
    if (isMac) expect(p).toContain('seatbelt');
  });

  it('never defaults to the unisolated profile when something better exists', () => {
    const d = defaultProfile();
    if (availableProfiles().length > 1) expect(d).not.toBe('native');
  });
});

describe('validation', () => {
  it('refuses a relative working directory', async () => {
    await expect(exec({ profile: 'native', cwd: 'relative' }, 'true')).rejects.toThrow(
      /absolute path/
    );
  });

  it('refuses an allowlist on a profile that cannot enforce it', async () => {
    // Silently granting full network instead would be the worst outcome: the
    // caller believes egress is restricted when nothing restricts it.
    await expect(
      exec({ profile: 'native', cwd: work, network: ['example.com'] }, 'true')
    ).rejects.toThrow(/cannot enforce an egress allowlist/);
    await expect(
      exec({ profile: 'container', cwd: work, network: ['example.com'] }, 'true')
    ).rejects.toThrow(/cannot enforce an egress allowlist/);
  });

  it('treats an empty allowlist as no network at all', async () => {
    const r = await exec({ profile: 'native', cwd: work, network: [] }, 'true');
    expect(r.code).toBe(0);
    expect(r.egress).toBeUndefined();
  });

  it('refuses a working directory that does not exist', async () => {
    await expect(exec({ profile: 'native', cwd: path.join(work, 'nope') }, 'true')).rejects.toThrow(
      /does not exist/
    );
  });

  it('refuses an unknown profile', async () => {
    await expect(
      exec({ profile: 'bogus' as SandboxSpec['profile'], cwd: work }, 'true')
    ).rejects.toThrow(SandboxError);
  });

  it('refuses the container profile when no runtime is installed', async () => {
    if (availableProfiles().includes('container')) return;
    await expect(exec({ profile: 'container', cwd: work }, 'true')).rejects.toThrow(
      /docker or podman/
    );
  });
});

describe('native execution', () => {
  // Built lazily: `work` is assigned in beforeAll, which runs after the
  // describe body is evaluated.
  const spec = (): SandboxSpec => ({ profile: 'native', cwd: work });

  it('captures stdout and the exit code', async () => {
    const r = await exec(spec(), 'echo', ['hello']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.timedOut).toBe(false);
  });

  it('reports a non-zero exit rather than throwing', async () => {
    const r = await exec(spec(), 'sh', ['-c', 'exit 3']);
    expect(r.code).toBe(3);
  });

  it('captures stderr', async () => {
    const r = await exec(spec(), 'sh', ['-c', 'echo oops >&2']);
    expect(r.stderr.trim()).toBe('oops');
  });

  it('warns loudly that there is no isolation', async () => {
    const r = await exec(spec(), 'true');
    expect(r.warnings.join(' ')).toMatch(/without isolation/i);
  });

  it('kills a command that overruns its wall clock', async () => {
    const r = await exec({ ...spec(), limits: { wallMs: 300 } }, 'sh', ['-c', 'sleep 30']);
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('kills the whole process group, not just the direct child', async () => {
    // The shell backgrounds a sleeper and exits; without group kill the
    // descendant would outlive the timeout.
    const r = await exec({ ...spec(), limits: { wallMs: 300 } }, 'sh', ['-c', 'sleep 30 & wait']);
    expect(r.timedOut).toBe(true);
  });

  it('truncates output beyond the cap instead of buffering it all', async () => {
    const r = await exec({ ...spec(), limits: { maxOutputBytes: 512 } }, 'sh', [
      '-c',
      'head -c 100000 /dev/zero | tr "\\0" "x"',
    ]);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(512);
  });

  it('injects secrets as environment variables and redacts them from output', async () => {
    const r = await exec({ ...spec(), secrets: { MY_TOKEN: 'sekrit-value-123456' } }, 'sh', [
      '-c',
      'echo "$MY_TOKEN"',
    ]);
    // The command saw the value...
    expect(r.code).toBe(0);
    // ...but it does not reach the caller.
    expect(r.stdout).not.toContain('sekrit-value-123456');
    expect(r.stdout).toContain('«redacted»');
  });

  it('passes plain env vars through unredacted', async () => {
    const r = await exec({ ...spec(), env: { GREETING: 'hi there' } }, 'sh', [
      '-c',
      'echo "$GREETING"',
    ]);
    expect(r.stdout.trim()).toBe('hi there');
  });

  it('surfaces a failure to start as a SandboxError', async () => {
    await expect(exec(spec(), 'this-command-does-not-exist-xyz')).rejects.toThrow(SandboxError);
  });
});

describe.skipIf(!isMac)('seatbelt isolation (macOS)', () => {
  const spec = (): SandboxSpec => ({ profile: 'seatbelt', cwd: work, network: 'none' });

  it('permits writing inside the workspace', async () => {
    const r = await exec(spec(), 'sh', ['-c', 'echo ok > allowed.txt && cat allowed.txt']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
    expect(fs.existsSync(path.join(work, 'allowed.txt'))).toBe(true);
  });

  it('refuses writing outside the workspace', async () => {
    const target = path.join(outside, 'breach.txt');
    const r = await exec(spec(), 'sh', ['-c', `echo pwned > ${target}`]);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('still permits reading outside the workspace, which tooling needs', async () => {
    const r = await exec(spec(), 'cat', [path.join(outside, 'secret.txt')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('TOP SECRET');
  });

  it('does not warn about missing isolation', async () => {
    const r = await exec(spec(), 'true');
    expect(r.warnings.join(' ')).not.toMatch(/without isolation/i);
  });

  it('says plainly what the allowlist does and does not stop', async () => {
    const r = await exec({ ...spec(), network: ['example.com'] }, 'true');
    expect(r.warnings.join(' ')).toMatch(/restricted to the allowlist/i);
    expect(r.warnings.join(' ')).toMatch(/proxy port is not stopped/i);
  });

  it('holds a sandboxed command to the allowlist, and records what it tried', async () => {
    // The real thing: two local servers, one listed and one not, reached with
    // curl inside the sandbox.
    const allowed = http.createServer((_q, res) => res.end('allowed body'));
    const blocked = http.createServer((_q, res) => res.end('blocked body'));
    await new Promise<void>((r) => allowed.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => blocked.listen(0, '127.0.0.1', () => r()));
    const allowedPort = (allowed.address() as net.AddressInfo).port;
    const blockedPort = (blocked.address() as net.AddressInfo).port;

    try {
      const run = (url: string, args: string[] = []) =>
        exec(
          { ...spec(), network: [`127.0.0.1:${allowedPort}`], limits: { wallMs: 15_000 } },
          '/usr/bin/curl',
          ['-s', '--max-time', '5', ...args, url]
        );

      const ok = await run(`http://127.0.0.1:${allowedPort}/`);
      expect(ok.stdout).toBe('allowed body');
      expect(ok.egress?.allowed).toBe(1);

      const denied = await run(`http://127.0.0.1:${blockedPort}/`);
      expect(denied.stdout).not.toContain('blocked body');
      expect(denied.egress?.denied).toMatchObject([{ host: '127.0.0.1', port: blockedPort }]);

      // And the proxy cannot simply be stepped around: a direct connection to
      // the allowed server, bypassing the proxy variables, is refused by the
      // sandbox itself because that port is not open to it.
      const direct = await run(`http://127.0.0.1:${allowedPort}/`, ['--noproxy', '*']);
      expect(direct.code).not.toBe(0);
      expect(direct.stdout).not.toContain('allowed body');
    } finally {
      await new Promise<void>((r) => allowed.close(() => r()));
      await new Promise<void>((r) => blocked.close(() => r()));
    }
  }, 30_000);

  it('enforces the wall clock like every other profile', async () => {
    const r = await exec({ ...spec(), limits: { wallMs: 300 } }, 'sh', ['-c', 'sleep 30']);
    expect(r.timedOut).toBe(true);
  });

  it('gives the command a private temp directory it can write to', async () => {
    const r = await exec(spec(), 'sh', ['-c', 'echo scratch > "$TMPDIR/x" && cat "$TMPDIR/x"']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('scratch');
  });

  it('does not open the shared temp directory to the command', async () => {
    // Granting os.tmpdir() outright would let a sandboxed command write into
    // every other process's temp files.
    const target = path.join(fs.realpathSync.native(os.tmpdir()), 'clerq-should-not-exist.txt');
    const r = await exec(spec(), 'sh', ['-c', `echo pwned > ${target}`]);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cleans up its private temp directory afterwards', async () => {
    const r = await exec(spec(), 'sh', ['-c', 'echo "$TMPDIR"']);
    const dir = r.stdout.trim();
    expect(dir).toContain('clerq-run-');
    expect(fs.existsSync(dir)).toBe(false);
  });
});
