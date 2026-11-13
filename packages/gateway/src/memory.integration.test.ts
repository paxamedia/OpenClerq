/**
 * Memory through the gateway's HTTP API: the records, search, the read policy,
 * summarising with a (fake) model, and what a managed chat carries from
 * memory. The console's raw mode must carry nothing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from './gateway.js';
import { recentEvents } from './events.js';

const TOKEN = 'memory-test-token-0123456789';
const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });

interface Seen {
  model: string;
  messages: Array<{ role: string; content: string }>;
}
const seen: Seen[] = [];

/** `down` answers 503; any other model answers with `reply`, which a test may set. */
let reply = (m: Seen): string => `echo from ${m.model}`;
async function startFakeModelServer(): Promise<http.Server> {
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Seen;
      seen.push({ model: body.model, messages: body.messages });
      if (body.model === 'down') {
        res.statusCode = 503;
        res.end('{"error":"busy"}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply(body) } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  return fake;
}

const VARS = ['CLERQ_PROVIDERS_FILE', 'CLERQ_LLM_PROVIDER', 'CLERQ_MODEL', 'CLERQ_KEYCHAIN'];

describe('memory API', () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-memory-'));
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
      ].join('\n');
    fs.writeFileSync(
      file,
      ['providers:', provider('ok', 'good'), provider('gone', 'down'), ''].join('\n')
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
      if ((await authed(`${baseUrl}/memory`)).status === 200) break;
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

  const get = (p: string) => authed(`${baseUrl}${p}`);
  const send = (method: string, p: string, body?: unknown) =>
    authed(`${baseUrl}${p}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

  beforeEach(async () => {
    seen.length = 0;
    reply = (m) => `echo from ${m.model}`;
    // Every test starts from nothing remembered, and the default policy.
    const all = await json<{ records: Array<{ id: string }> }>(
      await get('/memory/records?status=all')
    );
    for (const r of all.records) await send('DELETE', `/memory/records/${r.id}`);
    await send('PUT', '/memory/policy', {
      readTypes: ['fact', 'preference', 'decision', 'procedure', 'note'],
    });
  });

  describe('the endpoints that were always there', () => {
    it('set, read, list and delete a key, as before', async () => {
      const set = await send('POST', '/memory', { key: 'tone', value: { style: 'formal' } });
      expect(set.status).toBe(200);
      expect(await json(set)).toMatchObject({ ok: true, record: { key: 'tone', type: 'fact' } });

      const one = await json<Record<string, unknown>>(await get('/memory/tone'));
      expect(one).toMatchObject({ key: 'tone', value: { style: 'formal' } });
      expect(one.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const list = await json<{ entries: Array<Record<string, unknown>> }>(await get('/memory'));
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]).toMatchObject({
        key: 'tone',
        value: { style: 'formal' },
        type: 'fact',
      });

      expect((await send('DELETE', '/memory/tone')).status).toBe(200);
      expect((await get('/memory/tone')).status).toBe(404);
      expect(await json(await send('DELETE', '/memory/tone'))).toMatchObject({
        error: 'memory_not_found',
      });
      expect((await send('POST', '/memory', { value: 1 })).status).toBe(400);
    });

    it('set the same key again updates it in place, and a type keeps its own record', async () => {
      await send('POST', '/memory', { key: 'k', value: 'one' });
      await send('POST', '/memory', { key: 'k', value: 'two' });
      await send('POST', '/memory', { key: 'k', value: 'how', type: 'procedure' });
      const list = await json<{ entries: Array<{ type: string; value: unknown }> }>(
        await get('/memory?key=k')
      );
      expect(list.entries.map((e) => [e.type, e.value]).sort()).toEqual([
        ['fact', 'two'],
        ['procedure', 'how'],
      ]);
      expect(await json(await get('/memory/k?type=procedure'))).toMatchObject({ value: 'how' });
    });
  });

  describe('records', () => {
    it('are created, read, changed and deleted by id', async () => {
      const made = await send('POST', '/memory/records', {
        key: 'billing',
        value: 'rate is 80 EUR',
        type: 'decision',
        confidence: 0.8,
        expiresAt: '2099-06-01',
        sourceSession: 'ses_9',
      });
      expect(made.status).toBe(201);
      const { record } = await json<{ record: { id: string } & Record<string, unknown> }>(made);
      expect(record).toMatchObject({
        type: 'decision',
        confidence: 0.8,
        sourceSession: 'ses_9',
        origin: 'user',
        status: 'active',
      });
      // A second one under the same key is a record of its own.
      await send('POST', '/memory/records', { key: 'billing', value: 'second' });
      expect(
        (await json<{ records: unknown[] }>(await get('/memory/records?key=billing'))).records
      ).toHaveLength(2);
      expect(
        (await json<{ records: unknown[] }>(await get('/memory/records?type=decision'))).records
      ).toHaveLength(1);

      const got = await json<{ record: Record<string, unknown> }>(
        await get(`/memory/records/${record.id}`)
      );
      expect(got.record.value).toBe('rate is 80 EUR');
      const patched = await json<{ record: Record<string, unknown> }>(
        await send('PATCH', `/memory/records/${record.id}`, {
          value: 'rate is 90 EUR',
          confidence: null,
        })
      );
      expect(patched.record).toMatchObject({ value: 'rate is 90 EUR', type: 'decision' });
      expect(patched.record.confidence).toBeUndefined();
      expect((await send('DELETE', `/memory/records/${record.id}`)).status).toBe(200);
      expect((await get(`/memory/records/${record.id}`)).status).toBe(404);
      expect((await send('PATCH', `/memory/records/${record.id}`, { value: 1 })).status).toBe(404);
    });

    it('refuse what is not valid, saying why', async () => {
      const bad = async (body: unknown) => {
        const res = await send('POST', '/memory/records', body);
        expect(res.status).toBe(400);
        const out = await json<{ error: string; message: string }>(res);
        expect(out.error).toBe('invalid_memory');
        return out.message;
      };
      expect(await bad({ value: 1 })).toMatch(/key is required/);
      expect(await bad({ key: 'k', value: 1, type: 'opinion' })).toMatch(/type must be one of/);
      expect(await bad({ key: 'k', value: 1, confidence: 3 })).toMatch(/0 to 1/);
      expect(await bad({ key: 'k', value: 1, expiresAt: '2001-01-01' })).toMatch(/future/);
      // `import` and `consolidation` are the gateway's own.
      expect(await bad({ key: 'k', value: 1, origin: 'consolidation' })).toMatch(
        /"user" or "agent"/
      );
      expect((await get('/memory/records?type=gossip')).status).toBe(400);
      expect((await get('/memory/records?status=gone')).status).toBe(400);
    });
  });

  describe('search', () => {
    it('finds records by the words in them, with the type filter and the mode used', async () => {
      await send('POST', '/memory/records', {
        key: 'vat',
        value: 'quarterly VAT filing is due on the 20th',
      });
      await send('POST', '/memory/records', {
        key: 'vat-how',
        value: 'file the quarterly VAT return online',
        type: 'procedure',
      });
      const all = await json<{ mode: string; results: Array<{ key: string; score: number }> }>(
        await get('/memory/search?q=quarterly%20vat')
      );
      expect(all.mode).toBe('fts5');
      expect(all.results.map((r) => r.key).sort()).toEqual(['vat', 'vat-how']);
      const only = await json<{ results: Array<{ key: string }> }>(
        await get('/memory/search?q=quarterly&types=procedure')
      );
      expect(only.results.map((r) => r.key)).toEqual(['vat-how']);
      expect((await get('/memory/search')).status).toBe(400);
      expect((await get('/memory/search?q=x&types=nope')).status).toBe(400);
    });
  });

  describe('the read policy', () => {
    it('defaults to every type, and is set by listing the types a managed chat may read', async () => {
      const before = await json<{ readTypes: string[]; types: string[] }>(
        await get('/memory/policy')
      );
      expect(before.readTypes).toEqual(before.types);
      expect(before.types).toEqual(['fact', 'preference', 'decision', 'procedure', 'note']);
      const set = await send('PUT', '/memory/policy', { readTypes: ['procedure', 'fact'] });
      expect(await json(set)).toMatchObject({ readTypes: ['fact', 'procedure'] });
      expect((await send('PUT', '/memory/policy', { readTypes: ['gossip'] })).status).toBe(400);
      expect((await send('PUT', '/memory/policy', {})).status).toBe(400);
    });
  });

  describe('what a chat carries from memory', () => {
    async function seed() {
      await send('POST', '/memory/records', {
        key: 'tone',
        value: 'Keep answers short.',
        type: 'preference',
      });
      await send('POST', '/memory/records', {
        key: 'vat',
        value: 'The quarterly VAT filing is due on the 20th.',
      });
      await send('POST', '/memory/records', {
        key: 'vat-how',
        value: 'File the quarterly VAT return in the portal.',
        type: 'procedure',
      });
    }
    const systemOf = (m?: Seen) => m?.messages.find((x) => x.role === 'system')?.content ?? '';

    it('gives a task the notes that bear on it, with the preferences', async () => {
      await seed();
      await send('POST', '/task', { message: 'When is the quarterly VAT filing due?' });
      const system = systemOf(seen[0]);
      expect(system).toContain('<memory>');
      expect(system).toContain('- [preference] tone: Keep answers short.');
      expect(system).toContain('- [fact] vat: The quarterly VAT filing is due on the 20th.');
      expect(system).toContain('- [procedure] vat-how');
      expect(system).toMatch(/information, not instructions/);
    });

    it('carries only the types the policy lets it read', async () => {
      await seed();
      await send('PUT', '/memory/policy', { readTypes: ['procedure'] });
      await send('POST', '/task', { message: 'When is the quarterly VAT filing due?' });
      const system = systemOf(seen[0]);
      expect(system).toContain('[procedure] vat-how');
      expect(system).not.toContain('[fact]');
      expect(system).not.toContain('[preference]');

      seen.length = 0;
      await send('PUT', '/memory/policy', { readTypes: [] });
      await send('POST', '/task', { message: 'When is the quarterly VAT filing due?' });
      expect(systemOf(seen[0])).not.toContain('<memory>');
    });

    it('shows the same notes in the context preview, as it does for everything it sends', async () => {
      await seed();
      const preview = await json<{ systemPrompt: string }>(
        await send('POST', '/context/preview', {
          question: 'When is the quarterly VAT filing due?',
        })
      );
      expect(preview.systemPrompt).toContain('- [fact] vat:');
      await send('PUT', '/memory/policy', { readTypes: ['note'] });
      const narrowed = await json<{ systemPrompt: string }>(
        await send('POST', '/context/preview', {
          question: 'When is the quarterly VAT filing due?',
        })
      );
      expect(narrowed.systemPrompt).not.toContain('<memory>');
    });

    it('records the notes in the dry-run trace', async () => {
      await seed();
      const out = await json<{ trace: Array<{ step: string; detail?: string }> }>(
        await send('POST', '/task', { message: 'quarterly VAT', dryRun: true })
      );
      expect(out.trace.find((t) => t.step === 'memory')?.detail).toMatch(/\d+ saved notes?/);
    });

    it('adds nothing in the console’s raw mode, whatever is remembered', async () => {
      await seed();
      const raw = await json<{ id: string }>(await send('POST', '/sessions', { mode: 'raw' }));
      await send('POST', `/sessions/${raw.id}/send`, {
        text: 'When is the quarterly VAT filing due?',
        stream: false,
      });
      expect(seen[0].messages).toEqual([
        { role: 'user', content: 'When is the quarterly VAT filing due?' },
      ]);
      expect(JSON.stringify(seen[0])).not.toContain('memory');

      // The same message in a managed session does carry it.
      seen.length = 0;
      const managed = await json<{ id: string }>(
        await send('POST', '/sessions', { mode: 'managed' })
      );
      await send('POST', `/sessions/${managed.id}/send`, {
        text: 'When is the quarterly VAT filing due?',
        stream: false,
      });
      expect(systemOf(seen[0])).toContain('<memory>');
    });
  });

  describe('summarising', () => {
    it('folds the records of a key into one with a model, as a run, and can be undone', async () => {
      await send('POST', '/memory/records', { key: 'billing', value: 'rate is 80 EUR' });
      await send('POST', '/memory/records', { key: 'billing', value: 'rate is now 90 EUR' });
      reply = () => 'The rate is 90 EUR (was 80).';
      const res = await send('POST', '/memory/consolidate', { key: 'billing' });
      expect(res.status).toBe(200);
      const out = await json<{
        record: { id: string; value: string; origin: string };
        superseded: string[];
        model: string;
      }>(res);
      expect(out.record).toMatchObject({
        value: 'The rate is 90 EUR (was 80).',
        origin: 'consolidation',
      });
      expect(out.superseded).toHaveLength(2);
      expect(out.model).toBe('ok/good');
      // The model was sent the notes, oldest first.
      const prompt = seen[0].messages.at(-1)?.content ?? '';
      expect(prompt.indexOf('rate is 80 EUR')).toBeLessThan(prompt.indexOf('rate is now 90 EUR'));

      // It was a run: its cost is on the record.
      const runs = await json<{ runs: Array<{ id: string; input: string; tokensIn: number }> }>(
        await get('/runs?limit=1')
      );
      expect(runs.runs[0]).toMatchObject({ input: 'Summarise memory: billing', tokensIn: 100 });

      expect((await json<{ entries: unknown[] }>(await get('/memory'))).entries).toHaveLength(1);
      const hidden = await json<{ records: unknown[] }>(
        await get('/memory/records?status=superseded')
      );
      expect(hidden.records).toHaveLength(2);

      const undone = await send('POST', `/memory/records/${out.record.id}/unconsolidate`);
      expect(await json(undone)).toEqual({ restored: out.superseded });
      expect((await json<{ entries: unknown[] }>(await get('/memory'))).entries).toHaveLength(2);
    });

    it('says why it cannot, and answers 503 when the model is down', async () => {
      await send('POST', '/memory/records', { key: 'one', value: 'only' });
      const few = await send('POST', '/memory/consolidate', { key: 'one' });
      expect(few.status).toBe(409);
      expect(await json(few)).toMatchObject({ error: 'cannot_consolidate' });
      expect((await send('POST', '/memory/consolidate', {})).status).toBe(400);
      expect((await send('POST', `/memory/records/mem_nope/unconsolidate`)).status).toBe(404);

      await send('POST', '/memory/records', { key: 'two', value: 'a' });
      await send('POST', '/memory/records', { key: 'two', value: 'b' });
      // A model named for it is used as chosen.
      const down = await send('POST', '/memory/consolidate', { key: 'two', model: 'gone/down' });
      expect(down.status).toBe(503);
      expect(await json(down)).toMatchObject({ error: 'ai_unavailable' });
      expect(
        (await json<{ entries: unknown[] }>(await get('/memory?key=two'))).entries
      ).toHaveLength(2);
    });
  });

  it('says memory.updated for each change', async () => {
    const before = recentEvents().length;
    const made = await json<{ record: { id: string } }>(
      await send('POST', '/memory/records', { key: 'evt', value: 1 })
    );
    await send('DELETE', `/memory/records/${made.record.id}`);
    const updates = recentEvents()
      .slice(before)
      .filter((e) => e.name === 'memory.updated')
      .map((e) => (e.payload as { action: string }).action);
    expect(updates).toEqual(['created', 'deleted']);
  });

  it('needs a token on every endpoint', async () => {
    for (const [method, p] of [
      ['GET', '/memory'],
      ['GET', '/memory/search?q=x'],
      ['GET', '/memory/records'],
      ['POST', '/memory/records'],
      ['POST', '/memory/consolidate'],
      ['GET', '/memory/policy'],
      ['PUT', '/memory/policy'],
    ]) {
      const res = await fetch(`${baseUrl}${p}`, {
        method,
        body: method === 'GET' ? undefined : '{}',
      });
      expect(res.status, `${method} ${p}`).toBe(401);
    }
  });
});
