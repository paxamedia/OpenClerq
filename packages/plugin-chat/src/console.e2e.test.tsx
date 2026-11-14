// @vitest-environment jsdom
/**
 * The chat console's own UI code, in the app, over a real gateway, with plugin checks on.
 *
 * `OpenClerqApp` is mounted over the operator's client with the console as its one bundled
 * plugin; the gateway is the real one (in this process, with the chat plugin's manifest
 * in the folder the app carries, approved by its bundled checksum), and the model is a fake
 * server answering from a script. The console is driven through its page: what is clicked
 * and typed is what a person does. Every request it makes is recorded with the token it
 * carried:
 *
 *  - the console's calls carry a module UI token, never the gateway token;
 *  - each is one the manifest declares, and each declared one was made;
 *  - an endpoint it does not declare is refused with 403 (see plugins.console.test.ts in the
 *    gateway for the whole list) and the console says so;
 *  - the token is renewed before it ends, so a session outlives any one token.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, type Gateway } from '@clerq/gateway';
import { createGatewayClient } from '@clerq/gateway-client';
import { OpenClerqApp } from '@clerq/web';
import { chatManifest, chatPlugin } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom draws nothing, so it does not scroll.
Element.prototype.scrollIntoView = () => undefined;
// ...and has no modal dialogs: the browser's <dialog> opens and closes, and says so.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
};

const TOKEN = 'console-e2e-gateway-token-0123456789';
const KEY = 'sk-fake-console-key-0123456789';
const DECLARED: string[] = chatManifest.permissions.api;
/** The manifest as the app carries it: the file itself, bytes and all, so the gateway's checksum is the bundled one. */
const manifestText = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json'),
  'utf8'
);

// ---------------------------------------------------------------------------
// A model that answers from a script
// ---------------------------------------------------------------------------

interface ModelRequest {
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
}
type Reply = { text?: string; calls?: Array<{ name: string; args: unknown }> };
let script: Reply[] = [];
let callSeq = 0;
/** Streams that are held open until the client goes away. */
let held = 0;

function startFakeModel(): Promise<http.Server> {
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as ModelRequest;
      const last = JSON.stringify(body.messages.at(-1)?.content ?? '');
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'raw answer' } }] })}\n\n`
        );
        if (last.includes('slow question')) {
          // The answer never ends: the person stops it.
          held++;
          req.on('close', () => held--);
          return;
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      const next = script.shift() ?? { text: 'Done.' };
      const calls = (next.calls ?? []).map((c) => ({
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
                content: next.text ?? null,
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
  return new Promise((resolve) => fake.listen(0, '127.0.0.1', () => resolve(fake)));
}

// ---------------------------------------------------------------------------
// What was asked of the gateway, and with which token
// ---------------------------------------------------------------------------

interface Asked {
  method: string;
  path: string;
  /** `gateway` for the operator's token, else the module token it carried. */
  token: string;
  status?: number;
}
const asked: Asked[] = [];
let gatewayBase = '';
const realFetch = globalThis.fetch;

function recordFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const own = gatewayBase !== '' && url.origin === new URL(gatewayBase).origin;
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const entry: Asked | null = own
      ? {
          method: (init?.method ?? 'GET').toUpperCase(),
          path: url.pathname.replace(/^\/v1/, ''),
          token: auth === `Bearer ${TOKEN}` ? 'gateway' : auth.replace('Bearer ', ''),
        }
      : null;
    if (entry) asked.push(entry);
    const res = await realFetch(input, init);
    if (entry) entry.status = res.status;
    return res;
  }) as typeof fetch;
}

/** Whether a `METHOD /path/:id` pattern admits a request: the rule a module token is held to. */
function admits(pattern: string, method: string, p: string): boolean {
  const [m, route] = pattern.split(' ');
  if (m !== '*' && m !== method) return false;
  const want = route.split('/').filter(Boolean);
  const got = p.split('/').filter(Boolean);
  return want.length === got.length && want.every((w, i) => w.startsWith(':') || w === got[i]);
}

/** What the console asked, by the token it carried. */
const consoleCalls = () => asked.filter((a) => a.token.startsWith('clqm_'));
/** Whatever the manifest declares, whoever asked. */
const declaredCalls = () => asked.filter((a) => DECLARED.some((d) => admits(d, a.method, a.path)));

// ---------------------------------------------------------------------------
// A gateway, an app, and a person
// ---------------------------------------------------------------------------

let gw: Gateway;
let fake: http.Server;
let dir: string;
let folder: string;
let root: Root;
let host: HTMLElement;
const saved: Record<string, string | undefined> = {};
const VARS = [
  'HOME',
  'CLERQ_PROVIDERS_FILE',
  'CLERQ_LLM_PROVIDER',
  'CLERQ_KEYCHAIN',
  'FAKE_CHAT_KEY',
];
const operator = () => createGatewayClient({ baseUrl: gatewayBase, token: TOKEN });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for something to be true, letting React settle between looks; say what it was waiting for. */
async function until(check: () => unknown, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok: unknown = false;
    try {
      ok = check();
    } catch {
      ok = false;
    }
    if (ok) return;
    await act(async () => {
      await sleep(25);
    });
  }
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ').slice(0, 1500);
  throw new Error(`Timed out waiting for ${what}. The page says: ${text}`);
}

const text = () => document.body.textContent ?? '';
const buttons = () => [...document.querySelectorAll<HTMLElement>('button, [role="radio"], a')];
const named = (name: string | RegExp) =>
  buttons().find((b) => {
    const label = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });

async function click(el: Element | undefined | null, what: string): Promise<void> {
  if (!el) throw new Error(`There is no ${what} to click. The page says: ${text().slice(0, 800)}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function clickNamed(name: string | RegExp): Promise<void> {
  await until(() => named(name), `a "${String(name)}" button`);
  await click(named(name), String(name));
}

