import { describe, expect, it, vi } from 'vitest';
import type { RunDetail, RunStep } from '@clerq/gateway-client';
import { cronFromSimple, describeCron, nextFirings, parseCron, simpleSchedule } from './cron';
import { fillRef, forRecord, hitRoute, moduleRoute, refId } from './extensions';
import { duration, money, relativeTime } from './format';
import { areaOf, nameCurrent, resetHistory, visit, backTargetOf, type Nav } from './history';
import { connectStream, familiesOf, LiveStore, streamUrls } from './live';
import type { GatewayClient } from './client';
import { href, isUnder, parseHash, withQuery } from './router';
import { daily, monthSpend, pipeline, successRate } from './stats';

describe('cron', () => {
  it('reads five- and six-field lines, names and steps', () => {
    expect(parseCron('0 8 * * 1')?.weekdays).toEqual([1]);
    expect(parseCron('*/15 * * * *')?.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 0 9 * * mon-fri')?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 9 * * 7')?.weekdays).toEqual([0]);
    expect(parseCron('nonsense')).toBeNull();
    expect(parseCron('61 * * * *')).toBeNull();
  });

  it('says a schedule in words', () => {
    expect(describeCron('0 8 * * 1')).toBe('Mondays at 08:00');
    expect(describeCron('30 6 * * 1-5')).toBe('Weekdays at 06:30');
    expect(describeCron('0 9,17 * * *')).toBe('Every day at 09:00 and 17:00');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 9 1 * *')).toBe('On the 1st at 09:00');
  });

  it('finds the next firings in local time', () => {
    const from = new Date(2026, 10, 9, 10, 0); // a Monday, 10:00
    const next = nextFirings('0 8 * * 1', 3, from);
    expect(next.map((d) => [d.getDate(), d.getHours(), d.getDay()])).toEqual([
      [16, 8, 1],
      [23, 8, 1],
      [30, 8, 1],
    ]);
    expect(nextFirings('0 * * * *', 2, from).map((d) => d.getHours())).toEqual([11, 12]);
  });

  it('round-trips the picker’s days and time', () => {
    const line = cronFromSimple({ weekdays: [5, 1], hour: 7, minute: 5 });
    expect(line).toBe('5 7 * * 1,5');
    expect(simpleSchedule(line)).toEqual({ weekdays: [1, 5], hour: 7, minute: 5 });
    expect(simpleSchedule('*/5 * * * *')).toBeNull();
  });
});

describe('router', () => {
  it('splits the hash into path, segments and query', () => {
    const r = parseHash('#/m/crm/deals/42?tab=notes');
    expect(r.path).toBe('/m/crm/deals/42');
    expect(r.segments).toEqual(['m', 'crm', 'deals', '42']);
    expect(r.query.get('tab')).toBe('notes');
    expect(parseHash('').path).toBe('/');
  });

  it('builds paths and knows what is under what', () => {
    expect(href('runs', 'a b')).toBe('/runs/a%20b');
    expect(withQuery('/runs', { status: 'failed', date: null })).toBe('/runs?status=failed');
    expect(isUnder('/m/automations/x', '/m/automations')).toBe(true);
    expect(isUnder('/m/automationsx', '/m/automations')).toBe(false);
    expect(isUnder('/runs', '/')).toBe(false);
  });

  it('groups paths into areas for the back stack', () => {
    expect(areaOf('/m/crm/deals/1')).toBe('m/crm');
    expect(areaOf('/runs/abc?x=1')).toBe('runs');
    expect(areaOf('/')).toBe('home');
  });
});

describe('extensions', () => {
  it('opens module paths under #/m/<module>/ with the ref filled in', () => {
    expect(moduleRoute('notes', '/')).toBe('/m/notes');
    expect(moduleRoute('notes', '/?ref={ref}', 'core:person:per_1')).toBe(
      '/m/notes/?ref=core%3Aperson%3Aper_1'
    );
    expect(fillRef('/a/{ref}/b/{ref}', 'x')).toBe('/a/x/b/x');
    expect(refId('core:person:per_1')).toBe('per_1');
  });

  it('sends search hits to their module page or the record view', () => {
    expect(hitRoute({ ref: 'crm:deal:d1', moduleId: 'crm', path: '/deals/d1' })).toBe(
      '/m/crm/deals/d1'
    );
    expect(hitRoute({ ref: 'core:organisation:org_1', moduleId: 'core' })).toBe('/records/org_1');
    expect(hitRoute({ ref: 'crm:deal:d1', moduleId: 'crm' })).toBe('/m/crm');
  });

  it('picks the panels for a record type, in order', () => {
    const items = [
      { moduleId: 'a', id: 'x', order: 20, types: ['core:person'] },
      { moduleId: 'b', id: 'y', order: 10 },
      { moduleId: 'c', id: 'z', types: ['core:organisation'] },
    ];
    expect(forRecord(items, 'person').map((i) => i.id)).toEqual(['y', 'x']);
  });
});

