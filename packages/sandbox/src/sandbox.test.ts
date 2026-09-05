import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
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
    const out = redact('token=abcdef123456 and again abcdef123456', { T: 'abcdef123456' });
    expect(out).not.toContain('abcdef123456');
    expect(out).toBe('token=«redacted» and again «redacted»');
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

  it('seatbelt enables network only when asked', () => {
    const on = buildSeatbeltProfile({ profile: 'seatbelt', cwd: work, network: ['example.com'] });
    expect(on).toContain('(allow network*)');
    expect(on).not.toContain('(deny network*)');
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

  it('flags that host-level egress filtering is unavailable', async () => {
    const r = await exec({ ...spec(), network: ['example.com'] }, 'true');
    expect(r.warnings.join(' ')).toMatch(/all-or-nothing/i);
  });

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
