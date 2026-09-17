import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initStore, closeStore, getStore } from './store.js';
import { recordRun, recordModelCall, getRun, listRuns, currentRunId } from './runs.js';
import { recentEvents, resetEvents } from './events.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => {
  closeStore();
});

beforeEach(() => {
  resetEvents();
});

const tick = () => new Promise((r) => setTimeout(r, 5));

const priced = (tokensIn: number, tokensOut: number, costUsd: number | null) => ({
  provider: 'p',
  model: 'm',
  prompt: 'q',
  status: 'ok' as const,
  text: 'a',
  tokensIn,
  tokensOut,
  costUsd,
  latencyMs: 1,
});

async function runWith(message: string, fn: () => Promise<void>): Promise<string> {
  let id = '';
  await recordRun({ trigger: 'manual', message }, async () => {
    id = currentRunId() as string;
    await fn();
  });
  return id;
}

describe('run accounting', () => {
  it('stores what the run was asked to do', async () => {
    const id = await runWith('summarise the inbox', async () => {});
    expect(getRun(id)?.input).toBe('summarise the inbox');
  });

  it('records each model call as a step and totals them on the run', async () => {
    const id = await runWith('two calls', async () => {
      recordModelCall(priced(1000, 200, 0.004));
      await tick();
      recordModelCall(priced(500, 100, 0.002));
    });

    const run = getRun(id)!;
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0]).toMatchObject({
      kind: 'llm',
      status: 'ok',
      tokensIn: 1000,
      costUsd: 0.004,
    });
    expect(run.tokensIn).toBe(1500);
    expect(run.tokensOut).toBe(300);
    expect(run.costUsd).toBeCloseTo(0.006, 9);
    expect(run.costKnown).toBe(true);
  });

  it('flags the total as incomplete when a call had no price', async () => {
    const id = await runWith('unpriced', async () => {
      recordModelCall(priced(100, 100, 0.001));
      recordModelCall(priced(100, 100, null));
    });

    const run = getRun(id)!;
    expect(run.costKnown).toBe(false);
    expect(run.costUsd).toBeCloseTo(0.001, 9);
    // An unknown cost stays null rather than turning into a misleading 0.
    expect(run.steps[1]).toMatchObject({ costUsd: null });
    expect(listRuns(10).find((r) => r.id === id)?.costKnown).toBe(false);
  });

  it('does not count a failed call against the price check', async () => {
    const id = await runWith('failed call', async () => {
      recordModelCall({
        provider: 'p',
        model: 'm',
        prompt: 'q',
        status: 'error',
        error: 'no key',
        latencyMs: 1,
      });
    });

    const run = getRun(id)!;
    expect(run.steps[0]).toMatchObject({ status: 'error', output: { error: 'no key' } });
    expect(run.costKnown).toBe(true);
  });

  it('keeps concurrent runs apart', async () => {
    // Two runs interleaving across awaits must each see only their own calls —
    // the property that makes AsyncLocalStorage the right tool here.
    const [a, b] = await Promise.all([
      runWith('a', async () => {
        recordModelCall(priced(1, 0, 0));
        await tick();
        recordModelCall(priced(1, 0, 0));
      }),
      runWith('b', async () => {
        await tick();
        recordModelCall(priced(10, 0, 0));
      }),
    ]);

    expect(getRun(a)?.tokensIn).toBe(2);
    expect(getRun(b)?.tokensIn).toBe(10);
  });

  it('records nothing outside a run, but still emits the event', () => {
    const before = Number(getStore().prepare('SELECT COUNT(*) AS n FROM run_steps').get()?.n);
    recordModelCall(priced(5, 5, 0.1));
    const after = Number(getStore().prepare('SELECT COUNT(*) AS n FROM run_steps').get()?.n);

    expect(after).toBe(before);
    const event = recentEvents().find((e) => e.name === 'model.called');
    expect(event?.context.runId).toBeUndefined();
  });

  it('emits lifecycle events carrying the run id', async () => {
    const id = await runWith('events', async () => {
      recordModelCall(priced(1, 1, 0));
    });

    const names = recentEvents()
      .filter((e) => e.context.runId === id)
      .map((e) => e.name);
    expect(names).toEqual(['run.started', 'model.called', 'run.completed']);
  });

  it('records a thrown error as a failed run and rethrows it', async () => {
    let id = '';
    await expect(
      recordRun({ trigger: 'schedule', message: 'boom' }, async () => {
        id = currentRunId() as string;
        throw new Error('exploded');
      })
    ).rejects.toThrow('exploded');

    expect(getRun(id)).toMatchObject({ status: 'failed', exitReason: 'exploded', input: 'boom' });
  });
});