describe('live events', () => {
  it('maps event names to the data they change', () => {
    expect(familiesOf('run.completed')).toContain('runs');
    expect(familiesOf('approval.requested')).toContain('inbox');
    expect(familiesOf('record.merged')).toEqual(['records']);
    expect(familiesOf('notify.badge')).toEqual(['modules']);
    expect(familiesOf('notify.posted')).toEqual([]);
    expect(familiesOf('device.paired')).toEqual(['devices']);
    expect(familiesOf('something.else')).toEqual([]);
  });
});

describe('figures', () => {
  const run = (status: string, createdAt: string, costUsd = 1, costKnown = true) =>
    ({
      id: createdAt,
      status,
      trigger: 'schedule',
      createdAt,
      costUsd,
      costKnown,
      tokensIn: 0,
      tokensOut: 0,
    }) as RunDetail;

  it('counts success over done and failed only', () => {
    expect(successRate([run('done', ''), run('failed', ''), run('cancelled', '')])).toBe(0.5);
    expect(successRate([run('cancelled', '')])).toBeNull();
  });

  it('buckets runs by local day, today last', () => {
    const now = new Date(2026, 10, 9, 12);
    const days = daily(
      [
        run('done', new Date(2026, 10, 9, 8).toISOString()),
        run('done', new Date(2026, 10, 8, 8).toISOString()),
      ],
      3,
      (b) => b.length,
      now
    );
    expect(days.map((d) => d.value)).toEqual([0, 1, 1]);
  });

  it('marks month spend as a lower bound when a run had no price', () => {
    const now = new Date(2026, 10, 9);
    expect(monthSpend([run('done', new Date(2026, 10, 2).toISOString(), 2, false)], now)).toEqual({
      spent: 2,
      atLeast: true,
    });
  });

  it('reads the pipeline from a run’s steps', () => {
    const git = (action: string): RunStep => ({
      seq: 0,
      kind: 'git',
      input: { action },
      status: 'ok',
      createdAt: '',
    });
    const waiting = {
      ...run('awaiting_approval', ''),
      steps: [
        git('worktree'),
        { seq: 1, kind: 'llm', createdAt: '' },
        git('commit'),
        { seq: 2, kind: 'gate', status: 'passed', createdAt: '' },
      ],
      artifacts: [],
    } as RunDetail;
    const p = pipeline(waiting);
    expect([p.worktree, p.agent, p.commit, p.gates, p.approval, p.push]).toEqual([
      'done',
      'done',
      'done',
      'done',
      'waiting',
      'pending',
    ]);

    const gateFailed = {
      ...waiting,
      status: 'failed',
      steps: [
        ...waiting.steps.slice(0, 3),
        { seq: 2, kind: 'gate', status: 'failed', createdAt: '' },
      ],
    } as RunDetail;
    expect(pipeline(gateFailed).gates).toBe('failed');

    // A gate that failed before the agent escalated to another model does not
    // mark a run that went on to pass.
    const escalated = {
      ...waiting,
      steps: [
        ...waiting.steps.slice(0, 3),
        { seq: 3, kind: 'gate', status: 'failed', createdAt: '' },
        {
          seq: 4,
          kind: 'tool',
          input: { name: 'agent.escalate' },
          status: 'warning',
          createdAt: '',
        },
        { seq: 5, kind: 'llm', createdAt: '' },
        git('commit'),
        { seq: 6, kind: 'gate', status: 'passed', createdAt: '' },
      ],
    } as RunDetail;
    expect(pipeline(escalated).gates).toBe('done');

    const done = {
      ...waiting,
      status: 'done',
      steps: [git('worktree'), { seq: 1, kind: 'llm', createdAt: '' }],
    } as RunDetail;
    expect(pipeline(done).commit).toBe('skipped');
  });
});

