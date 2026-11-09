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
import { getStore } from '../store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(__dirname, '../../../module-sdk/examples/hello-world');
const TOKEN = 'modules-test-token-0123456789';
const VARS = [
  'HOME',
  'USERPROFILE',
  'CLERQ_KEYCHAIN',
  'CLERQ_VAULT_KEY',
  'CLERQ_MODULES_DIR',
  'CLERQ_LAUNCHCTL',
];

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
  // Sets things up, then fails: none of it may stay behind.
  const half = path.join(modulesDir, 'half-done');
  fs.mkdirSync(path.join(half, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(half, 'manifest.json'),
    JSON.stringify({ id: 'half-done', slug: 'half-done', name: 'Half', version: '0.1.0' })
  );
  fs.writeFileSync(
    path.join(half, 'dist', 'routes.js'),
    `export function register(ctx) {
  globalThis.__halfSeen = 0;
  ctx.events.subscribe('*', () => { globalThis.__halfSeen += 1; });
  ctx.inbox.onRespond(() => ({ fromHalf: true }));
  ctx.search.register(() => [{ ref: 'half-done:x:1', title: 'from half' }]);
  throw new Error('half done');
}
`
  );
  // Settings override the manifest's defaults.
  fs.mkdirSync(path.join(home, '.clerq', 'modules'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.clerq', 'modules', 'hello-world.json'),
    JSON.stringify({ greeting: 'Howdy' })
  );
  process.env.CLERQ_MODULES_DIR = modulesDir;
  // Never the real launchctl: this one knows no agents and records its calls.
  const fake = path.join(home, 'launchctl');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${home}/launchctl.log"\nexit 113\n`, {
    mode: 0o755,
  });
  process.env.CLERQ_LAUNCHCTL = fake;

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

  it('notifies through the bus and keeps the badge', async () => {
    const res = await api('/events/stream?names=notify.');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await api('/api/modules/hello-world/greetings', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ken' }),
    });
    let text = '';
    while (!(text.includes('notify.posted') && text.includes('notify.badge'))) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toMatch(/"name":"notify.posted".*"moduleId":"hello-world","title":"Greeted Ken"/);
    expect(text).toContain('"badge":"3"');
    const { modules } = (await (await api('/modules')).json()) as {
      modules: Array<{ id: string; badge: string | null }>;
    };
    expect(modules.find((m) => m.id === 'hello-world')?.badge).toBe('3');
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
    expect(run.steps[0].output).toEqual({ greetings: 3 });
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

describe('module tokens', () => {
  async function mint(id = 'hello-world', ttlSeconds?: number) {
    const res = await api(`/modules/${id}/token`, {
      method: 'POST',
      body: JSON.stringify({ ttlSeconds }),
    });
    return { status: res.status, body: (await res.json()) as { token: string; expiresAt: string } };
  }
  const as = (token: string, p: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${p}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });

  it("reaches the module's routes and the core endpoints its manifest declares, nothing else", async () => {
    const { status, body } = await mint();
    expect(status).toBe(201);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const t = body.token;
    expect((await as(t, '/api/modules/hello-world/hello')).status).toBe(200);
    expect((await as(t, '/runs')).status).toBe(200);
    expect((await as(t, '/approvals')).status).toBe(403);
    expect((await as(t, '/api/modules/broken/x')).status).toBe(403);
    expect((await as(t, '/secrets')).status).toBe(403);
    expect((await as(t, '/modules/hello-world/token', { method: 'POST' })).status).toBe(403);
    const stream = await fetch(`${baseUrl}/events/stream?token=${t}`);
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  });

  it('stops working once revoked', async () => {
    const { body } = await mint();
    await api('/modules/hello-world/tokens', { method: 'DELETE' });
    expect((await as(body.token, '/api/modules/hello-world/hello')).status).toBe(401);
  });

  it('answers 400 to a path that cannot be decoded', async () => {
    expect((await api('/runs/%E0%A4%A')).status).toBe(400);
  });

  it('is only issued for a loaded module', async () => {
    expect((await mint('broken')).status).toBe(404);
  });
});

