import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CompatibilityResult } from '@clerq/gateway-client';
import type { GatewayClient } from '../app/client';
import { CompatibilityNotice, watchCompatibility } from './Compatibility';

const result = (over: Partial<CompatibilityResult>): CompatibilityResult => ({
  ok: false,
  kind: 'gateway_newer',
  gateway: '2.0.0',
  api: { version: 2, supported: [2] },
  reason: 'This gateway speaks API 2; this app needs API 1. Update the app or the gateway.',
  ...over,
});

const OK = result({ ok: true, kind: 'compatible', reason: null });
const NOTHING = result({
  kind: 'unreachable',
  gateway: null,
  api: null,
  reason: 'Nothing answered at http://127.0.0.1:18790. Is OpenClerq running?',
});

/** A client that answers the check with each of `answers` in turn, the last one for ever after. */
function clientAnswering(...answers: Array<CompatibilityResult | Error>) {
  const calls = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next as CompatibilityResult;
  });
  return { client: { checkCompatibility: calls } as unknown as GatewayClient, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('watchCompatibility', () => {
  it('asks once at the start, and reports nothing wrong when the gateway is fine', async () => {
    const { client, calls } = clientAnswering(OK);
    const seen: Array<string | null> = [];
    watchCompatibility(client, (r) => seen.push(r));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([null]);
  });

  it.each([
    ['a gateway that speaks a newer API', result({})],
    [
      'a gateway older than 1.0',
      result({
        kind: 'gateway_older',
        gateway: '0.5.1',
        api: null,
        reason:
          'This gateway (version 0.5.1) is older than 1.0 and does not report an API version.',
      }),
    ],
    [
      'something that is not a gateway',
      result({
        kind: 'unexpected',
        gateway: null,
        api: null,
        reason: 'Something answered, but not like an OpenClerq gateway.',
      }),
    ],
  ])('reports the reason for %s, once, and does not ask again', async (_name, answer) => {
    const { client, calls } = clientAnswering(answer);
    const seen: Array<string | null> = [];
    watchCompatibility(client, (r) => seen.push(r));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen).toEqual([answer.reason]);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('says nothing while nothing answers, asks again after a wait, and reports once it does', async () => {
    const { client, calls } = clientAnswering(NOTHING, NOTHING, result({}));
    const seen: Array<string | null> = [];
    watchCompatibility(client, (r) => seen.push(r), [1000, 2000, 4000]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([result({}).reason]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it('gives up quietly when nothing ever answers', async () => {
    const { client, calls } = clientAnswering(NOTHING);
    const seen: Array<string | null> = [];
    watchCompatibility(client, (r) => seen.push(r), [1000, 2000]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([]);
  });

  it('stops when told to, even with a retry waiting', async () => {
    const { client, calls } = clientAnswering(NOTHING, result({}));
    const seen: Array<string | null> = [];
    const stop = watchCompatibility(client, (r) => seen.push(r), [1000]);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it('does not report an answer that comes after it was stopped', async () => {
    let finish: (r: CompatibilityResult) => void = () => undefined;
    const client = {
      checkCompatibility: () => new Promise<CompatibilityResult>((r) => (finish = r)),
    } as unknown as GatewayClient;
    const seen: Array<string | null> = [];
    const stop = watchCompatibility(client, (r) => seen.push(r));
    stop();
    finish(result({}));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });

  it('copes with a client that has no check, or one that throws', async () => {
    const seen: Array<string | null> = [];
    watchCompatibility({} as unknown as GatewayClient, (r) => seen.push(r));
    const { client } = clientAnswering(new Error('boom'));
    watchCompatibility(client, (r) => seen.push(r));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen).toEqual([]);
  });
});

describe('CompatibilityNotice', () => {
  it('shows the reason in plain words as an alert', () => {
    const html = renderToStaticMarkup(<CompatibilityNotice reason={result({}).reason} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      'This gateway speaks API 2; this app needs API 1. Update the app or the gateway.'
    );
  });

  it('is nothing at all when there is no reason', () => {
    expect(renderToStaticMarkup(<CompatibilityNotice reason={null} />)).toBe('');
  });
});
