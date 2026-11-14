/**
 * One request to GitHub's REST API.
 *
 * What it will not do: follow a redirect (every request here carries a
 * credential), wait for ever, or put a credential, a request body or a
 * response body in an error. An error carries GitHub's own `message` (cut
 * short) and the status, which is all anyone needs to act on.
 */

import { githubApiBase } from './config.js';

/** GitHub could not be asked, or refused. `status` 0 means no answer at all. */
export class GithubApiError extends Error {
  constructor(
    /** HTTP status, or 0 when GitHub did not answer (network, timeout, a redirect). */
    readonly status: number,
    message: string,
    /** GitHub's own clock when it answered (its `Date` header), in milliseconds since the epoch. */
    readonly serverTime?: number
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

export interface ApiResponse {
  status: number;
  /** The parsed JSON body, or undefined when there was none or it was not JSON. */
  body: unknown;
  headers: Headers;
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /** Starts with `/`; appended to the API's base address. */
  path: string;
  /** Sent as `Authorization: Bearer …`. None for the manifest conversion. */
  bearer?: string;
  /** Sent as `Authorization: Basic …` instead (an app's client id and secret). */
  basic?: { user: string; password: string };
  body?: unknown;
  /** Statuses that are an answer, not an error (404 for "not installed"). */
  accept?: number[];
}

export interface ApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Override for the base address (tests); default `githubApiBase()`. */
  base?: string;
}

export const API_TIMEOUT_MS = 15_000;
const MESSAGE_MAX = 300;

/** GitHub's own words from an error body, cut short. */
export function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, MESSAGE_MAX);
  }
  return fallback;
}

export async function githubRequest(
  request: ApiRequest,
  options: ApiOptions = {}
): Promise<ApiResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.base ?? githubApiBase()}${request.path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'OpenClerq',
  };
  if (request.bearer) headers.Authorization = `Bearer ${request.bearer}`;
  else if (request.basic) {
    headers.Authorization = `Basic ${Buffer.from(`${request.basic.user}:${request.basic.password}`).toString('base64')}`;
  }
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await doFetch(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new GithubApiError(
      0,
      timedOut ? 'GitHub did not answer in time.' : 'Could not reach GitHub.'
    );
  }

  // A redirect is not followed: GitHub answers 301 for a repository that was renamed.
  if (res.status >= 300 && res.status < 400) {
    throw new GithubApiError(0, `GitHub answered with a redirect (${res.status}); not followed.`);
  }

  const text = await res.text().catch(() => '');
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  const ok = (res.status >= 200 && res.status < 300) || request.accept?.includes(res.status);
  if (!ok) {
    const date = Date.parse(res.headers.get('date') ?? '');
    throw new GithubApiError(
      res.status,
      messageOf(body, `GitHub answered ${res.status}.`),
      Number.isFinite(date) ? date : undefined
    );
  }
  return { status: res.status, body, headers: res.headers };
}

/** The `rel="next"` address of a `Link` header, as a path and query, or null. */
export function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) {
      try {
        const u = new URL(m[1]);
        return `${u.pathname}${u.search}`;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** More than this far from GitHub's clock, an app's JWT is refused (it allows a minute: 30 s leaves room). */
export const CLOCK_SKEW_LIMIT_MS = 30_000;

/**
 * When a refusal is because this computer's clock is wrong, in words: GitHub
 * answers 401 to a JWT dated in its future or past, and that says nothing
 * about the key. `localNow` is the clock the JWT was made with. Null when
 * the clocks agree to within 30 seconds, or GitHub did not say what time it is.
 */
export function clockProblem(e: GithubApiError, localNow: number): string | null {
  if (e.status !== 401 || e.serverTime === undefined) return null;
  const skew = localNow - e.serverTime;
  if (Math.abs(skew) <= CLOCK_SKEW_LIMIT_MS) return null;
  const seconds = Math.round(Math.abs(skew) / 1000);
  const amount =
    seconds < 120
      ? `${seconds} seconds`
      : seconds < 7200
        ? `${Math.round(seconds / 60)} minutes`
        : `${Math.round(seconds / 3600)} hours`;
  return (
    `This computer's clock is about ${amount} ${skew > 0 ? 'ahead of' : 'behind'} GitHub's, ` +
    "and GitHub refuses an app's token signed at the wrong time. Correct the clock (turn on automatic time) and try again; the key is probably fine."
  );
}
