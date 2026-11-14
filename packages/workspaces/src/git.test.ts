/**
 * git() against commands that stall. The timeout must end the call, and every
 * process git started, however many layers of helper that is.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GitError, HARDENED_GIT, git, gitArgv } from './git.js';

const posix = process.platform !== 'win32';
const cwd = fs.realpathSync(os.tmpdir());

/** The processes whose command line contains `marker`. */
function running(marker: string): string[] {
  if (!posix) return [];
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes(marker) && !l.includes(' ps '))
    .map((l) => l.trim());
}

/** Wait until nothing matches `marker`, up to `ms`; returns what is left. */
async function leftOf(marker: string, ms = 2000): Promise<string[]> {
  const end = Date.now() + ms;
  let left = running(marker);
  while (left.length > 0 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    left = running(marker);
  }
  return left;
}

const servers: net.Server[] = [];
const held: net.Socket[] = [];
afterEach(async () => {
  held.splice(0).forEach((s) => s.destroy());
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A listener that accepts connections and never says a word. */
async function silentServer(): Promise<{ port: number; sockets: net.Socket[] }> {
  const sockets = held;
  const server = net.createServer((s) => {
    sockets.push(s);
    s.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, sockets };
}

describe('git()', () => {
  it('returns what git printed, and rejects a failure with its words', async () => {
    const ok = await git(['--version'], { cwd });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^git version/);
    await expect(git(['rev-parse', '--verify', 'no-such-ref'], { cwd })).rejects.toThrow(
      /^git rev-parse failed \(exit 128\)/
    );
    const soft = await git(['rev-parse', '--verify', 'no-such-ref'], { cwd, allowFailure: true });
    expect(soft.code).not.toBe(0);
    expect(soft.timedOut).toBeUndefined();
  });

  it('adds curl’s low-speed limit to a command that talks to a remote, and to no other', () => {
    expect(gitArgv(['ls-remote', 'https://x/y.git'], { timeoutMs: 20_000 })).toEqual([
      '-c',
      'http.lowSpeedLimit=1',
      '-c',
      'http.lowSpeedTime=20',
      'ls-remote',
      'https://x/y.git',
    ]);
    for (const sub of ['clone', 'fetch', 'pull', 'push']) {
      expect(gitArgv([sub], { timeoutMs: 600_000 }), sub).toContain('http.lowSpeedTime=600');
    }
    // Rounded up, never below a second; the default timeout is two minutes.
    expect(gitArgv(['fetch'], { timeoutMs: 100 })).toContain('http.lowSpeedTime=1');
    expect(gitArgv(['fetch'], {})).toContain('http.lowSpeedTime=120');
    for (const sub of ['status', 'commit', 'diff', 'worktree', 'config']) {
      expect(gitArgv([sub], { timeoutMs: 5000 }), sub).toEqual([sub]);
    }
    // The hardening comes first and is kept.
    expect(
      gitArgv(['push'], { harden: true, timeoutMs: 5000 }).slice(0, HARDENED_GIT.length)
    ).toEqual(HARDENED_GIT);
  });

  it.skipIf(!posix)(
    'settles on a server that never answers, within the timeout and a little, and leaves no git behind',
    async () => {
      const { port } = await silentServer();
      const url = `http://127.0.0.1:${port}/never.git`;
      const started = Date.now();
      const result = await git(['ls-remote', url], { cwd, timeoutMs: 2000, allowFailure: true });
      expect(Date.now() - started).toBeLessThan(4000);
      // Either the timeout killed it, or the low-speed limit ended the transfer first.
      expect(result.code === null ? result.timedOut : true).toBe(true);
      expect(result.code).not.toBe(0);
      // git-remote-http was started by git; it must be gone too.
      expect(await leftOf(`127.0.0.1:${port}`)).toEqual([]);
    },
    15_000
  );

  it.skipIf(!posix)(
    'kills the helpers git started even when nothing else would end them',
    async () => {
      // `ext::` runs a command as the transport, as git-remote-http is one; this one never ends,
      // inherits git's stderr, and so held the call open until it died (it did not, before).
      const marker = `987${process.pid}`;
      const started = Date.now();
      const result = await git(
        ['-c', 'protocol.ext.allow=always', 'ls-remote', `ext::sleep ${marker}`],
        { cwd, timeoutMs: 1000, allowFailure: true }
      );
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result).toMatchObject({ code: null, timedOut: true });
      expect(await leftOf(`sleep ${marker}`)).toEqual([]);
    },
    15_000
  );

  it.skipIf(!posix)('rejects a timeout in plain words unless failures are allowed', async () => {
    const marker = `986${process.pid}`;
    const err = await git(
      ['-c', 'protocol.ext.allow=always', 'ls-remote', `ext::sleep ${marker}`],
      {
        cwd,
        timeoutMs: 500,
      }
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toBe('git ls-remote timed out after 1 s');
    await leftOf(`sleep ${marker}`);
  });

  it.skipIf(!posix)(
    'ends on an abort the same way, and does not wait for the timeout',
    async () => {
      const marker = `985${process.pid}`;
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 300);
      const started = Date.now();
      const result = await git(
        ['-c', 'protocol.ext.allow=always', 'ls-remote', `ext::sleep ${marker}`],
        {
          cwd,
          timeoutMs: 60_000,
          signal: stop.signal,
          allowFailure: true,
        }
      );
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.code).toBeNull();
      expect(result.timedOut).toBeUndefined();
      expect(await leftOf(`sleep ${marker}`)).toEqual([]);
      // An abort that came first stops it before it starts.
      const early = new AbortController();
      early.abort();
      const none = await git(['--version'], { cwd, signal: early.signal, allowFailure: true });
      expect(none.code).not.toBe(0);
    }
  );
});
