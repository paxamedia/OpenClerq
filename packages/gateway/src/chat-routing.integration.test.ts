/**
 * Model routing for chat and tasks, through the gateway's HTTP API against a
 * fake model server: the default model may be replaced by the default chain
 * when it is unavailable; a model a person chose, and the console's raw mode,
 * never are. Every move is an event, a run step and a metric.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from './gateway.js';
import { chat } from './agent/llm-provider.js';
import { setDefaultFallback } from './routing.js';
import { recentEvents } from './events.js';
import { getRegistry } from './agent/llm-provider.js';

const TOKEN = 'chat-routing-test-token-0123456789';
const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });

const seen: Array<{ model: string; stream?: boolean }> = [];

/**
 * A /chat/completions endpoint. Model `down` answers 503, `busy` answers 429,
 * `bad` answers 400, `broken` streams a word and hangs up; anything else answers.
 */
async function startFakeModelServer(): Promise<http.Server> {
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; stream?: boolean };
      seen.push({ model: body.model, stream: body.stream });
      const fail = (status: number, message: string) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: message }));
      };
      if (body.model === 'down') return fail(503, 'service unavailable');
      if (body.model === 'busy') return fail(429, 'slow down');
      if (body.model === 'bad') return fail(400, 'invalid request');
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'echo ' } }] })}\n\n`);
        if (body.model === 'broken') {
          // Hang up after the first word.
          setTimeout(() => res.destroy(), 20);
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: body.model } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `echo from ${body.model}` } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  return fake;
}

const VARS = ['CLERQ_PROVIDERS_FILE', 'CLERQ_LLM_PROVIDER', 'CLERQ_MODEL', 'CLERQ_KEYCHAIN'];

describe('routing for chat and tasks', () => {
  let baseUrl: string;
  let server: {
    close: (cb?: () => void) => void;
    once: (e: string, cb: () => void) => void;
    address: () => { port: number } | null;
  };
  let fake: http.Server;
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeAll(async () => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    fake = await startFakeModelServer();
    const url = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-chat-routing-'));
    const file = path.join(dir, 'providers.yaml');
    const provider = (id: string, model: string) =>
      [
        `  - id: ${id}`,
        `    label: ${id}`,
        '    adapter: openai-compat',
        `    baseUrl: ${url}`,
        '    authEnv: null',
        `    defaultModel: ${model}`,
        '    models:',
        `      - id: ${model}`,
        '        inputPerM: 1',
        '        outputPerM: 1',
      ].join('\n');
    fs.writeFileSync(
      file,
      [
        'providers:',
        provider('ok', 'good'),
        provider('ok2', 'good2'),
        provider('gone', 'down'),
        provider('crowded', 'busy'),
        provider('picky', 'bad'),
        provider('flaky', 'broken'),
        '',
      ].join('\n')
    );
    for (const v of VARS) delete process.env[v];
    process.env.CLERQ_PROVIDERS_FILE = file;
    process.env.CLERQ_LLM_PROVIDER = 'ok';
    process.env.CLERQ_KEYCHAIN = 'off';
    const { server: s } = createGateway({
      port: 0,
      authToken: TOKEN,
      dbPath: ':memory:',
      modulesDir: '/nonexistent-modules-dir-xyz',
    });
    server = s as typeof server;
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (let i = 0; i < 50; i++) {
      if ((await authed(`${baseUrl}/routing`)).status === 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  }, 10_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  beforeEach(async () => {
    seen.length = 0;
    process.env.CLERQ_LLM_PROVIDER = 'ok';
    await put({ fallback: [] });
  });

  const put = (body: unknown) =>
    authed(`${baseUrl}/routing`, { method: 'PUT', body: JSON.stringify(body) });
  const post = (url: string, body: unknown) =>
    authed(`${baseUrl}${url}`, { method: 'POST', body: JSON.stringify(body) });
  const models = () => seen.map((s) => s.model);

  async function lastRun() {
    const list = (await (await authed(`${baseUrl}/runs?limit=1`)).json()) as {
      runs: Array<{ id: string }>;
    };
    return (await (await authed(`${baseUrl}/runs/${list.runs[0].id}`)).json()) as {
      id: string;
      status: string;
      steps: Array<{
        kind: string;
        status: string;
        input: Record<string, unknown>;
        output: Record<string, unknown>;
      }>;
    };
  }

  describe('the default chain', () => {
    it('is empty until it is set, and is read back as saved', async () => {
      const before = await (await authed(`${baseUrl}/routing`)).json();
      expect(before).toMatchObject({
        default: { provider: 'ok', model: 'good' },
        fallback: [],
        maxFallback: 5,
      });
      const saved = await put({ fallback: ['ok2/good2', 'crowded/busy'] });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ fallback: ['ok2/good2', 'crowded/busy'] });
      expect(
        ((await (await authed(`${baseUrl}/routing`)).json()) as { fallback: string[] }).fallback
      ).toEqual(['ok2/good2', 'crowded/busy']);
    });

    it('refuses what is not a chain of provider/model, naming why', async () => {
      const bad = async (fallback: unknown) => {
        const res = await put({ fallback });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('invalid_routing');
        return body.message;
      };
      expect(await bad('ok2/good2')).toMatch(/must be a list/);
      expect(await bad(['good2'])).toMatch(/must name the provider too/);
      expect(await bad(['nobody/x'])).toMatch(/Unknown provider "nobody"/);
      expect(await bad(['ok2/good2', 'ok2/good2'])).toMatch(/listed twice/);
      expect(await bad([7])).toMatch(/must be a model name/);
      expect(await bad(['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6'])).toMatch(/at most 5/);
    });

    it('needs a token', async () => {
      expect((await fetch(`${baseUrl}/routing`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/routing`, { method: 'PUT', body: '{}' })).status).toBe(401);
    });
  });

  describe('a task with no model of its own', () => {
    it('falls back along the chain when the default is unavailable, and records it', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      await put({ fallback: ['crowded/busy', 'ok2/good2'] });
      const before = (
        (await (await authed(`${baseUrl}/metrics`)).json()) as {
          llm_fallbacks_total: number;
        }
      ).llm_fallbacks_total;

      const res = await post('/task', { message: 'hello' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { explanation: string }).explanation).toBe('echo from good2');
      // down, then busy, then the one that answers: each tried once.
      expect(models()).toEqual(['down', 'busy', 'good2']);

      const run = await lastRun();
      expect(run.status).toBe('done');
      const llm = run.steps.filter((s) => s.kind === 'llm').map((s) => s.status);
      expect(llm).toEqual(['error', 'error', 'ok']);
      const moves = run.steps.filter((s) => s.input.name === 'model.fallback');
      expect(moves.map((s) => `${s.input.from}>${s.input.to}`)).toEqual([
        'gone/down>crowded/busy',
        'crowded/busy>ok2/good2',
      ]);
      expect(String(moves[0].output.reason)).toMatch(/returned 503/);
      expect(String(moves[1].output.reason)).toMatch(/returned 429/);

      const events = recentEvents().filter(
        (e) => e.name === 'model.fallback' && e.context.runId === run.id
      );
      expect(events).toHaveLength(2);
      expect(events[0].payload).toMatchObject({
        from: 'gone/down',
        to: 'crowded/busy',
        scope: 'chat',
      });

      const after = (
        (await (await authed(`${baseUrl}/metrics`)).json()) as {
          llm_fallbacks_total: number;
        }
      ).llm_fallbacks_total;
      expect(after - before).toBe(2);
    });

    it('fails with the last error when the whole chain is unavailable', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      await put({ fallback: ['crowded/busy'] });
      const res = await post('/task', { message: 'hello' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('ai_unavailable');
      expect(models()).toEqual(['down', 'busy']);
      expect((await lastRun()).status).toBe('failed');
    });

    it('does nothing different without a chain', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      const res = await post('/task', { message: 'hello' });
      expect(res.status).toBe(503);
      expect(models()).toEqual(['down']);
    });

    it('does not move on for a request the provider refused', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'picky';
      await put({ fallback: ['ok2/good2'] });
      const res = await post('/task', { message: 'hello' });
      expect(res.status).toBe(503);
      expect(models()).toEqual(['bad']);
    });

    it('does not try the default twice when the chain lists it', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      await put({ fallback: ['gone/down', 'ok2/good2'] });
      const res = await post('/task', { message: 'hello' });
      expect(res.status).toBe(200);
      expect(models()).toEqual(['down', 'good2']);
    });

    it('also applies to a gateway trigger, which has no model of its own', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      await put({ fallback: ['ok2/good2'] });
      await authed(`${baseUrl}/triggers`, {
        method: 'POST',
        body: JSON.stringify({ webhooks: { hook: { message: 'webhook task' } } }),
      });
      const res = await post('/webhook/hook', {});
      expect(res.status).toBe(200);
      expect(models()).toEqual(['down', 'good2']);
    });
  });

  describe('a model a person chose', () => {
    beforeEach(async () => {
      await put({ fallback: ['ok2/good2'] });
    });

    it('is used as chosen by /task, whatever the chain says', async () => {
      const res = await post('/task', { message: 'hello', model: 'gone/down' });
      expect(res.status).toBe(503);
      expect(models()).toEqual(['down']);
      expect((await lastRun()).steps.some((s) => s.input.name === 'model.fallback')).toBe(false);
    });

    it('is used as chosen by /explain', async () => {
      const res = await post('/explain', { question: 'why', model: 'crowded/busy' });
      expect(res.status).toBe(503);
      expect(models()).toEqual(['busy']);
    });

    it('is used as chosen in a chat session, picked per message or for the session', async () => {
      const managed = (await (await post('/sessions', { mode: 'managed' })).json()) as {
        id: string;
      };
      const perMessage = await post(`/sessions/${managed.id}/send`, {
        text: 'hi',
        stream: false,
        model: 'gone/down',
      });
      expect(perMessage.status).not.toBe(200);
      expect(models()).toEqual(['down']);

      seen.length = 0;
      const picked = (await (
        await post('/sessions', { mode: 'managed', model: 'crowded/busy' })
      ).json()) as { id: string };
      await post(`/sessions/${picked.id}/send`, { text: 'hi', stream: false });
      expect(models()).toEqual(['busy']);
    });

    it('is used as chosen by each column of a comparison, which reports it as an error', async () => {
      const session = (await (await post('/sessions', {})).json()) as { id: string };
      const res = await post(`/sessions/${session.id}/compare`, {
        text: 'which',
        models: ['gone/down', 'ok/good'],
      });
      const body = (await res.json()) as {
        columns: Array<{ model: string; error?: string; text?: string }>;
      };
      expect(body.columns[0].error).toMatch(/returned 503/);
      expect(body.columns[1].text).toBe('echo from good');
      expect(models().sort()).toEqual(['down', 'good']);
    });
  });

  describe('chat sessions', () => {
    it('falls back in managed mode when the default is unavailable, with the session in the event', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      await put({ fallback: ['ok2/good2'] });
      const session = (await (await post('/sessions', { mode: 'managed' })).json()) as {
        id: string;
      };
      const res = await post(`/sessions/${session.id}/send`, { text: 'hi', stream: false });
      expect(res.status).toBe(200);
      expect(models()).toEqual(['down', 'good2']);
      const event = recentEvents()
        .filter((e) => e.name === 'model.fallback')
        .at(-1);
      expect(event?.context.sessionId).toBe(session.id);
      expect(event?.context.runId).toBeTruthy();
    });

    it('never falls back in raw mode, whose request is one call to one model', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      await put({ fallback: ['ok2/good2'] });
      const session = (await (await post('/sessions', { mode: 'raw' })).json()) as { id: string };
      const res = await post(`/sessions/${session.id}/send`, { text: 'hi', stream: false });
      expect(res.status).not.toBe(200);
      expect(models()).toEqual(['down']);
    });
  });

  describe('chat() itself', () => {
    it('does not move on once part of the answer has been sent', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'flaky';
      setDefaultFallback(['ok2/good2'], getRegistry());
      const deltas: string[] = [];
      await expect(
        chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => deltas.push(d) })
      ).rejects.toThrow();
      expect(deltas).toEqual(['echo ']);
      expect(models()).toEqual(['broken']);
    });

    it('moves on when the stream failed before anything was sent', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      setDefaultFallback(['ok2/good2'], getRegistry());
      const deltas: string[] = [];
      const res = await chat({
        messages: [{ role: 'user', content: 'hi' }],
        onDelta: (d) => deltas.push(d),
      });
      expect(res.model).toBe('good2');
      expect(deltas.join('')).toBe('echo good2');
    });

    it('with strict, keeps the default as it is', async () => {
      process.env.CLERQ_LLM_PROVIDER = 'gone';
      setDefaultFallback(['ok2/good2'], getRegistry());
      await expect(
        chat({ messages: [{ role: 'user', content: 'hi' }], strict: true })
      ).rejects.toThrow(/returned 503/);
      expect(models()).toEqual(['down']);
    });
  });
});
