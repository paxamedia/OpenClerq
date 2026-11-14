import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { limitWaitForAnswer } from './timeout.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** A `fetch` with the limit installed, without touching the real one. */
function limited(ms: number) {
  const target = { fetch: globalThis.fetch };
  limitWaitForAnswer(ms, target);
  return target.fetch;
}

describe('limitWaitForAnswer', () => {
  it('ends a request that is never answered, as a timeout', async () => {
    const url = await listen(() => undefined);
    const started = Date.now();
    await expect(limited(200)(url)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('lets a request that is answered in time finish', async () => {
    const url = await listen((_req, res) => res.end('ok'));
    const res = await limited(2000)(url);
    expect(await res.text()).toBe('ok');
  });

  it('does not cut a stream off once it has begun', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('first\n');
      setTimeout(() => res.end('second\n'), 500);
    });
    const res = await limited(200)(url);
    expect(await res.text()).toBe('first\nsecond\n');
  });

  it('still ends a stream when the caller aborts it after it began', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hello\n\n');
    });
    const stop = new AbortController();
    const res = await limited(200)(url, { signal: stop.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    // Past the limit, then the caller gives up: the read must end, not hang.
    await new Promise((r) => setTimeout(r, 400));
    stop.abort();
    await expect(reader.read()).rejects.toBeDefined();
  });

  it('does not follow a redirect unless a caller asks to', async () => {
    let hits = 0;
    const target = await listen((_req, res) => {
      hits++;
      res.end('moved here');
    });
    const url = await listen((_req, res) => res.writeHead(307, { location: target }).end());
    await expect(limited(2000)(url, { method: 'POST', body: 'secret body' })).rejects.toBeDefined();
    expect(hits).toBe(0);
    // A caller that really wants to follow can say so.
    const followed = await limited(2000)(url, { redirect: 'follow' });
    expect(await followed.text()).toBe('moved here');
    expect(hits).toBe(1);
  });

  it('honours a signal that was already aborted', async () => {
    const url = await listen((_req, res) => res.end('late'));
    const stop = new AbortController();
    stop.abort();
    await expect(limited(2000)(url, { signal: stop.signal })).rejects.toBeDefined();
  });
});