async function typeInto(el: HTMLElement | null, value: string): Promise<void> {
  if (!el) throw new Error('No field to type into.');
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
    );
  });
}

const field = (label: string) => {
  const aria = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (aria) return aria;
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  return l?.htmlFor ? document.querySelector<HTMLInputElement>(`[id="${l.htmlFor}"]`) : null;
};

async function go(route: string): Promise<void> {
  await act(async () => {
    window.location.hash = route;
    await sleep(20);
  });
}

/** The conversations the gateway has, asked outside the recorder: the test's own bookkeeping. */
async function knownConversations(): Promise<Set<string>> {
  const res = await realFetch(`${gatewayBase}/v1/sessions?limit=500`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return new Set(
    ((await res.json()) as { sessions: Array<{ id: string }> }).sessions.map((x) => x.id)
  );
}

const openId = () => {
  const m = /#\/m\/chat\/(ses_[^/?]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
};

/** Open a new conversation through the console. Returns its id. */
async function newConversation(): Promise<string> {
  const known = await knownConversations();
  await go('#/m/chat');
  await until(() => named('New conversation'), 'the console to draw');
  await click(named('New conversation'), 'New conversation');
  await until(() => {
    const id = openId();
    return id !== null && !known.has(id);
  }, 'the new conversation to open');
  await until(() => field('Message'), 'the message box');
  return openId() as string;
}

const sessionIds = () =>
  [...document.querySelectorAll('a[href^="#/m/chat/ses_"]')].map((a) =>
    decodeURIComponent((a.getAttribute('href') as string).split('/').at(-1) as string)
  );

async function send(message: string): Promise<void> {
  await typeInto(field('Message'), message);
  await clickNamed('Send');
}

beforeAll(async () => {
  for (const v of VARS) saved[v] = process.env[v];
  fake = await startFakeModel();
  const url = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-console-e2e-')));
  folder = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'folder-')));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.clerq'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.clerq', 'gateway-token'), TOKEN, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dir, 'providers.yaml'),
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
  process.env.HOME = home;
  process.env.CLERQ_PROVIDERS_FILE = path.join(dir, 'providers.yaml');
  process.env.CLERQ_LLM_PROVIDER = 'fake';
  process.env.CLERQ_KEYCHAIN = 'off';
  process.env.FAKE_CHAT_KEY = KEY;
  // What the app carries: a folder with one folder in it, `chat`, holding the manifest.
  const bundled = path.join(dir, 'bundled');
  fs.mkdirSync(path.join(bundled, 'chat'), { recursive: true });
  fs.writeFileSync(path.join(bundled, 'chat', 'manifest.json'), manifestText);
  gw = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: path.join(dir, 'no-modules'),
    bundledPluginsDir: bundled,
    skillsDir: path.join(dir, 'no-skills'),
  });
  await gw.ready;
  const addr = gw.server.address();
  gatewayBase = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
  recordFetch();
  // Plugin checks on: the console is held to what it declares.
  await operator().setPluginSettings({ enforce: true });
}, 30_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await act(async () => root?.unmount());
  await gw?.close({ graceMs: 500 });
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.location.hash = '#/m/chat';
  await act(async () => {
    root.render(
      <OpenClerqApp
        client={operator()}
        host={{ kind: 'web', version: '1.0.0', openUrl: () => undefined }}
        modules={[chatPlugin]}
        // Short, so a long session is a few seconds: the token is renewed at 70% of it.
        pluginTokenSeconds={3}
      />
    );
  });
}

