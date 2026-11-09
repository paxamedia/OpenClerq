import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
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
    expect(gateway.logsStreamUrl()).toBe('http://127.0.0.1:18790/logs/stream?token=test-token-123');
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
    expect(cancel?.[0]).toBe('http://127.0.0.1:18790/runs/run_42/cancel');
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
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/kill');
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ triggers: false });
    expect(res.cancelledRuns).toBe(2);
  });

  it('resumes with a POST', async () => {
    stubFetch(() => Response.json({ ok: true, triggersResumed: true, wasPaused: true }));
    await gateway.resume();
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/resume');
    expect(calls[0][1]?.method).toBe('POST');
  });
});

describe('addresses', () => {
  it('encodes ids into the path, so an id cannot redirect the request', async () => {
    stubFetch(() => Response.json({ ok: true }));
    await gateway.deleteSession('../../kill');
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/sessions/..%2F..%2Fkill');
  });

  it('falls back to the default gateway URL when given an empty one', async () => {
    setGatewayBaseUrl('   ');
    stubFetch(() => Response.json({ sessions: [] }));
    await gateway.sessions();
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/sessions?limit=50');
  });
});

describe('automations', () => {
  it('sends the spec as YAML text and starts runs by id', async () => {
    stubFetch((url) =>
      url.endsWith('/run') ? Response.json({ runId: 'run_1' }) : Response.json({ id: 'aut_1' })
    );
    await gateway.createAutomation('name: x\n');
    expect(calls[0][0]).toBe('http://127.0.0.1:18790/automations');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ spec: 'name: x\n' });
    expect(await gateway.runAutomation('aut 1')).toEqual({ runId: 'run_1' });
    expect(calls[1][0]).toBe('http://127.0.0.1:18790/automations/aut%201/run');
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
    expect(url.pathname).toBe('/events/stream');
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
      'http://127.0.0.1:18790/runs?limit=1000&since=2026-11-02T00%3A00%3A00.000Z'
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
    expect(calls.map((c) => c[0].replace('http://127.0.0.1:18790', ''))).toEqual([
      '/records?type=person&q=ada',
      '/search?q=ada&types=core%3Aperson%2Ccrm%3Adeal',
      '/inbox?status=open',
      '/inbox/items/inb_1',
    ]);
    expect(calls[3][1]?.method).toBe('PATCH');
  });
});
