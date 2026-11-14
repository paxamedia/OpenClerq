/**
 * `clerq-server healthcheck`: is the server on this machine answering?
 *
 * Asks `/v1/health` (public, no token) at the address the server listens on:
 * 127.0.0.1 when it listens on every IPv4 interface or on 127.0.0.1, and the
 * address `CLERQ_HOST` names when that is one particular address. For a name
 * that can mean either loopback address (`localhost`, `::`) it tries each, since
 * the server may have bound only one of them. Healthy means HTTP 200 with
 * `"status":"ok"` from any of them. It says the process is serving requests;
 * whether the store opened is in `/v1/version` (`store.schema` is null until it
 * has).
 */

import { API_VERSION } from '@clerq/gateway-client/protocol';
import { readServerConfig, type Env } from './env.js';

/**
 * The addresses to try, in order, for a server listening on `host`. A
 * `localhost` that resolves to `::1` only (as in a container whose
 * /etc/hosts maps both) is not found at 127.0.0.1, and the other way round.
 */
export function connectHosts(host: string): string[] {
  if (host === '0.0.0.0' || host === '') return ['127.0.0.1'];
  if (host === 'localhost') return ['127.0.0.1', '[::1]'];
  if (host === '::' || host === '[::]') return ['[::1]', '127.0.0.1'];
  if (host === '::1' || host === '[::1]') return ['[::1]'];
  return [host.includes(':') && !host.startsWith('[') ? `[${host}]` : host];
}

export interface HealthResult {
  ok: boolean;
  message: string;
}

export async function healthcheck(
  env: Env,
  options: { timeoutMs: number; fetch?: typeof fetch }
): Promise<HealthResult> {
  let urls: string[];
  try {
    const { host, port } = readServerConfig(env);
    urls = connectHosts(host).map((h) => `http://${h}:${port}/v${API_VERSION}/health`);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const doFetch = options.fetch ?? fetch;
  const deadline = Date.now() + options.timeoutMs;
  const failures: string[] = [];
  for (const url of urls) {
    const left = Math.max(100, deadline - Date.now());
    try {
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(left),
        headers: { Accept: 'application/json' },
      });
      if (res.status !== 200) {
        failures.push(`${url} answered HTTP ${res.status}.`);
        continue;
      }
      const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
      if (body?.status !== 'ok') {
        failures.push(`${url} did not report status "ok".`);
        continue;
      }
      return { ok: true, message: `ok (${url})` };
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const why = timedOut
        ? `no answer within ${options.timeoutMs / 1_000} s`
        : ((e as { cause?: { code?: string } }).cause?.code ??
          (e instanceof Error ? e.message : String(e)));
      failures.push(`${url}: ${why}`);
    }
  }
  return { ok: false, message: failures.join(' ') };
}