afterEach(() => {
  script = [];
});

describe('the console in the app, with plugin checks on', () => {
  it('is given a client of its own and draws', async () => {
    await mount();
    await until(() => named('New conversation'), 'the console to draw');
    const gatewayId = (await operator().plugins()).plugins.find((p) => p.id === 'chat');
    expect(gatewayId).toMatchObject({ state: 'enabled', approval: { approvedBy: 'bundled' } });
    // The app asked for a token for the plugin with its own (operator) token...
    expect(asked.find((a) => a.path === '/modules/chat/token')).toMatchObject({
      method: 'POST',
      token: 'gateway',
      status: 201,
    });
    // ...and the console's first reads carry the module's token and not that one.
    await until(
      () => consoleCalls().some((a) => a.path === '/sessions'),
      'the console to list conversations'
    );
    expect(declaredCalls().every((a) => a.token.startsWith('clqm_'))).toBe(true);
  });

  it('sends a raw message and shows the answer', async () => {
    const id = await newConversation();
    await send('Hello');
    await until(() => text().includes('raw answer'), 'the raw answer');
    await until(() => sessionIds().includes(id), 'the conversation in the list');
    expect(
      consoleCalls().some((a) => a.method === 'POST' && a.path === `/sessions/${id}/send`)
    ).toBe(true);
    expect(consoleCalls().some((a) => a.method === 'GET' && a.path === '/providers')).toBe(true);
  });

  it('runs a managed turn in a folder, asks before it writes, and does as it is answered', async () => {
    const id = await newConversation();
    await clickNamed('Managed');
    await until(() => text().includes('Managed adds your prompt'), 'the mode to switch');
    // Attach a folder, with "ask before changes".
    await clickNamed('No folder');
    await until(() => field('Folder path'), 'the folder dialog');
    await typeInto(field('Folder path'), folder);
    await typeInto(field('Access'), 'default');
    await clickNamed('Attach');
    await until(
      () => /Ask before changes/.test(named(/Ask before changes/)?.textContent ?? ''),
      'the folder to attach'
    );
    expect(
      consoleCalls().some((a) => a.method === 'POST' && a.path === `/sessions/${id}/update`)
    ).toBe(true);

    script = [
      { calls: [{ name: 'write_file', args: { path: 'out.txt', content: 'hello\n' } }] },
      { text: 'Wrote it.' },
    ];
    await send('Write out.txt');
    await until(() => text().includes('Needs approval'), 'the approval card');
    await clickNamed('Approve');
    await until(() => text().includes('Wrote it.'), 'the answer after the approval');
    expect(fs.readFileSync(path.join(folder, 'out.txt'), 'utf8')).toBe('hello\n');
    const approve = consoleCalls().find((a) => /^\/approvals\/\d+\/approve$/.test(a.path));
    expect(approve).toMatchObject({ method: 'POST', status: 200 });

    script = [
      { calls: [{ name: 'write_file', args: { path: 'no.txt', content: 'x' } }] },
      { text: 'It was refused.' },
    ];
    await send('Write no.txt');
    await until(() => text().includes('Needs approval'), 'the second approval card');
    await clickNamed('Deny');
    await until(() => text().includes('It was refused.'), 'the answer after the refusal');
    expect(fs.existsSync(path.join(folder, 'no.txt'))).toBe(false);
    expect(consoleCalls().some((a) => /^\/approvals\/\d+\/deny$/.test(a.path))).toBe(true);
  });

  it('shows what managed adds over raw, for an answer', async () => {
    // The conversation from before is open; its answer has an Inspector.
    await until(() => named('Inspect'), 'an answer to inspect');
    const inspect = buttons()
      .filter((b) => b.textContent?.trim() === 'Inspect')
      .at(-1);
    await click(inspect, 'Inspect');
    await until(() => text().includes('What managed adds'), 'the mode diff');
    expect(text()).toContain('System prompt (raw sends none)');
    expect(consoleCalls().some((a) => a.method === 'POST' && a.path.endsWith('/mode-diff'))).toBe(
      true
    );
    await click(named('Close') ?? document.querySelector('[aria-label="Close"]'), 'Close');
  });

  it('shows a drafted automation, dry-runs it, and saves it switched off', async () => {
    const spec = [
      'name: ci-triage',
      'on:',
      '  schedule: "0 8 * * 1-5"',
      'targets:',
      `  repos: [local:${folder}]`,
      'agent:',
      '  driver: builtin',
      '  model: fake/good',
      'prompt: Check CI on main and summarise what broke.',
      'publish:',
      '  push: false',
      '  pull_request: none',
      '',
    ].join('\n');
    script = [
      { calls: [{ name: 'draft_automation', args: { spec } }] },
      { text: 'Drafted ci-triage.' },
    ];
    await send('Every weekday at 8 check CI.');
    await until(() => text().includes('ci-triage'), 'the draft card');
    await clickNamed('Dry run');
    await until(() => text().includes('Checked without running anything.'), 'the dry run');
    await clickNamed('Save');
    await until(() => text().includes('Open in Automations'), 'the draft to be saved');
    const automations = (await operator().automations()).automations;
    const saved = automations.find((a) => a.name === 'ci-triage');
    expect(saved).toMatchObject({ enabled: false });
    const calls = consoleCalls().map(
      (a) => `${a.method} ${a.path.replace(/ses_[^/]+/, ':id').replace(/drf_[^/]+/, ':draftId')}`
    );
    expect(calls).toContain('GET /sessions/:id/drafts/:draftId');
    expect(calls).toContain('POST /sessions/:id/drafts/:draftId/dry-run');
    expect(calls).toContain('POST /sessions/:id/drafts/:draftId/save');
  });

  it('compares models and keeps the answer a person chooses', async () => {
    await newConversation();
    await clickNamed('Compare');
    await until(() => text().includes('Pick two or more models'), 'the model picker');
    for (const label of [/Fake · good/, /Fake · other/]) {
      const box = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
        (c) => label.test(c.closest('label')?.textContent ?? '')
      );
      await click(box, String(label));
    }
    await typeInto(field('Message'), 'Which is better?');
    // The same button names the toggle and the send.
    await click(
      buttons()
        .filter((b) => b.textContent?.trim() === 'Compare')
        .at(-1),
      'Compare (send)'
    );
    await until(() => text().includes('In the transcript'), 'the columns');
    await until(() => named('Use this answer'), 'a second answer to choose');
    await click(named('Use this answer'), 'Use this answer');
    await until(
      () => consoleCalls().some((a) => a.path.endsWith('/promote') && a.status === 200),
      'the choice to be kept'
    );
    expect(consoleCalls().some((a) => a.path.endsWith('/compare') && a.status === 200)).toBe(true);
  });

  it('stops an answer in progress, and cancels its run', async () => {
    await newConversation();
    await send('slow question');
    await until(() => text().includes('raw answer') && named('Stop'), 'a partial answer and Stop');
    await clickNamed('Stop');
    await until(() => !named('Stop') && named('Send'), 'the answer to stop');
    await until(
      () =>
        consoleCalls().some(
          (a) => /^\/runs\/[^/]+\/cancel$/.test(a.path) && a.status !== undefined
        ),
      'the run to be cancelled'
    );
    // Asked, and let in: a run that the hang-up already ended answers 404 to the cancel, which is not a refusal.
    const cancel = consoleCalls().find((a) => /^\/runs\/[^/]+\/cancel$/.test(a.path));
    expect([200, 404]).toContain(cancel?.status);
    await until(() => held === 0, 'the fake model to see the stream end');
  });

  it('deletes a conversation after asking', async () => {
    const id = await newConversation();
    await clickNamed('Delete conversation');
    await until(() => text().includes('The conversation and its messages go.'), 'the question');
    await click(
      buttons()
        .filter((b) => b.textContent?.trim() === 'Delete conversation')
        .at(-1),
      'Delete conversation'
    );
    await until(
      () =>
        consoleCalls().some(
          (a) => a.method === 'DELETE' && a.path === `/sessions/${id}` && a.status === 200
        ),
      'the conversation to be deleted'
    );
    expect((await knownConversations()).has(id)).toBe(false);
  });
});

