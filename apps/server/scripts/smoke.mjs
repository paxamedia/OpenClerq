#!/usr/bin/env node
/**
 * Smoke test of a built clerq-server binary, for CI and for a local run:
 *
 *   node apps/server/scripts/smoke.mjs apps/server/dist/bun-linux-x64/clerq-server
 *
 * It starts the binary with a temporary HOME, on a free port, from a working
 * directory that holds a `.env` it must ignore, and checks:
 *   - `version` and `--help` print and exit 0, an unknown command exits 2;
 *   - /v1/health and /v1/version answer without a token, and the version is the
 *     one `version` printed, with the store open;
 *   - a protected route answers 401 without the token and with a wrong one, and
 *     200 with the token the server made (which the log never shows);
 *   - the token in the working directory's .env is not accepted;
 *   - `healthcheck` exits 0 while it runs and 1 once it has stopped;
 *   - SIGTERM exits 0 within 15 s, and leaves nothing in the write-ahead log (the
 *     database file alone is then the whole database).
 * Exits 0 when all hold, else 1 naming the first that did not.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) {
  console.error(
    `usage: smoke.mjs <path to clerq-server>${binary ? ` (not found: ${binary})` : ''}`
  );
  process.exit(2);
}
const exe = path.resolve(binary);
const STOP_WITHIN_MS = 15_000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-smoke-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'cwd');
fs.mkdirSync(home);
fs.mkdirSync(cwd);
const decoy = 'decoy-token-from-the-working-directory-0123456789';
fs.writeFileSync(path.join(cwd, '.env'), `CLERQ_GATEWAY_TOKEN=${decoy}\nCLERQ_PORT=1\n`);

const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
// Nothing of the caller's CLERQ_* settings; the keychain stays out of it on a Mac.
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  CLERQ_PORT: String(port),
  CLERQ_KEYCHAIN: 'off',
};

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n       ${detail}` : ''}`);
  if (!ok) failed = true;
};
const finish = (server) => {
  server?.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? '\nsmoke test FAILED' : '\nsmoke test passed');
  process.exit(failed ? 1 : 0);
};

const run = (args) => spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });

// --- commands that do not start the server ---
const version = run(['version']);
check(
  'version exits 0 and names the release, the API and the schema',
  version.status === 0 &&
    /^clerq-server \d+\.\d+\.\d+/.test(version.stdout) &&
    /API version: 1/.test(version.stdout) &&
    /Store schema: \d+/.test(version.stdout),
  version.stdout + version.stderr
);
const help = run(['--help']);
check('--help exits 0', help.status === 0 && help.stdout.includes('healthcheck'), help.stdout);
const unknown = run(['frobnicate']);
check('an unknown command exits 2', unknown.status === 2, `exit ${unknown.status}`);
const early = run(['healthcheck']);
check('healthcheck exits 1 before the server is up', early.status === 1, `exit ${early.status}`);

// --- the server ---
let log = '';
const server = spawn(exe, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));
const exited = new Promise((resolve) =>
  server.once('exit', (code, signal) => resolve({ code, signal }))
);

const get = (route, token) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });

let up = false;
for (const end = Date.now() + 30_000; Date.now() < end && !up; ) {
  try {
    up = (await get('/v1/health')).status === 200;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
check('the server answers /v1/health without a token', up, log);
if (!up) finish(server);

const info = await (await get('/v1/version')).json();
const printed = /^clerq-server (\S+)/.exec(version.stdout)?.[1];
check(
  '/v1/version answers without a token, with the release and the open store',
  info.gateway === printed && info.api?.version === 1 && Number.isInteger(info.store?.schema),
  JSON.stringify(info)
);

const tokenFile = path.join(home, '.clerq', 'gateway-token');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
check(
  'the token was made in HOME/.clerq, mode 0600',
  /^[0-9a-f]{64}$/.test(token) &&
    (process.platform === 'win32' || (fs.statSync(tokenFile).mode & 0o777) === 0o600)
);
check('a protected route answers 401 without a token', (await get('/v1/runs')).status === 401);
check(
  'a protected route answers 401 with a wrong token',
  (await get('/v1/runs', 'not-the-token')).status === 401
);
check(
  'a protected route answers 200 with the token',
  (await get('/v1/runs', token)).status === 200
);
check(
  "the working directory's .env was not read (its token is refused)",
  (await get('/v1/runs', decoy)).status === 401
);
check(
  'the log says where the token is and does not show it',
  log.includes(tokenFile) && !log.includes(token) && !log.includes(decoy),
  log
);
check('the log names the data directory', log.includes(path.join(home, '.clerq')), log);

const health = run(['healthcheck']);
check('healthcheck exits 0 while it runs', health.status === 0, health.stdout + health.stderr);

// --- stopping ---
const began = Date.now();
server.kill('SIGTERM');
const timer = setTimeout(() => server.kill('SIGKILL'), STOP_WITHIN_MS);
const { code, signal } = await exited;
clearTimeout(timer);
const took = Date.now() - began;
check(
  `SIGTERM exits 0 within ${STOP_WITHIN_MS / 1000} s (took ${took} ms)`,
  code === 0 && signal === null && took < STOP_WITHIN_MS,
  `exit ${code} signal ${signal}\n${log}`
);
const wal = path.join(home, '.clerq', 'clerq.db-wal');
check(
  'the database file holds everything: nothing is left in the write-ahead log',
  !fs.existsSync(wal) || fs.statSync(wal).size === 0
);
const after = run(['healthcheck']);
check('healthcheck exits 1 once it has stopped', after.status === 1, `exit ${after.status}`);
finish();
