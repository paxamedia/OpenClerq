/**
 * What `clerq-server` was asked to do. No arguments runs the server; the
 * others never start it.
 */

export type Command =
  | { kind: 'run' }
  | { kind: 'healthcheck'; timeoutMs: number }
  | { kind: 'version'; json: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/** How long `healthcheck` waits for an answer. */
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 5_000;

export const USAGE = `Usage: clerq-server [command]

The OpenClerq gateway as a headless daemon.

Commands:
  (none), run          Start the server and keep running until SIGTERM or SIGINT.
  healthcheck          Ask the running server's /v1/health; exit 0 if it answers
                       "ok", 1 if not. For Docker HEALTHCHECK and systemd.
                       --timeout <seconds>   how long to wait (default 5)
  version              Print the release, the API version and the store schema.
                       --json                as one JSON object
  help                 Print this text.

Environment (a variable set in the environment wins over ~/.clerq/.env):
  CLERQ_HOST           Address to listen on. Default 127.0.0.1.
  CLERQ_PORT           Port to listen on. Default 18790.
  CLERQ_GATEWAY_TOKEN  The API token. Default: ~/.clerq/gateway-token, made on first start.
  CLERQ_CALC_PATH      The clerq-calc binary. Default: the one next to this program.
  HOME                 The data directory is $HOME/.clerq.

Exit codes: 0 stopped cleanly (or a healthy check), 1 failed to start, run or stop in
time (or an unhealthy check), 2 bad arguments or configuration.
Documentation: docs/SERVER.md in the OpenClerq repository.
`;

export function parseArgs(argv: string[]): Command {
  const args = [...argv];
  if (args.some((a) => a === '-h' || a === '--help' || a === 'help')) return { kind: 'help' };
  const first = args.shift();
  if (first === undefined || first === 'run') {
    return args.length === 0
      ? { kind: 'run' }
      : { kind: 'error', message: `"run" takes no arguments (got "${args[0]}").` };
  }

  if (first === 'version' || first === '--version' || first === '-v') {
    let json = false;
    for (const a of args) {
      if (a === '--json') json = true;
      else return { kind: 'error', message: `Unknown argument for "version": "${a}".` };
    }
    return { kind: 'version', json };
  }

  if (first === 'healthcheck') {
    let timeoutMs = DEFAULT_HEALTHCHECK_TIMEOUT_MS;
    while (args.length > 0) {
      const a = args.shift() as string;
      if (a === '--timeout') {
        const seconds = Number(args.shift());
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
          return { kind: 'error', message: '--timeout takes a number of seconds above 0.' };
        }
        timeoutMs = Math.round(seconds * 1_000);
      } else {
        return { kind: 'error', message: `Unknown argument for "healthcheck": "${a}".` };
      }
    }
    return { kind: 'healthcheck', timeoutMs };
  }

  return { kind: 'error', message: `Unknown command "${first}".` };
}
