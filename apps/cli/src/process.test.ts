/**
 * The built command line as a real process: the entry point, its exit codes
 * and the limit on waiting for a gateway. Needs `pnpm build` first (the workspace
 * build does it); without it the tests are skipped locally and fail under CI.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, '..', 'dist', 'main.js');
const runnable = fs.existsSync(MAIN) || Boolean(process.env.CI);

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-proc-')));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

/** Run `clerq <args>` to the end, with a minimal environment of its own. */
function clerq(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!runnable)('the clerq program', () => {
  it('prints its version and the API version, exit 0', async () => {
    const r = await clerq(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^clerq \d+\.\d+\.\d+ \(API version 1\)\n$/);
  });

  it('prints help, exit 0, and a usage mistake with exit 64 on stderr', async () => {
    const help = await clerq(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: clerq <command> [options]');
    const bad = await clerq(['nope']);
    expect(bad.code).toBe(64);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('Unknown command "nope"');
  });

  it('exits 3 when nothing answers', async () => {
    const r = await clerq(['status', '--gateway', 'http://127.0.0.1:9']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Cannot reach the gateway at http://127.0.0.1:9');
  });

  it('gives up on a gateway that accepts a connection and never answers', async () => {
    const hung = http.createServer(() => undefined);
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
      const started = Date.now();
      const r = await clerq(['status', '--gateway', url], { CLERQ_TIMEOUT: '1' });
      expect(r.code).toBe(3);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });

  it('does not read a .env or a bunfig from the folder it is run in', async () => {
    fs.writeFileSync(
      path.join(home, '.env'),
      'CLERQ_GATEWAY_URL=http://127.0.0.1:9\nCLERQ_GATEWAY_TOKEN=decoy-token-0123456789\n'
    );
    const r = await clerq(['status', '--json', '--gateway', 'http://127.0.0.1:8']);
    expect(r.stdout + r.stderr).not.toContain('decoy-token');
    fs.rmSync(path.join(home, '.env'));
  });
});
