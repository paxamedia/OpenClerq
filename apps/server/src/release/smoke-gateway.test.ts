/**
 * scripts/smoke-gateway.mjs: the check that the desktop's gateway sidecar runs from a package. It is
 * given fake gateways here (small programs that answer, or do not, as a Bun-compiled one would); the
 * real thing is run on the .deb and the AppImage by scripts/check-linux-packages.sh in the Linux
 * builds, and by hand against a compiled gateway.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface Options {
  binary?: string;
  calc?: string;
  version?: string;
  timeout: number;
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const script = (await import(
  /* @vite-ignore */ pathToFileURL(path.join(root, 'scripts', 'smoke-gateway.mjs')).href
)) as {
  smoke(o: Options, log: (line: string) => void): Promise<{ ok: boolean }>;
  parseArgs(argv: string[]): Options;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-smoke-gw-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A program (a node script with a shebang) that behaves as the body says; `mode` is its file mode. */
function program(name: string, body: string, mode = 0o755): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode });
  return file;
}

/** A fake gateway: answers as the real one does, unless `flaw` says it does not. */
function gateway(name: string, flaw = '') {
  return program(
    name,
    `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const flaw = ${JSON.stringify(flaw)};
const token = 'a'.repeat(64);
fs.mkdirSync(path.join(process.env.HOME, '.clerq'), { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, '.clerq', 'gateway-token'), token);
const server = http.createServer((req, res) => {
  const authed = req.headers.authorization === 'Bearer ' + token;
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (req.url === '/v1/health') return json(200, { ok: true });
  if (req.url === '/v1/version') return json(200, { gateway: '1.2.3', api: { version: 1 }, store: { schema: flaw === 'nostore' ? null : 23 } });
  if (req.url === '/v1/runs') return authed || flaw === 'open' ? json(200, { runs: [] }) : json(401, { error: 'unauthorized' });
  if (req.url === '/v1/calculate/eval') return json(200, { values: { result: flaw === 'badcalc' ? 8 : 7 } });
  json(404, {});
});
if (flaw === 'deaf') setInterval(() => {}, 1000);
else server.listen(Number(process.env.CLERQ_PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`
  );
}

async function run(o: Partial<Options> & { binary: string }) {
  const lines: string[] = [];
  const { ok } = await script.smoke({ timeout: 10, ...o }, (l) => lines.push(l));
  return { ok, out: lines.join('\n') };
}

describe('the gateway smoke test', () => {
  it('passes a gateway that answers, protects its routes and gets an answer from the engine', async () => {
    const calc = program('clerq-calc-ok', '');
    const r = await run({ binary: gateway('good'), calc, version: '1.2.3' });
    expect(r.out).not.toContain('FAIL');
    expect(r.ok).toBe(true);
    for (const line of [
      'the gateway answers /v1/health',
      'it is release 1.2.3',
      'a protected route answers 401 without the token',
      'clerq-calc answers through the gateway',
    ]) {
      expect(r.out).toContain(`ok   ${line}`);
    }
  });

  it('fails a program that is a runtime with its code cut off: it starts, says something and answers nothing', async () => {
    // What Bun's own binary does with no script: print its help and exit.
    const bare = program(
      'bare',
      "console.log('Bun is a fast JavaScript runtime'); process.exit(0);"
    );
    const r = await run({ binary: bare, timeout: 5 });
    expect(r.ok).toBe(false);
    expect(r.out).toContain('FAIL the gateway answers /v1/health');
    expect(r.out).toContain('it exited');
    expect(r.out).toContain('Bun is a fast JavaScript runtime');
    // Or one that stays up and listens on nothing.
    const deaf = await run({ binary: gateway('deaf', 'deaf'), timeout: 2 });
    expect(deaf.ok).toBe(false);
    expect(deaf.out).toContain('no answer in 2 s');
  });

  it('fails what is wrong with a gateway that does answer', async () => {
    const calc = program('clerq-calc-2', '');
    const cases: [string, Partial<Options>, string][] = [
      ['open', { calc }, 'FAIL a protected route answers 401 without the token'],
      ['nostore', {}, 'FAIL /v1/version names a release, API 1 and an open store'],
      ['badcalc', { calc }, 'FAIL clerq-calc answers through the gateway'],
      ['', { version: '9.9.9' }, 'FAIL it is release 9.9.9'],
    ];
    for (const [flaw, extra, failure] of cases) {
      const r = await run({ binary: gateway(`flawed-${flaw || 'version'}`, flaw), ...extra });
      expect(r.ok, flaw || 'version').toBe(false);
      expect(r.out).toContain(failure);
    }
  });

  it('fails a file that is missing or that the system will not run, without hanging', async () => {
    expect((await run({ binary: path.join(tmp, 'nothing') })).out).toContain('FAIL');
    const noExec = program('not-executable', '', 0o644);
    const r = await run({ binary: noExec, timeout: 5 });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/FAIL (the gateway answers|the program starts)/);
  });

  it('reads its command line', () => {
    expect(script.parseArgs(['g', '--calc', 'c', '--version', 'v1.0.0', '--timeout', '5'])).toEqual(
      {
        binary: 'g',
        calc: 'c',
        version: '1.0.0',
        timeout: 5,
      }
    );
    expect(() => script.parseArgs([])).toThrow(/path to clerq-gateway/);
    expect(() => script.parseArgs(['g', '--bogus'])).toThrow(/Unknown option/);
    expect(() => script.parseArgs(['g', '--timeout', 'x'])).toThrow(/number of seconds/);
    expect(() => script.parseArgs(['g', 'h'])).toThrow(/Unexpected/);
  });
});
