/**
 * The last word on a request that failed: a JSON answer that says what kind
 * of failure it was and nothing taken from the request.
 *
 * Without it Express answers with its own page, which for a body that is not
 * valid JSON holds a stack trace and a piece of the body (`Unexpected token
 * 'M', "MIIEowIBAA"... is not valid JSON`: the start of a private key posted
 * to `/github/app/import`), and, outside tests, writes that stack to stderr.
 *
 * - a body that is not JSON: 400 `invalid_json`
 * - a body over the limit (`CLERQ_MAX_BODY`): 413 `payload_too_large`
 * - another failure of the request itself (status 4xx that is safe to say,
 *   such as a file that is not there): 4xx with a generic code
 * - anything else: 500 `internal`
 *
 * The log line has the method, the path (never the query, which can carry a
 * token), the status, the kind of error and, for a 500, where it was thrown
 * (the stack's frames, not its first line): never the body or the headers,
 * and never an error's own text, which can hold a piece of the request.
 */

import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger.js';

interface Failure {
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
  stack?: unknown;
}

function statusOf(e: Failure): number | undefined {
  const s = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof s === 'number' && Number.isInteger(s) ? s : undefined;
}

export function apiErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // Part of an answer is out already: the connection is all that is left to end.
  if (res.headersSent) return next(err);

  const e: Failure = err && typeof err === 'object' ? (err as Failure) : {};
  const type = typeof e.type === 'string' ? e.type : undefined;
  const status = statusOf(e);
  const parse = type === 'entity.parse.failed';
  let code: number;
  let body: { error: string; message?: string };
  if (parse) {
    code = 400;
    body = { error: 'invalid_json', message: 'The request body is not valid JSON.' };
  } else if (type === 'entity.too.large' || status === 413) {
    code = 413;
    body = { error: 'payload_too_large', message: 'The request body is too large.' };
  } else if (status !== undefined && status >= 400 && status < 500) {
    // The request itself could not be served (a file that is not there, a body that
    // could not be read): said by its kind, never by the error's own text.
    code = status;
    body =
      status === 404
        ? { error: 'not_found' }
        : status === 403
          ? { error: 'forbidden' }
          : { error: 'invalid_request', message: 'The request could not be read.' };
  } else {
    code = 500;
    body = { error: 'internal' };
  }

  const name = typeof e.name === 'string' ? e.name : 'Error';
  const detail: Record<string, unknown> = {
    method: req.method,
    path: req.path,
    status: code,
    kind: type ?? name,
  };
  // Where it happened, not what it said: an error's text can hold a piece of the request.
  if (code === 500) {
    if (typeof e.code === 'string') detail.code = e.code;
    if (typeof e.stack === 'string') {
      detail.at = e.stack
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 4)
        .map((line) => line.trim())
        .join(' | ');
    }
  }
  if (code >= 500) logger.error('Request failed', detail);
  else logger.warn('Request refused', detail);

  res.status(code).json(body);
}
