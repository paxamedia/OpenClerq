import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  API_VERSION,
  API_VERSION_HEADER,
  gateway,
  setGatewayBaseUrl,
  setGatewayToken,
  hasGatewayToken,
  GatewayError,
} from './index.js';

type FetchArgs = [string, RequestInit | undefined];

let calls: FetchArgs[];

/** Answer every fetch with `respond`, recording what was asked. */
function stubFetch(respond: (url: string, init?: RequestInit) => Response): void {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return respond(url, init);
  });
}

/** A streamed response whose body arrives in exactly these pieces. */
function sse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } }
  );
}

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const message = { id: 7, role: 'assistant', content: 'hello there', createdAt: 't' };

beforeEach(() => {
  setGatewayBaseUrl('http://127.0.0.1:18790');
  setGatewayToken('test-token-123');
});

afterEach(() => {
  vi.unstubAllGlobals();
  setGatewayToken(null);
});

describe('authentication', () => {
  it('sends the bearer token on every request', async () => {
    stubFetch(() => Response.json({ sessions: [] }));
    await gateway.sessions();
    const headers = calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token-123');
  });

  it('sends no Authorization header without a token', async () => {
    setGatewayToken(null);
    expect(hasGatewayToken()).toBe(false);
    stubFetch(() => Response.json({ sessions: [] }));
    await gateway.sessions();
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('puts the token in the log stream URL, the one place headers cannot go', () => {
    expect(gateway.logsStreamUrl()).toBe(
      'http://127.0.0.1:18790/v1/logs/stream?token=test-token-123'
    );
  });
});

describe('errors', () => {
  it('reports the status and body of a refused request', async () => {
    stubFetch(() => new Response('{"error":"invalid_session"}', { status: 400 }));
    await expect(gateway.session('ses_x')).rejects.toThrow(
      'Gateway 400: {"error":"invalid_session"}'
    );
  });
});

describe('sendMessage — streaming', () => {
  it('delivers deltas in order and resolves with the stored message', async () => {
    stubFetch(() =>
      sse([
        frame({ type: 'delta', text: 'hel' }),
        frame({ type: 'delta', text: 'lo' }),
        frame({ type: 'done', runId: 'run_1', message }),
      ])
    );
    const deltas: string[] = [];
    const result = await gateway.sendMessage('ses_1', { text: 'hi' }, (d) => deltas.push(d));

    expect(deltas).toEqual(['hel', 'lo']);
    expect(result).toEqual({ runId: 'run_1', message });
    expect(JSON.parse(calls[0][1]?.body as string)).toMatchObject({ text: 'hi', stream: true });
  });

  it('reassembles a frame split across network reads', async () => {
    const whole =
      frame({ type: 'delta', text: 'split' }) + frame({ type: 'done', runId: 'r', message });
    stubFetch(() => sse([whole.slice(0, 11), whole.slice(11, 30), whole.slice(30)]));
    const deltas: string[] = [];
    await gateway.sendMessage('ses_1', { text: 'hi' }, (d) => deltas.push(d));
    expect(deltas).toEqual(['split']);
  });

  it('keeps multi-byte characters intact across a split', async () => {
    const whole =
      frame({ type: 'delta', text: 'café ☕' }) + frame({ type: 'done', runId: 'r', message });
    const bytes = new TextEncoder().encode(whole);
    // Cut inside the ☕ code point.
    const cut = bytes.indexOf(0xe2) + 1;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, cut));
              controller.enqueue(bytes.slice(cut));
              controller.close();
            },
          })
        )
    );
    const deltas: string[] = [];
    await gateway.sendMessage('ses_1', { text: 'hi' }, (d) => deltas.push(d));
    expect(deltas).toEqual(['café ☕']);
  });

  it('rejects with the reason an error event carries', async () => {
    stubFetch(() =>
      sse([
        frame({ type: 'delta', text: 'partial' }),
        frame({ type: 'error', error: 'overloaded' }),
      ])
    );
    await expect(gateway.sendMessage('ses_1', { text: 'hi' }, () => {})).rejects.toThrow(
      'overloaded'
    );
  });

  it('rejects a stream that ends without an answer', async () => {
    stubFetch(() => sse([frame({ type: 'delta', text: 'cut off' })]));
    await expect(gateway.sendMessage('ses_1', { text: 'hi' }, () => {})).rejects.toThrow(
      /ended without an answer/
    );
  });

  it('surfaces a refusal made before the stream opened', async () => {
    stubFetch(() => new Response('{"error":"invalid_session"}', { status: 400 }));
    await expect(gateway.sendMessage('ses_1', { text: '' }, () => {})).rejects.toThrow(
      /Gateway 400/
    );
  });

  it('cancels the run by id when the caller aborts, since a hang-up alone may go unseen', async () => {
    const encoder = new TextEncoder();
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith('/cancel')) return Response.json({ ok: true, id: 'run_42' });
      // A stream that names its run, then stays open until the client aborts.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frame({ type: 'start', runId: 'run_42' })));
            controller.enqueue(encoder.encode(frame({ type: 'delta', text: 'partial' })));
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError'))
            );
          },
        })
      );
    });

    const stop = new AbortController();
    const deltas: string[] = [];
    const pending = gateway.sendMessage(
      'ses_1',
      { text: 'long answer' },
      (d) => {
        deltas.push(d);
        stop.abort();
      },
      stop.signal
    );

    await expect(pending).rejects.toThrow();
    expect(deltas).toEqual(['partial']);
    const cancel = calls.find(([url]) => url.endsWith('/cancel'));
    expect(cancel?.[0]).toBe('http://127.0.0.1:18790/v1/runs/run_42/cancel');
    expect(cancel?.[1]?.method).toBe('POST');
  });

  it('passes continueOnDisconnect through', async () => {
    stubFetch(() => sse([frame({ type: 'done', runId: 'r', message })]));
    await gateway.sendMessage('ses_1', { text: 'hi', continueOnDisconnect: true }, () => {});
    expect(JSON.parse(calls[0][1]?.body as string)).toMatchObject({ continueOnDisconnect: true });
  });
});

