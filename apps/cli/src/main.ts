#!/usr/bin/env node
/**
 * clerq: the OpenClerq command line. See docs/CLI.md; `clerq help` lists the
 * commands. This file only wires the process to `runCli`.
 */

async function main(): Promise<number> {
  const { limitWaitForAnswer } = await import('./timeout.js');
  // CLERQ_TIMEOUT (seconds) is for a slow link; the default is 30.
  const seconds = Number(process.env.CLERQ_TIMEOUT);
  limitWaitForAnswer(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000);
  // Ctrl-C ends a watch (the run goes on). Anything that does not watch gets a moment, then exits.
  const interrupt = new AbortController();
  let pressed = false;
  process.on('SIGINT', () => {
    if (pressed) process.exit(130);
    pressed = true;
    interrupt.abort();
    setTimeout(() => process.exit(130), 1500).unref();
  });
  // A closed pipe (`clerq logs ... | head`) ends the command quietly.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
  });

  const { runCli } = await import('./cli.js');
  return runCli(process.argv.slice(2), {
    env: process.env,
    io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    signal: interrupt.signal,
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`clerq: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  }
);
