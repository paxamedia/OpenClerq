/**
 * Enforcement: what a plugin does through its context is checked against what it
 * declared when the person has turned that on, and only audited when they have not.
 * Every checked surface runs in both modes against the same plugin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  auditRows,
  listPlugins,
  scratch,
  seedEnforce,
  sleep,
  startGateway,
  writePlugin,
  type Running,
  type Scratch,
} from './plugins.harness.js';

let s: Scratch;
let running: Running | undefined;
let roots: { read: string; write: string; outside: string };
let seen: string[];

beforeEach(() => {
  s = scratch();
  const make = (name: string) => {
    const dir = path.join(s.home, name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  roots = { read: make('readable'), write: make('writable'), outside: make('outside') };
  fs.writeFileSync(path.join(roots.read, 'a.txt'), 'inside');
  fs.writeFileSync(path.join(roots.outside, 'secret.txt'), 'outside');
  seen = [];
});

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = undefined;
  s.cleanup();
});

/** A `fetch` that answers from a table and records what it was asked. */
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  seen.push(`${init?.method ?? 'GET'} ${url}`);
  if (url === 'https://api.example.com/to-evil') {
    return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } });
  }
  if (url === 'https://api.example.com/to-cdn') {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://a.cdn.example.org/y' },
    });
  }
  return new Response('answer', { status: 200 });
}) as typeof fetch;

/** A route per helper, so a test can try each from outside. */
const TRY = `
  register(ctx) {
    const attempt = (name, fn) => ctx.routes.get('/try/' + name, async (req, res) => {
      try {
        res.json({ ok: true, value: await fn(req.query) });
      } catch (e) {
        res.json({ ok: false, name: e.name, code: e.code, permission: e.permission, subject: e.subject, message: String(e.message) });
      }
    });
    attempt('secret-get', (q) => ctx.secrets.get(q.name));
    attempt('secret-set', (q) => { ctx.secrets.set(q.name, 'value'); return true; });
    attempt('secret-delete', (q) => { ctx.secrets.delete(q.name); return true; });
    attempt('secret-list', () => ctx.secrets.list());
    attempt('service-status', async (q) => (await ctx.services.status(q.label)).label);
    attempt('service-list', () => ctx.services.list().map((x) => x.label));
    attempt('exec', async (q) => {
      const r = await ctx.exec(q.cmd, q.args ? q.args.split(',') : [], { timeoutMs: q.ms ? Number(q.ms) : 5000 });
      return { code: r.code, stdout: r.stdout.trim(), timedOut: r.timedOut, signal: r.signal };
    });
    attempt('fetch', async (q) => (await ctx.fetch(q.url, q.redirect ? { redirect: q.redirect } : {})).status);
    attempt('read', (q) => ctx.fs.readFile(q.path, 'utf8'));
    attempt('write', async (q) => { await ctx.fs.writeFile(q.path, 'written'); return true; });
    ctx.routes.get('/spawn', (_q, res) => {
      globalThis.__spawned = ctx.exec('/bin/sleep', ['30'], { timeoutMs: 60000 });
      res.json({ started: true });
    });
  },`;

const declared = () => ({
  secrets: ['token'],
  services: ['org.example.a'],
  exec: ['/bin/echo', '/usr/bin/env', '/bin/sleep', '/nonexistent/program'],
  net: ['api.example.com', '*.cdn.example.org', 'ports.example.com:8443'],
  fs: { read: [roots.read], write: [roots.write] },
});

function install(over: Record<string, unknown> = {}) {
  writePlugin(s.modules, {
    id: 'checked',
    hooks: TRY,
    permissions: declared(),
    manifest: {
      services: [{ label: 'org.example.a' }, { label: 'org.example.b' }],
      ...over,
    },
  });
}

type Outcome = {
  ok: boolean;
  value?: unknown;
  name?: string;
  code?: string;
  permission?: string;
  subject?: string;
  message?: string;
};

/** A gateway with the plugin running; with enforcement on, it is approved first, as a person would. */
const start = async (enforce: boolean) => {
  if (enforce) await seedEnforce(s);
  const gw = (running = await startGateway(s, { plugins: { fetch: fakeFetch } }));
  if (enforce) await approve(gw);
  return gw;
};