describe('sendMessage — without streaming', () => {
  it('asks for a single JSON answer when no delta handler is given', async () => {
    stubFetch(() => Response.json({ runId: 'run_2', message }));
    const result = await gateway.sendMessage('ses_1', { text: 'hi' });
    expect(result.runId).toBe('run_2');
    expect(JSON.parse(calls[0][1]?.body as string)).toMatchObject({ stream: false });
  });
});

describe('kill switch', () => {
  it('sends only the parts the caller wants to leave out', async () => {
    stubFetch(() =>
      Response.json({ ok: true, deniedApprovals: 0, cancelledRuns: 2, triggersPaused: false })
    );
    const res = await gateway.kill({ triggers: false });
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/kill');
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ triggers: false });
    expect(res.cancelledRuns).toBe(2);
  });

  it('resumes with a POST', async () => {
    stubFetch(() => Response.json({ ok: true, triggersResumed: true, wasPaused: true }));
    await gateway.resume();
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/resume');
    expect(calls[0][1]?.method).toBe('POST');
  });
});

describe('addresses', () => {
  it('encodes ids into the path, so an id cannot redirect the request', async () => {
    stubFetch(() => Response.json({ ok: true }));
    await gateway.deleteSession('../../kill');
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/sessions/..%2F..%2Fkill');
  });

  it('falls back to the default gateway URL when given an empty one', async () => {
    setGatewayBaseUrl('   ');
    stubFetch(() => Response.json({ sessions: [] }));
    await gateway.sessions();
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/sessions?limit=50');
  });
});

