/** Test helpers: streams that remember what they were given, and `cli()` to run one command line. */

import { EventEmitter } from 'node:events';
import { runCli, type RunOptions } from './cli.js';
import type { Env, Io } from './output.js';

/** Standard input that delivers `text` and ends, or, as a terminal, takes typed keys. */
export class FakeStdin extends EventEmitter {
  isTTY: boolean;
  raw = false;
  private started = false;
  constructor(
    private readonly text = '',
    tty = false
  ) {
    super();
    this.isTTY = tty;
  }
  setRawMode(on: boolean) {
    this.raw = on;
    return this;
  }
  setEncoding() {
    return this;
  }
  pause() {
    return this;
  }
  /** What the person types, for a terminal. */
  type(keys: string) {
    this.emit('data', keys);
  }
  resume() {
    if (this.started || this.isTTY) return this;
    this.started = true;
    queueMicrotask(() => {
      if (this.text) this.emit('data', this.text);
      this.emit('end');
    });
    return this;
  }
}

export interface Captured {
  io: Io;
  stdout(): string;
  stderr(): string;
}

export function capture(stdin: FakeStdin = new FakeStdin(), tty = false): Captured {
  let out = '';
  let err = '';
  return {
    io: {
      stdin,
      stdout: { write: (c) => ((out += c), true), isTTY: tty },
      stderr: { write: (c) => ((err += c), true), isTTY: tty },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `clerq <argv>` with a home directory and environment of the test's own. */
export async function cli(
  argv: string[],
  options: {
    home: string;
    env?: Env;
    stdin?: string;
    cwd?: string;
    tty?: boolean;
    signal?: AbortSignal;
    pollMs?: number;
    localUrl?: string;
    retryMs?: number;
    githubPollMs?: number;
    githubWaitMs?: number;
    /** What opens a file or address: a test's own, never a real browser. */
    openUrl?: RunOptions['openUrl'];
  } & Partial<Pick<RunOptions, 'io'>>
): Promise<CliResult> {
  const c = capture(new FakeStdin(options.stdin ?? ''), options.tty ?? false);
  const code = await runCli(argv, {
    env: { HOME: options.home, ...options.env },
    io: options.io ?? c.io,
    home: options.home,
    cwd: options.cwd ?? options.home,
    signal: options.signal,
    pollMs: options.pollMs ?? 500,
    localUrl: options.localUrl,
    retryMs: options.retryMs ?? 10,
    githubPollMs: options.githubPollMs ?? 20,
    githubWaitMs: options.githubWaitMs,
    // A test that does not say how things open must not open anything.
    openUrl: options.openUrl ?? (async () => false),
  });
  const result = { code, stdout: c.stdout(), stderr: c.stderr() };
  // CLERQ_TEST_SHOW=1 prints every command and what it said, to read the output as a person would.
  if (process.env.CLERQ_TEST_SHOW) {
    console.log(
      `$ clerq ${argv.join(' ')}\n${result.stdout}${result.stderr ? `[stderr]\n${result.stderr}` : ''}[exit ${code}]\n`
    );
  }
  return result;
}
