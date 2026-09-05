/**
 * Outbound network policy for the http.request tool.
 *
 * A hostname allowlist alone is not SSRF protection: an allowed host can resolve
 * to a private address, or redirect to one. Every request here is checked at four
 * points — scheme, hostname allowlist, resolved IP address, and again on every
 * redirect hop — and is bounded in time and response size.
 *
 * Residual risk, stated plainly: this resolves DNS and checks the answer, but the
 * subsequent connection performs its own lookup, so a TOCTOU rebinding attack
 * remains theoretically possible. Pinning the checked address requires a custom
 * agent/dispatcher and is tracked for the sandbox work in release 0.5.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export class NetworkPolicyError extends Error {
  readonly code = 'network_not_allowed';
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

export interface NetworkPolicy {
  /** Hostnames the tool may reach. Empty disables outbound requests entirely. */
  allowlist: string[];
  /** URL schemes permitted. Default: https only. */
  allowedSchemes?: string[];
  /** HTTP methods permitted. Default: GET, HEAD, POST. */
  allowedMethods?: string[];
  /** Redirect hops to follow, each revalidated. Default: 3. */
  maxRedirects?: number;
  /** Whole-request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** Maximum response body retained, in bytes. Default: 262144 (256 KiB). */
  maxBytes?: number;
  /**
   * Permit private, loopback and link-local destinations. Off by default; exists
   * for users deliberately targeting a service on their own network.
   */
  allowPrivateAddresses?: boolean;
}

const DEFAULTS = {
  allowedSchemes: ['https:'],
  allowedMethods: ['GET', 'HEAD', 'POST'],
  maxRedirects: 3,
  timeoutMs: 10_000,
  maxBytes: 262_144,
};

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 this network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0/24 protocol assignments, 192.0.2/24 TEST-NET
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved, incl. 255.255.255.255
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // strip zone index

  // IPv4-mapped (::ffff:1.2.3.4) and NAT64 (64:ff9b::1.2.3.4) carry a v4 address.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (embedded) return ipv4Blocked(embedded[1]);

  if (addr === '::' || addr === '::1') return true; // unspecified, loopback
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local (incl. AWS fd00:ec2::254)
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^ff/.test(addr)) return true; // ff00::/8 multicast
  return false;
}

/** True when an address must not be contacted. Unparseable addresses are blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family === 6) return ipv6Blocked(ip);
  return true;
}

function hostMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, ''); // strip trailing root dot
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase().trim().replace(/\.$/, '');
    if (!allowed) return false;
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  });
}

/**
 * Validate one URL against the policy: scheme, allowlist, and every address the
 * hostname resolves to. Throws NetworkPolicyError on any failure.
 */
export async function assertUrlAllowed(rawUrl: string, policy: NetworkPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetworkPolicyError('Invalid URL.');
  }

  const schemes = policy.allowedSchemes ?? DEFAULTS.allowedSchemes;
  if (!schemes.includes(url.protocol)) {
    throw new NetworkPolicyError(
      `Scheme "${url.protocol}" is not permitted. Allowed: ${schemes.join(', ')}.`
    );
  }

  if (url.username || url.password) {
    throw new NetworkPolicyError('URLs carrying credentials are not permitted.');
  }

  if (!hostMatchesAllowlist(url.hostname, policy.allowlist)) {
    throw new NetworkPolicyError(`Host "${url.hostname}" is not in the configured httpAllowlist.`);
  }

  if (policy.allowPrivateAddresses) return url;

  // A literal IP in the URL is checked directly; a name is resolved first.
  const literal = net.isIP(url.hostname.replace(/^\[|\]$/g, ''));
  if (literal) {
    const ip = url.hostname.replace(/^\[|\]$/g, '');
    if (isBlockedAddress(ip)) {
      throw new NetworkPolicyError(
        `Address ${ip} is in a blocked range (loopback, private, link-local or reserved).`
      );
    }
    return url;
  }

  let addresses: string[];
  try {
    const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new NetworkPolicyError(`Could not resolve "${url.hostname}".`);
  }

  if (addresses.length === 0) {
    throw new NetworkPolicyError(`"${url.hostname}" resolved to no addresses.`);
  }
  // Every answer must be acceptable — one bad record is enough to refuse.
  for (const ip of addresses) {
    if (isBlockedAddress(ip)) {
      throw new NetworkPolicyError(
        `"${url.hostname}" resolves to ${ip}, which is in a blocked range (loopback, private, link-local or reserved).`
      );
    }
  }

  return url;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** True when the body hit maxBytes and was cut short. */
  truncated: boolean;
  /** Every URL visited, starting with the request and including redirect hops. */
  chain: string[];
}

/** Read a response body up to `maxBytes`, without buffering more than that. */
async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/**
 * Perform an HTTP request under the policy, following redirects manually so each
 * hop is revalidated against the allowlist and address rules.
 */
export async function safeFetch(
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  policy: NetworkPolicy
): Promise<SafeFetchResult> {
  if (!Array.isArray(policy.allowlist) || policy.allowlist.length === 0) {
    throw new NetworkPolicyError(
      'Outbound HTTP is disabled. Configure capabilities.httpAllowlist to enable it.'
    );
  }

  const methods = policy.allowedMethods ?? DEFAULTS.allowedMethods;
  const method = (init.method || 'GET').toUpperCase();
  if (!methods.includes(method)) {
    throw new NetworkPolicyError(
      `Method ${method} is not permitted. Allowed: ${methods.join(', ')}.`
    );
  }

  const maxRedirects = policy.maxRedirects ?? DEFAULTS.maxRedirects;
  const timeoutMs = policy.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = policy.maxBytes ?? DEFAULTS.maxBytes;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = rawUrl;
    let currentMethod = method;
    let currentBody = init.body;
    const chain: string[] = [];

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = await assertUrlAllowed(currentUrl, policy);
      chain.push(url.toString());

      const res = await fetch(url, {
        method: currentMethod,
        headers: init.headers ?? {},
        body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
        redirect: 'manual',
        signal: controller.signal,
      });

      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
      if (!isRedirect) {
        const { text, truncated } = await readCapped(res, maxBytes);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, bodyText: text, truncated, chain };
      }

      if (hop === maxRedirects) {
        throw new NetworkPolicyError(`Exceeded ${maxRedirects} redirects.`);
      }

      // Resolve the next hop against the current URL and revalidate on the next pass.
      currentUrl = new URL(res.headers.get('location') as string, url).toString();
      // 303, and 301/302 in practice, downgrade to GET and drop the body.
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      await res.body?.cancel().catch(() => {});
    }

    throw new NetworkPolicyError('Redirect handling failed.');
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new NetworkPolicyError(`Request timed out after ${timeoutMs}ms.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