describe('automations', () => {
  it('sends the spec as YAML text and starts runs by id', async () => {
    stubFetch((url) =>
      url.endsWith('/run') ? Response.json({ runId: 'run_1' }) : Response.json({ id: 'aut_1' })
    );
    await gateway.createAutomation('name: x\n');
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/automations');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ spec: 'name: x\n' });
    expect(await gateway.runAutomation('aut 1')).toEqual({ runId: 'run_1' });
    expect(calls[1][0]).toBe('http://127.0.0.1:18790/v1/automations/aut%201/run');
  });

  it('carries a refusal’s status and body, so an editor can point at the line', async () => {
    stubFetch(() =>
      Response.json({ error: 'invalid_spec', message: 'bad', line: 3, column: 5 }, { status: 400 })
    );
    const err = await gateway.previewAutomation('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ status: 400, body: { line: 3, column: 5 } });
  });
});

describe('event stream', () => {
  const event = (id: string, name: string) =>
    `id: ${id}\ndata: ${JSON.stringify({ id, name, at: 't', context: {}, payload: {} })}\n\n`;

  it('builds an EventSource URL with the token, filter and start point', () => {
    const url = new URL(
      gateway.eventsStreamUrl({ names: ['run.', 'approval.'], lastEventId: 'a-3' })
    );
    expect(url.pathname).toBe('/v1/events/stream');
    expect(url.searchParams.get('token')).toBe('test-token-123');
    expect(url.searchParams.get('names')).toBe('run.,approval.');
    expect(url.searchParams.get('lastEventId')).toBe('a-3');
  });

  it('reconnects after a drop, resuming from the last event and reporting a reset', async () => {
    const controller = new AbortController();
    const got: string[] = [];
    let resets = 0;
    let n = 0;
    stubFetch(() => {
      n += 1;
      if (n === 1)
        return sse([
          'id: a-0\n: connected\n\n',
          event('a-1', 'run.started'),
          event('a-2', 'run.co'),
        ]);
      if (n === 2) return sse(['event: reset\nid: b-0\ndata: {}\n\n', event('b-1', 'run.started')]);
      controller.abort();
      return sse([]);
    });
    await gateway.streamEvents((e) => got.push(e.id), {
      names: ['run.'],
      signal: controller.signal,
      retryMs: 1,
      onReset: () => resets++,
    });
    expect(got).toEqual(['a-1', 'a-2', 'b-1']);
    expect(resets).toBe(1);
    expect(calls[0][0]).toContain('/events/stream?names=run.');
    const second = calls[1][1]?.headers as Record<string, string>;
    expect(second['Last-Event-ID']).toBe('a-2');
    expect(second.Authorization).toBe('Bearer test-token-123');
    expect((calls[2][1]?.headers as Record<string, string>)['Last-Event-ID']).toBe('b-1');
  });

  it('gives up on a refused token', async () => {
    stubFetch(() => new Response('{}', { status: 401 }));
    await expect(gateway.streamEvents(() => undefined, { retryMs: 1 })).rejects.toBeInstanceOf(
      GatewayError
    );
  });
});

describe('run history', () => {
  it('passes since as an ISO time', async () => {
    stubFetch(() => Response.json({ runs: [] }));
    await gateway.runs(1000, { since: new Date('2026-11-02T00:00:00Z') });
    expect(calls[0][0]).toBe(
      'http://127.0.0.1:18790/v1/runs?limit=1000&since=2026-11-02T00%3A00%3A00.000Z'
    );
  });
});

describe('records, search and inbox', () => {
  it('build their queries', async () => {
    stubFetch(() => Response.json({}));
    await gateway.records({ type: 'person', q: 'ada' });
    await gateway.search('ada', { types: ['core:person', 'crm:deal'] });
    await gateway.inbox({ status: 'open' });
    await gateway.setInboxStatus('inb_1', 'done');
    expect(calls.map((c) => c[0].replace('http://127.0.0.1:18790/v1', ''))).toEqual([
      '/records?type=person&q=ada',
      '/search?q=ada&types=core%3Aperson%2Ccrm%3Adeal',
      '/inbox?status=open',
      '/inbox/items/inb_1',
    ]);
    expect(calls[3][1]?.method).toBe('PATCH');
  });
});

describe('memory', () => {
  it('sends a key with its type, and deletes with the token', async () => {
    stubFetch(() => Response.json({ ok: true }));
    await gateway.setMemory('tone', 'short', { type: 'preference', confidence: 0.9 });
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/memory');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      key: 'tone',
      value: 'short',
      type: 'preference',
      confidence: 0.9,
    });

    // A delete needs the token as much as any other call.
    await gateway.deleteMemory('a key/with slash');
    expect(calls[1][0]).toBe('http://127.0.0.1:18790/v1/memory/a%20key%2Fwith%20slash');
    expect(calls[1][1]?.method).toBe('DELETE');
    expect((calls[1][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token-123'
    );
    await gateway.deleteMemoryRecord('mem_1');
    expect(calls[2][0]).toBe('http://127.0.0.1:18790/v1/memory/records/mem_1');
    expect((calls[2][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token-123'
    );
  });

  it('lists, searches and filters records', async () => {
    stubFetch(() => Response.json({ records: [], results: [], mode: 'fts5', query: 'x' }));
    await gateway.memoryRecords({ type: 'procedure', status: 'superseded' });
    expect(calls[0][0]).toBe(
      'http://127.0.0.1:18790/v1/memory/records?type=procedure&status=superseded'
    );
    await gateway.memoryRecords();
    expect(calls[1][0]).toBe('http://127.0.0.1:18790/v1/memory/records');
    await gateway.searchMemory('quarterly vat', ['fact', 'procedure'], 5);
    expect(calls[2][0]).toBe(
      'http://127.0.0.1:18790/v1/memory/search?q=quarterly+vat&types=fact%2Cprocedure&limit=5'
    );
  });

  it('adds, patches, summarises, undoes and sets the read policy', async () => {
    stubFetch(() => Response.json({}));
    await gateway.addMemoryRecord({ key: 'k', value: 1, type: 'note' });
    await gateway.updateMemoryRecord('mem_1', { value: null });
    await gateway.consolidateMemory('k', { type: 'note', model: 'openai/gpt-5-mini' });
    await gateway.unconsolidateMemory('mem_2');
    await gateway.setMemoryPolicy(['fact']);
    expect(
      calls.map(([u, i]) => `${i?.method} ${u.replace('http://127.0.0.1:18790/v1', '')}`)
    ).toEqual([
      'POST /memory/records',
      'PATCH /memory/records/mem_1',
      'POST /memory/consolidate',
      'POST /memory/records/mem_2/unconsolidate',
      'PUT /memory/policy',
    ]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ value: null });
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({
      key: 'k',
      type: 'note',
      model: 'openai/gpt-5-mini',
    });
    expect(JSON.parse(String(calls[4][1]?.body))).toEqual({ readTypes: ['fact'] });
  });
});

describe('repositories', () => {
  it('reads the list and one repository by an encoded id', async () => {
    stubFetch(() => Response.json({ repos: [] }));
    await gateway.repos();
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/repos');
    expect(calls[0][1]?.method).toBeUndefined();
    stubFetch(() => Response.json({ id: 'repo_a/b', recentRuns: [] }));
    await gateway.repo('repo_a/b');
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/repos/repo_a%2Fb');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token-123'
    );
  });

  it('carries a refusal’s status', async () => {
    stubFetch(() => Response.json({ error: 'repo_not_found' }, { status: 404 }));
    await expect(gateway.repo('repo_x')).rejects.toMatchObject({ status: 404 });
  });

  it('adds one by target, with check only when asked', async () => {
    stubFetch(() => Response.json({ id: 'repo_1', created: true }, { status: 201 }));
    await gateway.addRepo('github:acme/app');
    await gateway.addRepo('github:acme/app', { check: true });
    expect(calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'POST http://127.0.0.1:18790/v1/repos',
      'POST http://127.0.0.1:18790/v1/repos',
    ]);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ target: 'github:acme/app' });
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
      target: 'github:acme/app',
      check: true,
    });
  });

  it('hands an unreachable remote back as a refusal that keeps the check', async () => {
    stubFetch(() =>
      Response.json(
        { error: 'repo_unreachable', message: 'No.', check: { reachable: false } },
        { status: 422 }
      )
    );
    await expect(gateway.addRepo('github:acme/app', { check: true })).rejects.toMatchObject({
      status: 422,
      body: { error: 'repo_unreachable', check: { reachable: false } },
    });
  });
});

