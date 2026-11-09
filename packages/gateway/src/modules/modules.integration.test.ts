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
