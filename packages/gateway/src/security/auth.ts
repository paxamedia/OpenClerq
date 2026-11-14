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
import { writePrivateFile } from '@clerq/store';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { normalisePath, principalAllows, resolveToken, type Principal } from './scoped-tokens.js';
import { DEFAULT_TENANT, TENANT_ID, runInTenant } from '../tenant.js';

/** Endpoints reachable without a token. These must reveal no configuration. */
export const PUBLIC_PATHS = new Set(['/health', '/version']);

/**
 * Endpoints that may carry the token as a `token` query parameter instead of a
 * header. This exists solely for Server-Sent Events: the browser EventSource API
 * cannot set request headers. Restricted to loopback-facing read-only streams.
 */
export const QUERY_TOKEN_PATHS = new Set(['/logs/stream', '/events', '/events/stream']);

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
  // Readable only by the owning user, in a directory only they can enter.
  writePrivateFile(getTokenPath(), `${token}\n`);
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
 * A module's UI files. They are static code with no data in them, and an
 * iframe cannot send a header with them; the UI gets its token over the
 * desktop's postMessage bridge and sends it on its API calls. The gateway
 * answers every path under `/ui` from the files, so no module route there
 * can be reached without a token.
 */
const MODULE_UI = /^\/api\/modules\/[a-z][a-z0-9-]*\/ui(\/|$)/;

/**
 * Where GitHub sends the browser back after the app manifest is accepted. A
 * browser lands on it, so it cannot send a header; it proves itself with the
 * single-use `state` that `POST /github/app/manifest` made, checked in the
 * handler. This is the only `/github` route without a token. `/v1` is taken
 * off before auth, so `/v1/github/app/callback` arrives as this path.
 */
const GITHUB_CALLBACK = '/github/app/callback';

/** Whether a request needs no token at all. */
function isPublic(req: Request): boolean {
  if (PUBLIC_PATHS.has(req.path)) return true;
  // A phone pairing has no token yet; it proves itself with a single-use code.
  if (req.method === 'POST' && req.path === '/devices/pair') return true;
  if (req.method === 'GET' && req.path === GITHUB_CALLBACK) return true;
  return (req.method === 'GET' || req.method === 'HEAD') && MODULE_UI.test(req.path);
}

/** Who made the request, once requireAuth has let it through. */
export function principalOf(res: Response): Principal | undefined {
  return res.locals.principal as Principal | undefined;
}

/**
 * Require a valid token on every request except public ones: the gateway
 * token, which reaches everything, or a scoped token (a module UI's or a
 * device's), which reaches only what its scopes name. A valid scoped token
 * outside its scopes gets 403.
 * CORS preflight is allowed through so the browser can read the real response.
 */
export function requireAuth(
  expectedToken: string,
  resolveScoped: (token: string) => Principal | null = resolveToken
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();
    if (normalisePath(req.path) === null) {
      return res.status(400).json({ error: 'invalid_path', message: 'The path is not valid.' });
    }
    if (isPublic(req)) return next();

    const presented = extractToken(req);
    if (!presented) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="clerq-gateway"');
      return res.status(401).json({
        error: 'unauthorized',
        message:
          'Missing bearer token. Send "Authorization: Bearer <token>" from ~/.clerq/gateway-token.',
      });
    }

    // The gateway token reaches every tenant and picks one with X-Clerq-Tenant;
    // a scoped token is bound to one and may only name that one.
    const header = req.headers['x-clerq-tenant'];
    const named = typeof header === 'string' && header.trim() ? header.trim() : undefined;
    if (named !== undefined && !TENANT_ID.test(named)) {
      return res
        .status(400)
        .json({ error: 'invalid_tenant', message: `Invalid tenant "${named}".` });
    }

    if (tokensMatch(presented, expectedToken)) {
      res.locals.principal = { kind: 'operator' } satisfies Principal;
      res.locals.tenantNamed = named !== undefined;
      return runInTenant(named ?? DEFAULT_TENANT, next);
    }

    const scoped = resolveScoped(presented);
    if (!scoped) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid gateway token.',
      });
    }
    if (!principalAllows(scoped, req.method, req.path)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `This token is not valid for ${req.method} ${req.path}.`,
      });
    }
    const tenant = scoped.tenantId ?? DEFAULT_TENANT;
    if (named !== undefined && named !== tenant) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'This token is bound to another tenant.',
      });
    }
    res.locals.principal = scoped;
    runInTenant(tenant, next);
  };
}
