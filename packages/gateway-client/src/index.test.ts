import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gateway, setGatewayBaseUrl, setGatewayToken, hasGatewayToken } from './index.js';

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