describe('approvals', () => {
  it('answers with an empty body, as it always did', async () => {
    stubFetch(() => Response.json({ ok: true }));
    await gateway.decideApproval(7, 'approve');
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/approvals/7/approve');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({});
  });

  it('can say who decided and why', async () => {
    stubFetch(() => Response.json({ ok: true }));
    await gateway.decideApproval(8, 'deny', { by: 'cli', reason: 'not now' });
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/approvals/8/deny');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ by: 'cli', reason: 'not now' });
  });
});

describe('routing', () => {
  it('reads and sets the default fallback chain', async () => {
    stubFetch(() => Response.json({ fallback: ['openai/gpt-5-mini'] }));
    await gateway.routing();
    await gateway.setRouting(['openai/gpt-5-mini']);
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/v1/routing');
    expect(calls[1][1]?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ fallback: ['openai/gpt-5-mini'] });
  });

  it('starts a run with a model of its own only when given one', async () => {
    stubFetch(() => Response.json({ runId: 'run_1' }));
    await gateway.runAutomation('aut_1');
    await gateway.runAutomation('aut_1', 'anthropic/claude-sonnet-4-5');
    expect(String(calls[0][1]?.body)).toBe('{}');
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ model: 'anthropic/claude-sonnet-4-5' });
  });
});

