/**
 * The chat console's managed mode and conversational authoring, through the
 * gateway's HTTP API. The store, the builtin agent loop and the spec parser are
 * real; the model is a fake OpenAI-compatible server answering from a script.
 *
 *  - raw mode sends the conversation and nothing else: no system prompt, no
 *    memory, no tools;
 *  - managed mode runs a tool-using loop with the system prompt, memory and a
 *    policy-filtered tool set, records steps and tool calls on the message's run,
 *    asks approvals inline and in the inbox, and redacts provider keys;
 *  - a model drafts automations (errors come back with their line); a person
 *    dry-runs and saves them; saved, they are switched off, say where they came
 *    from, and their first push waits; no tool enables, edits or runs one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { evaluate } from '@clerq/policy';
import { offeredTools } from '@clerq/drivers';
import { createGateway } from '../gateway.js';
import { getStore } from '../store.js';
import { chatPolicy, chatTools, CHAT_NEVER } from './tools.js';
import { CHAT_PERMISSION_MODES } from './sessions.js';

const TOKEN = 'chat-managed-test-token-0123456789';
const KEY = 'sk-fake-chat-key-0123456789';

// ---------------------------------------------------------------------------
// A model that answers from a script
// ---------------------------------------------------------------------------

interface Request {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}
type Reply = { text?: string; calls?: Array<{ name: string; args: unknown }> };

const requests: Request[] = [];
let script: Array<Reply | ((req: Request) => Reply)> = [];
let callSeq = 0;

async function startFakeModel(): Promise<http.Server> {
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Request;
      requests.push(body);
      if (body.stream) {
        // Raw mode streams; it is a plain echo.
        res.setHeader('content-type', 'text/event-stream');
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'raw answer' } }] })}\n\n`
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      const next = script.shift() ?? { text: 'Done.' };
      const reply = typeof next === 'function' ? next(body) : next;
      const calls = (reply.calls ?? []).map((c) => ({
        id: `call_${++callSeq}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: reply.text ?? null,
                ...(calls.length ? { tool_calls: calls } : {}),
              },
              finish_reason: calls.length ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()));
  return fake;
}

const VARS = [
  'CLERQ_PROVIDERS_FILE',
  'CLERQ_LLM_PROVIDER',
  'CLERQ_MODEL',
  'CLERQ_KEYCHAIN',
  'FAKE_CHAT_KEY',
];

describe('chat console: managed mode and authoring', () => {
  let baseUrl: string;
  let server: http.Server;
  let fake: http.Server;
  let dir: string;
  let repoDir: string;
  let saved: Record<string, string | undefined>;

  const authed = (url: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${url}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        ...init.headers,
      },
    });
  const post = (url: string, body: unknown = {}) =>
    authed(url, { method: 'POST', body: JSON.stringify(body) });
  const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) =>
    (await (await res).json()) as T;

  async function newSession(body: Record<string, unknown> = { mode: 'managed' }) {
    const res = await post('/sessions', body);
    expect(res.status).toBe(201);
    return json<{ id: string; workspace: string | null; permissionMode: string }>(res);
  }

  /** Send and read the stream to its end, calling `on` with each event. */
  async function send(
    sessionId: string,
    text: string,
    on: (event: Record<string, unknown>) => void | Promise<void> = () => undefined,
    extra: Record<string, unknown> = {}
  ) {
    const res = await post(`/sessions/${sessionId}/send`, { text, ...extra });
    expect(res.status).toBe(200);
    const events: Array<Record<string, unknown>> = [];
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!frame.startsWith('data:')) continue;
        const event = JSON.parse(frame.slice(5).trim()) as Record<string, unknown>;
        events.push(event);
        await on(event);
      }
    }
    return events;
  }

  const done = (events: Array<Record<string, unknown>>) =>
    events.find((e) => e.type === 'done') as {
      runId: string;
      message: { content: string; meta: Record<string, unknown> };
    };

  beforeAll(async () => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    fake = await startFakeModel();
    const url = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-chat-managed-'));
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-chat-folder-')));
    const file = path.join(dir, 'providers.yaml');
    fs.writeFileSync(
      file,
      [
        'providers:',
        '  - id: fake',
        '    label: Fake',
        '    adapter: openai-compat',
        `    baseUrl: ${url}`,
        '    authEnv: FAKE_CHAT_KEY',
        '    defaultModel: good',
        '    models:',
        '      - id: good',
        '        context: 200000',
        '        inputPerM: 1',
        '        outputPerM: 1',
        '      - id: other',
        '        context: 200000',
        '        inputPerM: 1',
        '        outputPerM: 1',
        '',
      ].join('\n')
    );
    for (const v of VARS) delete process.env[v];
    process.env.CLERQ_PROVIDERS_FILE = file;
    process.env.CLERQ_LLM_PROVIDER = 'fake';
    process.env.CLERQ_KEYCHAIN = 'off';
    process.env.FAKE_CHAT_KEY = KEY;
    const { server: s } = createGateway({
      port: 0,
      authToken: TOKEN,
      dbPath: ':memory:',
      modulesDir: '/nonexistent-modules-dir-xyz',
      skillsDir: path.join(dir, 'no-skills'),
    });
    server = s;
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (let i = 0; i < 100; i++) {
      if ((await authed('/sessions')).status === 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await post('/memory/records', {
      type: 'preference',
      key: 'tone',
      value: 'Answers in British English',
    });
  }, 15_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  beforeEach(() => {
    requests.length = 0;
    script = [];
  });

  it('raw mode sends the conversation and nothing else: no system prompt, memory or tools', async () => {
    const s = await newSession({ mode: 'raw' });
    const events = await send(s.id, 'Hello');
    expect(done(events).message.content).toBe('raw answer');
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.tools).toBeUndefined();
    expect(req.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(JSON.stringify(req)).not.toContain('British English');
    // Even with a folder attached, raw stays a text channel.
    await post(`/sessions/${s.id}/update`, { workspace: repoDir });
    requests.length = 0;
    await send(s.id, 'Again');
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].messages.every((m) => m.role !== 'system')).toBe(true);
    const run = await json<{ toolCalls: unknown[] }>(authed(`/runs/${done(events).runId}`));
    expect(run.toolCalls).toEqual([]);
  });

  it('managed mode runs a tool loop with prompt, memory and the tools policy allows, recorded on the run', async () => {
    const s = await newSession();
    script = [
      { text: 'Looking.', calls: [{ name: 'search_memory', args: { query: 'tone' } }] },
      { text: 'You prefer British English.' },
    ];
    const events = await send(s.id, 'What tone do I like?');
    const end = done(events);
    expect(end.message.content).toBe('You prefer British English.');
    expect(end.message.meta).toMatchObject({
      mode: 'managed',
      provider: 'fake',
      model: 'good',
      toolCalls: 1,
      memoryCount: 1,
      runId: end.runId,
    });
    expect(events.some((e) => e.type === 'delta' && String(e.text).includes('Looking.'))).toBe(
      true
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'memory.search' }));

    const first = requests[0];
    const system = first.messages[0];
    expect(system.role).toBe('system');
    expect(String(system.content)).toContain('<memory>');
    expect(String(system.content)).toContain('draft_automation');
    expect(first.tools?.map((t) => t.function.name)).toEqual([
      'search_memory',
      'save_memory',
      'draft_automation',
    ]);
    // The search result went back to the model.
    expect(JSON.stringify(requests[1].messages)).toContain('British English');

    const run = await json<{
      trigger: string;
      sessionId: string;
      status: string;
      toolCalls: Array<{ name: string; status: string; approvalState: string }>;
      steps: Array<{ kind: string }>;
    }>(authed(`/runs/${end.runId}`));
    expect(run).toMatchObject({ trigger: 'manual', sessionId: s.id, status: 'done' });
    expect(run.toolCalls).toEqual([
      expect.objectContaining({
        name: 'memory.search',
        status: 'ok',
        approvalState: 'not_required',
      }),
    ]);
    expect(run.steps.filter((x) => x.kind === 'llm').length).toBeGreaterThanOrEqual(2);
    const calls = await json<{ toolCalls: unknown[] }>(authed(`/runs/${end.runId}/tool-calls`));
    expect(calls.toolCalls).toHaveLength(1);
    expect((await authed('/runs/run_nope/tool-calls')).status).toBe(404);

    // The transcript keeps the answer; the next turn carries it.
    script = [{ text: 'Second.' }];
    requests.length = 0;
    await send(s.id, 'And?');
    expect(requests[0].messages.slice(1).map((m) => m.content)).toEqual([
      'What tone do I like?',
      'You prefer British English.',
      'And?',
    ]);
  });

  it('saves a note the model writes, as the agent’s, with the conversation', async () => {
    const s = await newSession();
    script = [
      { calls: [{ name: 'save_memory', args: { type: 'fact', key: 'pet', value: 'a cat' } }] },
      { text: 'Noted.' },
    ];
    await send(s.id, 'Remember I have a cat.');
    const { records } = await json<{
      records: Array<{ key: string; origin: string; sourceSession: string }>;
    }>(authed('/memory/records?key=pet'));
    expect(records.find((r) => r.key === 'pet')).toMatchObject({
      origin: 'agent',
      sourceSession: s.id,
    });
  });

  it('offers no file or shell tool without a folder, and the repository tools in one that is attached', async () => {
    const s = await newSession();
    script = [{ calls: [{ name: 'run_shell', args: { command: 'ls /' } }] }, { text: 'No.' }];
    const events = await send(s.id, 'List the root');
    expect(requests[0].tools?.map((t) => t.function.name)).not.toContain('run_shell');
    const run = await json<{ toolCalls: Array<{ output: string; status: string }> }>(
      authed(`/runs/${done(events).runId}`)
    );
    expect(run.toolCalls[0].output).toContain('There is no tool "run_shell"');

    const bad = await post(`/sessions/${s.id}/update`, { workspace: path.join(repoDir, 'nope') });
    expect(bad.status).toBe(400);
    expect((await post(`/sessions/${s.id}/update`, { workspace: '/' })).status).toBe(400);
    const attached = await json<{ workspace: string }>(
      post(`/sessions/${s.id}/update`, { workspace: repoDir })
    );
    expect(attached.workspace).toBe(repoDir);

    fs.writeFileSync(path.join(repoDir, 'notes.txt'), `key is ${KEY}\n`);
    requests.length = 0;
    script = [
      { calls: [{ name: 'read_file', args: { path: 'notes.txt' } }] },
      { text: 'Read it.' },
    ];
    const second = await send(s.id, 'Read notes.txt');
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['read_file', 'write_file', 'run_shell', 'search_memory'])
    );
    // The provider key in the file never reaches the model or the record.
    expect(JSON.stringify(requests[1].messages)).not.toContain(KEY);
    expect(JSON.stringify(requests[1].messages)).toContain('«redacted»');
    const stored = await json<{ toolCalls: Array<{ output: string }> }>(
      authed(`/runs/${done(second).runId}`)
    );
    expect(stored.toolCalls[0].output).not.toContain(KEY);
  });

  it('asks for approval in the chat stream and in the inbox, and acts on the answer', async () => {
    const s = await newSession({ mode: 'managed', workspace: repoDir, permissionMode: 'default' });
    expect(s.permissionMode).toBe('default');
    script = [
      { calls: [{ name: 'write_file', args: { path: 'out.txt', content: 'hello\n' } }] },
      { text: 'Wrote it.' },
    ];
    let inbox: Array<{ id: number; sessionId?: string; tool: string }> = [];
    let runStatus = '';
    const events = await send(s.id, 'Write out.txt', async (event) => {
      if (event.type !== 'approval') return;
      const approval = event.approval as { id: number; runId: string; input: unknown };
      expect(approval.input).toEqual({ path: 'out.txt', content: 'hello\n' });
      inbox = (await json<{ approvals: typeof inbox }>(authed('/approvals'))).approvals;
      runStatus = (await json<{ status: string }>(authed(`/runs/${approval.runId}`))).status;
      expect((await post(`/approvals/${approval.id}/approve`)).status).toBe(200);
    });
    expect(inbox).toEqual([expect.objectContaining({ tool: 'fs.write', sessionId: s.id })]);
    expect(runStatus).toBe('awaiting_approval');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval_decided', approved: true })
    );
    expect(fs.readFileSync(path.join(repoDir, 'out.txt'), 'utf8')).toBe('hello\n');
    const run = await json<{ status: string; toolCalls: Array<{ approvalState: string }> }>(
      authed(`/runs/${done(events).runId}`)
    );
    expect(run.status).toBe('done');
    expect(run.toolCalls[0].approvalState).toBe('approved');

    // Denied: nothing is written, and the model is told.
    script = [
      { calls: [{ name: 'write_file', args: { path: 'no.txt', content: 'x' } }] },
      { text: 'It was refused.' },
    ];
    await send(s.id, 'Write no.txt', async (event) => {
      if (event.type === 'approval') {
        await post(`/approvals/${(event.approval as { id: number }).id}/deny`);
      }
    });
    expect(fs.existsSync(path.join(repoDir, 'no.txt'))).toBe(false);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Not permitted');
  });

  const GOOD_SPEC = (name: string) =>
    [
      `name: ${name}`,
      'on:',
      '  schedule: "0 8 * * 1-5"',
      'targets:',
      `  repos: [local:${repoDir}]`,
      'agent:',
      '  driver: builtin',
      '  model: fake/good',
      'prompt: Check CI on main and summarise what broke.',
      'publish:',
      '  push: true',
      '  pull_request: none',
      'approvals:',
      '  push: auto',
      '',
    ].join('\n');

  it('drafts an automation: spec errors go back with their line; a person dry-runs and saves it disabled', async () => {
    const s = await newSession();
    script = [
      {
        calls: [
          {
            name: 'draft_automation',
            args: {
              spec: 'name: ci-triage\ntargets:\n  repos: [local:/tmp]\nagent:\n  driver: nope\nprompt: x\n',
            },
          },
        ],
      },
      (req) => {
        // The error, with its line, is what the model sees.
        const last = JSON.stringify(req.messages.at(-1));
        expect(last).toContain('Line 5');
        expect(last).toContain('5 |   driver: nope');
        return { calls: [{ name: 'draft_automation', args: { spec: GOOD_SPEC('ci-triage') } }] };
      },
      { text: 'Drafted ci-triage.' },
    ];
    const automationsBefore = (await json<{ automations: unknown[] }>(authed('/automations')))
      .automations.length;
    const events = await send(s.id, 'Every weekday at 8 check CI and summarise.');
    const end = done(events);
    const drafts = end.message.meta.drafts as Array<{ id: string; name: string }>;
    expect(drafts).toEqual([expect.objectContaining({ name: 'ci-triage' })]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'draft' }));
    // Drafting saved nothing.
    expect(
      (await json<{ automations: unknown[] }>(authed('/automations'))).automations
    ).toHaveLength(automationsBefore);

    const draft = await json<{
      source: string;
      summary: { schedule: string; pushApproval: string };
    }>(authed(`/sessions/${s.id}/drafts/${drafts[0].id}`));
    expect(draft.source).toBe(GOOD_SPEC('ci-triage'));
    expect(draft.summary).toMatchObject({ schedule: '0 8 * * 1-5', pushApproval: 'auto' });
    expect(
      (await json<{ drafts: unknown[] }>(authed(`/sessions/${s.id}/drafts`))).drafts
    ).toHaveLength(1);

    const runsBefore = (await json<{ runs: unknown[] }>(authed('/runs?limit=500'))).runs.length;
    const dry = await json<{
      executed: boolean;
      timeZone: string;
      nextFirings: string[];
      repo: { path: string };
      checks: Array<{ level: string; message: string }>;
      estimate: { perRunUsd: number | null; firingsPerMonth: number; note: string };
      policy: { approvalRequired: string[] };
    }>(post(`/sessions/${s.id}/drafts/${drafts[0].id}/dry-run`));
    expect(dry.executed).toBe(false);
    expect(dry.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(dry.nextFirings).toHaveLength(10);
    for (const at of dry.nextFirings) {
      const d = new Date(at);
      expect(d.getHours()).toBe(8);
      expect([1, 2, 3, 4, 5]).toContain(d.getDay());
    }
    expect(dry.repo.path).toBe(repoDir);
    expect(dry.estimate.perRunUsd).toBeNull();
    expect(dry.estimate.firingsPerMonth).toBeGreaterThanOrEqual(20);
    // First push waits, whatever the draft asked for.
    expect(dry.policy.approvalRequired).toContain('git.push');
    expect(dry.checks.map((c) => c.message)).toContain(
      'Pushing waits for your approval in the Approvals inbox.'
    );
    // A dry run executes nothing.
    expect((await json<{ runs: unknown[] }>(authed('/runs?limit=500'))).runs).toHaveLength(
      runsBefore
    );

    const savedRes = await post(`/sessions/${s.id}/drafts/${drafts[0].id}/save`);
    expect(savedRes.status).toBe(201);
    const saved = await json<{ id: string; enabled: boolean; authoredBy: string }>(savedRes);
    expect(saved).toMatchObject({ enabled: false, authoredBy: `chat ${s.id}` });
    const listed = await json<{ authoredBy: string; enabled: boolean }>(
      authed(`/automations/${saved.id}`)
    );
    expect(listed).toMatchObject({ enabled: false, authoredBy: `chat ${s.id}` });
    const preview = await json<{ policy: { approvalRequired: string[] } }>(
      post('/automations/preview', { spec: GOOD_SPEC('ci-triage'), id: saved.id })
    );
    expect(preview.policy.approvalRequired).toContain('git.push');
    // Saved once.
    expect((await post(`/sessions/${s.id}/drafts/${drafts[0].id}/save`)).status).toBe(400);
    expect((await post(`/sessions/${s.id}/drafts/drf_nope/save`)).status).toBe(400);
  });

  it('has no tool that saves, enables, edits or runs an automation, and refuses any call that tries', async () => {
    // Saved by a person from an earlier draft, still off.
    const s = await newSession();
    script = [
      { calls: [{ name: 'draft_automation', args: { spec: GOOD_SPEC('no-arming') } }] },
      { text: 'Drafted.' },
    ];
    const drafted = done(await send(s.id, 'Draft one'));
    const draftId = (drafted.message.meta.drafts as Array<{ id: string }>)[0].id;
    const saved = await json<{ id: string }>(post(`/sessions/${s.id}/drafts/${draftId}/save`));

    // The model tries everything it might: none exists, nothing changes.
    const attempts = [
      'enable_automation',
      'run_automation',
      'save_automation',
      'update_automation',
      'spawn_agent',
    ];
    script = [
      { calls: attempts.map((name) => ({ name, args: { id: saved.id } })) },
      // A draft that asks to be enabled is still only a draft.
      {
        calls: [
          { name: 'draft_automation', args: { spec: `${GOOD_SPEC('armed')}enabled: true\n` } },
        ],
      },
      { text: 'I cannot.' },
    ];
    const events = await send(s.id, 'Switch it on and run it now.');
    const run = await json<{ toolCalls: Array<{ name: string; output: string }> }>(
      authed(`/runs/${done(events).runId}`)
    );
    for (const name of attempts) {
      expect(run.toolCalls.find((c) => c.name === name)?.output).toContain(
        `There is no tool "${name}"`
      );
    }
    expect(run.toolCalls.at(-1)?.output).toContain('not drafted');
    const after = await json<{ enabled: boolean }>(authed(`/automations/${saved.id}`));
    expect(after.enabled).toBe(false);
    const db = getStore();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM runs WHERE automation_id = ?').get(saved.id)?.n
    ).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM automations WHERE enabled = 1').get()?.n).toBe(0);

    // Whatever the folder or permission mode, the tool set is the same short list,
    // and the rules deny every arming action by name.
    for (const workspace of [false, true]) {
      for (const permissionMode of CHAT_PERMISSION_MODES) {
        const rules = chatPolicy({ workspace, permissionMode, memoryReadTypes: ['fact'] });
        const names = offeredTools(rules, {
          repository: workspace,
          extra: chatTools({ sessionId: 's', runId: 'r', rules }),
        }).map((t) => t.name);
        for (const name of names) {
          expect(name).toMatch(
            /^(fs\.(read|list|search|write|edit)|runtime\.shell|git\.(status|diff)|memory\.(search|write)|automation\.draft)$/
          );
        }
        if (!workspace)
          expect(names).toEqual([
            'memory.search',
            ...(permissionMode === 'plan' ? [] : ['memory.write']),
            'automation.draft',
          ]);
        for (const never of CHAT_NEVER) {
          expect(evaluate(rules, { name: never, risk: 'write' }).decision).toBe('deny');
        }
      }
    }
  });

  it('shows what managed adds over raw for a message, without calling a model', async () => {
    const s = await newSession();
    await authed('/routing', { method: 'PUT', body: JSON.stringify({ fallback: ['fake/other'] }) });
    try {
      const diff = await json<{
        raw: { system: null; tools: unknown[]; memory: null; model: string; messages: unknown[] };
        managed: {
          system: string;
          memory: { count: number } | null;
          tools: Array<{ modelName: string; decision: string }>;
          model: string;
          fallbackModels: string[];
          messages: unknown[];
        };
      }>(post(`/sessions/${s.id}/mode-diff`, { text: 'Which tone?' }));
      expect(requests).toHaveLength(0);
      expect(diff.raw).toMatchObject({ system: null, tools: [], memory: null, model: 'fake/good' });
      expect(diff.raw.messages).toEqual([{ role: 'user', content: 'Which tone?' }]);
      expect(diff.managed.system).toContain('<memory>');
      expect(diff.managed.memory?.count).toBe(1);
      expect(diff.managed.tools.map((t) => t.modelName)).toEqual([
        'search_memory',
        'save_memory',
        'draft_automation',
      ]);
      expect(diff.managed.fallbackModels).toEqual(['fake/other']);
      // A model named for the message is used as chosen: no fallback.
      const chosen = await json<{ managed: { fallbackModels: string[]; model: string } }>(
        post(`/sessions/${s.id}/mode-diff`, { text: 'x', model: 'fake/other' })
      );
      expect(chosen.managed).toMatchObject({ model: 'fake/other', fallbackModels: [] });
      expect((await post('/sessions/ses_nope/mode-diff', { text: 'x' })).status).toBe(404);
    } finally {
      await authed('/routing', { method: 'PUT', body: JSON.stringify({ fallback: [] }) });
    }
  });
});