describe('the console over a long session', () => {
  it('goes on working on a renewed token after the one it began with has ended', async () => {
    // A token lives 3 seconds here and is renewed at 70% of that.
    const first = new Set(consoleCalls().map((a) => a.token));
    expect(first.size).toBe(1);
    const [oldest] = [...first];
    // Idle for longer than a token lives. Nothing asks for the old one again; the app has been renewing.
    await act(async () => {
      await sleep(3600);
    });
    const before = consoleCalls().length;
    await newConversation();
    await send('Still here?');
    await until(() => text().includes('raw answer'), 'an answer after the long wait');
    const after = consoleCalls().slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((a) => a.status !== 401 && a.status !== 403)).toBe(true);
    // It is on a token it did not begin with, which is a module token still.
    expect(after.every((a) => a.token.startsWith('clqm_') && !first.has(a.token))).toBe(true);
    // The one it began with has ended.
    const stale = await realFetch(`${gatewayBase}/v1/sessions`, {
      headers: { authorization: `Bearer ${oldest}` },
    });
    expect(stale.status).toBe(401);
    // The app asked for each new token with its own token, not with the old module token.
    const mints = asked.filter((a) => a.path === '/modules/chat/token');
    expect(mints.length).toBeGreaterThanOrEqual(2);
    expect(mints.every((a) => a.token === 'gateway')).toBe(true);
  });

  it('is held to what it declares: its own token is refused anything else', async () => {
    const token = consoleCalls().at(-1)?.token as string;
    const call = (method: string, p: string) =>
      realFetch(`${gatewayBase}/v1${p}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
    expect((await call('GET', '/runs')).status).toBe(403);
    expect((await call('GET', '/automations')).status).toBe(403);
    expect((await call('POST', '/kill')).status).toBe(403);
    expect((await call('GET', '/plugins')).status).toBe(403);
    expect((await call('GET', '/sessions')).status).toBe(200);
  });
});

describe('what the console is allowed and what it did', () => {
  it('made only calls the manifest declares, with a module token and never the gateway token, and every declared call', () => {
    // Relies on the tests above, in this file's order.
    const stray = consoleCalls().filter((a) => !DECLARED.some((d) => admits(d, a.method, a.path)));
    expect(stray.map((a) => `${a.method} ${a.path}`)).toEqual([]);
    expect(declaredCalls().filter((a) => a.token === 'gateway')).toEqual([]);
    const never = DECLARED.filter(
      (d) =>
        !consoleCalls().some(
          (a) =>
            admits(d, a.method, a.path) &&
            a.status !== undefined &&
            a.status !== 401 &&
            a.status !== 403
        )
    );
    expect(never).toEqual([]);
  });
});

describe('when what the gateway says about the plugin changes', () => {
  const postedTo = (p: string, from: number) =>
    asked.slice(from).filter((a) => a.method === 'POST' && a.path === p);

  it('says it is switched off, makes no call for it, and comes back on a new token when it is switched on', async () => {
    await go('#/m/chat');
    await until(() => named('New conversation'), 'the console');
    const mintsBefore = asked.filter((a) => a.path === '/modules/chat/token').length;
    await operator().disablePlugin('chat');
    await until(() => text().includes('Chat is switched off'), 'the notice');
    expect(named('New conversation')).toBeUndefined();
    expect(named('Open Settings → Plugins')).toBeDefined();
    const calls = consoleCalls().length;
    await act(async () => {
      await sleep(400);
    });
    expect(consoleCalls().length).toBe(calls);
    await operator().enablePlugin('chat');
    await until(() => named('New conversation'), 'the console to come back');
    expect(asked.filter((a) => a.path === '/modules/chat/token').length).toBeGreaterThan(
      mintsBefore
    );
  });

  /** Wait until the app has asked the gateway about its plugins again, after `count` asks, and has drawn. */
  const listedAgain = async (count: number) => {
    await until(
      () => asked.filter((a) => a.path === '/plugins').length > count,
      'the app to ask which plugins run'
    );
    await act(async () => {
      await sleep(50);
    });
  };

  it('uses the app’s own client when plugin checks are off, as it did before, and goes back to its token when they are on', async () => {
    await go('#/m/chat');
    await until(() => named('New conversation'), 'the console');
    const asks = asked.filter((a) => a.path === '/plugins').length;
    await operator().setPluginSettings({ enforce: false });
    await listedAgain(asks);
    await until(() => named('New conversation'), 'the console, on the app’s client');
    // A conversation made now is made with the app's token.
    const from = asked.length;
    await click(named('New conversation'), 'New conversation');
    await until(() => postedTo('/sessions', from).length > 0, 'a conversation to be made');
    expect(postedTo('/sessions', from)[0].token).toBe('gateway');

    const mints = asked.filter((a) => a.path === '/modules/chat/token').length;
    const asksAgain = asked.filter((a) => a.path === '/plugins').length;
    await operator().setPluginSettings({ enforce: true });
    await listedAgain(asksAgain);
    await until(
      () =>
        asked.filter((a) => a.path === '/modules/chat/token').length > mints &&
        named('New conversation'),
      'a token for the console, and the console'
    );
    const again = asked.length;
    await click(named('New conversation'), 'New conversation');
    await until(() => postedTo('/sessions', again).length > 0, 'a conversation to be made');
    expect(postedTo('/sessions', again)[0].token).toMatch(/^clqm_/);
  });
});
