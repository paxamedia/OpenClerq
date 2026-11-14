/**
 * A gateway that answers with a redirect is not followed: the request, a POST's
 * body and the token included, goes nowhere else. The CLI says so in plain words
 * and exits 3, since that address is not a gateway to use.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cli } from './test-harness.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-redirect-')));
const env = { CLERQ_GATEWAY_TOKEN: 'a-token-for-the-stub-0123456789' };

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

/** Where a redirect leads: it records everything that arrives. */
async function target() {
  const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
  const url = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  return { url, seen };
}

const VERSION = { gateway: '0.5.1', api: { version: 1, supported: [1] }, store: { schema: 21 } };

describe('a redirect from the gateway', () => {
  it('is refused by every command, before anything goes on to where it points', async () => {
    const moved = await target();
    const gw = await listen((_req, res) => res.writeHead(307, { location: moved.url }).end());
    for (const argv of [['status'], ['automation', 'list'], ['approvals'], ['run', 'x']]) {
      const r = await cli([...argv, '--gateway', gw], { home, env });
      expect(r.code, argv.join(' ')).toBe(3);
      expect(r.stderr, argv.join(' ')).toContain(
        'answered with a redirect, and a redirect is not followed'
      );
    }
    const login = await cli(['login', gw, '--token-stdin'], {
      home,
      stdin: `${env.CLERQ_GATEWAY_TOKEN}\n`,
    });
    expect(login.code).toBe(3);
    expect(login.stderr).toContain('is not followed');
    expect(fs.existsSync(path.join(home, '.clerq', 'cli.json'))).toBe(false);
    expect(moved.seen).toEqual([]);
  });

  it('does not resend a POST body to where a 307 or 308 points', async () => {
    const moved = await target();
    for (const status of [307, 308]) {
      const gw = await listen((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/version') res.end(JSON.stringify(VERSION));
        else res.writeHead(status, { location: moved.url }).end();
      });
      const file = path.join(home, 'spec.yaml');
      fs.writeFileSync(file, 'name: tidy\nprompt: a secret instruction\n');
      const r = await cli(['automation', 'apply', '-f', file, '--gateway', gw], { home, env });
      // The version check passed; the refusal came on the POST, and is a gateway to leave alone.
      expect(r.code, String(status)).toBe(3);
      expect(r.stderr, String(status)).toContain('is not followed');
      expect(r.stderr).not.toContain(env.CLERQ_GATEWAY_TOKEN);
    }
    expect(moved.seen).toEqual([]);
  });

  it('is said in the status table as a gateway that is not usable', async () => {
    const moved = await target();
    const gw = await listen((_req, res) => res.writeHead(302, { location: moved.url }).end());
    const r = await cli(['status', '--json', '--gateway', gw], { home, env });
    expect(r.code).toBe(3);
    const status = JSON.parse(r.stdout) as {
      compatibility: { ok: boolean; kind: string; reason: string };
    };
    expect(status.compatibility).toMatchObject({ ok: false, kind: 'unexpected' });
    expect(status.compatibility.reason).toContain('answered with a redirect');
    expect(moved.seen).toEqual([]);
  });
});