describe('managed chat and drafts', () => {
  it('hands tool activity, approvals and drafts to onEvent, and text to onDelta', async () => {
    const approval = {
      id: 3,
      runId: 'run_1',
      tool: 'fs.write',
      tier: 'medium',
      reason: 'r',
      requestedAt: 't',
    };
    stubFetch(() =>
      sse([
        frame({ type: 'start', runId: 'run_1' }),
        frame({ type: 'tool', id: 'c1', name: 'fs.write', status: 'running' }),
        frame({ type: 'approval', approval }),
        frame({ type: 'approval_decided', id: 3, approved: true }),
        frame({ type: 'draft', draft: { id: 'drf_1', name: 'x', summary: null } }),
        frame({ type: 'delta', text: 'done' }),
        frame({ type: 'done', runId: 'run_1', message }),
      ])
    );
    const events: string[] = [];
    const deltas: string[] = [];
    await gateway.sendMessage(
      'ses_1',
      { text: 'hi' },
      (d) => deltas.push(d),
      undefined,
      (e) => events.push(e.type)
    );
    expect(events).toEqual(['tool', 'approval', 'approval_decided', 'draft']);
    expect(deltas).toEqual(['done']);
  });

  it('reaches the mode diff, the drafts and a run’s tool calls by id', async () => {
    stubFetch(() => Response.json({}));
    await gateway.modeDiff('ses 1', { text: 'hi' });
    await gateway.drafts('ses 1');
    await gateway.draft('ses 1', 'drf 1');
    await gateway.dryRunDraft('ses 1', 'drf 1');
    await gateway.saveDraft('ses 1', 'drf 1');
    await gateway.runToolCalls('run 1');
    await gateway.updateSession('ses 1', { workspace: '/tmp/x', permissionMode: 'default' });
    expect(
      calls.map(
        ([url, init]) => `${init?.method ?? 'GET'} ${url.replace('http://127.0.0.1:18790/v1', '')}`
      )
    ).toEqual([
      'POST /sessions/ses%201/mode-diff',
      'GET /sessions/ses%201/drafts',
      'GET /sessions/ses%201/drafts/drf%201',
      'POST /sessions/ses%201/drafts/drf%201/dry-run',
      'POST /sessions/ses%201/drafts/drf%201/save',
      'GET /runs/run%201/tool-calls',
      'POST /sessions/ses%201/update',
    ]);
    expect(JSON.parse(String(calls[6][1]?.body))).toEqual({
      workspace: '/tmp/x',
      permissionMode: 'default',
    });
  });
});