describe('module UI', () => {
  it('serves dist/ui without a token, and nothing else under /ui', async () => {
    const index = await fetch(`${baseUrl}/api/modules/hello-world/ui/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await index.text()).toContain('<h1>Hello world</h1>');
    const js = await fetch(`${baseUrl}/api/modules/hello-world/ui/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${baseUrl}/api/modules/hello-world/ui/missing.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/modules/hello-world/ui/../greetings`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/modules/hello-world/ui/%2e%2e/greetings`)).status).not.toBe(
      200
    );
    expect((await fetch(`${baseUrl}/api/modules/hello-world/ui/`, { method: 'POST' })).status).toBe(
      401
    );
    expect((await fetch(`${baseUrl}/api/modules/broken/ui/`)).status).toBe(404);
  });

  it('lists where a module UI is', async () => {
    const { modules } = (await (await api('/modules')).json()) as {
      modules: Array<{ id: string; ui: string | null }>;
    };
    expect(modules.find((m) => m.id === 'hello-world')?.ui).toBe('/api/modules/hello-world/ui/');
    expect(modules.find((m) => m.id === 'broken')?.ui).toBeNull();
  });
});

describe('module services', () => {
  it(
    'reports the services the manifest declares, and refuses others',
    { timeout: 60_000 },
    async () => {
      const res = await api('/api/modules/hello-world/services');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        services: [
          {
            label: 'org.example.hello-world.worker',
            name: 'Example worker',
            loaded: false,
            running: false,
            pid: null,
            lastExitCode: null,
          },
        ],
      });
      const other = await api('/api/modules/hello-world/services/com.example.other/start', {
        method: 'POST',
      });
      expect(other.status).toBe(404);
      // Not loaded, and its plist is not on this machine: nothing is started.
      const start = await api(
        '/api/modules/hello-world/services/org.example.hello-world.worker/start',
        {
          method: 'POST',
        }
      );
      expect(start.status).toBe(502);
      expect(fs.readFileSync(path.join(home, 'launchctl.log'), 'utf8')).not.toMatch(
        /bootstrap|kickstart/
      );
    }
  );
});

describe('module permissions', () => {
  it('lists what a manifest declares, and records it in the audit log', async () => {
    const { modules } = (await (await api('/modules')).json()) as {
      modules: Array<{
        id: string;
        permissions: Record<string, unknown>;
        permissionWarnings: string[];
      }>;
    };
    const hello = modules.find((m) => m.id === 'hello-world')!;
    expect(hello.permissions).toEqual({
      exec: [],
      fs: { read: [], write: [] },
      net: [],
      secrets: ['token'],
      services: ['org.example.hello-world.worker'],
      llm: false,
    });
    expect(hello.permissionWarnings).toEqual([]);
    const row = getStore()
      .prepare(
        "SELECT detail FROM audit_log WHERE action = 'module.installed' AND subject = 'hello-world'"
      )
      .get();
    expect(JSON.parse(String(row?.detail)).permissions.secrets).toEqual(['token']);
  });
});

describe('shared records', () => {
  it('resolves a person once, whoever asks, and refuses a conflict', async () => {
    const first = await api('/records/resolve', {
      method: 'POST',
      body: JSON.stringify({ type: 'person', name: 'Barbara', emails: ['barbara@example.org'] }),
    });
    expect(first.status).toBe(201);
    const { record } = (await first.json()) as { record: { id: string; ref: string } };

    // A module greets the same person by email: same record, linked from the module's own ref.
    await api('/api/modules/hello-world/greetings', {
      method: 'POST',
      body: JSON.stringify({ name: 'Barbara', email: 'BARBARA@example.org' }),
    });
    const got = (await (await api(`/records/${record.id}`)).json()) as {
      links: Array<{ from: string; kind: string }>;
    };
    expect(got.links).toHaveLength(2);
    expect(got.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: expect.stringMatching(/^hello-world:greeting:\d+$/),
          kind: 'greeted',
        }),
        expect.objectContaining({
          from: expect.stringMatching(/^core:activity:act_/),
          kind: 'about',
        }),
      ])
    );
    const { activities } = (await (await api(`/records/${record.id}/activities`)).json()) as {
      activities: Array<{ name: string; createdBy: string }>;
    };
    expect(activities).toMatchObject([
      { name: 'Greeted Barbara', createdBy: 'module:hello-world' },
    ]);

    await api('/records', {
      method: 'POST',
      body: JSON.stringify({ type: 'person', emails: ['other@example.org'] }),
    });
    const conflict = await api('/records/resolve', {
      method: 'POST',
      body: JSON.stringify({
        type: 'person',
        emails: ['barbara@example.org', 'other@example.org'],
      }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { candidates: unknown[] }).candidates).toHaveLength(2);
  });
});

