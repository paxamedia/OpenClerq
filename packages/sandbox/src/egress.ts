/**
 * Egress allowlist, enforced at the boundary.
 *
 * An allowlist checked inside the agent's own HTTP tool is advice: the process
 * can open a socket itself, or run curl. The control has to sit somewhere the
 * process cannot route around.
 *
 * So the allowlist lives in a proxy on loopback, and the sandbox denies every
 * other outbound connection. A sandboxed command can reach exactly the hosts on
 * the list, through this proxy, and nothing else — including the hosts it
 * resolves itself, because it never gets to resolve anything.
 *
 * The proxy speaks the two forms a client needs: CONNECT for TLS, and
 * absolute-form requests for plain HTTP. Anything else is refused with 403 and
 * recorded, so a refusal is visible rather than a silent hang.
 */

import http from 'node:http';
import net from 'node:net';

export interface EgressRule {
  /** Lower-case host, or "*.example.com" for any subdomain of it. */
  host: string;
  /** Undefined means any port. */
  port?: number;
}

export class EgressError extends Error {
  readonly code = 'egress_error';
  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

/**
 * Parse allowlist entries: "example.com", "example.com:443", "*.example.com",
 * "127.0.0.1:8080".
 */
export function parseAllowlist(entries: string[]): EgressRule[] {
  return entries.map((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) throw new EgressError('An allowlist entry is empty.');
    // Bracketed IPv6, optionally with a port: [::1]:443
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (v6) return rule(v6[1], v6[2], raw);

    const parts = entry.split(':');
    if (parts.length > 2) return { host: entry }; // bare IPv6 literal
    return rule(parts[0], parts[1], raw);
  });
}

function rule(host: string, portText: string | undefined, raw: string): EgressRule {
  if (!host) throw new EgressError(`Allowlist entry "${raw}" has no host.`);
  if (portText === undefined) return { host };
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EgressError(`Allowlist entry "${raw}" has an invalid port.`);
  }
  return { host, port };
}

export function isAllowed(rules: EgressRule[], host: string, port: number): boolean {
  const target = host.toLowerCase().replace(/^\[|\]$/g, '');
  return rules.some((r) => {
    if (r.port !== undefined && r.port !== port) return false;
    if (r.host.startsWith('*.')) {
      // A wildcard covers subdomains only; the apex must be listed on its own.
      return target.endsWith(r.host.slice(1)) && target.length > r.host.length - 1;
    }
    return r.host === target;
  });
}

/** One connection the proxy turned away. */
export interface DeniedAttempt {
  host: string;
  port: number;
  at: string;
}

export interface EgressProxy {
  /** Proxy URL to hand to the sandboxed process, e.g. http://127.0.0.1:53421. */
  url: string;
  port: number;
  /** Connections allowed so far. */
  readonly allowed: number;
  /** Connections refused, for the run's record. */
  readonly denied: DeniedAttempt[];
  close(): Promise<void>;
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };
  const i = authority.lastIndexOf(':');
  if (i === -1) return { host: authority, port: defaultPort };
  const port = Number(authority.slice(i + 1));
  if (!Number.isInteger(port)) return { host: authority, port: defaultPort };
  return { host: authority.slice(0, i), port };
}

/**
 * Start the proxy on loopback. The caller closes it when the run ends.
 *
 * @param allowlist hosts the sandboxed process may reach
 * @param opts.host interface to bind; loopback by default, and it should stay
 *   that way — an open egress proxy is an open relay.
 */
export async function startEgressProxy(
  allowlist: string[],
  opts: { host?: string; port?: number } = {}
): Promise<EgressProxy> {
  const rules = parseAllowlist(allowlist);
  const denied: DeniedAttempt[] = [];
  let allowed = 0;
  const sockets = new Set<net.Socket>();

  const refuse = (host: string, port: number): void => {
    denied.push({ host, port, at: new Date().toISOString() });
  };

  const server = http.createServer();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // Plain HTTP: the client sends an absolute-form request line.
  server.on('request', (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Proxy requires an absolute-form request URI.\n');
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    if (target.protocol !== 'http:' || !isAllowed(rules, target.hostname, port)) {
      refuse(target.hostname, port);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`Egress to ${target.hostname}:${port} is not on the allowlist.\n`);
      return;
    }

    allowed += 1;
    const upstream = http.request(
      {
        host: target.hostname,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Upstream error: ${e.message}\n`);
    });
    req.pipe(upstream);
  });

  // TLS and anything else tunnelled: CONNECT host:port.
  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    const { host, port } = splitHostPort(req.url ?? '', 443);
    if (!isAllowed(rules, host, port)) {
      refuse(host, port);
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n`,
        () => void clientSocket.destroy()
      );
      return;
    }

    allowed += 1;
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', () => {
      // The client is mid-handshake; closing is the only honest answer.
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n', drop);
    });
    clientSocket.on('error', drop);
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://${host}:${port}`,
    port,
    get allowed() {
      return allowed;
    },
    denied,
    close() {
      return new Promise<void>((resolve) => {
        // Tunnelled sockets keep the server alive; a run that ends must not wait
        // for a long-lived connection to close on its own.
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}
