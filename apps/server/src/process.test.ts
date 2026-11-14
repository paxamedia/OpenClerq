/**
 * The built server as a real process: start-up, the token, the settings it
 * reads, a clean stop on SIGTERM and SIGINT, and what a stop leaves for the
 * next start. Needs `pnpm build` first (the workspace build does it); without
 * it the tests are skipped locally and fail under CI.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@clerq/store';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, '..', 'dist', 'main.js');
const GATEWAY = path.resolve(here, '..', '..', '..', 'packages', 'gateway', 'dist', 'index.js');
const built = fs.existsSync(MAIN) && fs.existsSync(GATEWAY);
const runnable = built || Boolean(process.env.CI);
const isWindows = process.platform === 'win32';

let root: string;
const running: ChildProcess[] = [];

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-server-proc-')));
});

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function newHome(): string {
  return fs.mkdtempSync(path.join(root, 'home-'));
}

interface Launched {
  child: ChildProcess;
  output(): string;
  /** Resolves once the server logs "Ready"; rejects if it exits first. */
  ready: Promise<void>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launch(options: {
  home: string;
  env?: Record<string, string>;
  args?: string[];
  cwd?: string;
}): Launched {
  const child = spawn(process.execPath, [MAIN, ...(options.args ?? [])], {
    cwd: options.cwd ?? root,
    // Nothing of the developer's own CLERQ_* settings leaks into the test.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: options.home,
      CLERQ_KEYCHAIN: 'off',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let text = '';
  const onData = (chunk: Buffer) => {
    text += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const ready = new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (text.includes('] Ready')) {
        clearInterval(poll);
        resolve();
      }
    }, 20);
    void exit.then(() => {
      clearInterval(poll);
      reject(new Error(`the server exited before it was ready:\n${text}`));
    });
  });
  ready.catch(() => undefined);
  return { child, output: () => text, ready, exit };
}

/** Run a command to the end. */
async function runOnce(args: string[], env: Record<string, string> = {}, home = newHome()) {
  const l = launch({ home, args, env });
  const { code } = await l.exit;
  return { code, output: l.output() };
}