describe('extensions and search', () => {
  it('aggregates extension points across modules', async () => {
    const all = (await (await api('/extensions')).json()) as Record<
      string,
      Array<{ moduleId: string; id: string }>
    >;
    expect(all.nav).toEqual([
      { moduleId: 'hello-world', id: 'main', title: 'Hello world', path: '/' },
    ]);
    expect(all['record.panel'][0]).toMatchObject({
      moduleId: 'hello-world',
      types: ['core:person'],
    });
    expect(all['settings.page']).toEqual([]);
  });

  it('searches core records and modules together', async () => {
    const res = await api('/search?q=barbara');
    const { results, errors } = (await res.json()) as {
      results: Array<{ ref: string; moduleId: string; title: string; score: number }>;
      errors: unknown[];
    };
    expect(errors).toEqual([]);
    expect(results[0]).toMatchObject({ moduleId: 'core', title: 'Barbara', score: 0.8 });
    expect(
      results.some((r) => r.moduleId === 'hello-world' && r.title === 'Greeting for Barbara')
    ).toBe(true);
    const only = (await (await api('/search?q=barbara&types=hello-world:greeting')).json()) as {
      results: Array<{ moduleId: string }>;
    };
    expect(only.results.every((r) => r.moduleId === 'hello-world')).toBe(true);
    expect((await api('/search')).status).toBe(400);
  });
});

describe('inbox', () => {
  it('lists module items and pending approvals together', async () => {
    const asked = await api('/api/modules/hello-world/approval', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Please' }),
    });
    expect(asked.status).toBe(202);
    const { approvalId } = (await asked.json()) as { approvalId: number };

    const { items } = (await (await api('/inbox')).json()) as {
      items: Array<{
        id: string;
        kind: string;
        title: string;
        moduleId: string | null;
        ref: string | null;
      }>;
    };
    expect(items.find((i) => i.id === `apr_${approvalId}`)).toMatchObject({
      kind: 'approval',
      title: 'Approve hello-world.demo',
    });
    const task = items.find((i) => i.title === 'Follow up with Barbara')!;
    expect(task).toMatchObject({ kind: 'task', moduleId: 'hello-world' });
    expect(task.ref).toMatch(/^core:person:per_/);

    // An approval is decided where it always was.
    expect(
      (await api(`/inbox/items/apr_${approvalId}`, { method: 'PATCH', body: '{}' })).status
    ).toBe(400);
    await api(`/approvals/${approvalId}/approve`, { method: 'POST', body: '{}' });
    const after = (await (await api('/inbox?kind=approval')).json()) as { items: unknown[] };
    expect(after.items).toEqual([]);
  });

  it('hands a response to the module and closes the item', async () => {
    const { items } = (await (await api('/inbox?module=hello-world')).json()) as {
      items: Array<{ id: string; ref: string }>;
    };
    const res = await api(`/inbox/items/${items[0].id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Called back' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      item: { status: 'done', resolvedBy: 'operator' },
      result: { noted: true },
    });
    const personId = items[0].ref.split(':')[2];
    const { activities } = (await (await api(`/records/${personId}/activities`)).json()) as {
      activities: Array<{ name: string }>;
    };
    expect(activities[0].name).toBe('Called back');
  });

  it('adds and dismisses an item over HTTP', async () => {
    const created = await api('/inbox/items', {
      method: 'POST',
      body: JSON.stringify({ kind: 'alert', title: 'Disk nearly full', priority: 5 }),
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string };
    const dismissed = await api(`/inbox/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'dismissed' }),
    });
    expect(await dismissed.json()).toMatchObject({ status: 'dismissed' });
    expect(
      (await api(`/inbox/items/${item.id}/respond`, { method: 'POST', body: '{}' })).status
    ).toBe(409);
    expect(
      (
        await api('/inbox/items', {
          method: 'POST',
          body: JSON.stringify({ kind: 'nag', title: 'x' }),
        })
      ).status
    ).toBe(400);
  });
});

