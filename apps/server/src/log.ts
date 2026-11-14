/**
 * The server's own log lines, in the gateway's format so one stream reads
 * the same: `[time] [LEVEL] message`, or a JSON line when CLERQ_LOG_JSON=1.
 */

import type { Env } from './env.js';

export type Level = 'INFO' | 'WARN' | 'ERROR';

export interface Sink {
  out(line: string): void;
  err(line: string): void;
}

export const consoleSink: Sink = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export function makeLog(env: Env, sink: Sink = consoleSink, now: () => Date = () => new Date()) {
  const json = env.CLERQ_LOG_JSON === '1' || env.CLERQ_LOG_JSON === 'true';
  return (level: Level, message: string): void => {
    const ts = now().toISOString();
    const line = json
      ? JSON.stringify({ ts, level, msg: message })
      : `[${ts}] [${level}] ${message}`;
    // Errors on stderr, the rest on stdout, as the gateway's logger does.
    if (level === 'INFO') sink.out(line);
    else sink.err(line);
  };
}

export type Log = ReturnType<typeof makeLog>;
