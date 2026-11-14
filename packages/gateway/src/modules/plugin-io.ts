/**
 * `ctx.exec`, `ctx.fetch` and `ctx.fs`: what a plugin runs, calls and reads
 * through its context, each checked by the plugin's `PluginGuard` first.
 *
 * They work with enforcement off too (the guard then only audits what is outside
 * the declaration). They end with the plugin: a command still running when the
 * plugin stops is killed, and a request still open is aborted.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ExecOptions, ExecResult, PluginExec, PluginFetch, PluginFs } from '@clerq/plugin-sdk';
import type { PluginGuard } from './plugin-guard.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

/** What a command is given of the gateway's environment; the rest (tokens, API keys) stays behind. */
const SAFE_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM'];

export interface IoDeps {
  id: string;
  guard: PluginGuard;
  /** Aborts when the plugin stops. */
  signal: AbortSignal;
  /** Throws once the plugin has stopped. */
  assertLive(): void;
  /** For tests: the `fetch` used. */
  fetchImpl?: typeof fetch;
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function run(
  cmd: string,
  args: string[],
  opts: ExecOptions,
  signal: AbortSignal,
  running: Set<ChildProcess>
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const k of SAFE_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, opts.env ?? {});
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      return reject(new Error(`Could not start "${cmd}": ${(e as Error).message}`));
    }
    running.add(child);
    const cap = Math.max(1, opts.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    const take = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
      if (bytes >= cap) return bytes;
      chunks.push(chunk.subarray(0, cap - bytes));
      return bytes + chunk.length;
    };
    child.stdout?.on('data', (c: Buffer) => (outBytes = take(out, outBytes, c)));
    child.stderr?.on('data', (c: Buffer) => (errBytes = take(err, errBytes, c)));
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree(child);
      },
      Math.min(Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
    );
    const onAbort = () => killTree(child);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      running.delete(child);
      fn();
    };
    child.on('error', (e) =>
      finish(() => reject(new Error(`Could not start "${cmd}": ${e.message}`)))
    );
    child.on('close', (code, sig) =>
      finish(() =>
        resolve({
          code,
          signal: sig,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
        })
      )
    );
    // A command that does not read its input closes the pipe; that is not an error here.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

const SENSITIVE_ON_REDIRECT = ['authorization', 'cookie', 'proxy-authorization'];

export function createIo(deps: IoDeps): { exec: PluginExec; fetch: PluginFetch; fs: PluginFs } {
  const running = new Set<ChildProcess>();
  deps.signal.addEventListener('abort', () => running.forEach(killTree), { once: true });
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const exec: PluginExec = async (cmd, args = [], opts = {}) => {
    deps.assertLive();
    if (typeof cmd !== 'string' || cmd === '') throw new Error('ctx.exec needs a command.');
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new Error('ctx.exec takes its arguments as a list of strings.');
    }
    deps.guard.command(cmd);
    return run(cmd, args, opts, deps.signal, running);
  };

  const fetchChecked: PluginFetch = async (input, init = {}) => {
    deps.assertLive();
    let url: URL;
    try {
      url = new URL(input instanceof URL ? input.href : String(input));
    } catch {
      throw new Error('ctx.fetch needs a full address, like "https://api.example.com/v1".');
    }
    const mode = init.redirect ?? 'follow';
    const signal = init.signal ? AbortSignal.any([init.signal, deps.signal]) : deps.signal;
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    let headers = new Headers(init.headers);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('ctx.fetch only does http and https.');
      }
      deps.guard.host(url);
      const res = await doFetch(url, {
        ...init,
        method,
        body,
        headers,
        signal,
        // Each hop is checked here, so a redirect cannot lead somewhere that was not declared.
        redirect: mode === 'follow' ? 'manual' : mode,
      });
      const location = res.headers.get('location');
      if (mode !== 'follow' || res.status < 300 || res.status > 399 || !location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error('ctx.fetch followed too many redirects.');
      void res.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        headers = new Headers(headers);
        for (const h of SENSITIVE_ON_REDIRECT) headers.delete(h);
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET';
        body = undefined;
      } else if (
        body !== undefined &&
        typeof body !== 'string' &&
        !(body instanceof URLSearchParams)
      ) {
        if (
          typeof (body as ReadableStream).getReader === 'function' ||
          typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
        ) {
          throw new Error('ctx.fetch cannot follow a redirect with a streamed body.');
        }
      }
      url = next;
    }
  };

  const files: PluginFs = {
    readFile: (async (p: string, encoding?: 'utf8') => {
      deps.assertLive();
      const real = deps.guard.path(p, 'read');
      const data = await fsp.readFile(real);
      return encoding === 'utf8' ? data.toString('utf8') : data;
    }) as PluginFs['readFile'],
    async writeFile(p, data) {
      deps.assertLive();
      const real = deps.guard.path(p, 'write');
      await fsp.mkdir(path.dirname(real), { recursive: true });
      await fsp.writeFile(real, data);
    },
  };

  return { exec, fetch: fetchChecked, fs: files };
}
