/**
 * A request that gets no answer from the gateway should end, not hang for as
 * long as the operating system waits. The limit covers the time until the
 * response starts; a stream (a followed run) is not cut off once it has begun,
 * and the caller's own `signal` still ends it.
 */

export function limitWaitForAnswer(ms: number, target: { fetch: typeof fetch } = globalThis): void {
  const original = target.fetch;
  target.fetch = (input, init) => {
    const request = new AbortController();
    const caller = init?.signal;
    if (caller?.aborted) request.abort(caller.reason);
    // Kept for the life of the request: a stream is ended by the caller long after it began.
    else caller?.addEventListener('abort', () => request.abort(caller.reason), { once: true });
    const timeout = setTimeout(
      () => request.abort(new DOMException('The gateway did not answer in time.', 'TimeoutError')),
      ms
    );
    // `redirect: 'error'` unless a caller says otherwise: the client already asks for it, and
    // this keeps a request added later from following a redirect with the token's request.
    return original(input, { redirect: 'error', ...init, signal: request.signal }).finally(() =>
      clearTimeout(timeout)
    );
  };
}
