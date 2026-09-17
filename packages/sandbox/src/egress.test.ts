import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import {
  parseAllowlist,
  isAllowed,
  startEgressProxy,
  EgressError,
  type EgressProxy,
} from './egress.js';

describe('parseAllowlist', () => {
  it('accepts a bare host, a host with a port and a wildcard', () => {
    expect(parseAllowlist(['example.com', 'example.com:443', '*.example.com'])).toEqual([
      { host: 'example.com' },
      { host: 'example.com', port: 443 },
      { host: '*.example.com' },
    ]);
  });

  it('lower-cases hosts, because DNS is case-insensitive', () => {
    expect(parseAllowlist(['API.Example.COM'])).toEqual([{ host: 'api.example.com' }]);
  });

  it('handles bracketed IPv6 with and without a port', () => {
    expect(parseAllowlist(['[::1]:8080', '[fe80::1]'])).toEqual([
      { host: '::1', port: 8080 },
      { host: 'fe80::1' },
    ]);
  });

  it('refuses an empty entry or an impossible port', () => {
    expect(() => parseAllowlist([''])).toThrow(EgressError);
    expect(() => parseAllowlist(['example.com:0'])).toThrow(/invalid port/);
    expect(() => parseAllowlist(['example.com:99999'])).toThrow(/invalid port/);
    expect(() => parseAllowlist(['example.com:https'])).toThrow(/invalid port/);
  });
});

describe('isAllowed', () => {
  const rules = parseAllowlist(['example.com', 'api.internal:8443', '*.corp.example']);

  it('matches a listed host on any port when no port is given', () => {
    expect(isAllowed(rules, 'example.com', 443)).toBe(true);
    expect(isAllowed(rules, 'example.com', 8080)).toBe(true);
  });

  it('honours a port restriction', () => {
    expect(isAllowed(rules, 'api.internal', 8443)).toBe(true);
    expect(isAllowed(rules, 'api.internal', 443)).toBe(false);
  });

  it('matches subdomains under a wildcard but not the apex', () => {
    expect(isAllowed(rules, 'build.corp.example', 443)).toBe(true);
    expect(isAllowed(rules, 'a.b.corp.example', 443)).toBe(true);
    expect(isAllowed(rules, 'corp.example', 443)).toBe(false);
  });

  it('refuses a host that merely ends with a listed one', () => {
    // notexample.com must not pass because it ends in example.com.
    expect(isAllowed(rules, 'notexample.com', 443)).toBe(false);
    expect(isAllowed(rules, 'example.com.evil.test', 443)).toBe(false);
  });

  it('refuses everything when the list is empty', () => {
    expect(isAllowed([], 'example.com', 443)).toBe(false);
  });
});

describe('egress proxy', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let tcp: net.Server;
  let tcpPort: number;
  let proxy: EgressProxy;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.end('upstream body'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as net.AddressInfo).port;

    // A plain TCP echo server, to prove a CONNECT tunnel carries bytes both ways.
    tcp = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    tcpPort = (tcp.address() as net.AddressInfo).port;

    proxy = await startEgressProxy([`127.0.0.1:${upstreamPort}`, `127.0.0.1:${tcpPort}`]);
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    await new Promise<void>((r) => tcp.close(() => r()));
  });

  const viaProxy = (target: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(target);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'GET',
          path: target, // absolute-form: how a client addresses a proxy
          headers: { host: url.host },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });

  it('forwards a request to an allowed host', async () => {
    const res = await viaProxy(`http://127.0.0.1:${upstreamPort}/`);
    expect(res).toEqual({ status: 200, body: 'upstream body' });
  });

  it('refuses a host that is not on the list, and records the attempt', async () => {
    const before = proxy.denied.length;
    const res = await viaProxy('http://blocked.example/secret');
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/not on the allowlist/);
    expect(proxy.denied.slice(before)).toMatchObject([{ host: 'blocked.example', port: 80 }]);
  });

  it('refuses an allowed host on a port that is not allowed', async () => {
    const res = await viaProxy(`http://127.0.0.1:${upstreamPort + 1000}/`);
    expect(res.status).toBe(403);
  });

  const connect = (authority: string) =>
    new Promise<{ status: number; socket: net.Socket }>((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      socket.once('data', (chunk) => {
        const status = Number(/^HTTP\/1\.\d (\d+)/.exec(chunk.toString())?.[1] ?? 0);
        resolve({ status, socket });
      });
      socket.on('error', reject);
    });

  it('tunnels to an allowed host through CONNECT', async () => {
    const { status, socket } = await connect(`127.0.0.1:${tcpPort}`);
    expect(status).toBe(200);

    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (c) => resolve(c.toString()));
      socket.write('ping');
    });
    expect(echoed).toBe('ping');
    socket.destroy();
  });

  it('refuses CONNECT to a host that is not on the list', async () => {
    const { status, socket } = await connect('blocked.example:443');
    expect(status).toBe(403);
    socket.destroy();
    expect(proxy.denied.at(-1)).toMatchObject({ host: 'blocked.example', port: 443 });
  });

  it('counts what it let through', () => {
    expect(proxy.allowed).toBeGreaterThanOrEqual(2);
  });

  it('binds loopback only — an open egress proxy is an open relay', () => {
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
