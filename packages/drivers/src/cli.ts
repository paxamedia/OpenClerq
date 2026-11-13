/**
 * What every CLI driver shares: starting the agent in a sandbox, turning its
 * output lines into events as they arrive, and stopping it when the caller
 * stops listening. A driver supplies the command line and a parser for its
 * CLI's output; the process handling is the same for all of them.
 */

import path from 'node:path';
import { exec, type ExecResult, type SandboxSpec } from '@clerq/sandbox';
import type { DriverAvailability, DriverEvent, DriverResult, DriverRunInput } from './types.js';

/** Reads one CLI's output. */
export interface EventParser {
  /** One line of output, as events. Lines it cannot read come back as log events. */
  consume(line: string, stream: 'stdout' | 'stderr'): DriverEvent[];
  /** The outcome, once the process has ended. */
  finish(run: ExecResult): DriverResult;
}

export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
/** Tool output kept per result. A test log can run to megabytes. */
export const MAX_TOOL_OUTPUT_CHARS = 64_000;

export function capped(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[…${text.length - MAX_TOOL_OUTPUT_CHARS} more characters]`
    : text;
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A line of a CLI's own stderr that reports a failed API call, or undefined.
 * Stderr is the CLI's: the agent's text and its tools' output go to stdout.
 */
export function apiErrorIn(lines: readonly string[]): string | undefined {
  const PROVIDER =
    /\bAPI Error\b|\boverloaded\b|\brate[_ ]?limit|\b(?:status|HTTP)[: ]+(?:5\d\d|429)\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bsocket hang up\b|\bfetch failed\b/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROVIDER.test(lines[i])) return lines[i].trim().slice(0, 500);
  }
  return undefined;
}

/**
 * The variables that point a CLI at a state directory of the run's (see
 * `DriverRunInput.stateHome`), or `fromGateway` (the user's own overrides)
 * when it runs on the user's state.
 */
export function stateEnv(
  stateHome: string | undefined,
  inHome: (home: string) => Record<string, string>,
  fromGateway: Record<string, string>
): Record<string, string> {
  return stateHome ? { HOME: stateHome, ...inHome(stateHome) } : fromGateway;
}

/** Whether the agent runs inside a container image, where the CLI is the image's own. */
export function inContainer(input: Pick<DriverRunInput, 'sandbox'>): boolean {
  return input.sandbox?.profile === 'container';
}

/**
 * What `detect` says for a CLI that runs inside a container image: the host's
 * copy is not the one used, so there is nothing here to check. A missing CLI
 * in the image fails the run when it starts, saying so.
 */
export function containerAvailability(id: string, cliName: string): DriverAvailability {
  return { id, available: true, path: cliName };
}

/** A finished event for a run that never got as far as starting the CLI. */
export function failed(summary: string, warnings: string[] = []): DriverEvent {
  return {
    type: 'finished',
    result: {
      ok: false,
      summary,
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      exitCode: null,
      timedOut: false,
      cancelled: false,
      permissionDenials: [],
      warnings,
    },
  };
}

/** Terminal colour codes, which a CLI may print even when it is not a terminal. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * The environment for the CLI: the caller's variables, and PATH with the
 * CLI's own directory first. An npm install is a node script, and node
 * usually sits beside it.
 */
export function cliEnv(
  bin: string,
  env: Record<string, string> | undefined,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...env,
    PATH: [path.dirname(bin), env?.PATH ?? process.env.PATH ?? '']
      .filter(Boolean)
      .join(path.delimiter),
    ...extra,
  };
}

/** Run a short command to learn something about the CLI, such as its version. */
export async function probe(
  bin: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ ok: boolean; code: number | null; text: string }> {
  const r = await exec(
    {
      profile: 'native',
      cwd: path.dirname(bin),
      env: cliEnv(bin, undefined, env),
      limits: { wallMs: 15_000 },
    },
    bin,
    args
  );
  return {
    ok: r.code === 0,
    code: r.code,
    text: stripAnsi(`${r.stdout}\n${r.stderr}`).trim(),
  };
}

/**
 * The long options a command line relies on: those before the `--` that ends
 * the options and starts the prompt.
 */
export function flagsOf(args: string[]): string[] {
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  return [...new Set(options.filter((a) => a.startsWith('--')))];
}

/**
 * Which of `wanted` the CLI's `--help` does not mention. Says nothing is
 * missing when help cannot be read, so a CLI that words its help unexpectedly
 * is not turned away for it.
 */
export async function missingFlags(
  bin: string,
  helpArgs: string[],
  wanted: string[],
  env?: Record<string, string>
): Promise<string[]> {
  if (wanted.length === 0) return [];
  const help = await probe(bin, helpArgs, env);
  const listed = new Set(
    (help.text.match(/(?<![\w-])--[a-z][\w-]*/gi) ?? []).map((f) => f.toLowerCase())
  );
  if (!help.ok || listed.size === 0) return [];
  return wanted.filter((flag) => !listed.has(flag));
}

/**
 * Run the CLI and stream what it does. The process is stopped when the
 * caller's signal aborts, when the time limit passes, and when the caller
 * stops iterating; its whole process group goes with it.
 */
export async function* runCli(options: {
  bin: string;
  args: string[];
  input: DriverRunInput;
  env: Record<string, string>;
  parser: EventParser;
}): AsyncIterable<DriverEvent> {
  const { args, input, env, parser } = options;
  // In a container the CLI is the image's own, found on the image's PATH.
  const bin = options.bin;

  // Stops the process if the caller abandons the iteration early.
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', forward, { once: true });

  const spec: SandboxSpec = {
    ...input.sandbox,
    profile: input.sandbox?.profile ?? 'native',
    cwd: input.cwd,
    env,
    secrets: input.secrets,
    limits: { wallMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxOutputBytes: 2_097_152 },
  };

  const queue: DriverEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (event: DriverEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  void exec(spec, bin, args, {
    signal: controller.signal,
    onLine: (line, which) => {
      for (const event of parser.consume(line, which)) push(event);
    },
    onSpawn: input.onSpawn ? (spawned) => input.onSpawn?.({ ...spawned, command: bin }) : undefined,
    // A dev server the agent started would otherwise outlive the run, unseen.
    reapGroup: true,
  })
    .then(
      (result) => push({ type: 'finished', result: parser.finish(result) }),
      (e: unknown) => push(failed(e instanceof Error ? e.message : String(e)))
    )
    .finally(() => {
      done = true;
      wake?.();
      wake = null;
    });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as DriverEvent;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    input.signal?.removeEventListener('abort', forward);
    if (!done) controller.abort();
  }
}
