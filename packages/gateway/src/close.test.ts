/**
 * `createGateway().close()`: what a daemon does on SIGTERM. It stops serving,
 * stops starting work, closes the store, and leaves a run in flight alone for
 * the next start to reclaim the way it reclaims a crashed gateway's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@clerq/store';
import { createGateway, type Gateway } from './gateway.js';
import { closeStore, getStore, isStoreOpen } from './store.js';
import { emit } from './events.js';
import { createRun, getRun, INTERRUPTED } from './runs.js';
import { createAutomation, ensureRepoRow, setAutomationEnabled } from './automations/store.js';

const TOKEN = 'close-test-token-0123456789abcdef';

let root: string;
let repo: string;
let savedKeychain: string | undefined;

beforeAll(() => {
  savedKeychain = process.env.CLERQ_KEYCHAIN;
  process.env.CLERQ_KEYCHAIN = 'off';
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-close-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
});

afterAll(() => {
  closeStore();
  fs.rmSync(root, { recursive: true, force: true });
  if (savedKeychain === undefined) delete process.env.CLERQ_KEYCHAIN;
  else process.env.CLERQ_KEYCHAIN = savedKeychain;
});

const start = (dbPath: string, extra: Parameters<typeof createGateway>[0] = {}): Gateway =>
  createGateway({
    port: 0,
    host: '127.0.0.1',
    authToken: TOKEN,
    dbPath,
    modulesDir: '/nonexistent-modules-dir-xyz',
    ...extra,
  });

const portOf = (g: Gateway): number => (g.server.address() as net.AddressInfo).port;
const get = (g: Gateway, route: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${portOf(g)}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });

/** A pid nobody holds: an owner that is gone. */
async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

/**
 * A request that is in flight: its head has been sent and its body is still
 * arriving, so the server has it under way and waits for it. `finish()` sends
 * the rest, and the answer is in `answer()` once the socket has closed.
 */
