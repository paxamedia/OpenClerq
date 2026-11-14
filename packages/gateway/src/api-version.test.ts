/**
 * The API version middleware on its own: the header, the `/vN` prefix, and what
 * happens when they disagree. The gateway itself serves one version, so a
 * second is stood in here to reach the cases that need two.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { API_VERSION, API_VERSION_HEADER } from '@clerq/gateway-client/protocol';
import { apiVersionOf, negotiateApiVersion, stampApiVersion } from './api-version.js';

let server: Server;
let base: string;
let two: Server;
let baseTwo: string;

function appServing(supported: number[]): express.Express {
  const app = express();
  app.use(stampApiVersion);
  app.use(negotiateApiVersion(supported));
  app.use((req, res) => {
    res.json({ url: req.url, originalUrl: req.originalUrl, version: apiVersionOf(res) });
  });
  return app;
}

const listen = (app: express.Express) =>
  new Promise<{ server: Server; base: string }>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve({ server: s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}` });
    });
  });

beforeAll(async () => {
  ({ server, base } = await listen(appServing([1])));
  ({ server: two, base: baseTwo } = await listen(appServing([1, 2])));
});

afterAll(async () => {
  await Promise.all([server, two].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('the version header on every response', () => {
  it('is 1, with or without a request header', async () => {
    const plain = await fetch(`${base}/anything`);
    expect(plain.headers.get(API_VERSION_HEADER)).toBe(String(API_VERSION));
    const asked = await fetch(`${base}/anything`, { headers: { [API_VERSION_HEADER]: '1' } });
    expect(asked.headers.get(API_VERSION_HEADER)).toBe('1');
  });

  it('is still there on a refusal', async () => {
    const res = await fetch(`${base}/anything`, { headers: { [API_VERSION_HEADER]: '9' } });
    expect(res.status).toBe(400);
    expect(res.headers.get(API_VERSION_HEADER)).toBe('1');
  });
});

describe('the /v1 prefix', () => {
  it('is removed, and the version is recorded', async () => {
    const body = await (await fetch(`${base}/v1/runs?limit=5`)).json();
    expect(body).toEqual({ url: '/runs?limit=5', originalUrl: '/v1/runs?limit=5', version: 1 });
  });

  it('maps /v1 and /v1/ to the root and keeps the query', async () => {
    expect(((await (await fetch(`${base}/v1`)).json()) as { url: string }).url).toBe('/');
    expect(((await (await fetch(`${base}/v1/`)).json()) as { url: string }).url).toBe('/');
    expect(((await (await fetch(`${base}/v1?a=1`)).json()) as { url: string }).url).toBe('/?a=1');
  });

  it('is removed once only, and only as a whole segment', async () => {
    const twice = (await (await fetch(`${base}/v1/v1/runs`)).json()) as { url: string };
    expect(twice.url).toBe('/v1/runs');
    for (const path of ['/v1x/runs', '/vv1/runs', '/runs/v1', '/v/runs']) {
      const body = (await (await fetch(`${base}${path}`)).json()) as { url: string };
      expect(body.url).toBe(path);
    }
  });

  it('serves the bare path as version 1', async () => {
    expect(await (await fetch(`${base}/runs`)).json()).toMatchObject({ url: '/runs', version: 1 });
  });
});

describe('a version the gateway does not serve', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['/runs', { [API_VERSION_HEADER]: '2' }, '2'],
    ['/runs', { [API_VERSION_HEADER]: 'abc' }, 'abc'],
    ['/runs', { [API_VERSION_HEADER]: '1.5' }, '1.5'],
    ['/runs', { [API_VERSION_HEADER]: '0' }, '0'],
    ['/runs', { [API_VERSION_HEADER]: '-1' }, '-1'],
    ['/runs', { [API_VERSION_HEADER]: '01' }, '01'],
    ['/runs', { [API_VERSION_HEADER]: '1, 1' }, '1, 1'],
    ['/runs', { [API_VERSION_HEADER]: ' ' }, ''],
    ['/v2/runs', {}, '2'],
    ['/v0/runs', {}, '0'],
    ['/v01/runs', {}, '01'],
    ['/v1/runs', { [API_VERSION_HEADER]: '2' }, '2'],
    ['/v2/runs', { [API_VERSION_HEADER]: '1' }, '2'],
  ];
  it.each(cases)('is a 400 for %s with %j', async (path, headers, requested) => {
    const res = await fetch(`${base}${path}`, { headers });
    expect(res.status).toBe(400);
    expect(res.headers.get(API_VERSION_HEADER)).toBe('1');
    expect(await res.json()).toMatchObject({
      error: 'unsupported_api_version',
      requested,
      supported: [1],
    });
  });

  it('says in words what it does serve, and does not echo a long header whole', async () => {
    const res = await fetch(`${base}/runs`, { headers: { [API_VERSION_HEADER]: 'x'.repeat(300) } });
    const body = (await res.json()) as { requested: string; message: string };
    expect(body.requested.length).toBeLessThan(60);
    expect(body.message).toContain('serves: 1');
  });
});

describe('a gateway that serves two versions', () => {
  it('serves each, and records which', async () => {
    const one = await (await fetch(`${baseTwo}/v1/runs`)).json();
    const twoBody = await (await fetch(`${baseTwo}/v2/runs`)).json();
    const byHeader = await fetch(`${baseTwo}/runs`, { headers: { [API_VERSION_HEADER]: '2' } });
    expect(one).toMatchObject({ url: '/runs', version: 1 });
    expect(twoBody).toMatchObject({ url: '/runs', version: 2 });
    expect(await byHeader.json()).toMatchObject({ url: '/runs', version: 2 });
    expect(byHeader.headers.get(API_VERSION_HEADER)).toBe('2');
  });

  it('answers a request that names no version as version 1', async () => {
    const res = await fetch(`${baseTwo}/runs`);
    expect(await res.json()).toMatchObject({ version: 1 });
    expect(res.headers.get(API_VERSION_HEADER)).toBe('1');
  });

  it('refuses a path and a header that name different versions', async () => {
    const res = await fetch(`${baseTwo}/v1/runs`, { headers: { [API_VERSION_HEADER]: '2' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'api_version_mismatch',
      header: '2',
      path: '1',
      supported: [1, 2],
    });
    const other = await fetch(`${baseTwo}/v2/runs`, { headers: { [API_VERSION_HEADER]: '1' } });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: 'api_version_mismatch' });
  });

  it('accepts a path and a header that agree', async () => {
    const res = await fetch(`${baseTwo}/v2/runs`, { headers: { [API_VERSION_HEADER]: '2' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2 });
  });

  it('still refuses a third', async () => {
    const res = await fetch(`${baseTwo}/v3/runs`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ requested: '3', supported: [1, 2] });
  });
});
