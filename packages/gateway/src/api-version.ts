/**
 * API versioning: the `/v1` path prefix and the `Clerq-Api-Version` header.
 * See docs/API.md for the rules clients rely on.
 *
 * Two small middlewares, both ahead of authentication so a client can learn
 * why it was refused without a token:
 *
 *   stampApiVersion    first of all: every response, whatever happens later
 *                      (a preflight, a 401, a 404, an error), carries the header.
 *   negotiateApiVersion reads the header and the path prefix, refuses a version
 *                      the gateway does not serve, and rewrites `/v1/x` to `/x`.
 *
 * There is one router. `/v1/x` is `/x` with the version recorded, so the bare
 * paths keep working as aliases through 1.x and nothing is registered twice.
 * Everything downstream (auth, scoped tokens, the public-path list) sees the
 * bare path.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  API_VERSION,
  API_VERSION_HEADER,
  SUPPORTED_API_VERSIONS,
  parseApiVersion,
  type ApiVersionMismatch,
  type UnsupportedApiVersion,
  type VersionInfo,
} from '@clerq/gateway-client/protocol';

/** A request that names no version is a version 1 request, now and in every later release. */
export const UNVERSIONED_API_VERSION = 1;

/** `/v<digits>` at the start of the path, followed by `/`, the query or the end. */
const PATH_VERSION = /^\/v(\d+)(?=[/?]|$)/;

/** Longest request text echoed back in an error. */
const ECHO_LIMIT = 40;

const echo = (text: string): string =>
  text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT)}...` : text;

/** The version a request was served as, once `negotiateApiVersion` has run. */
export function apiVersionOf(res: Response): number {
  return typeof res.locals.apiVersion === 'number' ? res.locals.apiVersion : API_VERSION;
}

/** Put `Clerq-Api-Version` on every response, including those that never reach a route. */
export const stampApiVersion: RequestHandler = (_req, res, next) => {
  res.setHeader(API_VERSION_HEADER, String(API_VERSION));
  next();
};

function unsupported(res: Response, text: string, supported: readonly number[]): void {
  const body: UnsupportedApiVersion = {
    error: 'unsupported_api_version',
    requested: echo(text),
    supported: [...supported],
    message: `This gateway does not serve API version "${echo(text)}". It serves: ${supported.join(', ')}.`,
  };
  res.status(400).json(body);
}

function mismatch(res: Response, header: string, path: string, supported: readonly number[]): void {
  const body: ApiVersionMismatch = {
    error: 'api_version_mismatch',
    header: echo(header),
    path: echo(path),
    supported: [...supported],
    message: `The path asks for API version ${echo(path)} but the ${API_VERSION_HEADER} header asks for ${echo(header)}. Send one, or make them agree.`,
  };
  res.status(400).json(body);
}

/**
 * @param supported the versions this gateway serves (a parameter so a test can
 *   stand in a gateway that serves more than one; the default is the real list)
 */
export function negotiateApiVersion(
  supported: readonly number[] = SUPPORTED_API_VERSIONS
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers[API_VERSION_HEADER.toLowerCase()];
    const headerText = typeof raw === 'string' ? raw : undefined;
    const pathMatch = PATH_VERSION.exec(req.url);
    const pathText = pathMatch?.[1];

    const named: Array<{ text: string; version: number | null }> = [];
    if (headerText !== undefined)
      named.push({ text: headerText, version: parseApiVersion(headerText) });
    if (pathText !== undefined) named.push({ text: pathText, version: parseApiVersion(pathText) });
    for (const n of named) {
      if (n.version === null || !supported.includes(n.version)) {
        return unsupported(res, n.text, supported);
      }
    }
    if (named.length === 2 && named[0].version !== named[1].version) {
      return mismatch(res, named[0].text, named[1].text, supported);
    }

    const version = named[0]?.version ?? UNVERSIONED_API_VERSION;
    res.locals.apiVersion = version;
    res.setHeader(API_VERSION_HEADER, String(version));

    if (pathMatch) {
      // `/v1` is `/`; `/v1?x=1` is `/?x=1`. req.originalUrl keeps what was sent.
      const rest = req.url.slice(pathMatch[0].length);
      req.url = rest.startsWith('/') ? rest : `/${rest}`;
    }
    next();
  };
}

/** The body of GET /version. */
export function versionInfo(gateway: string, schema: number | null): VersionInfo {
  return {
    gateway,
    api: { version: API_VERSION, supported: [...SUPPORTED_API_VERSIONS] },
    store: { schema },
  };
}
