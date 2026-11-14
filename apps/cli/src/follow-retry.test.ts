/** A followed run survives the gateway being briefly away, and gives up when it is not coming back. */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cli } from './test-harness.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-retry-')));
const env = { CLERQ_GATEWAY_TOKEN: 'a-token-for-the-stub-0123456789' };

const run = (status: string) => ({
  id: 'run_1',
  status,
  trigger: 'manual',
  automationName: 'tidy',
  createdAt: new Date().toISOString(),
  costUsd: 0,
  costKnown: true,
  tokensIn: 0,
  tokensOut: 0,
  steps: [],
  toolCalls: [],
  artifacts: [],
});

let server: http.Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

/** A gateway whose answers to `GET /v1/runs/run_1` are `script`, in order, the last one repeating. */
async function stub(script: Array<number | string>): Promise<{ url: string; asked: () => number }> {
  let asked = 0;
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/version') {
      res.end(
        JSON.stringify({
          gateway: '0.5.1',
          api: { version: 1, supported: [1] },
          store: { schema: 21 },
        })
      );
    } else if (req.url === '/v1/runs/run_1') {
      const next = script[Math.min(asked++, script.length - 1)];
      if (typeof next === 'number')
        res.writeHead(next).end(JSON.stringify({ error: 'server_stopping' }));
      else res.end(JSON.stringify(run(next)));
    } else {
      res.writeHead(404).end('{"error":"not_found"}');
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked: () => asked };
}

describe('following through an outage', () => {
  it('tries again after a 503, says so once, and finishes when the run does', async () => {
    const gw = await stub(['executing', 503, 503, 'executing', 'done']);
    const r = await cli(['logs', 'run_1', '--follow', '--gateway', gw.url], {
      home,
      env,
      pollMs: 50,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.match(/Lost contact with the gateway; trying again\./g)).toHaveLength(1);
    expect(r.stdout).toContain('Run succeeded.');
  });

  it('gives up after a few tries, with the gateway’s own words and exit 1', async () => {
    const gw = await stub(['executing', 503]);
    const r = await cli(['logs', 'run_1', '--follow', '--gateway', gw.url], {
      home,
      env,
      pollMs: 50,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('The gateway had a problem (503)');
    // One look for the header, then six tries.
    expect(gw.asked()).toBe(1 + 6);
  });

  it('does not retry a refusal that will not change', async () => {
    const gw = await stub(['executing', 404]);
    const r = await cli(['logs', 'run_1', '--follow', '--gateway', gw.url], {
      home,
      env,
      pollMs: 50,
    });
    expect(r.code).toBe(1);
    expect(gw.asked()).toBe(2);
    expect(r.stdout).not.toContain('Lost contact');
  });

  it('tries again when the connection itself drops', async () => {
    let drops = 2;
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/version') {
        res.end(
          JSON.stringify({
            gateway: '0.5.1',
            api: { version: 1, supported: [1] },
            store: { schema: 21 },
          })
        );
      } else if (req.url === '/v1/runs/run_1') {
        // The header look answers; the next two are cut off mid-way.
        if (drops-- <= 0 || drops === 1)
          res.end(JSON.stringify(run(drops <= 0 ? 'done' : 'executing')));
        else req.socket.destroy();
      } else res.writeHead(404).end('{}');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await cli(['logs', 'run_1', '--follow', '--gateway', url], { home, env, pollMs: 50 });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('Lost contact with the gateway; trying again.');
  });
});
