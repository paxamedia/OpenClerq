/**
 * The module platform end to end, through the example hello-world module in
 * packages/module-sdk/examples, loaded from a path the way CLERQ_MODULES_DIR
 * names one.
 *
 * HOME points at a scratch directory, so the vault, module config and tokens
 * never touch the developer's ~/.clerq; the store is in memory.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(__dirname, '../../../module-sdk/examples/hello-world');
const TOKEN = 'modules-test-token-0123456789';
const VARS = ['HOME', 'USERPROFILE', 'CLERQ_KEYCHAIN', 'CLERQ_VAULT_KEY', 'CLERQ_MODULES_DIR'];

let baseUrl = '';
let home = '';
let server: { close: (cb?: () => void) => void };
const saved: Record<string, string | undefined> = {};

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });

beforeAll(async () => {
  for (const v of VARS) saved[v] = process.env[v];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-modules-'));
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  delete process.env.CLERQ_VAULT_KEY;
  process.env.CLERQ_KEYCHAIN = 'off';

  // Modules as a user would install them: a directory of module directories.
  const modulesDir = path.join(home, 'modules');
  fs.cpSync(EXAMPLE, path.join(modulesDir, 'hello-world'), { recursive: true });
  const broken = path.join(modulesDir, 'broken');
  fs.mkdirSync(path.join(broken, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(broken, 'manifest.json'),
    JSON.stringify({ id: 'broken', slug: 'broken', name: 'Broken', version: '0.1.0' })
  );
  fs.writeFileSync(
    path.join(broken, 'dist', 'routes.js'),
    "export function register() { throw new Error('cannot start'); }\n"
  );
  const trespasser = path.join(modulesDir, 'trespasser');
  fs.mkdirSync(path.join(trespasser, 'migrations'), { recursive: true });
  fs.writeFileSync(
    path.join(trespasser, 'manifest.json'),
    JSON.stringify({ id: 'trespasser', slug: 'trespasser', name: 'T', version: '0.1.0' })
  );
  fs.writeFileSync(path.join(trespasser, 'migrations', '0001_x.sql'), 'DROP TABLE runs;');
  // Settings override the manifest's defaults.
  fs.mkdirSync(path.join(home, '.clerq', 'modules'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.clerq', 'modules', 'hello-world.json'),
    JSON.stringify({ greeting: 'Howdy' })
  );
  process.env.CLERQ_MODULES_DIR = modulesDir;

  const gw = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    skillsDir: path.join(home, 'skills'),
  });
  server = gw.server;
  await gw.ready;
  const addr = gw.server.address();
  baseUrl = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('module context', () => {
  it('lists modules, and keeps going past one that fails to register', async () => {
    const res = await api('/modules');
    const { modules } = (await res.json()) as {
      modules: Array<{ id: string; status: string; error: string | null }>;
    };
    expect(modules.find((m) => m.id === 'hello-world')?.status).toBe('loaded');
    expect(modules.find((m) => m.id === 'broken')).toMatchObject({
      status: 'failed',
      error: 'cannot start',
    });
    expect((await api('/api/modules/broken/anything')).status).toBe(404);
  });

  it("serves a module's routes with its config", async () => {
    const res = await api('/api/modules/hello-world/hello?name=Ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Howdy, Ada' });
  });

  it("runs a module's migrations and lets it use its tables", async () => {
    const post = await api('/api/modules/hello-world/greetings', {
      method: 'POST',
      body: JSON.stringify({ name: 'Grace' }),
    });
    expect(post.status).toBe(201);
    const { greetings } = (await (await api('/api/modules/hello-world/greetings')).json()) as {
      greetings: Array<{ name: string }>;
    };
    expect(greetings.map((g) => g.name)).toEqual(['Grace']);
  });

  it('puts module events on the bus under module.<id>.', async () => {
    const res = await api('/events/stream?names=module.hello-world.');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await api('/api/modules/hello-world/greetings', {
      method: 'POST',
      body: JSON.stringify({ name: 'Linus' }),
    });
    let text = '';
    while (!text.includes('"name":"module.hello-world.greeted"')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain('"payload":{"name":"Linus"}');
  });

  it('fails a module whose migration touches tables it does not own', async () => {
    const { modules } = (await (await api('/modules')).json()) as {
      modules: Array<{ id: string; status: string; error: string | null }>;
    };
    expect(modules.find((m) => m.id === 'trespasser')).toMatchObject({ status: 'failed' });
    expect(modules.find((m) => m.id === 'trespasser')?.error).toMatch(/mod_trespasser_/);
  });

  it('requires the gateway token on module routes', async () => {
    expect((await fetch(`${baseUrl}/api/modules/hello-world/hello`)).status).toBe(401);
  });

  it('keeps module secrets under the module id', async () => {
    const put = await api('/api/modules/hello-world/token', {
      method: 'PUT',
      body: JSON.stringify({ value: 's3cret' }),
    });
    expect(put.status).toBe(200);
    expect(await (await api('/api/modules/hello-world/token')).json()).toEqual({
      set: true,
      names: ['token'],
    });
    const { secrets } = (await (await api('/secrets')).json()) as { secrets: string[] };
    expect(secrets).toContain('hello-world/token');
  });
});

describe('module triggers', () => {
  async function waitForRun(id: string) {
    for (let i = 0; i < 100; i++) {
      const run = (await (await api(`/runs/${id}`)).json()) as {
        status: string;
        moduleId?: string;
        triggerId?: string;
        trigger: string;
        exitReason?: string;
        steps: Array<{ kind: string; output?: unknown }>;
      };
      if (['done', 'failed', 'cancelled'].includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`run ${id} did not finish`);
  }

  it('lists triggers with the next cron firing', async () => {
    const { modules } = (await (await api('/modules')).json()) as {
      modules: Array<{
        id: string;
        triggers: Array<{ id: string; kind: string; nextRunAt: string | null }>;
      }>;
    };
    const triggers = modules.find((m) => m.id === 'hello-world')!.triggers;
    expect(triggers.map((t) => t.id).sort()).toEqual(['count', 'nightly']);
    expect(new Date(triggers.find((t) => t.id === 'nightly')!.nextRunAt!).getHours()).toBe(3);
  });

  it('records a webhook firing as a run of the module, with its result', async () => {
    const res = await api('/api/modules/hello-world/triggers/count', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const run = await waitForRun(runId);
    expect(run).toMatchObject({
      status: 'done',
      trigger: 'webhook',
      moduleId: 'hello-world',
      triggerId: 'count',
    });
    expect(run.steps[0].output).toEqual({ greetings: 2 });
  });

  it('records a handler that throws as a failed run', async () => {
    const res = await api('/api/modules/hello-world/triggers/count', {
      method: 'POST',
      body: JSON.stringify({ fail: true }),
    });
    const run = await waitForRun(((await res.json()) as { runId: string }).runId);
    expect(run).toMatchObject({ status: 'failed', exitReason: 'Asked to fail.' });
  });

  it('fires a cron trigger by hand, 404s an unknown one, and pauses under the kill switch', async () => {
    const manual = await api('/api/modules/hello-world/triggers/nightly', { method: 'POST' });
    const run = await waitForRun(((await manual.json()) as { runId: string }).runId);
    expect(run).toMatchObject({ status: 'done', trigger: 'manual' });
    expect((await api('/api/modules/hello-world/triggers/nope', { method: 'POST' })).status).toBe(
      404
    );

    await api('/kill', { method: 'POST', body: JSON.stringify({ approvals: false, runs: false }) });
    const paused = await api('/api/modules/hello-world/triggers/count', { method: 'POST' });
    expect(paused.status).toBe(503);
    await api('/resume', { method: 'POST' });
    expect(
      (await api('/api/modules/hello-world/triggers/count', { method: 'POST', body: '{}' })).status
    ).toBe(202);
  });
});
