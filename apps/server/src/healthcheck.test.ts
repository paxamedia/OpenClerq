import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { connectHosts, healthcheck } from './healthcheck.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A server that answers every request with `answer`; returns its port. */
async function serve(answer: (res: http.ServerResponse, url: string) => void): Promise<number> {
  const server = http.createServer((req, res) => answer(res, req.url ?? ''));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('healthcheck', () => {
  it('is healthy when /v1/health answers 200 with status ok', async () => {
    let asked = '';
    const port = await serve((res, url) => {
      asked = url;
      json(res, 200, { status: 'ok', service: 'clerq-gateway' });
    });
    const r = await healthcheck({ CLERQ_PORT: String(port) }, { timeoutMs: 2_000 });
    expect(r.ok).toBe(true);
    expect(asked).toBe('/v1/health');
  });

  it('is unhealthy on any other status code', async () => {
    const port = await serve((res) => json(res, 503, { status: 'ok' }));
    const r = await healthcheck({ CLERQ_PORT: String(port) }, { timeoutMs: 2_000 });
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('HTTP 503');
  });

  it('is unhealthy when the answer is not status ok, or not JSON', async () => {
    const odd = await serve((res) => json(res, 200, { status: 'starting' }));
    expect((await healthcheck({ CLERQ_PORT: String(odd) }, { timeoutMs: 2_000 })).ok).toBe(false);
    const text = await serve((res) => res.end('hello'));
    expect((await healthcheck({ CLERQ_PORT: String(text) }, { timeoutMs: 2_000 })).ok).toBe(false);
  });

  it('is unhealthy when nothing is listening', async () => {
    const port = await serve((res) => json(res, 200, { status: 'ok' }));
    await new Promise((r) => servers.pop()?.close(r));
    const r = await healthcheck({ CLERQ_PORT: String(port) }, { timeoutMs: 2_000 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(String(port));
  });

  it('is unhealthy when the answer takes longer than the timeout', async () => {
    const port = await serve(() => undefined);
    const began = Date.now();
    const r = await healthcheck({ CLERQ_PORT: String(port) }, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no answer within');
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it('is unhealthy, saying why, when the port setting is wrong', async () => {
    const r = await healthcheck({ CLERQ_PORT: 'eighty' }, { timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('CLERQ_PORT');
  });

  it('sends no token, since /v1/health is public', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const port = await serve((res) => json(res, 200, { status: 'ok' }));
    servers[0].on('request', (req) => {
      seen = req.headers;
    });
    await healthcheck(
      { CLERQ_PORT: String(port), CLERQ_GATEWAY_TOKEN: 'secret-token' },
      { timeoutMs: 2_000 }
    );
    expect(seen.authorization).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('secret-token');
  });

  it('asks through the fetch it is given, at the address from CLERQ_HOST and CLERQ_PORT', async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    await healthcheck(
      { CLERQ_HOST: '0.0.0.0', CLERQ_PORT: '9000' },
      { timeoutMs: 1_000, fetch: fake }
    );
    await healthcheck(
      { CLERQ_HOST: '192.168.1.5', CLERQ_PORT: '9001' },
      { timeoutMs: 1_000, fetch: fake }
    );
    await healthcheck({}, { timeoutMs: 1_000, fetch: fake });
    expect(urls).toEqual([
      'http://127.0.0.1:9000/v1/health',
      'http://192.168.1.5:9001/v1/health',
      'http://127.0.0.1:18790/v1/health',
    ]);
  });
});

describe('connectHosts', () => {
  it('goes to loopback for a wildcard or loopback listener, and to a named address as it is', () => {
    expect(connectHosts('0.0.0.0')).toEqual(['127.0.0.1']);
    expect(connectHosts('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(connectHosts('::1')).toEqual(['[::1]']);
    expect(connectHosts('10.0.0.7')).toEqual(['10.0.0.7']);
    expect(connectHosts('fd00::7')).toEqual(['[fd00::7]']);
    expect(connectHosts('openclerq.lan')).toEqual(['openclerq.lan']);
  });

  it('tries both loopback addresses for a name that can mean either', () => {
    expect(connectHosts('localhost')).toEqual(['127.0.0.1', '[::1]']);
    expect(connectHosts('::')).toEqual(['[::1]', '127.0.0.1']);
  });
});

describe('healthcheck with a host that can mean either loopback address', () => {
  const ok = () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  const refused = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };

  it('is healthy when the server listens on IPv6 loopback only (localhost -> ::1)', async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return url.includes('[::1]') ? ok() : refused();
    }) as unknown as typeof fetch;
    const r = await healthcheck(
      { CLERQ_HOST: 'localhost', CLERQ_PORT: '9000' },
      { timeoutMs: 1_000, fetch: fake }
    );
    expect(r.ok).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:9000/v1/health', 'http://[::1]:9000/v1/health']);
  });

  it('is healthy on IPv4 only without asking IPv6, and unhealthy naming both when neither answers', async () => {
    const urls: string[] = [];
    const v4 = (async (url: string) => {
      urls.push(url);
      return ok();
    }) as unknown as typeof fetch;
    expect(
      (
        await healthcheck(
          { CLERQ_HOST: 'localhost', CLERQ_PORT: '9000' },
          { timeoutMs: 1_000, fetch: v4 }
        )
      ).ok
    ).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:9000/v1/health']);

    const none = (async () => refused()) as unknown as typeof fetch;
    const r = await healthcheck(
      { CLERQ_HOST: 'localhost', CLERQ_PORT: '9000' },
      { timeoutMs: 1_000, fetch: none }
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('127.0.0.1:9000');
    expect(r.message).toContain('[::1]:9000');
  });

  it('works against real listeners: localhost with the server on ::1 only, or on 127.0.0.1 only', async () => {
    const v6 = http.createServer((_req, res) => json(res, 200, { status: 'ok' }));
    servers.push(v6);
    const bound = await new Promise<boolean>((resolve) => {
      v6.once('error', () => resolve(false));
      v6.listen(0, '::1', () => resolve(true));
    });
    if (!bound) return; // this machine has no IPv6 loopback
    const port = (v6.address() as net.AddressInfo).port;
    expect(
      (
        await healthcheck(
          { CLERQ_HOST: 'localhost', CLERQ_PORT: String(port) },
          { timeoutMs: 2_000 }
        )
      ).ok
    ).toBe(true);
    expect(
      (await healthcheck({ CLERQ_HOST: '::1', CLERQ_PORT: String(port) }, { timeoutMs: 2_000 })).ok
    ).toBe(true);

    const v4Port = await serve((res) => json(res, 200, { status: 'ok' }));
    expect(
      (
        await healthcheck(
          { CLERQ_HOST: 'localhost', CLERQ_PORT: String(v4Port) },
          { timeoutMs: 2_000 }
        )
      ).ok
    ).toBe(true);
  });
});
