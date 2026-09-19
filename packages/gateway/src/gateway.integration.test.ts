/**
 * Gateway integration tests.
 * Starts the gateway on a random port and hits endpoints.
 *
 * Model calls go to a fake OpenAI-compatible server started here, through a
 * test-only provider registry. No test can reach a real vendor or spend money,
 * whatever keys the developer's environment happens to hold.
 *
 * POST /calculate/eval returns 200 if clerq-calc is built, 503 otherwise.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from './gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesSkillsDir = path.join(__dirname, '__fixtures__', 'skills');

const TEST_TOKEN = 'integration-test-token-0123456789';
/** Authenticated fetch — every endpoint except /health requires a bearer token. */
const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${TEST_TOKEN}` } });

/** What the fake model server was sent, for assertions. */
interface SeenRequest {
  model: string;
  authorization?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
}

/** Calls to the fake that were slow on purpose, and how many the gateway walked away from. */
const slowCalls = { started: 0, abandoned: 0 };

/**
 * A stand-in for a vendor's /chat/completions endpoint. Every call reports
 * 1200 prompt and 300 completion tokens; a prompt containing FAIL_ME gets a 500,
 * and one containing SLOW takes seconds to answer.
 */
async function startFakeModelServer(seen: SeenRequest[]): Promise<http.Server> {
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      };
      seen.push({
        model: body.model,
        authorization: req.headers.authorization,
        messages: body.messages,
        stream: body.stream,
      });
      const prompt = body.messages[body.messages.length - 1].content;
      if (prompt.includes('FAIL_ME')) {
        res.setHeader('content-type', 'application/json');
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'upstream boom' }));
        return;
      }

      // SLOW keeps a call in flight for seconds, so there is something to cancel.
      if (prompt.includes('SLOW')) {
        slowCalls.started += 1;
        const timers: NodeJS.Timeout[] = [];
        res.on('close', () => {
          if (!res.writableFinished) slowCalls.abandoned += 1;
          timers.forEach(clearTimeout);
        });
        if (body.stream) {
          res.setHeader('content-type', 'text/event-stream');
          for (let i = 0; i < 20; i++) {
            timers.push(
              setTimeout(
                () => {
                  res.write(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: '.' } }] })}\n\n`
                  );
                  if (i === 19) res.end('data: [DONE]\n\n');
                },
                150 * (i + 1)
              )
            );
          }
        } else {
          res.setHeader('content-type', 'application/json');
          timers.push(
            setTimeout(
              () =>
                res.end(
                  JSON.stringify({
                    choices: [{ message: { content: 'slow answer' } }],
                    usage: { prompt_tokens: 1200, completion_tokens: 300 },
                  })
                ),
              1200
            )
          );
        }
        return;
      }

      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        for (const word of ['echo ', 'from ', body.model]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 1200, completion_tokens: 300 },
          })}\n\n`
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `echo from ${body.model}` } }],
          usage: { prompt_tokens: 1200, completion_tokens: 300 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  return fake;
}

const LLM_VARS = [
  'CLERQ_PROVIDERS_FILE',
  'CLERQ_LLM_PROVIDER',
  'CLERQ_MODEL',
  'CLERQ_LLM_BASE_URL',
  'CLERQ_OLLAMA_URL',
  'FAKECLOUD_TEST_KEY',
  // Off for the same reason the store is in memory: a test must never write to
  // the developer's real keychain, which is what an unguarded /secrets call
  // would do.
  'CLERQ_KEYCHAIN',
];

describe('gateway integration', () => {
  let baseUrl: string;
  let server: {
    close: (cb?: () => void) => void;
    once: (e: string, cb: () => void) => void;
    address: () => { port: number } | null;
  };
  let fakeModels: http.Server;
  const seen: SeenRequest[] = [];
  let registryDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    savedEnv = Object.fromEntries(LLM_VARS.map((v) => [v, process.env[v]]));
    fakeModels = await startFakeModelServer(seen);
    const fakeUrl = `http://127.0.0.1:${(fakeModels.address() as { port: number }).port}/v1`;

    // `fake` is keyless and priced at $2 / $10 per million tokens, so one call
    // costs 1200 * 2e-6 + 300 * 10e-6 = $0.0054. `fakecloud` needs a key and has
    // no price, which must surface as an unknown cost rather than a free one.
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-gw-registry-'));
    const registryFile = path.join(registryDir, 'providers.yaml');
    fs.writeFileSync(
      registryFile,
      [
        'providers:',
        '  - id: fake',
        '    label: Fake local',
        '    adapter: openai-compat',
        `    baseUrl: ${fakeUrl}`,
        '    authEnv: null',
        '    defaultModel: priced',
        '    models:',
        '      - id: priced',
        '        inputPerM: 2',
        '        outputPerM: 10',
        '  - id: fakecloud',
        '    label: Fake cloud',
        '    adapter: openai-compat',
        `    baseUrl: ${fakeUrl}`,
        '    authEnv: FAKECLOUD_TEST_KEY',
        '    models:',
        '      - id: unpriced',
        '',
      ].join('\n')
    );
    for (const v of LLM_VARS) delete process.env[v];
    process.env.CLERQ_PROVIDERS_FILE = registryFile;
    process.env.CLERQ_LLM_PROVIDER = 'fake';
    process.env.FAKECLOUD_TEST_KEY = 'fakecloud-test-key';
    process.env.CLERQ_KEYCHAIN = 'off';

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => fakeModels.close(() => resolve()));
    fs.rmSync(registryDir, { recursive: true, force: true });
    for (const v of LLM_VARS) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
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

  it('POST /task answers through the configured provider', async () => {
    const res = await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What can you help with?' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.explanation).toBe('echo from priced');
    expect(body.model).toBe('priced');
  });

  it("sends the selected skill's instructions, and previews exactly what is sent", async () => {
    seen.length = 0;
    const question = 'Explain the fixture numbers';
    const res = await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skillSlug?: string }).skillSlug).toBe('fixture-skill');
    const [system, user] = seen[0].messages ?? [];
    expect(system.role).toBe('system');
    expect(system.content).toContain('Answer in one sentence.');
    expect(system.content).not.toContain("slug: 'fixture-skill'");

    const preview = (await (
      await authed(`${baseUrl}/context/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, skillSlug: 'fixture-skill' }),
      })
    ).json()) as { systemPrompt: string; userContent: string };
    expect(preview.systemPrompt).toBe(system.content);
    expect(preview.userContent).toBe(user.content);
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
    expect(run.status).toBe('done');
    expect(run.input).toBe('record me');
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
    expect(run.steps[0].kind).toBe('llm');
    expect((run.steps[0].input as { prompt: string }).prompt).toContain('trace me');
  });

  /** POST /task, then fetch the run it created with its steps. */
  async function taskRun(body: Record<string, unknown>) {
    const res = await authed(`${baseUrl}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const list = (await (await authed(`${baseUrl}/runs?limit=1`)).json()) as {
      runs: Array<{ id: string }>;
    };
    const run = (await (await authed(`${baseUrl}/runs/${list.runs[0].id}`)).json()) as {
      status: string;
      input: string;
      exitReason?: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      costKnown: boolean;
      steps: Array<{
        kind: string;
        status: string;
        input: { provider: string; model: string; prompt: string };
        output: { text?: string; error?: string };
        tokensIn?: number;
        tokensOut?: number;
        costUsd: number | null;
      }>;
    };
    return { res, run };
  }

  it('accounts for the tokens and cost of each model call', async () => {
    const { run } = await taskRun({ message: 'count me' });

    expect(run.status).toBe('done');
    const llm = run.steps.filter((s) => s.kind === 'llm');
    expect(llm).toHaveLength(1);
    expect(llm[0]).toMatchObject({
      status: 'ok',
      input: { provider: 'fake', model: 'priced' },
      output: { text: 'echo from priced' },
      tokensIn: 1200,
      tokensOut: 300,
    });
    expect(llm[0].costUsd).toBeCloseTo(0.0054, 9);

    expect(run.tokensIn).toBe(1200);
    expect(run.tokensOut).toBe(300);
    expect(run.costUsd).toBeCloseTo(0.0054, 9);
    expect(run.costKnown).toBe(true);
  });

  it('stores triggers, refusing a config that would never fire', async () => {
    const save = (config: unknown) =>
      authed(`${baseUrl}/triggers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

    const bad = await save({ cron: [{ id: 'x', schedule: 'every tuesday', message: 'm' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/invalid schedule/);

    const config = {
      cron: [{ id: 'daily', schedule: '0 9 * * *', message: 'morning summary' }],
      file: [],
      webhooks: { deploy: { message: 'deploy finished' } },
    };
    expect((await save(config)).status).toBe(200);
    expect(await (await authed(`${baseUrl}/triggers`)).json()).toEqual(config);
  });

  it('records a webhook firing as a run of its own', async () => {
    // Saved by the test above, which also started the triggers.
    const res = await authed(`${baseUrl}/webhook/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };

    const run = (await (await authed(`${baseUrl}/runs/${runId}`)).json()) as {
      trigger: string;
      input: string;
      status: string;
      tokensIn: number;
    };
    expect(run).toMatchObject({ trigger: 'webhook', input: 'deploy finished', status: 'done' });
    expect(run.tokensIn).toBe(1200);

    expect((await authed(`${baseUrl}/webhook/nope`, { method: 'POST' })).status).toBe(404);
    // Leave no cron job running behind the suite.
    await authed(`${baseUrl}/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });

  it('routes a qualified model to its provider and marks an unpriced cost unknown', async () => {
    seen.length = 0;
    const { run } = await taskRun({ message: 'price me', model: 'fakecloud/unpriced' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      model: 'unpriced',
      authorization: 'Bearer fakecloud-test-key',
    });
    expect(run.steps[0].input).toMatchObject({ provider: 'fakecloud', model: 'unpriced' });
    expect(run.steps[0].costUsd).toBeNull();
    expect(run.tokensIn).toBe(1200);
    expect(run.costKnown).toBe(false);
  });

  it('records a failed model call on the run and answers 503', async () => {
    const { res, run } = await taskRun({ message: 'FAIL_ME please' });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('ai_unavailable');
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/returned 500/);
    expect(run.steps[0]).toMatchObject({ kind: 'llm', status: 'error' });
    expect(run.steps[0].output.error).toMatch(/upstream boom/);
    expect(run.tokensIn).toBe(0);
  });

  it('lists providers with qualified models and no endpoint URLs', async () => {
    const res = await authed(`${baseUrl}/providers`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('127.0.0.1');

    const body = JSON.parse(text) as {
      providers: Array<{ id: string; ready: boolean; models: Array<{ ref: string }> }>;
      current: { provider: string; model: string };
    };
    expect(body.current).toEqual({ provider: 'fake', model: 'priced' });
    expect(body.providers.map((p) => p.id)).toEqual(['fake', 'fakecloud']);
    expect(body.providers[1]).toMatchObject({
      ready: true,
      models: [{ ref: 'fakecloud/unpriced' }],
    });
  });

  it('reports the configured provider in /health', async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
      llm: Record<string, unknown>;
    };
    expect(body.llm).toEqual({ mode: 'local', provider: 'fake', model: 'priced', available: true });
  });

  it('totals model spend in /metrics, flagging unpriced calls', async () => {
    const body = (await (await authed(`${baseUrl}/metrics`)).json()) as Record<string, number>;
    expect(body.llm_cost_usd_total).toBeGreaterThanOrEqual(0.0054);
    expect(body.llm_unpriced_calls_total).toBeGreaterThanOrEqual(1);
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

  it('exposes the approvals inbox', async () => {
    const res = await authed(`${baseUrl}/approvals`);
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { approvals: unknown[] }).approvals)).toBe(true);
  });

  it('404s a decision on an approval that is not pending', async () => {
    const res = await authed(`${baseUrl}/approvals/9999/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('approval_not_pending');
  });

  const post = (url: string, body?: unknown, signal?: AbortSignal) =>
    authed(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait for a condition rather than a clock. A fixed sleep that is ample on a
   * laptop can be too short on a loaded CI runner, and a test that acts before
   * its request has arrived fails for reasons that have nothing to do with the
   * code under test.
   */
  async function waitFor(what: string, condition: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  /** Wait until the fake provider is serving one more slow call than before. */
  const slowCallArrives = (before: number) =>
    waitFor('the slow call to reach the provider', () => slowCalls.started > before);

  /** The newest run, once it has left the executing state. */
  async function settledLatestRun(): Promise<{ id: string; status: string; exitReason?: string }> {
    // Generous: under a loaded CI runner a slow call can take seconds to settle.
    for (let i = 0; i < 200; i++) {
      const { runs } = (await (await authed(`${baseUrl}/runs?limit=1`)).json()) as {
        runs: Array<{ id: string; status: string; exitReason?: string }>;
      };
      if (runs[0] && runs[0].status !== 'executing') return runs[0];
      await sleep(50);
    }
    throw new Error('run never settled');
  }

  it('stops a run in flight, pauses triggers, and resumes them', async () => {
    // Before, /kill only refused approvals: runs, spend and schedules carried on.
    const started = slowCalls.started;
    const task = post(`${baseUrl}/task`, { message: 'SLOW kill me' });
    await slowCallArrives(started);

    const killed = await post(`${baseUrl}/kill`);
    expect(killed.status).toBe(200);
    const body = (await killed.json()) as {
      cancelledRuns: number;
      triggersPaused: boolean;
    };
    expect(body.cancelledRuns).toBeGreaterThanOrEqual(1);
    expect(body.triggersPaused).toBe(true);

    // The task answers that it was cancelled — not that the provider failed.
    const taskRes = await task;
    expect(taskRes.status).toBe(409);
    expect(((await taskRes.json()) as { error: string }).error).toBe('run_cancelled');
    expect(await settledLatestRun()).toMatchObject({
      status: 'cancelled',
      exitReason: 'Kill switch engaged',
    });

    // While paused, a saved trigger does not start and a webhook is refused.
    const saved = await post(`${baseUrl}/triggers`, { webhooks: { ping: { message: 'pong' } } });
    expect(await saved.json()).toMatchObject({ ok: true, paused: true });
    expect((await post(`${baseUrl}/webhook/ping`)).status).toBe(503);
    expect(await (await authed(`${baseUrl}/kill`)).json()).toMatchObject({ triggersPaused: true });

    const resumed = await post(`${baseUrl}/resume`);
    expect(await resumed.json()).toMatchObject({ ok: true, wasPaused: true });
    expect((await post(`${baseUrl}/webhook/ping`)).status).toBe(200);

    await post(`${baseUrl}/triggers`, {});
  });

  it('can stop runs without pausing the schedule', async () => {
    const body = (await (await post(`${baseUrl}/kill`, { triggers: false })).json()) as {
      triggersPaused: boolean;
    };
    expect(body.triggersPaused).toBe(false);
    expect(await (await authed(`${baseUrl}/kill`)).json()).toMatchObject({ triggersPaused: false });
  });

  it('stops a streamed call when the client hangs up', async () => {
    const session = (await (await post(`${baseUrl}/sessions`)).json()) as { id: string };
    const before = slowCalls.abandoned;
    const started = slowCalls.started;
    const client = new AbortController();
    const pending = post(
      `${baseUrl}/sessions/${session.id}/send`,
      { text: 'SLOW stream' },
      client.signal
    )
      .then((r) => r.text())
      .catch(() => undefined);
    await slowCallArrives(started);
    client.abort();
    await pending;

    // Recorded as cancelled, and the gateway walked away from the provider
    // rather than keep paying for an answer nobody would read.
    expect(await settledLatestRun()).toMatchObject({
      status: 'cancelled',
      exitReason: 'The client disconnected.',
    });
    await waitFor('the provider call to be abandoned', () => slowCalls.abandoned > before);
  });

  it('names the run first on a stream, and stops it by id without a hang-up', async () => {
    // The desktop sidecar runs under Bun, where a hang-up is invisible, so
    // cancelling by id is the path that must work everywhere.
    const session = (await (await post(`${baseUrl}/sessions`)).json()) as { id: string };
    const res = await post(`${baseUrl}/sessions/${session.id}/send`, { text: 'SLOW by id' });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let runId = '';
    while (!runId) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      runId = /"type":"start","runId":"([^"]+)"/.exec(text)?.[1] ?? '';
    }
    expect(runId).toMatch(/^run_/);

    const cancelled = await post(`${baseUrl}/runs/${runId}/cancel`);
    expect(await cancelled.json()).toEqual({ ok: true, id: runId });

    // The same connection then carries the outcome.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toMatch(/"type":"error"/);
    const run = (await (await authed(`${baseUrl}/runs/${runId}`)).json()) as {
      status: string;
      exitReason: string;
    };
    expect(run).toMatchObject({ status: 'cancelled', exitReason: 'Cancelled by request' });

    // A second cancel finds nothing running.
    expect((await post(`${baseUrl}/runs/${runId}/cancel`)).status).toBe(404);
  });

  it('finishes the call anyway when the client asks it to', async () => {
    const started = slowCalls.started;
    const client = new AbortController();
    const pending = post(
      `${baseUrl}/task`,
      { message: 'SLOW but keep going', continueOnDisconnect: true },
      client.signal
    ).catch(() => undefined);
    // Hang up only once the run exists and its model call is in flight, so the
    // newest run below is this one and not the previous test's.
    await slowCallArrives(started);
    client.abort();
    await pending;

    const run = await settledLatestRun();
    expect(run.status).toBe('done');
  }, 10_000);

  it('requires a token for approvals and the kill switch', async () => {
    expect((await fetch(`${baseUrl}/approvals`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/kill`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/resume`, { method: 'POST' })).status).toBe(401);
  });

  it('streams events, accepting the token as a query parameter', async () => {
    const ok = await fetch(`${baseUrl}/events?token=${TEST_TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/event-stream');
    await ok.body?.cancel();
    expect((await fetch(`${baseUrl}/events`)).status).toBe(401);
  });

  describe('chat console', () => {
    const json = (url: string, body?: unknown, method = 'POST') =>
      authed(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    /** Read an SSE response to completion and return its events. */
    async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
      const text = await res.text();
      return text
        .split('\n\n')
        .filter((frame) => frame.startsWith('data:'))
        .map((frame) => JSON.parse(frame.slice(5).trim()) as Record<string, unknown>);
    }

    it('streams a raw answer and records it as a run', async () => {
      const created = await json(`${baseUrl}/sessions`, { title: 'Raw chat' });
      expect(created.status).toBe(201);
      const session = (await created.json()) as { id: string; mode: string };
      expect(session.mode).toBe('raw');

      seen.length = 0;
      const res = await json(`${baseUrl}/sessions/${session.id}/send`, { text: 'hello there' });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const events = await readEvents(res);

      // The answer arrives in pieces, then one final event with the stored message.
      expect(events.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual([
        'echo ',
        'from ',
        'priced',
      ]);
      const done = events.at(-1) as {
        type: string;
        runId: string;
        message: { content: string; meta: Record<string, unknown> };
      };
      expect(done.type).toBe('done');
      expect(done.message.content).toBe('echo from priced');
      expect(done.message.meta).toMatchObject({ mode: 'raw', provider: 'fake', tokensIn: 1200 });
      expect(seen[0].stream).toBe(true);

      const run = (await (await authed(`${baseUrl}/runs/${done.runId}`)).json()) as {
        trigger: string;
        costUsd: number;
      };
      expect(run.trigger).toBe('manual');
      expect(run.costUsd).toBeCloseTo(0.0054, 9);
    });

    it('sends the conversation, and nothing of its own, in raw mode', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      await json(`${baseUrl}/sessions/${session.id}/send`, { text: 'first', stream: false });
      seen.length = 0;
      await json(`${baseUrl}/sessions/${session.id}/send`, { text: 'second', stream: false });

      // History is carried; no system prompt is added — that is what raw means.
      expect(seen[0].messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'echo from priced' },
        { role: 'user', content: 'second' },
      ]);
      expect(seen[0].messages?.some((m) => m.role === 'system')).toBe(false);
    });

    it('keeps the exact request body for inspection', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const sent = (await (
        await json(`${baseUrl}/sessions/${session.id}/send`, { text: 'inspect me', stream: false })
      ).json()) as { message: { meta: { request: { model: string } } } };
      expect(sent.message.meta.request.model).toBe('priced');
    });

    it('runs the full pipeline in managed mode', async () => {
      const session = (await (await json(`${baseUrl}/sessions`, { mode: 'managed' })).json()) as {
        id: string;
      };
      seen.length = 0;
      const sent = (await (
        await json(`${baseUrl}/sessions/${session.id}/send`, {
          text: 'managed please',
          stream: false,
        })
      ).json()) as { message: { content: string; meta: Record<string, unknown> } };

      expect(sent.message.meta).toMatchObject({ mode: 'managed' });
      // The managed pipeline adds the system prompt the raw one omits.
      expect(seen[0].messages?.[0].role).toBe('system');
    });

    it('titles an untitled conversation after its opening line', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      await json(`${baseUrl}/sessions/${session.id}/send`, { text: 'Summarise Q3', stream: false });
      const fetched = (await (await authed(`${baseUrl}/sessions/${session.id}`)).json()) as {
        title: string;
        messages: unknown[];
      };
      expect(fetched.title).toBe('Summarise Q3');
      expect(fetched.messages).toHaveLength(2);
    });

    it('refuses an empty message and an unknown session', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const empty = await json(`${baseUrl}/sessions/${session.id}/send`, {
        text: '   ',
        stream: false,
      });
      expect(empty.status).toBe(400);
      const missing = await json(`${baseUrl}/sessions/ses_nope/send`, {
        text: 'hi',
        stream: false,
      });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe('invalid_session');
    });

    it('reports a provider failure as an event on an accepted stream', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const events = await readEvents(
        await json(`${baseUrl}/sessions/${session.id}/send`, { text: 'FAIL_ME now' })
      );
      expect(events.at(-1)).toMatchObject({ type: 'error' });
      expect(String(events.at(-1)?.error)).toMatch(/returned 500/);
    });

    it('compares models side by side and promotes the chosen column', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const res = await json(`${baseUrl}/sessions/${session.id}/compare`, {
        text: 'which is better',
        models: ['fake/priced', 'fakecloud/unpriced', 'fake/does-not-matter'],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runId: string;
        messageId: number;
        columns: Array<{ model: string; text?: string; costUsd: number | null; latencyMs: number }>;
      };

      expect(body.columns.map((c) => c.model)).toEqual([
        'fake/priced',
        'fakecloud/unpriced',
        'fake/does-not-matter',
      ]);
      expect(body.columns[0].costUsd).toBeCloseTo(0.0054, 9);
      // An unpriced model reports unknown, not free.
      expect(body.columns[1].costUsd).toBeNull();
      expect(body.columns[0].latencyMs).toBeGreaterThanOrEqual(0);

      // Every column is charged to the one run.
      const run = (await (await authed(`${baseUrl}/runs/${body.runId}`)).json()) as {
        tokensIn: number;
        costKnown: boolean;
        steps: unknown[];
      };
      expect(run.steps).toHaveLength(3);
      expect(run.tokensIn).toBe(3600);
      expect(run.costKnown).toBe(false);

      // The first answer stands until a human picks another.
      const before = (await (await authed(`${baseUrl}/sessions/${session.id}`)).json()) as {
        messages: Array<{ content: string; meta?: { chosen?: number } }>;
      };
      expect(before.messages.at(-1)?.meta?.chosen).toBe(0);

      const promoted = await json(`${baseUrl}/sessions/${session.id}/promote`, {
        messageId: body.messageId,
        index: 1,
      });
      expect(promoted.status).toBe(200);
      const after = (await (await authed(`${baseUrl}/sessions/${session.id}`)).json()) as {
        messages: Array<{
          content: string;
          meta?: { chosen?: number; columns?: Array<{ model: string }> };
        }>;
      };
      const turn = after.messages.at(-1)!;
      expect(turn.content).toBe('echo from unpriced');
      expect(turn.meta?.chosen).toBe(1);
      // Promoting chooses; it does not discard the alternatives.
      expect(turn.meta?.columns).toHaveLength(3);
    });

    it('records a model that fails as a column, not as a failed comparison', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const body = (await (
        await json(`${baseUrl}/sessions/${session.id}/compare`, {
          text: 'FAIL_ME everywhere',
          models: ['fake/priced', 'fake/other'],
        })
      ).json()) as { columns: Array<{ error?: string; text?: string }> };

      expect(body.columns.every((c) => c.error && c.text === undefined)).toBe(true);
      expect(body.columns[0].error).toMatch(/returned 500/);
    });

    it('refuses an unknown mode with a status code, before any stream opens', async () => {
      // Before, "garbage" was quietly treated as raw and answered 200.
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const res = await json(`${baseUrl}/sessions/${session.id}/send`, {
        text: 'hi',
        mode: 'garbage',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as { message: string }).message).toMatch(/raw" or "managed/);
    });

    it('refuses non-string models without leaking internals', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const res = await json(`${baseUrl}/sessions/${session.id}/compare`, {
        text: 'hi',
        models: [123, { a: 1 }],
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toMatch(/Model 1 must be a non-empty model reference/);
      expect(text).not.toMatch(/trim is not a function/);
    });

    it('lets a model be compared with itself, to see its variance', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const body = (await (
        await json(`${baseUrl}/sessions/${session.id}/compare`, {
          text: 'twice',
          models: ['fake/priced', 'fake/priced'],
        })
      ).json()) as { columns: Array<{ text?: string }> };
      expect(body.columns).toHaveLength(2);
      expect(body.columns.every((c) => c.text)).toBe(true);
    });

    it('needs at least two models to compare', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      const res = await json(`${baseUrl}/sessions/${session.id}/compare`, {
        text: 'one only',
        models: ['fake/priced'],
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/at least two models/);
    });

    it('deletes a conversation and requires a token throughout', async () => {
      const session = (await (await json(`${baseUrl}/sessions`)).json()) as { id: string };
      expect((await json(`${baseUrl}/sessions/${session.id}`, undefined, 'DELETE')).status).toBe(
        200
      );
      expect((await authed(`${baseUrl}/sessions/${session.id}`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/sessions`)).status).toBe(401);
    });
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
