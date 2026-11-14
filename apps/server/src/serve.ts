/**
 * Run the gateway as a daemon until it is told to stop.
 *
 * Start-up: settings from the environment and `~/.clerq/.env`, the data
 * directory made private, the token resolved (never printed), the gateway
 * started, and one block of lines saying what is running and where.
 *
 * Shutdown, on SIGTERM or SIGINT: `gateway.close()` (stop accepting
 * connections, stop the schedules and the queue, close the store; runs in
 * flight are left for the next start to reclaim, see its documentation), then
 * exit 0. If that takes longer than 10 s the process exits 1. A second signal
 * while stopping exits 1 at once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chooseCalcPath } from './calc.js';
import { ensureHome, loadEnvFile, readServerConfig, type Env } from './env.js';
import { makeLog, type Log } from './log.js';
import { startupLines } from './startup.js';

/** How long a clean stop may take before the process gives up and exits 1. */
export const STOP_DEADLINE_MS = 10_000;

/** Flush what has been logged, then exit. */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

export async function serve(env: Env = process.env, log: Log = makeLog(env)): Promise<void> {
  const home = ensureHome(env);
  const envFile = loadEnvFile(env, home, (m) => log('WARN', m));
  // The file may set the log format; start logging in it from here on.
  log = makeLog(env);
  const { host, port } = readServerConfig(env);
  const calcFrom = chooseCalcPath(env);

  const [
    { createGateway, GATEWAY_VERSION, resolveGatewayToken, getCalcBinaryPath },
    protocol,
    store,
  ] = await Promise.all([
    import('@clerq/gateway'),
    import('@clerq/gateway-client/protocol'),
    import('@clerq/store'),
  ]);

  // ~/.clerq holds API keys, conversations and the vault: this account only.
  try {
    const tightened = store.secureClerqHome();
    if (tightened.length > 0) {
      log(
        'INFO',
        `Restricted ${tightened.length} path(s) under ${store.clerqHome()} to this account`
      );
    }
  } catch (e) {
    log(
      'WARN',
      `Could not restrict ${store.clerqHome()} permissions: ${e instanceof Error ? e.message : e}`
    );
  }

  // Resolved (and, on a first start, written) before anything is served.
  const { token, source } = resolveGatewayToken();
  const calcPath = getCalcBinaryPath();
  for (const line of startupLines({
    gateway: GATEWAY_VERSION,
    api: { version: protocol.API_VERSION, supported: protocol.SUPPORTED_API_VERSIONS },
    schema: store.newestKnownSchema(),
    host,
    port,
    dataDir: store.clerqHome(),
    token: { source, file: path.join(store.clerqHome(), 'gateway-token') },
    envFile,
    calc: { path: calcPath, found: fs.existsSync(calcPath), from: calcFrom },
  })) {
    log(line.level, line.message);
  }

  const gateway = createGateway({ port, host, authToken: token });

  let stopping = false;
  // After a stop has begun, a run still going may touch the closed store and
  // fail; that is what the next start's recovery is for, and not worth a crash.
  process.on('unhandledRejection', (reason) => {
    if (stopping) {
      log(
        'WARN',
        `Ignored an error while stopping: ${reason instanceof Error ? reason.message : String(reason)}`
      );
      return;
    }
    throw reason;
  });
  process.on('uncaughtException', (error) => {
    if (stopping) {
      log('WARN', `Ignored an error while stopping: ${error.message}`);
      return;
    }
    log('ERROR', `Unexpected error: ${error.stack ?? error.message}`);
    exitAfterFlush(1);
  });

  const stop = async (why: string, exitCode: number, graceMs?: number): Promise<void> => {
    stopping = true;
    const deadline = setTimeout(() => {
      log('ERROR', `Did not stop within ${STOP_DEADLINE_MS / 1_000} s; exiting`);
      exitAfterFlush(1);
    }, STOP_DEADLINE_MS);
    let code = exitCode;
    try {
      await gateway.close(graceMs === undefined ? {} : { graceMs });
    } catch (e) {
      log('ERROR', `Stopping failed: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
    clearTimeout(deadline);
    log('INFO', why);
    exitAfterFlush(code);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) {
        log('WARN', `Received ${signal} again; exiting now`);
        exitAfterFlush(1);
        return;
      }
      log('INFO', `Received ${signal}; stopping`);
      void stop('Stopped', 0);
    });
  }

  // A database from a newer OpenClerq, one that could not be backed up, one
  // another process is still upgrading, or a port that is taken: nothing is
  // being served, so leave with the reason and a failure code.
  gateway.ready.catch((e: unknown) => {
    if (stopping) return;
    log('ERROR', `Not started: ${e instanceof Error ? e.message : String(e)}`);
    void stop('Exiting', 1, 0);
  });
  gateway.ready.then(
    () => {
      if (!stopping) log('INFO', 'Ready');
    },
    () => undefined
  );
}
