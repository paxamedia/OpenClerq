import { describe, it, expect } from 'vitest';
import type { DriverResult } from '@clerq/drivers';
import { MAX_BACKOFF_MS, retryPlan, transientCause } from './retry.js';
import { parseSpec } from './spec.js';
import { pickFair, type Candidate } from './queue.js';

const failed = (over: Partial<DriverResult> = {}): DriverResult => ({
  ok: false,
  summary: 'The agent reported an error.',
  costUsd: null,
  tokensIn: 0,
  tokensOut: 0,
  durationMs: 1,
  exitCode: 1,
  timedOut: false,
  cancelled: false,
  permissionDenials: [],
  warnings: [],
  ...over,
});

describe('transientCause', () => {
  it('retries a crashed agent and a provider that was down', () => {
    expect(transientCause(failed({ crashed: true }))).toBe('driver_crash');
    expect(transientCause(failed(), 'Anthropic returned 529: {"type":"overloaded_error"}')).toBe(
      'provider_unavailable'
    );
    expect(transientCause(failed(), 'OpenAI returned 503: upstream')).toBe('provider_unavailable');
    expect(transientCause(failed(), 'DeepSeek returned 429: slow down')).toBe(
      'provider_unavailable'
    );
    expect(transientCause(failed(), 'fetch failed')).toBe('provider_unavailable');
    expect(transientCause(failed({ apiError: 'API Error: 500 Internal server error' }))).toBe(
      'provider_unavailable'
    );
    expect(transientCause(failed({ apiError: 'stream error: overloaded_error' }))).toBe(
      'provider_unavailable'
    );
  });

  it('never retries a decision, a limit, a cancel or an ordinary failure', () => {
    expect(transientCause(failed({ ok: true }))).toBeNull();
    expect(transientCause(failed({ cancelled: true, crashed: true }))).toBeNull();
    expect(transientCause(failed({ timedOut: true, crashed: true }))).toBeNull();
    // Refused a tool: a policy decision or a person's denial.
    expect(
      transientCause(failed({ crashed: true, permissionDenials: [{ tool: 'Bash' }] }))
    ).toBeNull();
    expect(
      transientCause(failed({ summary: "Stopped: the run's budget of $1.00 is spent ($1.0100)." }))
    ).toBeNull();
    expect(transientCause(failed({ summary: 'The model declined to continue.' }))).toBeNull();
    expect(transientCause(failed(), 'Anthropic returned 400: bad request')).toBeNull();
    expect(transientCause(failed(), 'Anthropic returned 401: invalid x-api-key')).toBeNull();
    expect(transientCause(failed({ summary: 'Fixed the 500 error page.' }))).toBeNull();
  });

  it("never reads the agent's own final message as a provider error", () => {
    // What claude-code puts in the summary: its reason, then the agent's text.
    for (const summary of [
      'Stopped: max turns. I added a rate limit to /login and checked it.',
      'The agent reported an error. The test fails with ECONNREFUSED on port 5432.',
      'Stopped: max budget usd. The endpoint returned 500 when called with an empty body.',
      'The agent reported an error. API Error: 529 overloaded',
    ]) {
      expect(transientCause(failed({ summary })), summary).toBeNull();
    }
    // A driver error that is not a provider outage.
    expect(transientCause(failed({ apiError: 'API Error: 400 invalid request' }))).toBeNull();
  });
});

describe('retryPlan', () => {
  const spec = (retry: string) =>
    parseSpec(`
name: x
targets:
  repos: [local:/tmp/x]
agent:
  driver: claude-code
prompt: p
sandbox:
  profile: native
${retry}`);

  it('doubles the backoff with each retry, up to an hour, and stops when they are used up', () => {
    const s = spec('retry:\n  max_retries: 3\n  backoff: 30s\n');
    const now = 1_000_000;
    expect(retryPlan(s, 1, now)).toEqual({ notBefore: new Date(now + 30_000), retry: 1, of: 3 });
    expect(retryPlan(s, 2, now)?.notBefore).toEqual(new Date(now + 60_000));
    expect(retryPlan(s, 3, now)?.notBefore).toEqual(new Date(now + 120_000));
    expect(retryPlan(s, 4, now)).toBeNull();

    const long = spec('retry:\n  max_retries: 10\n  backoff: 1h\n');
    expect(retryPlan(long, 5, now)?.notBefore).toEqual(new Date(now + MAX_BACKOFF_MS));
  });

  it('never retries without retry.max_retries', () => {
    expect(retryPlan(spec(''), 1)).toBeNull();
  });
});

describe('pickFair', () => {
  const c = (id: string, repoId: string, createdAt: string): Candidate => ({
    id,
    automationId: `aut_${id}`,
    repoId,
    createdAt,
  });

  it('takes the oldest run when nothing is going', () => {
    const picked = pickFair(
      [
        c('a2', 'A', '2026-01-01T00:02'),
        c('a1', 'A', '2026-01-01T00:01'),
        c('b1', 'B', '2026-01-01T00:03'),
      ],
      new Map(),
      new Map()
    );
    expect(picked?.id).toBe('a1');
  });

  it('prefers the repository with fewer runs going, then the one served longest ago', () => {
    const queue = [
      c('a2', 'A', '2026-01-01T00:02'),
      c('a3', 'A', '2026-01-01T00:03'),
      c('b1', 'B', '2026-01-01T00:09'),
      c('c1', 'C', '2026-01-01T00:08'),
    ];
    // A has a run going: B and C go first, the older of the never-served ones first.
    expect(pickFair(queue, new Map([['A', 1]]), new Map([['A', 1]]))?.id).toBe('c1');
    // Nothing going, A served most recently, B and C never: B or C, oldest first.
    expect(pickFair(queue, new Map(), new Map([['A', 5]]))?.id).toBe('c1');
    // All served: the one served longest ago.
    expect(
      pickFair(
        queue,
        new Map(),
        new Map([
          ['A', 5],
          ['B', 3],
          ['C', 4],
        ])
      )?.id
    ).toBe('b1');
  });

  it('round-robins a busy repository with a quiet one', () => {
    // Repository A has four automations queued, B one, queued last.
    let queue = [
      c('a1', 'A', '1'),
      c('a2', 'A', '2'),
      c('a3', 'A', '3'),
      c('a4', 'A', '4'),
      c('b1', 'B', '5'),
    ];
    const served = new Map<string, number>();
    const order: string[] = [];
    for (let seq = 1; queue.length > 0; seq++) {
      const next = pickFair(queue, new Map(), served) as Candidate;
      order.push(next.id);
      served.set(next.repoId as string, seq);
      queue = queue.filter((q) => q !== next);
    }
    expect(order).toEqual(['a1', 'b1', 'a2', 'a3', 'a4']);
  });

  it('returns nothing for an empty queue', () => {
    expect(pickFair([], new Map(), new Map())).toBeUndefined();
  });
});
