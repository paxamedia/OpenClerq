/**
 * The versioned API on a running gateway: `/v1` paths and the bare aliases,
 * `Clerq-Api-Version` in both directions, `GET /version`, and the header on
 * every kind of answer. See docs/API.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newestKnownSchema } from '@clerq/store';
import { API_VERSION_HEADER } from '@clerq/gateway-client/protocol';
import { createGateway, GATEWAY_VERSION } from './gateway.js';
import { issueToken } from './security/scoped-tokens.js';

const TOKEN = 'api-version-test-token-0123456789';
const auth = { Authorization: `Bearer ${TOKEN}` };

let server: ReturnType<typeof createGateway>['server'];
let base: string;
let home: string;
let savedHome: string | undefined;
let savedKeychain: string | undefined;

const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });
const authed = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { ...auth, ...(init.headers as object) } });

beforeAll(async () => {
  savedHome = process.env.HOME;
  savedKeychain = process.env.CLERQ_KEYCHAIN;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-apiv-'));
  process.env.HOME = home;
  process.env.CLERQ_KEYCHAIN = 'off';
  const gw = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
  });
  server = gw.server;
  await gw.ready;
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedKeychain === undefined) delete process.env.CLERQ_KEYCHAIN;
  else process.env.CLERQ_KEYCHAIN = savedKeychain;
});

describe('GET /version', () => {
  it('needs no token, on /version and on /v1/version', async () => {
    for (const p of ['/version', '/v1/version']) {
      const res = await get(p);
      expect(res.status, p).toBe(200);
      expect(await res.json()).toEqual({
        gateway: GATEWAY_VERSION,
        api: { version: 1, supported: [1] },
        store: { schema: newestKnownSchema() },
      });
    }
  });

  it('reveals nothing but versions', async () => {
    const text = JSON.stringify(await (await get('/v1/version')).json());
    expect(text).not.toContain(home);
    expect(text).not.toContain(TOKEN);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['api', 'gateway', 'store']);
  });
});

describe('GET /health', () => {
  it('answers the same on /health and /v1/health, with no token, and reports the API', async () => {
    const bare = await get('/health');
    const prefixed = await get('/v1/health');
    expect(bare.status).toBe(200);
    expect(prefixed.status).toBe(200);
    const body = (await bare.json()) as Record<string, unknown>;
    expect(await prefixed.json()).toEqual(body);
    expect(body).toMatchObject({
      status: 'ok',
      service: 'clerq-gateway',
      version: GATEWAY_VERSION,
      api: { version: 1, supported: [1] },
    });
  });
});

describe('/v1 and the bare paths are one API', () => {
  it('answers a GET the same way, and an unknown route the same way', async () => {
    for (const p of ['/sessions', '/capabilities', '/runs', '/automations', '/nope']) {
      const bare = await authed(p);
      const prefixed = await authed(`/v1${p}`);
      expect(prefixed.status, p).toBe(bare.status);
      // An unknown route's page names the address that was asked for.
      if (p !== '/nope') expect(await prefixed.text(), p).toBe(await bare.text());
    }
  });

  it('takes a POST on /v1 and shows the result on the bare path', async () => {
    const created = await authed('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'made under /v1' }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };
    const bare = await authed(`/sessions/${session.id}`);
    expect(bare.status).toBe(200);
    expect(await bare.json()).toMatchObject({ id: session.id, title: 'made under /v1' });
    const removed = await authed(`/v1/sessions/${session.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await authed(`/sessions/${session.id}`)).status).toBe(404);
  });

  it('streams events on /v1/events/stream, with the token in a header or in the query', async () => {
    for (const [p, headers] of [
      ['/v1/events/stream', auth],
      [`/v1/events/stream?token=${TOKEN}`, {}],
      ['/events/stream', auth],
    ] as const) {
      const controller = new AbortController();
      const res = await fetch(`${base}${p}`, { headers, signal: controller.signal });
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type'), p).toContain('text/event-stream');
      expect(res.headers.get(API_VERSION_HEADER), p).toBe('1');
      controller.abort();
    }
  });

  it('keeps the token requirement on both', async () => {
    expect((await get('/runs')).status).toBe(401);
    expect((await get('/v1/runs')).status).toBe(401);
    expect((await get('/v1/events/stream')).status).toBe(401);
  });

  it('applies a scoped token to the path it names, whichever way it is written', async () => {
    const { token } = issueToken({
      kind: 'module',
      subject: 'apiv-test',
      scopes: ['GET /runs'],
      ttlMs: 60_000,
    });
    const scoped = { Authorization: `Bearer ${token}` };
    expect((await get('/runs', scoped)).status).toBe(200);
    expect((await get('/v1/runs', scoped)).status).toBe(200);
    // Never reachable with a scoped token, and the prefix does not change that.
    expect((await get('/secrets', scoped)).status).toBe(403);
    expect((await get('/v1/secrets', scoped)).status).toBe(403);
    expect((await get('/v1/sessions', scoped)).status).toBe(403);
    expect((await get('/v1/v1/runs', scoped)).status).toBe(403);
  });

  it('does not strip a prefix twice or from the middle of a path', async () => {
    expect((await authed('/v1/v1/health')).status).toBe(404);
    expect((await authed('/runs/v1')).status).toBe(404);
    expect((await authed('/v1runs')).status).toBe(404);
  });
});

describe('Clerq-Api-Version', () => {
  it('is on every response, including 401, 403, 404, 400 and a preflight', async () => {
    const { token } = issueToken({
      kind: 'module',
      subject: 'apiv-test-2',
      scopes: ['GET /runs'],
      ttlMs: 60_000,
    });
    const answers: Array<[string, Response]> = [
      ['200', await get('/v1/health')],
      ['401', await get('/v1/runs')],
      ['401 bare', await get('/runs')],
      ['403', await get('/v1/secrets', { Authorization: `Bearer ${token}` })],
      ['404', await authed('/v1/nope')],
      ['404 bare', await authed('/nope')],
      ['400 invalid path', await authed('/v1/%E0%A4%A')],
      ['400 version', await get('/v1/health', { [API_VERSION_HEADER]: '7' })],
      [
        '204 preflight',
        await fetch(`${base}/v1/runs`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'tauri://localhost',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization,clerq-api-version',
          },
        }),
      ],
    ];
    for (const [label, res] of answers) {
      expect(res.headers.get(API_VERSION_HEADER), label).toBe('1');
    }
    expect(answers.map(([label, res]) => `${label}:${res.status}`)).toEqual([
      '200:200',
      '401:401',
      '401 bare:401',
      '403:403',
      '404:404',
      '404 bare:404',
      '400 invalid path:400',
      '400 version:400',
      '204 preflight:204',
    ]);
  });

  it('lets a browser send it, and read it back', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,clerq-api-version',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'clerq-api-version'
    );
    expect(res.headers.get('access-control-expose-headers')).toBe(API_VERSION_HEADER);
  });

  it('means 1 when it is missing, and accepts 1', async () => {
    expect((await authed('/v1/sessions')).status).toBe(200);
    expect((await authed('/sessions', { headers: { [API_VERSION_HEADER]: '1' } })).status).toBe(
      200
    );
    expect((await authed('/v1/sessions', { headers: { [API_VERSION_HEADER]: '1' } })).status).toBe(
      200
    );
  });

  it('refuses a version it does not serve before checking the token', async () => {
    for (const [p, headers] of [
      ['/v1/runs', { [API_VERSION_HEADER]: '2' }],
      ['/runs', { [API_VERSION_HEADER]: 'two' }],
      ['/v2/runs', {}],
      ['/v2/health', {}],
    ] as const) {
      const res = await get(p, headers);
      expect(res.status, p).toBe(400);
      expect(res.headers.get(API_VERSION_HEADER), p).toBe('1');
      expect(await res.json(), p).toMatchObject({
        error: 'unsupported_api_version',
        supported: [1],
      });
    }
  });

  it('refuses a version on the public paths too, so a client learns the reason', async () => {
    const res = await get('/v1/version', { [API_VERSION_HEADER]: '2' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ requested: '2', supported: [1] });
  });
});