describe('the API version', () => {
  const headerOf = (init?: RequestInit): string | undefined =>
    (init?.headers as Record<string, string> | undefined)?.[API_VERSION_HEADER];

  it('is one integer, exported', () => {
    expect(API_VERSION).toBe(1);
    expect(API_VERSION_HEADER).toBe('Clerq-Api-Version');
  });

  it('calls /v1 and sends the header on a GET, a POST and a DELETE', async () => {
    stubFetch(() => Response.json({ ok: true, sessions: [], secrets: [] }));
    await gateway.sessions();
    await gateway.setSecret('A', 'b');
    await gateway.deleteSecret('A');
    await gateway.deleteMemory('k');
    await gateway.deleteSession('ses_1');
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/v1/sessions',
      '/v1/secrets',
      '/v1/secrets/A',
      '/v1/memory/k',
      '/v1/sessions/ses_1',
    ]);
    for (const [, init] of calls) expect(headerOf(init)).toBe('1');
  });

  it('sends the header when it follows the event stream and when it streams a reply', async () => {
    stubFetch(() => sse([frame({ type: 'done', runId: 'r', message })]));
    await gateway.sendMessage('ses_1', { text: 'hi' }, () => undefined);
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort();
      return sse([]);
    });
    await gateway.streamEvents(() => undefined, { signal: controller.signal });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0][0]).pathname).toBe('/v1/events/stream');
    expect(headerOf(calls[0][1])).toBe('1');
  });

  it('sends the header even when the caller sets other headers', async () => {
    stubFetch(() => Response.json({}));
    await gateway.health();
    expect(headerOf(calls[0][1])).toBe('1');
    expect((calls[0][1]?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('turns a refused version into a GatewayError in plain words', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'unsupported_api_version', requested: '1', supported: [2] }),
          { status: 400 }
        )
    );
    const err = await gateway.sessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(400);
    expect((err as GatewayError).message).toBe(
      'This gateway speaks API 2; this app needs API 1. Update the app or the gateway.'
    );
    expect((err as GatewayError).body).toMatchObject({ error: 'unsupported_api_version' });
  });

  it('says the same for a delete, a streamed reply and the event stream', async () => {
    const refusal = () =>
      new Response(JSON.stringify({ error: 'unsupported_api_version', supported: [2] }), {
        status: 400,
      });
    stubFetch(refusal);
    await expect(gateway.deleteSecret('A')).rejects.toThrow('This gateway speaks API 2');
    await expect(gateway.sendMessage('s', { text: 'x' })).rejects.toThrow(
      'This gateway speaks API 2'
    );
    // A version the gateway does not serve will not get better by retrying.
    await expect(gateway.streamEvents(() => undefined, { retryMs: 5 })).rejects.toThrow(
      'This gateway speaks API 2'
    );
  });

  it('leaves other 400s as they were', async () => {
    stubFetch(() => new Response('{"error":"invalid_session"}', { status: 400 }));
    await expect(gateway.session('x')).rejects.toThrow('Gateway 400: {"error":"invalid_session"}');
  });
});

