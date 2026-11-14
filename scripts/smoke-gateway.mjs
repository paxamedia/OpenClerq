#!/usr/bin/env node
/**
 * Start the desktop app's gateway sidecar (clerq-gateway, compiled by Bun) from wherever a package
 * put it, and check that it works: used on the `.deb` and AppImage the release builds, which move
 * and may rewrite these programs on the way (strip, patchelf), and a Bun-compiled program keeps
 * its code appended to the file, which that can cut off. A cut-off one is just the Bun runtime:
 * it starts, listens on nothing and answers nothing.
 *
 *   node scripts/smoke-gateway.mjs <clerq-gateway> [--calc <clerq-calc>] [--version <x.y.z>] [--timeout <seconds>]
 *
 * It runs the program the way the desktop does (from its own folder, on a free port of 127.0.0.1,
 * with a temporary HOME and nothing of the caller's CLERQ_* settings) and checks, in order:
 *   - /v1/health answers within the timeout (default 30 s), while the process is still alive;
 *   - /v1/version names a release (and the one --version names), API 1 and an open store;
 *   - a protected route answers 401 without the token and 200 with the one it made;
 *   - with --calc: the gateway, told where clerq-calc is, gets an answer from it (1+2*3 is 7).
 * Then it stops it with SIGTERM. Exit 0 when all hold, 1 naming the first that did not, 2 for bad usage.
 * Never uses ports 18790-18792.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const o = { timeout: 30 };
  const args = [...argv];
  const take = (flag) => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  while (args.length > 0) {
    const a = args.shift();
    if (a === '--calc') o.calc = take(a);
    else if (a === '--version') o.version = take(a).replace(/^v/, '');
    else if (a === '--timeout') o.timeout = Number(take(a));
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else if (o.binary === undefined) o.binary = a;
    else throw new Error(`Unexpected argument ${a}.`);
  }
  if (!o.binary) throw new Error('A path to clerq-gateway is needed.');
  if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw new Error('--timeout must be a number of seconds.');
  return o;
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    if (port < 18790 || port > 18792) return port;
  }
}

/** Run the checks; returns { ok, lines } so a test can read them. */
export async function smoke(o, log = console.log) {
  let failed = false;
  const check = (name, ok, detail = '') => {
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n       ${String(detail).slice(-1500)}` : ''}`);
    if (!ok) failed = true;
    return ok;
  };
  const exe = path.resolve(o.binary);
  if (!fs.existsSync(exe)) {
    check(`${o.binary} exists`, false);
    return { ok: false };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-gateway-smoke-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    CLERQ_PORT: String(port),
    CLERQ_HOST: '127.0.0.1',
    CLERQ_KEYCHAIN: 'off',
    ...(o.calc ? { CLERQ_CALC_PATH: path.resolve(o.calc) } : {}),
  };
  let log_ = '';
  let child;
  try {
    child = spawn(exe, [], { cwd: path.dirname(exe), env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // The system refused to start it at all (a file that is not a program, or one cut off).
    check('the program starts', false, e instanceof Error ? e.message : String(e));
    fs.rmSync(root, { recursive: true, force: true });
    return { ok: false };
  }
  child.stdout.on('data', (c) => (log_ += c));
  child.stderr.on('data', (c) => (log_ += c));
  let exit = null;
  let settle;
  const exited = new Promise((resolve) => (settle = resolve));
  child.once('exit', (code, signal) => {
    exit = { code, signal };
    settle(exit);
  });
  // The system could not run it (no permission, say): there is no exit to wait for.
  child.once('error', (e) => {
    exit = { code: null, signal: null, error: e.message };
    settle(exit);
  });

  const get = (route, token) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });

  try {
    let up = false;
    for (const end = Date.now() + o.timeout * 1000; Date.now() < end && !up && !exit; ) {
      try {
        up = (await get('/v1/health')).status === 200;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const why = exit
      ? `it exited (${exit.error ?? `code ${exit.code}, signal ${exit.signal}`}) before it answered`
      : `no answer in ${o.timeout} s: not a gateway, or a Bun program with its code cut off`;
    if (!check('the gateway answers /v1/health', up, `${why}\n${log_}`)) return { ok: false };

    const info = await (await get('/v1/version')).json();
    check(
      '/v1/version names a release, API 1 and an open store',
      typeof info.gateway === 'string' &&
        /^\d+\.\d+\.\d+/.test(info.gateway) &&
        info.api?.version === 1 &&
        Number.isInteger(info.store?.schema),
      JSON.stringify(info)
    );
    if (o.version) {
      check(`it is release ${o.version}`, info.gateway === o.version, JSON.stringify(info));
    }

    const tokenFile = path.join(home, '.clerq', 'gateway-token');
    const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    check('it made a token in HOME/.clerq', /^[0-9a-f]{64}$/.test(token));
    check('a protected route answers 401 without the token', (await get('/v1/runs')).status === 401);
    check('and 200 with it', (await get('/v1/runs', token)).status === 200);

    if (o.calc) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calculate/eval`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expression: '1+2*3', inputs: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      check(
        'clerq-calc answers through the gateway (1+2*3 is 7)',
        res.status === 200 && /\b7(\.0+)?\b/.test(text),
        `${res.status} ${text}`
      );
    }
  } finally {
    if (!exit) child.kill('SIGTERM');
    const stopped = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))]);
    if (stopped === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { ok: !failed };
}

function isMain() {
  try {
    return (
      fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/smoke-gateway.mjs <clerq-gateway> [--calc <clerq-calc>] [--version <x.y.z>] [--timeout <seconds>]`);
    process.exit(2);
  }
  const { ok } = await smoke(options);
  console.log(ok ? '\ngateway smoke test passed' : '\ngateway smoke test FAILED');
  process.exit(ok ? 0 : 1);
}
