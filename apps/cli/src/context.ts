import type { Call } from './args.js';
import type { Env, Io, Output } from './output.js';

/** What a command is given: the world it runs in. Tests build their own. */
export interface Context {
  env: Env;
  io: Io;
  out: Output;
  cwd: string;
  /** The account's home directory: where `~/.clerq` is. */
  home: string;
  /** Aborted when the person presses Ctrl-C. */
  signal: AbortSignal;
  /** The gateway being talked to, once a command has chosen it; for words about a failure. */
  url: string;
  /** The gateway on this computer. Always http://127.0.0.1:18790 outside tests. */
  localUrl: string;
  /** How long a followed run waits between looks when no event arrives. */
  pollMs: number;
  /** The wait before looking again after a lost connection, doubled by attempt. Default 1000. */
  retryMs: number;
  /** How often `clerq github` looks at the gateway while it waits for GitHub. Default 2000. */
  githubPollMs: number;
  /** How long `clerq github connect` waits for the app to come back from GitHub. Default 10 minutes (the manifest's own). */
  githubWaitMs: number;
  /**
   * Open a file or an address in the default application (the browser). False when there is
   * none to open. Tests replace it: nothing in a test opens a real browser.
   */
  openUrl: (target: string) => Promise<boolean>;
  call: Call;
}