describe('checkCompatibility', () => {
  const ok = (api: { version: number; supported: number[] }) =>
    Response.json({ gateway: '1.0.0', api, store: { schema: 21 } });

  it('is compatible with a gateway that serves this version, asking /v1/version with no token', async () => {
    stubFetch(() => ok({ version: 1, supported: [1] }));
    const result = await gateway.checkCompatibility();
    expect(result).toEqual({
      ok: true,
      kind: 'compatible',
      gateway: '1.0.0',
      api: { version: 1, supported: [1] },
      reason: null,
    });
    expect(new URL(calls[0][0]).pathname).toBe('/v1/version');
    expect((calls[0][1]?.headers as Record<string, string>)[API_VERSION_HEADER]).toBe('1');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('is compatible with a gateway that serves more than this version', async () => {
    stubFetch(() => ok({ version: 2, supported: [1, 2] }));
    expect(await gateway.checkCompatibility()).toMatchObject({ ok: true, kind: 'compatible' });
  });

  it('names a gateway that serves only a newer API', async () => {
    stubFetch(() => ok({ version: 2, supported: [2] }));
    expect(await gateway.checkCompatibility()).toEqual({
      ok: false,
      kind: 'gateway_newer',
      gateway: '1.0.0',
      api: { version: 2, supported: [2] },
      reason: 'This gateway speaks API 2; this app needs API 1. Update the app or the gateway.',
    });
  });

  it('reads a newer gateway that refuses /v1 before it can say what it serves', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'unsupported_api_version', requested: '1', supported: [2, 3] }),
          { status: 400 }
        )
    );
    expect(await gateway.checkCompatibility()).toMatchObject({
      ok: false,
      kind: 'gateway_newer',
      api: { version: 3, supported: [2, 3] },
      reason: 'This gateway speaks API 3; this app needs API 1. Update the app or the gateway.',
    });
  });

  it('names a gateway that serves only an older API', async () => {
    // Only reachable once this client speaks a later version; stand one in by reading the wire.
    stubFetch(() => ok({ version: 0, supported: [0] }));
    const result = await gateway.checkCompatibility();
    expect(result.kind).toBe('gateway_older');
    expect(result.reason).toContain('Update the gateway.');
  });

  it('says a gateway from before 1.0 is before 1.0 (404 on /v1/version, health without an api)', async () => {
    stubFetch((url) =>
      url.endsWith('/health')
        ? Response.json({ status: 'ok', service: 'clerq-gateway', version: '0.5.1' })
        : new Response('Not found', { status: 404 })
    );
    const result = await gateway.checkCompatibility();
    expect(result).toMatchObject({ ok: false, kind: 'gateway_older', gateway: '0.5.1', api: null });
    expect(result.reason).toContain('older than 1.0');
    expect(result.reason).toContain('0.5.1');
    // The probe is a plain GET: no custom header to trip a browser's preflight.
    const probe = calls.find(([url]) => url.endsWith('/health'));
    expect(probe?.[0]).toBe('http://127.0.0.1:18790/health');
    // No header and no token: a plain GET, so no CORS preflight. A redirect is never followed.
    expect(probe?.[1]).toEqual({ redirect: 'error' });
  });

  it('says the same when an older gateway answers 401 because it has no public /version', async () => {
    stubFetch((url) =>
      url.endsWith('/health')
        ? Response.json({ status: 'ok', service: 'clerq-gateway', version: '0.4.0' })
        : new Response('{"error":"unauthorized"}', { status: 401 })
    );
    expect(await gateway.checkCompatibility()).toMatchObject({ kind: 'gateway_older' });
  });

  it('says so when a browser refused the version header of an older gateway (the request itself fails)', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.headers) throw new TypeError('Failed to fetch');
      return Response.json({ status: 'ok', service: 'clerq-gateway', version: '0.5.1' });
    });
    expect(await gateway.checkCompatibility()).toMatchObject({
      ok: false,
      kind: 'gateway_older',
    });
  });

  it('says nothing answered when nothing does', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const result = await gateway.checkCompatibility();
    expect(result).toEqual({
      ok: false,
      kind: 'unreachable',
      gateway: null,
      api: null,
      reason: 'Nothing answered at http://127.0.0.1:18790. Is OpenClerq running?',
    });
  });

  it('does not take another server for a gateway', async () => {
    stubFetch(() => new Response('<html>nope</html>', { status: 404 }));
    expect(await gateway.checkCompatibility()).toMatchObject({ ok: false, kind: 'unexpected' });
    stubFetch(() => Response.json({ hello: 'world' }));
    expect(await gateway.checkCompatibility()).toMatchObject({ ok: false, kind: 'unexpected' });
    stubFetch(() => new Response('boom', { status: 500 }));
    const result = await gateway.checkCompatibility();
    expect(result).toMatchObject({ ok: false, kind: 'unexpected' });
    expect(result.reason).toContain('500');
  });

  it('never throws, even when the connection drops while it reads the answer', async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 404,
          text: async () => {
            throw new TypeError('terminated');
          },
        }) as unknown as Response
    );
    expect(await gateway.checkCompatibility()).toMatchObject({ ok: false, kind: 'unreachable' });
  });

  it('does not make up a version for a gateway that lists none', async () => {
    stubFetch(() => ok({ version: 0, supported: [] }));
    const result = await gateway.checkCompatibility();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'This gateway does not say which API versions it speaks; this app needs API 1. Update the gateway.'
    );
  });

  it('reads GET /version through version()', async () => {
    stubFetch(() => ok({ version: 1, supported: [1] }));
    expect((await gateway.version()).store.schema).toBe(21);
    expect(new URL(calls[0][0]).pathname).toBe('/v1/version');
  });
});

