/**
 * What a failed request is answered with, through a whole gateway: JSON, with
 * nothing taken from the request. The bodies here look like what an operator
 * might post by mistake: the start of a private key, a long document.
 *
 * HOME is a scratch directory, the store is in memory, and the example
 * hello-world module is loaded so a module's routes and files are covered too.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiErrors } from './error-handler.js';
import { createGateway } from './gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(__dirname, '../../module-sdk/examples/hello-world');
const TOKEN = 'error-handler-test-token-0123456789';
const VARS = [
  'HOME',
  'USERPROFILE',
  'CLERQ_KEYCHAIN',
  'CLERQ_VAULT_KEY',
  'CLERQ_MODULES_DIR',
  'CLERQ_MAX_BODY',
];
const saved: Record<string, string | undefined> = {};

/**
 * The start of a private key, which is not JSON. Put together here, so that no whole PEM
 * header sits in the source for a secret scanner to take for a key.
 */
const HEADER = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const PEM_BODY = `${HEADER}\nMIIEowIBAAKCAQEAsecretsecretsecret\n`;
/** Valid JSON that the parser cuts off in the middle of a key. */
const CUT_JSON = `{"privateKey": "${HEADER}\\nMIIEowIBAAKCAQEA`;

let home: string;
let baseUrl: string;
let server: { close: (cb?: () => void) => void };

const post = (p: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    body,
  });

beforeAll(async () => {
  for (const v of VARS) saved[v] = process.env[v];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-errors-'));
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  delete process.env.CLERQ_VAULT_KEY;
  process.env.CLERQ_KEYCHAIN = 'off';
  process.env.CLERQ_MAX_BODY = '2kb';
  const modulesDir = path.join(home, 'modules');
  fs.cpSync(EXAMPLE, path.join(modulesDir, 'hello-world'), { recursive: true });
  process.env.CLERQ_MODULES_DIR = modulesDir;

  const gw = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    skillsDir: path.join(home, 'skills'),
  });
  server = gw.server;
  await gw.ready;
  baseUrl = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a body that is not JSON', () => {
  const ROUTES = [
    '/github/app/import',
    '/v1/github/app/import',
    '/github/app/manifest',
    '/secrets',
    '/automations',
    '/automations/preview',
    '/repos',
    '/memory',
    '/task',
    '/api/modules/hello-world/greetings',
  ];

  it('is answered 400 invalid_json by every route, without a word of the body', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      })
    );
    const answers: Array<{ route: string; status: number; text: string; version: string | null }> =
      [];
    try {
      for (const route of ROUTES) {
        for (const body of [PEM_BODY, CUT_JSON]) {
          const res = await post(route, body);
          answers.push({
            route,
            status: res.status,
            text: await res.text(),
            version: res.headers.get('clerq-api-version'),
          });
          expect(res.headers.get('content-type')).toContain('application/json');
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    for (const a of answers) {
      expect([a.route, a.status]).toEqual([a.route, 400]);
      expect(JSON.parse(a.text)).toEqual({
        error: 'invalid_json',
        message: 'The request body is not valid JSON.',
      });
      // The version header every answer carries is kept.
      expect([a.route, a.version]).toEqual([a.route, '1']);
      // Nothing of the body, no stack, no parser text.
      for (const leak of ['MIIE', 'BEGIN', 'secretsecret', 'SyntaxError', ' at ', 'node_modules']) {
        expect([a.route, a.text.includes(leak)]).toEqual([a.route, false]);
      }
    }
    // The log says that a request was refused, and for what, but not what it held.
    const logged = logs.join('\n');
    expect(logged).toContain('Request refused');
    expect(logged).toContain('entity.parse.failed');
    expect(logged).toContain('/github/app/import');
    for (const leak of ['MIIE', 'BEGIN', 'secretsecret', 'SyntaxError', 'is not valid JSON']) {
      expect(logged).not.toContain(leak);
    }
  });

  it('is refused for a route that needs a token before anyone reads it, as before', async () => {
    // Authentication comes after the parser, so the parse failure answers first: still no body.
    const res = await fetch(`${baseUrl}/github/app/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: PEM_BODY,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('MIIE');
  });
});

describe('a body over the limit', () => {
  it('is 413 payload_too_large, with nothing of it in the answer', async () => {
    const big = JSON.stringify({ privateKey: `MIIEowIBAAKCAQEA${'x'.repeat(4_000)}` });
    for (const route of [
      '/github/app/import',
      '/v1/secrets',
      '/api/modules/hello-world/greetings',
    ]) {
      const res = await post(route, big);
      expect([route, res.status]).toEqual([route, 413]);
      expect(await res.json()).toEqual({
        error: 'payload_too_large',
        message: 'The request body is too large.',
      });
      expect(res.headers.get('clerq-api-version')).toBe('1');
    }
  });
});

describe('a module’s own files', () => {
  it('answer a missing file with JSON 404, not an HTML page', async () => {
    const res = await fetch(`${baseUrl}/api/modules/hello-world/ui/missing.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('clerq-api-version')).toBe('1');
    // The files themselves are served as before.
    expect((await fetch(`${baseUrl}/api/modules/hello-world/ui/app.js`)).status).toBe(200);
  });
});

describe('the handler itself', () => {
  /** An app with routes that fail the ways a route can, and the handler last. */
  async function serve(): Promise<{ url: string; stop: () => Promise<void> }> {
    const app = express();
    app.use(express.json());
    app.get('/throws', () => {
      throw new Error('database said hunter2 in the middle');
    });
    app.get('/rejects', async () => {
      await Promise.resolve();
      throw new Error('async failure MIIEowIBAA');
    });
    app.get('/parses', () => {
      JSON.parse('{"a": "MIIEowIBAA');
    });
    app.get('/refuses', (_req, _res, next) => {
      next(Object.assign(new Error('Forbidden: /etc/passwd'), { status: 403, expose: true }));
    });
    app.get('/half', (_req, res, next) => {
      res.write('{"partial":');
      next(new Error('after the headers'));
    });
    app.use(apiErrors);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      stop: () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => r());
        }),
    };
  }

  it('answers any other failure 500 internal, and never says what it was', async () => {
    const { url, stop } = await serve();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      for (const p of ['/throws', '/rejects', '/parses']) {
        const res = await fetch(`${url}${p}?token=abc123`);
        expect([p, res.status]).toEqual([p, 500]);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'internal' });
        for (const leak of ['hunter2', 'MIIE', 'at ', 'Error:']) {
          expect([p, text.includes(leak)]).toEqual([p, false]);
        }
      }
    } finally {
      spy.mockRestore();
      await stop();
    }
    // Logged with the method, the path (never the query) and where it was thrown: the
    // error's own text can hold a piece of the request, so it is left out.
    const logged = errors.join('\n');
    expect(logged).toContain('Request failed');
    expect(logged).toContain('/throws');
    expect(logged).toContain('error-handler.integration.test');
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('MIIEowIBAA');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('\n    at ');
  });

  it('says only the kind of a refusal it can pass on', async () => {
    const { url, stop } = await serve();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await fetch(`${url}/refuses`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    } finally {
      warn.mockRestore();
      await stop();
    }
  });

  it('leaves an answer that has begun to Express: the connection ends', async () => {
    const { url, stop } = await serve();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await fetch(`${url}/half`).catch(() => null);
      // Either the partial answer or a reset: never a second, JSON, answer on top.
      if (res) expect(await res.text().catch(() => '')).not.toContain('"error":"internal"');
    } finally {
      error.mockRestore();
      await stop();
    }
  });
});
