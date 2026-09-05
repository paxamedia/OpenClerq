import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedAddress, assertUrlAllowed, safeFetch, NetworkPolicyError } from './network.js';

describe('isBlockedAddress', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.9.9.9')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('blocks the cloud metadata endpoint', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('fd00:ec2::254')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('allows addresses just outside the private ranges', () => {
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
    expect(isBlockedAddress('11.0.0.1')).toBe(false);
  });

  it('blocks CGNAT, unspecified, multicast and reserved', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('blocks IPv6 unique-local, link-local and multicast', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('unwraps IPv4-mapped IPv6 rather than trusting the wrapper', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks anything it cannot parse', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  const base = { allowlist: ['example.com'], allowPrivateAddresses: true };

  it('rejects a host outside the allowlist', async () => {
    await expect(assertUrlAllowed('https://evil.example/', base)).rejects.toThrow(
      /not in the configured httpAllowlist/
    );
  });

  it('rejects a disallowed scheme', async () => {
    await expect(assertUrlAllowed('http://example.com/', base)).rejects.toThrow(
      /Scheme "http:" is not permitted/
    );
    await expect(assertUrlAllowed('file:///etc/passwd', base)).rejects.toThrow(NetworkPolicyError);
  });

  it('permits http when explicitly configured', async () => {
    const url = await assertUrlAllowed('http://example.com/x', {
      ...base,
      allowedSchemes: ['http:', 'https:'],
    });
    expect(url.hostname).toBe('example.com');
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(assertUrlAllowed('https://user:pass@example.com/', base)).rejects.toThrow(
      /credentials/
    );
  });

  it('rejects a literal private IP even when allow-listed', async () => {
    await expect(
      assertUrlAllowed('https://169.254.169.254/latest/meta-data/', {
        allowlist: ['169.254.169.254'],
      })
    ).rejects.toThrow(/blocked range/);
  });

  it('matches wildcard subdomains but not the bare apex', async () => {
    const policy = { allowlist: ['*.example.com'], allowPrivateAddresses: true };
    await expect(assertUrlAllowed('https://api.example.com/', policy)).resolves.toBeDefined();
    await expect(assertUrlAllowed('https://example.com/', policy)).rejects.toThrow(
      NetworkPolicyError
    );
  });

  it('is not fooled by a trailing dot on the hostname', async () => {
    await expect(assertUrlAllowed('https://example.com./', base)).resolves.toBeDefined();
  });

  it('rejects an invalid URL', async () => {
    await expect(assertUrlAllowed('not a url', base)).rejects.toThrow(/Invalid URL/);
  });
});

describe('safeFetch', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('fine');
      } else if (req.url === '/redirect-offsite') {
        // An allowed host redirecting somewhere it should not reach.
        res.writeHead(302, { Location: 'http://evil.example/steal' });
        res.end();
      } else if (req.url === '/redirect-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('y'.repeat(50_000));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Local test server is on loopback, so these tests opt into private addresses.
  const policy = (extra: Record<string, unknown> = {}) => ({
    allowlist: ['127.0.0.1'],
    allowedSchemes: ['http:'],
    allowPrivateAddresses: true,
    ...extra,
  });

  it('refuses to run at all with an empty allowlist', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/ok`, {}, { allowlist: [] })).rejects.toThrow(
      /Outbound HTTP is disabled/
    );
  });

  it('rejects a method outside the allowlist', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/ok`, { method: 'DELETE' }, policy())
    ).rejects.toThrow(/Method DELETE is not permitted/);
  });

  it('performs an allowed request', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/ok`, {}, policy());
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('fine');
    expect(res.truncated).toBe(false);
    expect(res.chain).toHaveLength(1);
  });

  it('revalidates redirects against the allowlist', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/redirect-offsite`, {}, policy())
    ).rejects.toThrow(/not in the configured httpAllowlist/);
  });

  it('blocks loopback by default, even when the host is allow-listed', async () => {
    // No allowPrivateAddresses: this is what a user gets out of the box.
    await expect(
      safeFetch(
        `http://127.0.0.1:${port}/ok`,
        {},
        { allowlist: ['127.0.0.1'], allowedSchemes: ['http:'] }
      )
    ).rejects.toThrow(/blocked range/);
  });

  it('stops a redirect loop at the configured limit', async () => {
    await expect(
      safeFetch(`http://127.0.0.1:${port}/loop`, {}, policy({ maxRedirects: 2 }))
    ).rejects.toThrow(/Exceeded 2 redirects/);
  });

  it('truncates an oversized body at maxBytes', async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/big`, {}, policy({ maxBytes: 1000 }));
    expect(res.truncated).toBe(true);
    expect(res.bodyText.length).toBe(1000);
  });

  it('times out a slow request', async () => {
    const slow = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const slowPort = (slow.address() as AddressInfo).port;
    try {
      await expect(
        safeFetch(`http://127.0.0.1:${slowPort}/`, {}, policy({ timeoutMs: 150 }))
      ).rejects.toThrow(/timed out after 150ms/);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});