describe('format', () => {
  it('says times, money and durations with units', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(relativeTime('2026-11-09T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime('2026-11-09T15:00:00Z', now)).toBe('in 3 h');
    expect(money(4.2)).toBe('$4.20');
    expect(money(0.004)).toBe('$0.0040');
    expect(money(3, { atLeast: true })).toBe('≥ $3.00');
    expect(duration(850)).toBe('850 ms');
    expect(duration(250_000)).toBe('4 min 10 s');
  });
});

/** A browser history in miniature: entries with state, and a position. */
function fakeBrowser() {
  const entries: Array<{ path: string; state: unknown }> = [{ path: '/', state: null }];
  let at = 0;
  const nav: Nav = {
    get state() {
      return entries[at].state;
    },
    replaceState(state) {
      entries[at].state = state;
    },
  };
  return {
    nav,
    push(path: string) {
      entries.splice(at + 1);
      entries.push({ path, state: null });
      at += 1;
      visit(path, nav);
    },
    replace(path: string) {
      entries[at].path = path;
      visit(path, nav);
    },
    move(by: number) {
      at += by;
      visit(entries[at].path, nav);
    },
    start() {
      visit(entries[at].path, nav);
    },
    name(title: string) {
      nameCurrent(entries[at].path, title);
    },
    here: () => entries[at].path,
  };
}

describe('back stack', () => {
  it('names the page Back will reach, even when paths repeat', () => {
    resetHistory();
    const b = fakeBrowser();
    b.start();
    b.name('Home');
    b.push('/runs');
    b.name('Runs');
    b.push('/inbox');
    b.name('Inbox');
    b.push('/runs');
    b.name('Runs');
    // Two entries back is Runs; one back is Inbox, not the older Runs.
    expect(backTargetOf('/runs')?.title).toBe('Inbox');
    b.move(-1);
    expect(backTargetOf('/inbox')?.title).toBe('Runs');
    b.move(-1);
    expect(backTargetOf('/runs')?.title).toBe('Home');
    b.move(1);
    expect(backTargetOf('/inbox')?.title).toBe('Runs');
  });

  it('keeps the place through a replace and drops forward entries on a new page', () => {
    resetHistory();
    const b = fakeBrowser();
    b.start();
    b.name('Home');
    b.push('/runs');
    b.name('Runs');
    b.push('/runs/a');
    b.replace('/runs/b');
    b.name('Run b');
    expect(backTargetOf('/runs/b')).toBeNull();
    b.move(-1);
    b.push('/inbox');
    b.name('Inbox');
    expect(backTargetOf('/inbox')?.title).toBe('Runs');
  });
});

describe('event stream', () => {
  const event = (id: string, name = 'notify.posted') => ({
    id,
    name,
    at: new Date().toISOString(),
    context: {},
    payload: null,
  });

  it('delivers an event once, even if a reconnect replays it', () => {
    const store = new LiveStore();
    const seen: string[] = [];
    store.onEvent((e) => seen.push(e.id ?? ''));
    store.dispatch(event('a-1'));
    store.dispatch(event('a-2'));
    store.dispatch(event('a-1'));
    expect(seen).toEqual(['a-1', 'a-2']);
  });

  it('reads /events/stream through the client, with no token in a URL', async () => {
    const store = new LiveStore();
    let opts: Parameters<GatewayClient['streamEvents']>[1];
    let push: (e: unknown) => void = () => {};
    const client = {
      logsStreamUrl: () => 'http://127.0.0.1:1/logs/stream?token=secret',
      streamEvents: vi.fn((on: (e: unknown) => void, o: typeof opts) => {
        push = on;
        opts = o;
        return new Promise<void>(() => {});
      }),
    } as unknown as GatewayClient;
    const seen: string[] = [];
    store.onEvent((e) => seen.push(e.name));
    const close = connectStream(store, client);
    expect(client.streamEvents).toHaveBeenCalledOnce();
    opts?.onOpen?.();
    expect(store.stream).toBe('live');
    // Recent events from before the stream opened are still delivered: only /events is filtered by time.
    push({ ...event('x-1', 'run.started'), at: '2000-01-01T00:00:00Z' });
    expect(seen).toEqual(['run.started']);
    close();
    expect(opts?.signal?.aborted).toBe(true);
  });

  it('keeps the token out of the URL the older stream uses', () => {
    const client = {
      logsStreamUrl: () => 'http://127.0.0.1:1/logs/stream',
    } as unknown as GatewayClient;
    expect(streamUrls(client)).toEqual(['http://127.0.0.1:1/events']);
  });
});
