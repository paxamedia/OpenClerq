/**
 * Running one command line: parse it, print help or the version, or load the
 * command and run it. Returns the exit code; nothing here exits the process,
 * so a test can call it with its own streams, environment and home directory.
 */

import os from 'node:os';
import path from 'node:path';
import { parseArgs, type Parsed } from './args.js';
import { COMMANDS } from './commands.js';
import { DEFAULT_URL } from './connection.js';
import type { Context } from './context.js';
import { EXIT, describeFailure } from './errors.js';
import { helpFor } from './help.js';
import { systemOpen } from './open.js';
import { Output, type Env, type Io } from './output.js';
import { CLI_VERSION } from './version.js';

export interface RunOptions {
  env: Env;
  io: Io;
  cwd?: string;
  home?: string;
  /** Aborted by Ctrl-C. */
  signal?: AbortSignal;
  /** The gateway on this computer; tests point it at theirs. Default http://127.0.0.1:18790. */
  localUrl?: string;
  /** How long a followed run waits between looks when no event comes. Default 3000. */
  pollMs?: number;
  /** The wait before looking again after a lost connection. Default 1000. */
  retryMs?: number;
  /** How often `clerq github` looks while it waits for GitHub. Default 2000. */
  githubPollMs?: number;
  /** How long `clerq github connect` and `login` wait. Default 10 minutes. */
  githubWaitMs?: number;
  /** Open a file or address in the default application. Default: the system's (`open`, `xdg-open`). */
  openUrl?: (target: string) => Promise<boolean>;
}

/** The account's home: where `~/.clerq` is. */
export function homeOf(env: Env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.resolve(home);
}

/** `clerq 0.5.1 (API version 1)`. */
export async function versionLine(): Promise<string> {
  const { API_VERSION } = await import('@clerq/gateway-client/protocol');
  return `clerq ${CLI_VERSION} (API version ${API_VERSION})`;
}

function show(io: Io, parsed: Parsed & { kind: 'help' | 'error' }): number {
  const text = helpFor(COMMANDS, parsed.kind === 'help' ? parsed.topic : [], CLI_VERSION);
  if (parsed.kind === 'help') {
    io.stdout.write(
      text ?? `No help for "${parsed.topic.join(' ')}".\n\n${helpFor(COMMANDS, [], CLI_VERSION)}`
    );
    return text ? EXIT.ok : EXIT.usage;
  }
  const hint =
    parsed.topic.length > 0
      ? `Run \`clerq help ${parsed.topic.join(' ')}\` for its usage.`
      : 'Run `clerq help` for the commands.';
  io.stderr.write(`clerq: ${parsed.message}\n${hint}\n`);
  return EXIT.usage;
}

export async function runCli(argv: string[], options: RunOptions): Promise<number> {
  const { env, io } = options;
  const parsed = parseArgs(argv, COMMANDS);
  if (parsed.kind === 'help' || parsed.kind === 'error') return show(io, parsed);
  if (parsed.kind === 'version') {
    io.stdout.write(`${await versionLine()}\n`);
    return EXIT.ok;
  }

  const { call } = parsed;
  const out = new Output(io, call.opts.json === true, env, call.opts['no-color'] === true);
  const ctx: Context = {
    env,
    io,
    out,
    cwd: options.cwd ?? process.cwd(),
    home: options.home ?? homeOf(env),
    signal: options.signal ?? new AbortController().signal,
    url: '',
    localUrl: options.localUrl ?? DEFAULT_URL,
    pollMs: options.pollMs ?? 3_000,
    retryMs: options.retryMs ?? 1_000,
    githubPollMs: options.githubPollMs ?? 2_000,
    githubWaitMs: options.githubWaitMs ?? 10 * 60_000,
    openUrl: options.openUrl ?? systemOpen,
    call,
  };
  try {
    const { run } = await call.command.load();
    return await run(ctx, call);
  } catch (e) {
    const failure = describeFailure(e, ctx.url || 'the gateway');
    out.error(failure.message);
    return failure.exitCode;
  }
}
