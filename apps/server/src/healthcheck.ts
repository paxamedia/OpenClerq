/**
 * `clerq-server healthcheck`: is the server on this machine answering?
 *
 * Asks `/v1/health` (public, no token) at the address the server listens on:
 * 127.0.0.1 when it listens on every interface or on loopback, else the
 * address `CLERQ_HOST` names. Healthy means HTTP 200 with `"status":"ok"`.
 * It says the process is serving requests; whether the store opened is in
 * `/v1/version` (`store.schema` is null until it has).
 */

import { API_VERSION } from '@clerq/gateway-client/protocol';
import { readServerConfig, type Env } from './env.js';

/** The address to connect to for a server listening on `host`. */
export function connectHost(host: string): string {
  if (host === '0.0.0.0' || host === 'localhost' || host === '') return '127.0.0.1';
  if (host === '::' || host === '::1' || host === '[::]' || host === '[::1]') return '[::1]';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export interface HealthResult {
  ok: boolean;
  message: string;
}

export async function healthcheck(
  env: Env,
  options: { timeoutMs: number; fetch?: typeof fetch }
): Promise<HealthResult> {
  let url: string;
  try {
    const { host, port } = readServerConfig(env);
    url = `http://${connectHost(host)}:${port}/v${API_VERSION}/health`;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const res = await (options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) return { ok: false, message: `${url} answered HTTP ${res.status}.` };
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    if (body?.status !== 'ok') return { ok: false, message: `${url} did not report status "ok".` };
    return { ok: true, message: `ok (${url})` };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const why = timedOut
      ? `no answer within ${options.timeoutMs / 1_000} s`
      : ((e as { cause?: { code?: string } }).cause?.code ??
        (e instanceof Error ? e.message : String(e)));
    return { ok: false, message: `${url}: ${why}` };
  }
}
