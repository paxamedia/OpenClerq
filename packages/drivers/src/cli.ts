/**
 * What every CLI driver shares: starting the agent in a sandbox, turning its
 * output lines into events as they arrive, and stopping it when the caller
 * stops listening. A driver supplies the command line and a parser for its
 * CLI's output; the process handling is the same for all of them.
 */

import path from 'node:path';
import { exec, type ExecResult, type SandboxSpec } from '@clerq/sandbox';
import type { DriverEvent, DriverResult, DriverRunInput } from './types.js';

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
  const { bin, args, input, env, parser } = options;

  // Stops the process if the caller abandons the iteration early.
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', forward, { once: true });

  const spec: SandboxSpec = {
    profile: input.sandbox?.profile ?? 'native',
    network: input.sandbox?.network,
    allowWrite: input.sandbox?.allowWrite,
    image: input.sandbox?.image,
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
