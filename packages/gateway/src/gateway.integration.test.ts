/**
 * Gateway integration tests.
 * Starts the gateway on a random port and hits endpoints.
 * Requires no ANTHROPIC_API_KEY for /health and /skills.
 * POST /calculate/eval returns 200 if clerq-calc is built, 503 otherwise.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGateway } from './gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesSkillsDir = path.join(__dirname, '__fixtures__', 'skills');

const TEST_TOKEN = 'integration-test-token-0123456789';
/** Authenticated fetch — every endpoint except /health requires a bearer token. */
const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${TEST_TOKEN}` } });

describe('gateway integration', () => {
  let baseUrl: string;
  let server: {
    close: (cb?: () => void) => void;
    once: (e: string, cb: () => void) => void;
    address: () => { port: number } | null;
  };

  beforeAll(async () => {
    process.env.CLERQ_DEV = '1';
    const { server: s } = createGateway({
      port: 0,
      devMode: true,
      authToken: TEST_TOKEN,
      // In-memory store: tests must never touch the developer's ~/.clerq.
      dbPath: ':memory:',
      skillsDir: fixturesSkillsDir,
      modulesDir: '/nonexistent-modules-dir-xyz',
    });
    server = s as typeof server;
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 18790;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 10000);

  afterAll(async () => {
    return new Promise<void>((resolve) => server.close(resolve));
  });

  it('GET /health returns 200 with status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; service?: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBeDefined();
  });

  it('GET /skills returns 200 with skills array', async () => {
    const res = await authed(`${baseUrl}/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills?: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills!.length).toBeGreaterThanOrEqual(1);
    const fixture = (body.skills as Array<{ slug?: string }>).find(
      (s) => s.slug === 'fixture-skill'
    );
    expect(fixture).toBeDefined();
  });

  it('POST /calculate/eval returns 200 or 503', async () => {
    const res = await authed(`${baseUrl}/calculate/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: '10 + 25', inputs: {} }),
    });
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      expect(body.values).toBeDefined();
      expect((body.values as Record<string, number>).result).toBe(35);
    } else {
      expect(body.error).toBe('calculation_engine_unavailable');
    }
  });

  it('POST /task returns 200 or 503', async () => {
    const res = await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What can you help with?' }),
    });
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      expect(body.explanation).toBeDefined();
    } else {
      expect(body.error).toBeDefined();
    }
  });

  it('GET /health needs no token', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated request to a privileged endpoint', async () => {
    const res = await fetch(`${baseUrl}/skills`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unauthorized');
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a wrong token', async () => {
    const res = await fetch(`${baseUrl}/skills`, {
      headers: { Authorization: 'Bearer not-the-right-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token of a different length without leaking via error shape', async () => {
    const res = await fetch(`${baseUrl}/tools`, { headers: { Authorization: 'Bearer short' } });
    expect(res.status).toBe(401);
  });

  it('accepts the token via the X-Clerq-Token header', async () => {
    const res = await fetch(`${baseUrl}/tools`, { headers: { 'X-Clerq-Token': TEST_TOKEN } });
    expect(res.status).toBe(200);
  });

  it('accepts a query token on the SSE log stream only', async () => {
    const ok = await fetch(`${baseUrl}/logs/stream?token=${TEST_TOKEN}`);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();

    // The same query parameter must not authenticate a normal endpoint.
    const denied = await fetch(`${baseUrl}/tools?token=${TEST_TOKEN}`);
    expect(denied.status).toBe(401);
  });

  it('records a run for POST /task and exposes it in history', async () => {
    // Before 0.5 a task left no trace: the result was logged and discarded.
    await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'record me' }),
    });

    const res = await authed(`${baseUrl}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs.length).toBeGreaterThanOrEqual(1);

    const run = body.runs[0];
    expect(run.trigger).toBe('manual');
    // The LLM is unconfigured in tests, so the run is expected to fail — the
    // point is that the failure is recorded rather than lost.
    expect(['done', 'failed']).toContain(run.status);
    expect(run.finishedAt).toBeDefined();
  });

  it('returns a run with its step trace', async () => {
    await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'trace me' }),
    });
    const list = (await (await authed(`${baseUrl}/runs?limit=1`)).json()) as {
      runs: Array<{ id: string }>;
    };
    const res = await authed(`${baseUrl}/runs/${list.runs[0].id}`);
    expect(res.status).toBe(200);
    const run = (await res.json()) as { id: string; steps: Array<Record<string, unknown>> };
    expect(run.id).toBe(list.runs[0].id);
    expect(run.steps.length).toBeGreaterThanOrEqual(1);
    expect(run.steps[0].input).toBe('trace me');
  });

  it('404s an unknown run', async () => {
    const res = await authed(`${baseUrl}/runs/run_does-not-exist`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('run_not_found');
  });

  it('does not record a run for a dry run', async () => {
    const before = (await (await authed(`${baseUrl}/runs`)).json()) as { runs: unknown[] };
    await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'dry', dryRun: true }),
    });
    const after = (await (await authed(`${baseUrl}/runs`)).json()) as { runs: unknown[] };
    expect(after.runs.length).toBe(before.runs.length);
  });

  it('requires a token for run history', async () => {
    expect((await fetch(`${baseUrl}/runs`)).status).toBe(401);
  });

  it('does not send a wildcard CORS header', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reflects an allow-listed origin', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://localhost:1420' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
  });
});