describe('tenants', () => {
  const inTenant = (tenant: string, p: string, init: RequestInit = {}) =>
    api(p, { ...init, headers: { 'X-Clerq-Tenant': tenant, ...init.headers } });

  it("keeps a module's rows and the shared records apart per tenant", async () => {
    await inTenant('acme', '/api/modules/hello-world/greetings', {
      method: 'POST',
      body: JSON.stringify({ name: 'Wile', email: 'barbara@example.org' }),
    });
    const acme = (await (await inTenant('acme', '/api/modules/hello-world/greetings')).json()) as {
      greetings: Array<{ name: string }>;
    };
    expect(acme.greetings.map((g) => g.name)).toEqual(['Wile']);
    const plain = (await (await api('/api/modules/hello-world/greetings')).json()) as {
      greetings: Array<{ name: string }>;
    };
    expect(plain.greetings.map((g) => g.name)).not.toContain('Wile');

    // The same email is a different person in each tenant.
    const inAcme = (await (await inTenant('acme', '/records?q=barbara@example.org')).json()) as {
      records: Array<{ id: string; name: string; tenantId: string }>;
    };
    const inDefault = (await (await api('/records?q=barbara@example.org')).json()) as {
      records: Array<{ id: string; name: string }>;
    };
    expect(inAcme.records).toMatchObject([{ name: 'Wile', tenantId: 'acme' }]);
    expect(inDefault.records).toMatchObject([{ name: 'Barbara' }]);
    expect(inAcme.records[0].id).not.toBe(inDefault.records[0].id);
    const acmeInbox = (await (await inTenant('acme', '/inbox')).json()) as {
      items: Array<{ title: string }>;
    };
    expect(acmeInbox.items.map((i) => i.title)).toEqual(['Follow up with Wile']);
  });

  it('binds a module token to the tenant it was issued in', async () => {
    const minted = await inTenant('acme', '/modules/hello-world/token', {
      method: 'POST',
      body: '{}',
    });
    const { token, tenantId } = (await minted.json()) as { token: string; tenantId: string };
    expect(tenantId).toBe('acme');
    const as = (headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}/api/modules/hello-world/greetings`, {
        headers: { Authorization: `Bearer ${token}`, ...headers },
      });
    const own = (await (await as()).json()) as { greetings: Array<{ name: string }> };
    expect(own.greetings.map((g) => g.name)).toEqual(['Wile']);
    expect((await as({ 'X-Clerq-Tenant': 'default' })).status).toBe(403);
    expect((await inTenant('Not Valid', '/runs')).status).toBe(400);
  });
});

describe('a module that fails part-way', () => {
  it('leaves no subscriptions, search handler or inbox handler behind', async () => {
    const { modules } = (await (await api('/modules')).json()) as {
      modules: Array<{ id: string; status: string }>;
    };
    expect(modules.find((m) => m.id === 'half-done')?.status).toBe('failed');
    const seen = (globalThis as { __halfSeen?: number }).__halfSeen;
    await api('/kill', { method: 'POST', body: JSON.stringify({ approvals: false, runs: false }) });
    await api('/resume', { method: 'POST' });
    expect((globalThis as { __halfSeen?: number }).__halfSeen).toBe(seen);
    const { results } = (await (await api('/search?q=from')).json()) as {
      results: Array<{ moduleId: string }>;
    };
    expect(results.some((r) => r.moduleId === 'half-done')).toBe(false);
  });
});

describe('service audit', () => {
  it("records the module's UI token as the actor, not the operator", async () => {
    const { token } = (await (
      await api('/modules/hello-world/token', { method: 'POST', body: '{}' })
    ).json()) as { token: string };
    const res = await fetch(
      `${baseUrl}/api/modules/hello-world/services/org.example.hello-world.worker/stop`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const row = getStore()
      .prepare(
        "SELECT actor FROM audit_log WHERE action = 'module.hello-world.service.stop' ORDER BY id DESC"
      )
      .get();
    expect(row?.actor).toBe('module:hello-world');
  }, 60_000);
});