const get = (port: number, route: string, token?: string) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe.skipIf(!runnable)('clerq-server commands', () => {
  it('prints the release, the API version and the store schema', async () => {
    const r = await runOnce(['version']);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/^clerq-server \d+\.\d+\.\d+/);
    expect(r.output).toMatch(/API version: 1 \(supported: 1\)/);
    expect(r.output).toMatch(/Store schema: \d+/);
    const json = JSON.parse((await runOnce(['version', '--json'])).output);
    expect(json).toMatchObject({ api: { version: 1, supported: [1] } });
    expect(json.store.schema).toBeGreaterThanOrEqual(21);
  });

  it('prints help and exits 0; an unknown command exits 2 and starts nothing', async () => {
    const help = await runOnce(['--help']);
    expect(help.code).toBe(0);
    expect(help.output).toContain('Usage: clerq-server');
    const bad = await runOnce(['frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.output).toContain('Unknown command "frobnicate"');
  });

  it('exits 1 from healthcheck when nothing is listening, naming the address', async () => {
    const port = await freePort();
    const r = await runOnce(['healthcheck'], { CLERQ_PORT: String(port) });
    expect(r.code).toBe(1);
    expect(r.output).toContain('unhealthy');
    expect(r.output).toContain(`127.0.0.1:${port}`);
  });

  it('exits 2 for a port that is not a port, before opening anything', async () => {
    const home = newHome();
    const r = await runOnce([], { CLERQ_PORT: 'eighty' }, home);
    expect(r.code).toBe(2);
    expect(r.output).toContain('CLERQ_PORT must be');
    expect(fs.existsSync(path.join(home, '.clerq', 'clerq.db'))).toBe(false);
  });
});

describe.skipIf(!runnable || isWindows)('clerq-server running', () => {
  it('serves, keeps the token to itself, answers healthcheck, and stops on SIGTERM with 0', async () => {
    const home = newHome();
    const port = await freePort();
    const token = 'env-token-0123456789abcdef0123456789abcdef';
    const env = { CLERQ_PORT: String(port), CLERQ_GATEWAY_TOKEN: token };
    const server = launch({ home, env });
    await server.ready;

    // Public without a token; protected with none; open with the right one.
    const health = await get(port, '/v1/health');
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    const version = await get(port, '/v1/version');
    expect(version.status).toBe(200);
    expect(await version.json()).toMatchObject({
      api: { version: 1 },
      store: { schema: expect.any(Number) },
    });
    expect((await get(port, '/v1/runs')).status).toBe(401);
    expect((await get(port, '/v1/runs', 'wrong-token')).status).toBe(401);
    expect((await get(port, '/v1/runs', token)).status).toBe(200);

    // The health check subcommand agrees.
    const check = await runOnce(['healthcheck'], env);
    expect(check.code).toBe(0);
    expect(check.output).toContain('ok');

    // What it says about itself.
    const out = server.output();
    expect(out).toMatch(/OpenClerq server \d+\.\d+\.\d+ \(API version 1/);
    expect(out).toContain(`Listening on http://127.0.0.1:${port}`);
    expect(out).toContain(`Data directory: ${path.join(home, '.clerq')}`);
    expect(out).toContain('Gateway token: from CLERQ_GATEWAY_TOKEN');
    expect(out).not.toContain(token);

    // An event stream never ends by itself; the stop has to end it.
    const stream = await fetch(`http://127.0.0.1:${port}/v1/events/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const streamEnded = reader.read().then(
      (r) => r.done,
      () => true
    );

    const began = Date.now();
    server.child.kill('SIGTERM');
    const { code, signal } = await server.exit;
    expect(await streamEnded).toBe(true);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    // The open event stream ends at once; it does not hold the stop up.
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(server.output()).toContain('Received SIGTERM');
    expect(server.output()).toContain('] Stopped');
    expect(server.output()).not.toContain(token);
    await expect(get(port, '/v1/health')).rejects.toThrow();
    // The store was closed cleanly: no log left beside the database.
    expect(fs.existsSync(path.join(home, '.clerq', 'clerq.db-wal'))).toBe(false);
  });

  it('stops on SIGINT with 0 as well', async () => {
    const port = await freePort();
    const server = launch({ home: newHome(), env: { CLERQ_PORT: String(port) } });
    await server.ready;
    server.child.kill('SIGINT');
    expect(await server.exit).toEqual({ code: 0, signal: null });
  });

  it('makes its own token, 0600, tells where it is and never prints it', async () => {
    const home = newHome();
    const port = await freePort();
    const server = launch({ home, env: { CLERQ_PORT: String(port) } });
    await server.ready;
    const file = path.join(home, '.clerq', 'gateway-token');
    const token = fs.readFileSync(file, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(server.output()).toContain(`generated at ${file}`);
    expect(server.output()).not.toContain(token);
    expect((await get(port, '/v1/runs', token)).status).toBe(200);
    server.child.kill('SIGTERM');
    await server.exit;

    // The second start uses it and says where it is.
    const again = launch({ home, env: { CLERQ_PORT: String(port) } });
    await again.ready;
    expect(again.output()).toContain(`Gateway token: in ${file}`);
    expect(again.output()).not.toContain(token);
    again.child.kill('SIGTERM');
    await again.exit;
  });

  it("reads ~/.clerq/.env, not the working directory's, and the environment wins over it", async () => {
    const home = newHome();
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const filePort = await freePort();
    const envPort = await freePort();
    fs.mkdirSync(path.join(home, '.clerq'), { recursive: true });
    fs.writeFileSync(path.join(home, '.clerq', '.env'), `CLERQ_PORT=${filePort}\n`);
    fs.writeFileSync(
      path.join(cwd, '.env'),
      'CLERQ_PORT=1\nCLERQ_GATEWAY_TOKEN=token-from-the-working-directory-0123456789\n'
    );

    // The home file sets the port; the working directory's file is ignored.
    const a = launch({ home, cwd });
    await a.ready;
    expect(a.output()).toContain(`Listening on http://127.0.0.1:${filePort}`);
    expect(a.output()).toContain('Gateway token: generated');
    expect(
      (await get(filePort, '/v1/runs', 'token-from-the-working-directory-0123456789')).status
    ).toBe(401);
    a.child.kill('SIGTERM');
    await a.exit;

    // A variable in the environment beats the file.
    const b = launch({ home, cwd, env: { CLERQ_PORT: String(envPort) } });
    await b.ready;
    expect(b.output()).toContain(`Listening on http://127.0.0.1:${envPort}`);
    b.child.kill('SIGTERM');
    await b.exit;

    // And healthcheck reads the same file.
    const c = launch({ home, cwd });
    await c.ready;
    expect((await runOnce(['healthcheck'], {}, home)).code).toBe(0);
    c.child.kill('SIGTERM');
    await c.exit;
  });

  it('warns when it is bound beyond loopback', async () => {
    const port = await freePort();
    const server = launch({
      home: newHome(),
      env: { CLERQ_PORT: String(port), CLERQ_HOST: '0.0.0.0' },
    });
    await server.ready;
    expect(server.output()).toMatch(/\[WARN\] Bound to 0\.0\.0\.0/);
    expect(
      (await runOnce(['healthcheck'], { CLERQ_PORT: String(port), CLERQ_HOST: '0.0.0.0' })).code
    ).toBe(0);
    server.child.kill('SIGTERM');
    expect((await server.exit).code).toBe(0);
  });

  it('answers healthcheck for CLERQ_HOST=localhost, whichever loopback address that names', async () => {
    const port = await freePort();
    const env = { CLERQ_PORT: String(port), CLERQ_HOST: 'localhost' };
    const server = launch({ home: newHome(), env });
    await server.ready;
    const check = await runOnce(['healthcheck'], env);
    expect({ code: check.code, output: check.output }).toMatchObject({ code: 0 });
    server.child.kill('SIGTERM');
    expect((await server.exit).code).toBe(0);
  });

  it('exits 1 with the reason when the port is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const server = launch({ home: newHome(), env: { CLERQ_PORT: String(port) } });
      expect((await server.exit).code).toBe(1);
      expect(server.output()).toContain('Not started');
      expect(server.output()).toMatch(/EADDRINUSE|address already in use/);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it('exits 1 on a database from a newer OpenClerq, with the reason', async () => {
    const home = newHome();
    const port = await freePort();
    // Run once to make a database, then claim it was written by a later version.
    const first = launch({ home, env: { CLERQ_PORT: String(port) } });
    await first.ready;
    first.child.kill('SIGTERM');
    await first.exit;
    const file = path.join(home, '.clerq', 'clerq.db');
    const db = await openDatabase(file);
    db.prepare("INSERT INTO schema_migrations VALUES (9999, 'from_the_future', 'x')").run();
    db.close();

    const second = launch({ home, env: { CLERQ_PORT: String(port) } });
    expect((await second.exit).code).toBe(1);
    expect(second.output()).toContain('Not started');
    expect(second.output()).toContain('written by a newer OpenClerq');
  });

  it('leaves a run in flight and a queued run alone on SIGTERM; the next start settles the first', async () => {
    const home = newHome();
    const port = await freePort();
    const token = 'run-token-0123456789abcdef0123456789abcdef';
    const env = { CLERQ_PORT: String(port), CLERQ_GATEWAY_TOKEN: token };
    const first = launch({ home, env });
    await first.ready;

    // A run the server is "working on" (owned by it, lease good) and one waiting.
    const file = path.join(home, '.clerq', 'clerq.db');
    const db = await openDatabase(file);
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO runs (id, status, trigger, created_at, started_at, owner_pid, lease_until)
       VALUES (?, ?, 'manual', ?, ?, ?, ?)`
    );
    insert.run(
      'run_inflight',
      'executing',
      now,
      now,
      first.child.pid as number,
      new Date(Date.now() + 60_000).toISOString()
    );
    insert.run('run_waiting', 'queued', now, null, null, null);
    db.close();

    first.child.kill('SIGTERM');
    expect(await first.exit).toEqual({ code: 0, signal: null });

    // Nothing was written to either run by the stop.
    const after = await openDatabase(file);
    expect(after.prepare("SELECT status FROM runs WHERE id = 'run_inflight'").get()).toEqual({
      status: 'executing',
    });
    expect(after.prepare("SELECT status FROM runs WHERE id = 'run_waiting'").get()).toEqual({
      status: 'queued',
    });
    after.close();

    // The next start reclaims the first through the recovery a crash gets. (The waiting row
    // has no automation, which the queue then fails; that is its rule, not the stop's.)
    const second = launch({ home, env });
    await second.ready;
    const run = await (await get(port, '/v1/runs/run_inflight', token)).json();
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Interrupted/);
    second.child.kill('SIGTERM');
    expect((await second.exit).code).toBe(0);
  });
});
