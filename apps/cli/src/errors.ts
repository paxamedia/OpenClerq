/**
 * What a command can end in, and how a failure from the gateway client is
 * turned into words and an exit code.
 */

import { GatewayError } from '@clerq/gateway-client';

/**
 * Exit codes. 0 and 1 are the usual pair; 2 and 3 are told apart because a
 * script wants to react to them: a run that is waiting for a person, and a
 * gateway that cannot be used at all. 64 is "bad usage" (sysexits' EX_USAGE),
 * kept away from 2 so a typo is never read as "waiting for approval".
 */
export const EXIT = {
  ok: 0,
  /** The command did not do what was asked: a run failed or was cancelled, a spec has errors, a request was refused. */
  failed: 1,
  /** A run is waiting for an approval (`run --follow --stop-at-approval`). */
  approval: 2,
  /** The gateway cannot be used: nothing answers, or it does not speak this CLI's API version. */
  gateway: 3,
  /** Bad arguments or options. Nothing was sent. */
  usage: 64,
  /** Stopped with Ctrl-C. */
  interrupted: 130,
} as const;

/** A failure with something to say to the person and the exit code to leave with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failed
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = 'UsageError';
  }
}

/** The words of a gateway refusal: its `message`, else its `error` code, else the status. */
function refusalText(e: GatewayError): string {
  const body = e.body;
  if (body && typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  if (body && typeof body.error === 'string') return body.error;
  return e.message;
}

/**
 * A failure in plain words, with the exit code it leaves with. `url` is the
 * gateway being talked to, for the cases where it could not be reached.
 */
export function describeFailure(e: unknown, url: string): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof GatewayError) {
    const code = typeof e.body?.error === 'string' ? e.body.error : '';
    // A gateway that redirects, or something else answering at the address: not one to use.
    if (
      code === 'unsupported_api_version' ||
      code === 'api_version_mismatch' ||
      code === 'redirect_refused'
    ) {
      return new CliError(e.message, EXIT.gateway);
    }
    if (e.status === 401) {
      return new CliError(
        `The gateway at ${url} refused the token. Run \`clerq login\` again, or check CLERQ_GATEWAY_TOKEN.`
      );
    }
    if (e.status === 403) {
      return new CliError(
        `This token is not allowed to do that (${refusalText(e)}). The command line needs the gateway's own token, not a phone's or a module's.`
      );
    }
    if (e.status >= 500) {
      return new CliError(`The gateway had a problem (${e.status}): ${refusalText(e)}`);
    }
    return new CliError(refusalText(e));
  }
  const message = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
  if (
    (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) ||
    /timed? ?out/i.test(message)
  ) {
    return new CliError(`The gateway at ${url} did not answer in time.`, EXIT.gateway);
  }
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|network/i.test(
      `${message} ${cause}`
    )
  ) {
    return new CliError(
      `Lost contact with the gateway at ${url}${cause ? ` (${cause})` : ''}. Is OpenClerq still running?`,
      EXIT.gateway
    );
  }
  return new CliError(message);
}