const approve = async (gw: Running) => {
  const p = (await listPlugins(gw)).checked;
  const res = await gw.api('/plugins/checked/approve', {
    method: 'POST',
    body: JSON.stringify({ permissionsHash: p.permissionsHash, checksum: p.checksum }),
  });
  expect(res.status).toBe(200);
};

const attempt = async (gw: Running, name: string, query: Record<string, string> = {}) =>
  (await gw.json<Outcome>(
    `/api/modules/checked/try/${name}?${new URLSearchParams(query).toString()}`
  )) as Outcome;

const denied = (permission: string, subject: string): Partial<Outcome> => ({
  ok: false,
  name: 'PluginPermissionError',
  code: 'plugin_permission_denied',
  permission,
  subject,
});

const rows = (action: string) => auditRows(action).filter((r) => r.subject === 'checked');

describe.each([
  ['off', false],
  ['on', true],
] as const)('with enforcement %s', (_label, on) => {
  const outside = (permission: string, subject: string): Partial<Outcome> =>
    on ? denied(permission, subject) : { ok: true };

  beforeEach(() => install());

  it('lets the plugin use what it declared, either way, without a word in the audit log', async () => {
    const gw = await start(on);
    expect(await attempt(gw, 'secret-set', { name: 'token' })).toMatchObject({ ok: true });
    expect(await attempt(gw, 'secret-get', { name: 'token' })).toMatchObject({
      ok: true,
      value: 'value',
    });
    expect(await attempt(gw, 'secret-list')).toMatchObject({ ok: true, value: ['token'] });
    expect(await attempt(gw, 'secret-delete', { name: 'token' })).toMatchObject({ ok: true });
    expect(await attempt(gw, 'service-status', { label: 'org.example.a' })).toMatchObject({
      ok: true,
    });
    expect(await attempt(gw, 'exec', { cmd: '/bin/echo', args: 'hi' })).toMatchObject({
      ok: true,
      value: { code: 0, stdout: 'hi' },
    });
    for (const url of [
      'https://api.example.com/x',
      'https://a.cdn.example.org/x',
      'https://ports.example.com:8443/x',
    ]) {
      expect(await attempt(gw, 'fetch', { url })).toMatchObject({ ok: true, value: 200 });
    }
    expect(await attempt(gw, 'read', { path: path.join(roots.read, 'a.txt') })).toMatchObject({
      ok: true,
      value: 'inside',
    });
    expect(
      await attempt(gw, 'write', { path: path.join(roots.write, 'deep', 'b.txt') })
    ).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(roots.write, 'deep', 'b.txt'), 'utf8')).toBe('written');
    expect(rows('plugin.permission.denied')).toEqual([]);
    expect(rows('plugin.permission.undeclared')).toEqual([]);
  });

  it('secrets: a name that is not declared', async () => {
    const gw = await start(on);
    // Another name exists in the plugin's own part of the vault.
    await attempt(gw, 'secret-set', { name: 'other' }).catch(() => undefined);
    const got = await attempt(gw, 'secret-get', { name: 'other' });
    expect(got).toMatchObject(outside('secrets', 'other'));
    expect(await attempt(gw, 'secret-set', { name: 'more' })).toMatchObject(
      outside('secrets', 'more')
    );
    expect(await attempt(gw, 'secret-delete', { name: 'other' })).toMatchObject(
      outside('secrets', 'other')
    );
    if (on) {
      expect(got.message).toContain('may not read the secret "other"');
      expect(got.message).toContain('permissions.secrets');
      expect(got.message).toContain('enforcement is on');
    }
  });

  it('secrets: list shows only the declared names while it is on', async () => {
    const gw = await start(false);
    // Written while nothing is enforced...
    await attempt(gw, 'secret-set', { name: 'token' });
    await attempt(gw, 'secret-set', { name: 'other' });
    if (on) {
      await gw.api('/plugins/settings', { method: 'PUT', body: JSON.stringify({ enforce: true }) });
      // Enforcement stops a plugin nobody approved; approve what is listed and go on.
      expect((await listPlugins(gw)).checked.state).toBe('awaiting_approval');
      await approve(gw);
    }
    const list = await attempt(gw, 'secret-list');
    expect((list.value as string[]).sort()).toEqual(on ? ['token'] : ['other', 'token']);
  });

  it('services: a label that the manifest lists but permissions.services does not', async () => {
    const gw = await start(on);
    const log = path.join(s.home, 'launchctl.log');
    const out = await attempt(gw, 'service-status', { label: 'org.example.b' });
    expect(out).toMatchObject(outside('services', 'org.example.b'));
    // Refused before launchd was asked; allowed, it asked.
    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').toMatch(
      on ? /^$/ : /org\.example\.b/
    );
    expect(await attempt(gw, 'service-list')).toMatchObject({
      ok: true,
      value: on ? ['org.example.a'] : ['org.example.a', 'org.example.b'],
    });
  });

  it('exec: a command that is not written exactly as declared', async () => {
    const gw = await start(on);
    // Not the same string, though it finds the same program.
    expect(await attempt(gw, 'exec', { cmd: 'echo', args: 'hi' })).toMatchObject(
      outside('exec', 'echo')
    );
    expect(await attempt(gw, 'exec', { cmd: '/bin/ls', args: roots.read })).toMatchObject(
      outside('exec', '/bin/ls')
    );
  });

  it('exec: a declared program that does not exist is an error either way, not a permission error', async () => {
    const gw = await start(on);
    const out = await attempt(gw, 'exec', { cmd: '/nonexistent/program' });
    expect(out.ok).toBe(false);
    expect(out.code).not.toBe('plugin_permission_denied');
    expect(out.message).toContain('Could not start');
  });

  it('fetch: a host, a port or a redirect that is not declared', async () => {
    const gw = await start(on);
    expect(await attempt(gw, 'fetch', { url: 'https://evil.example.net/x' })).toMatchObject(
      outside('net', 'evil.example.net:443')
    );
    // The apex of a wildcard is its own host; a port other than the declared one is another.
    expect(await attempt(gw, 'fetch', { url: 'https://cdn.example.org/x' })).toMatchObject(
      outside('net', 'cdn.example.org:443')
    );
    expect(await attempt(gw, 'fetch', { url: 'https://ports.example.com/x' })).toMatchObject(
      outside('net', 'ports.example.com:443')
    );
    // A host declared without a port is open on every port; with one, only that.
    expect(await attempt(gw, 'fetch', { url: 'http://api.example.com:9/x' })).toMatchObject({
      ok: true,
      value: 200,
    });
    // A request to a declared host that sends the caller somewhere else.
    seen.length = 0;
    const hop = await attempt(gw, 'fetch', { url: 'https://api.example.com/to-evil' });
    expect(hop).toMatchObject(
      on ? denied('net', 'evil.example.net:443') : { ok: true, value: 200 }
    );
    expect(seen).toEqual(
      on
        ? ['GET https://api.example.com/to-evil']
        : ['GET https://api.example.com/to-evil', 'GET https://evil.example.net/x']
    );
    // ...or somewhere that is declared, which it follows.
    expect(await attempt(gw, 'fetch', { url: 'https://api.example.com/to-cdn' })).toMatchObject({
      ok: true,
      value: 200,
    });
  });

  it('fetch: only http and https, and a full address, in both modes', async () => {
    const gw = await start(on);
    for (const url of ['file:///etc/passwd', 'ftp://api.example.com/x']) {
      const out = await attempt(gw, 'fetch', { url });
      expect(out).toMatchObject({ ok: false });
      expect(out.message).toContain('only does http and https');
      expect(out.code).not.toBe('plugin_permission_denied');
    }
    expect((await attempt(gw, 'fetch', { url: 'api.example.com/x' })).message).toContain(
      'needs a full address'
    );
  });

  it('fs: a path outside the declared folders, a .. that climbs out, and a link that leads out', async () => {
    const gw = await start(on);
    const target = path.join(roots.outside, 'secret.txt');
    const via = (p: string) => attempt(gw, 'read', { path: p });

    expect(await via(target)).toMatchObject(
      on ? denied('fs.read', target) : { ok: true, value: 'outside' }
    );
    // `..` is resolved before the check: this is the outside file, written to look inside.
    const climb = path.join(roots.read, '..', 'outside', 'secret.txt');
    expect(await via(climb)).toMatchObject(
      on ? denied('fs.read', target) : { ok: true, value: 'outside' }
    );
    // A link inside the folder to a file outside it.
    fs.symlinkSync(target, path.join(roots.read, 'link.txt'));
    expect(await via(path.join(roots.read, 'link.txt'))).toMatchObject(
      on ? denied('fs.read', path.join(roots.read, 'link.txt')) : { ok: true, value: 'outside' }
    );
    // A link to a folder outside, then a file under it.
    fs.symlinkSync(roots.outside, path.join(roots.read, 'dir-link'));
    expect(await via(path.join(roots.read, 'dir-link', 'secret.txt'))).toMatchObject(
      on ? { ok: false, permission: 'fs.read' } : { ok: true, value: 'outside' }
    );
    // A new file written through a dangling link would create its target outside.
    fs.symlinkSync(path.join(roots.outside, 'created.txt'), path.join(roots.write, 'dangling'));
    const wrote = await attempt(gw, 'write', { path: path.join(roots.write, 'dangling') });
    if (on) {
      expect(wrote).toMatchObject({ ok: false, permission: 'fs.write' });
      expect(fs.existsSync(path.join(roots.outside, 'created.txt'))).toBe(false);
    }
  });

  it('fs: reading is not writing, and a relative path is not a path', async () => {
    const gw = await start(on);
    const inWrite = path.join(roots.write, 'only-write.txt');
    fs.writeFileSync(inWrite, 'w');
    expect(await attempt(gw, 'read', { path: inWrite })).toMatchObject(
      on ? denied('fs.read', inWrite) : { ok: true, value: 'w' }
    );
    const inRead = path.join(roots.read, 'a.txt');
    expect(await attempt(gw, 'write', { path: inRead })).toMatchObject(
      on ? denied('fs.write', inRead) : { ok: true }
    );
    const rel = await attempt(gw, 'read', { path: 'a.txt' });
    expect(rel).toMatchObject({ ok: false });
    expect(rel.message).toContain('absolute path');
    expect(rel.code).not.toBe('plugin_permission_denied');
    expect((await attempt(gw, 'read', { path: '' })).message).toContain('needs a path');
  });

  it('fs: a path through another name for a declared folder is inside it', async () => {
    const gw = await start(on);
    // The folder is declared by its real path; this is the same folder through a link.
    const alias = path.join(s.home, 'alias');
    fs.symlinkSync(roots.read, alias);
    expect(await attempt(gw, 'read', { path: path.join(alias, 'a.txt') })).toMatchObject({
      ok: true,
      value: 'inside',
    });
  });

  it('writes an audit row for each thing it went beyond, with who and what', async () => {
    const gw = await start(on);
    await attempt(gw, 'secret-get', { name: 'other' });
    await attempt(gw, 'exec', { cmd: '/bin/ls', args: roots.read });
    await attempt(gw, 'fetch', { url: 'https://evil.example.net/x' });
    await attempt(gw, 'read', { path: path.join(roots.outside, 'secret.txt') });
    const action = on ? 'plugin.permission.denied' : 'plugin.permission.undeclared';
    const other = on ? 'plugin.permission.undeclared' : 'plugin.permission.denied';
    expect(rows(other)).toEqual([]);
    const found = rows(action);
    expect(found.map((r) => [r.detail.permission, r.detail.subject])).toEqual([
      ['secrets', 'other'],
      ['exec', '/bin/ls'],
      ['net', 'evil.example.net:443'],
      ['fs.read', path.join(roots.outside, 'secret.txt')],
    ]);
    for (const r of found) {
      expect(r.actor).toBe('plugin:checked');
      expect(r.detail.enforced).toBe(on);
    }
    // The same thing again within the minute is not another row.
    await attempt(gw, 'secret-get', { name: 'other' });
    expect(rows(action)).toHaveLength(4);
  });
});

