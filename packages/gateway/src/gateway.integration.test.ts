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

describe('gateway integration', () => {
  let baseUrl: string;
  let server: { close: (cb?: () => void) => void; once: (e: string, cb: () => void) => void; address: () => { port: number } | null };

  beforeAll(async () => {
    process.env.CLERQ_DEV = '1';
    const { server: s } = createGateway({
      port: 0,
      devMode: true,
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
    const res = await fetch(`${baseUrl}/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills?: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills!.length).toBeGreaterThanOrEqual(1);
    const fixture = (body.skills as Array<{ slug?: string }>).find((s) => s.slug === 'fixture-skill');
    expect(fixture).toBeDefined();
  });

  it('POST /calculate/eval returns 200 or 503', async () => {
    const res = await fetch(`${baseUrl}/calculate/eval`, {
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
    const res = await fetch(`${baseUrl}/task`, {
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
});