async function holdRequest(g: Gateway) {
  const socket = net.connect(portOf(g), '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  let received = '';
  socket.on('data', (chunk) => {
    received += String(chunk);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(
    'POST /v1/nothing HTTP/1.1\r\nHost: x\r\n' +
      `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
      'Content-Length: 7\r\nConnection: close\r\n\r\n{"a"'
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    finish: () => socket.write(':1}'),
    answer: async () => {
      await closed;
      return received;
    },
  };
}

let counter = 0;
function automationFor(): ReturnType<typeof createAutomation> {
  counter += 1;
  const created = createAutomation(
    [
      `name: close-${counter}`,
      'targets:',
      `  repos: [local:${repo}]`,
      'agent:',
      '  driver: claude-code',
      'prompt: nothing',
      'sandbox:',
      '  profile: native',
      'publish:',
      '  push: false',
    ].join('\n')
  );
  return setAutomationEnabled(created.id, true);
}

describe('close()', () => {
  it('stops listening, closes the store and leaves no write-ahead log behind', async () => {
    const file = path.join(root, 'plain', 'clerq.db');
    const g = start(file);
    await g.ready;
    expect((await get(g, '/v1/health')).status).toBe(200);
    expect(isStoreOpen()).toBe(true);
    const port = portOf(g);

    await g.close();

    expect(g.server.listening).toBe(false);
    expect(isStoreOpen()).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    // A clean close checkpoints the log and removes it.
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    // And the file is whole: another process can open it.
    const db = await openDatabase(file);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n).toBeGreaterThan(0);
    db.close();
  });

  it('is safe to call twice and gives the same answer', async () => {
    const g = start(path.join(root, 'twice', 'clerq.db'));
    await g.ready;
    const first = g.close();
    const second = g.close();
    expect(second).toBe(first);
    await first;
    await g.close();
    expect(isStoreOpen()).toBe(false);
  });

  it('ends an event stream at once, without waiting for the grace period', async () => {
    const g = start(path.join(root, 'sse', 'clerq.db'));
    await g.ready;
    // A request under way keeps the grace period running.
    const held = await holdRequest(g);
    const res = await get(g, '/v1/events/stream');
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();

    const began = Date.now();
    const closing = g.close({ graceMs: 5_000 });
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    const ended = await reader.read().then(
      (r) => r.done,
      () => true
    );
    expect(ended).toBe(true);
    expect(Date.now() - began).toBeLessThan(2_000);
    // The close itself still waits for the request under way.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    held.finish();
    await closing;
    expect(await held.answer()).toMatch(/^HTTP\/1\.1 404 /);
    expect(g.server.listening).toBe(false);
  });

  it('refuses a request that arrives once close has begun', async () => {
    const g = start(path.join(root, 'refuse', 'clerq.db'));
    await g.ready;
    const held = await holdRequest(g);
    const closing = g.close({ graceMs: 5_000 });
    // The same app on another listener stands for a request on a connection that was already open.
    const side = http.createServer(g.app);
    await new Promise<void>((resolve) => side.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(
        `http://127.0.0.1:${(side.address() as net.AddressInfo).port}/v1/runs`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }
      );
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.headers.get('connection')).toBe('close');
      expect(await res.json()).toMatchObject({ error: 'server_stopping' });
    } finally {
      await new Promise((resolve) => side.close(resolve));
      held.finish();
      await closing;
    }
  });

  it('does not start a queued run while it waits for a request in flight', async () => {
    const file = path.join(root, 'waiting', 'clerq.db');
    const g = start(file);
    await g.ready;
    const a = automationFor();
    // A run waiting for a slot that comes due 300 ms from now...
    const queued = createRun({
      trigger: 'schedule',
      automationId: a.id,
      status: 'queued',
      repoId: ensureRepoRow(a.spec!),
    });
    getStore()
      .prepare('UPDATE runs SET not_before = ? WHERE id = ?')
      .run(new Date(Date.now() + 300).toISOString(), queued);
    // ...which the queue is told about, so it will look again when it is due.
    emit('run.queued', {}, { runId: queued });

    // The close is held open by a request under way, well past that moment.
    const held = await holdRequest(g);
    const closing = g.close({ graceMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(getStore().prepare('SELECT status FROM runs WHERE id = ?').get(queued)).toEqual({
      status: 'queued',
    });
    held.finish();
    await closing;

    const seen = await openDatabase(file);
    expect(seen.prepare('SELECT status FROM runs WHERE id = ?').get(queued)).toEqual({
      status: 'queued',
    });
    seen.close();
  });

  it('lets a request that is in flight finish within the grace period', async () => {
    const g = start(path.join(root, 'inflight', 'clerq.db'));
    await g.ready;
    // A request whose body is still arriving when close() is called.
    const socket = net.connect(portOf(g), '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    let received = '';
    socket.on('data', (chunk) => {
      received += String(chunk);
    });
    socket.write(
      'POST /v1/nothing HTTP/1.1\r\nHost: x\r\n' +
        `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
        'Content-Length: 7\r\nConnection: close\r\n\r\n{"a"'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = g.close({ graceMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(g.server.listening).toBe(false);
    socket.write(':1}');
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    // Served, not cut off: the route does not exist, which is the answer a finished request gets.
    expect(received).toMatch(/^HTTP\/1\.1 404 /);
    await closing;
  });

  it('answers 503 to a request still unanswered when the grace period is over', async () => {
    const g = start(path.join(root, 'late', 'clerq.db'));
    await g.ready;
    const socket = net.connect(portOf(g), '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    let received = '';
    socket.on('data', (chunk) => {
      received += String(chunk);
    });
    // The body never finishes arriving.
    socket.write(
      'POST /v1/nothing HTTP/1.1\r\nHost: x\r\n' +
        `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
        'Content-Length: 50\r\n\r\n{"a"'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const began = Date.now();
    await g.close({ graceMs: 200 });
    expect(Date.now() - began).toBeLessThan(3_000);
    await new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      else socket.once('close', () => resolve());
    });
    expect(received).toMatch(/^HTTP\/1\.1 503 /);
    expect(received).toContain('server_stopping');
    expect(received).toMatch(/retry-after: 5/i);
  });

  it('when called before the gateway has started, nothing starts and ready says why', async () => {
    const file = path.join(root, 'early', 'clerq.db');
    const g = start(file);
    const closing = g.close();
    await expect(g.ready).rejects.toThrow('closed before it finished starting');
    await closing;
    expect(g.server.listening).toBe(false);
    expect(isStoreOpen()).toBe(false);
  });

  it('keeps a queued run queued and leaves a run in flight for the next start to reclaim', async () => {
    const file = path.join(root, 'runs', 'clerq.db');
    const first = start(file);
    await first.ready;

    const a = automationFor();
    const repoId = ensureRepoRow(a.spec!);
    // A run mid-way, owned by this process with its lease still good...
    const running = createRun({
      trigger: 'schedule',
      automationId: a.id,
      status: 'executing',
      repoId,
    });
    const lease = new Date(Date.now() + 60_000).toISOString();
    getStore()
      .prepare('UPDATE runs SET lease_until = ?, attempt = 1 WHERE id = ?')
      .run(lease, running);
    // ...and one waiting, held back by a backoff that ends while the gateway is closing.
    const queued = createRun({
      trigger: 'schedule',
      automationId: a.id,
      status: 'queued',
      repoId,
    });
    getStore()
      .prepare('UPDATE runs SET not_before = ? WHERE id = ?')
      .run(new Date(Date.now() + 300).toISOString(), queued);

    await first.close();
    // Past the queued run's backoff: a queue that was still going would have started it.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const seen = await openDatabase(file);
    const row = (id: string) =>
      seen
        .prepare('SELECT status, lease_until, exit_reason, owner_pid FROM runs WHERE id = ?')
        .get(id);
    expect(row(running)).toMatchObject({ status: 'executing', lease_until: lease });
    expect(row(running)?.exit_reason).toBeNull();
    expect(row(queued)).toMatchObject({ status: 'queued' });
    // Make the owner look gone, as it is once the process that closed has exited.
    seen
      .prepare('UPDATE runs SET owner_pid = ?, owner_start = NULL, lease_until = ? WHERE id = ?')
      .run(await deadPid(), new Date(Date.now() - 60_000).toISOString(), running);
    seen
      .prepare('UPDATE runs SET not_before = ? WHERE id = ?')
      .run(new Date(Date.now() + 3_600_000).toISOString(), queued);
    seen.close();

    // The next start settles it through the same recovery a crash gets.
    const second = start(file);
    await second.ready;
    const settled = getRun(running);
    expect(settled?.status).toBe('failed');
    expect(settled?.exitReason).toBe(INTERRUPTED);
    expect(getRun(queued)?.status).toBe('queued');
    await second.close();
  }, 30_000);
});

describe('a port that cannot be bound', () => {
  it('rejects ready with the reason instead of carrying on with nothing to serve', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const g = start(path.join(root, 'busy', 'clerq.db'), { port });
      await expect(g.ready).rejects.toThrow(/EADDRINUSE|address already in use/);
      expect(g.server.listening).toBe(false);
      expect(isStoreOpen()).toBe(false);
      // Closing what never opened is still fine.
      await g.close();
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });
});
