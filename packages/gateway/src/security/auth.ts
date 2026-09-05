/**
 * Gateway authentication.
 *
 * Authentication answers "is this caller allowed to control this gateway".
 * Licensing (middleware/license.ts) answers "is this install entitled to feature X".
 * They are separate concerns and neither may substitute for the other.
 *
 * Token resolution order:
 *   1. CLERQ_GATEWAY_TOKEN environment variable
 *   2. ~/.clerq/gateway-token (created with 0600 on first run)
 *
 * There is no unauthenticated mode. Development is not an exception.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** Endpoints reachable without a token. These must reveal no configuration. */
export const PUBLIC_PATHS = new Set(['/health']);

/**
 * Endpoints that may carry the token as a `token` query parameter instead of a
 * header. This exists solely for Server-Sent Events: the browser EventSource API
 * cannot set request headers. Restricted to loopback-facing read-only streams.
 */
export const QUERY_TOKEN_PATHS = new Set(['/logs/stream']);

const TOKEN_BYTES = 32;

function getTokenPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'gateway-token');
}

function readTokenFile(): string | null {
  const p = getTokenPath();
  try {
    if (!fs.existsSync(p)) return null;
    const value = fs.readFileSync(p, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeTokenFile(token: string): void {
  const p = getTokenPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written 0600: readable only by the owning user.
  fs.writeFileSync(p, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Resolve the gateway token, generating and persisting one when absent.
 * Returns both the token and where it came from, so startup can tell the
 * operator how to authenticate.
 */
export function resolveGatewayToken(): { token: string; source: 'env' | 'file' | 'generated' } {
  const fromEnv = process.env.CLERQ_GATEWAY_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const fromFile = readTokenFile();
  if (fromFile) return { token: fromFile, source: 'file' };

  const token = generateToken();
  writeTokenFile(token);
  return { token, source: 'generated' };
}

/** Constant-time comparison that does not leak length through early return. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure cost does not depend on length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }

  const alt = req.headers['x-clerq-token'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();

  if (QUERY_TOKEN_PATHS.has(req.path)) {
    const q = (req.query as Record<string, unknown>)?.token;
    if (typeof q === 'string' && q.trim()) return q.trim();
  }

  return null;
}

/**
 * Require a valid bearer token on every request except PUBLIC_PATHS.
 * CORS preflight is allowed through so the browser can read the real response.
 */
export function requireAuth(expectedToken: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();
    if (PUBLIC_PATHS.has(req.path)) return next();

    const presented = extractToken(req);
    if (!presented) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="clerq-gateway"');
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Missing bearer token. Send "Authorization: Bearer <token>" from ~/.clerq/gateway-token.',
      });
    }

    if (!tokensMatch(presented, expectedToken)) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid gateway token.',
      });
    }

    next();
  };
}