describe('what the helpers do beyond the check', () => {
  beforeEach(() => install());

  it('runs a command without the gateway’s own environment', async () => {
    process.env.CLERQ_TEST_ONLY_SECRET = 'do-not-pass';
    try {
      const gw = await start(true);
      const out = await attempt(gw, 'exec', { cmd: '/usr/bin/env' });
      const env = String((out.value as { stdout: string }).stdout);
      expect(env).not.toContain('do-not-pass');
      expect(env).not.toContain('CLERQ_GATEWAY_TOKEN');
      expect(env).toContain('PATH=');
    } finally {
      delete process.env.CLERQ_TEST_ONLY_SECRET;
    }
  });

  it('stops a command that runs past its limit', async () => {
    const gw = await start(true);
    const out = await attempt(gw, 'exec', { cmd: '/bin/sleep', args: '30', ms: '150' });
    expect(out.value).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  });

  it('kills a command that is still running when the plugin stops', async () => {
    const gw = await start(true);
    await gw.api('/api/modules/checked/spawn');
    const pending = (globalThis as { __spawned?: Promise<{ signal: string | null }> }).__spawned;
    await sleep(50);
    const t0 = Date.now();
    await gw.api('/plugins/checked/disable', { method: 'POST', body: '{}' });
    expect((await pending)?.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('does not offer the model or memory helpers: llm and memory are declared and recorded only', async () => {
    writePlugin(s.modules, {
      id: 'no-llm',
      permissions: { llm: true, memory: { read: ['fact'], write: ['note'] } },
      hooks: `register(ctx) { log.push(Object.keys(ctx).filter((k) => /llm|memory|model/i.test(k)).join(',') || 'none'); log.push(JSON.stringify(ctx.permissions.memory)); log.push(String(ctx.permissions.llm)); },`,
    });
    const gw = await start(false);
    const { events } = await import('./plugins.harness.js');
    expect(events('no-llm').slice(1)).toEqual([
      'none',
      '{"read":["fact"],"write":["note"]}',
      'true',
    ]);
    const p = (await listPlugins(gw))['no-llm'];
    expect(p.permissions).toMatchObject({ llm: true, memory: { read: ['fact'], write: ['note'] } });
  });
});

describe('redirects, with a real network stack', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((srv) => new Promise((r) => srv.close(r))));
  });

  /** Two servers on loopback: A redirects to what it is told, B counts who reaches it. */
  async function twoServers() {
    let reachedB = 0;
    const b = http.createServer((_req, res) => {
      reachedB += 1;
      res.end('B');
    });
    await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
    const portB = (b.address() as AddressInfo).port;
    const a = http.createServer((req, res) => {
      if (req.url === '/to-b') {
        res.writeHead(302, { location: `http://127.0.0.1:${portB}/x` }).end();
      } else if (req.url === '/to-self') {
        res.writeHead(302, { location: '/ok' }).end();
      } else {
        res.end('A');
      }
    });
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', r));
    servers.push(a, b);
    return { portA: (a.address() as AddressInfo).port, portB, reachedB: () => reachedB };
  }

  const plugin = (portA: number) =>
    writePlugin(s.modules, {
      id: 'checked',
      hooks: TRY,
      permissions: { net: [`127.0.0.1:${portA}`] },
    });

  it('does not follow a redirect from a declared host to one that is not, when it is on', async () => {
    const { portA, portB, reachedB } = await twoServers();
    plugin(portA);
    await seedEnforce(s);
    const gw = (running = await startGateway(s));
    await approve(gw);
    expect(await attempt(gw, 'fetch', { url: `http://127.0.0.1:${portA}/to-b` })).toMatchObject(
      denied('net', `127.0.0.1:${portB}`)
    );
    // The request never reached it: it was refused before it was made.
    expect(reachedB()).toBe(0);
    // A redirect inside the declared host is followed.
    expect(await attempt(gw, 'fetch', { url: `http://127.0.0.1:${portA}/to-self` })).toMatchObject({
      ok: true,
      value: 200,
    });
    // And one the caller asked not to follow is handed back as it is.
    expect(
      await attempt(gw, 'fetch', { url: `http://127.0.0.1:${portA}/to-b`, redirect: 'manual' })
    ).toMatchObject({ ok: true, value: 302 });
    expect(reachedB()).toBe(0);
  });

  it('follows it, and audits it, when enforcement is off', async () => {
    const { portA, portB, reachedB } = await twoServers();
    plugin(portA);
    const gw = (running = await startGateway(s));
    expect(await attempt(gw, 'fetch', { url: `http://127.0.0.1:${portA}/to-b` })).toMatchObject({
      ok: true,
      value: 200,
    });
    expect(reachedB()).toBe(1);
    expect(rows('plugin.permission.undeclared').map((r) => r.detail.subject)).toEqual([
      `127.0.0.1:${portB}`,
    ]);
  });
});