describe('redirects', () => {
  /** What Node's fetch throws for `redirect: 'error'`, and what Bun's does. */
  const nodeStyle = () =>
    new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  const bunStyle = () => new Error('UnexpectedRedirect fetching "http://127.0.0.1:18790/v1/runs"');

  it('are never followed, whatever the request', async () => {
    stubFetch(() => Response.json({ ok: true, sessions: [], runs: [], items: [] }));
    await gateway.sessions();
    await gateway.deleteSecret('X');
    await gateway.checkCompatibility();
    await gateway.sendMessage('s1', { content: 'hi' }).catch(() => undefined);
    const stop = new AbortController();
    stop.abort();
    await gateway.streamEvents(() => undefined, { signal: stop.signal });
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const [url, init] of calls) expect(init?.redirect, url).toBe('error');
  });

  it('become a plain refusal, from Node’s error or Bun’s, with nothing sent on', async () => {
    for (const thrown of [nodeStyle, bunStyle]) {
      vi.stubGlobal('fetch', async () => {
        throw thrown();
      });
      const err = (await gateway.runs().catch((e: unknown) => e)) as GatewayError;
      expect(err).toBeInstanceOf(GatewayError);
      expect(err.body).toMatchObject({ error: 'redirect_refused' });
      expect(err.message).toContain('http://127.0.0.1:18790 answered with a redirect');
      expect(err.message).toContain('is not followed');
    }
  });

  it('say so when the version check meets one, instead of "nothing answered"', async () => {
    vi.stubGlobal('fetch', async () => {
      throw nodeStyle();
    });
    const r = await gateway.checkCompatibility();
    expect(r).toMatchObject({ ok: false, kind: 'unexpected' });
    expect(r.reason).toContain('answered with a redirect');
  });

  it('end a followed stream at once instead of being retried', async () => {
    vi.stubGlobal('fetch', async () => {
      throw nodeStyle();
    });
    await expect(gateway.streamEvents(() => undefined, { retryMs: 1 })).rejects.toMatchObject({
      body: { error: 'redirect_refused' },
    });
  });

  it('leave other failures as they were', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });
    await expect(gateway.runs()).rejects.toThrow('fetch failed');
    expect((await gateway.checkCompatibility()).kind).toBe('unreachable');
  });
});
