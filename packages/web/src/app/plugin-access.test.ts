import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInfo } from '@clerq/gateway-client';
import { createFixtureClient } from '../fixtures';
import { decideAccess, ScopedToken, whyNotRunning, type MintedToken } from './plugin-access';

const T0 = Date.parse('2026-11-14T10:00:00Z');

/** A mint that hands out `tok-1`, `tok-2`… each good for `lifeMs` from when it is asked for. */
function minter(lifeMs: number) {
  let n = 0;
  const calls: number[] = [];
  const mint = vi.fn(async (): Promise<MintedToken> => {
    calls.push(Date.now());
    return { token: `tok-${++n}`, expiresAt: new Date(Date.now() + lifeMs).toISOString() };
  });
  return { mint, calls };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a plugin’s UI token', () => {
  it('is asked for at once, and has none to send until it arrives', async () => {
    const { mint } = minter(15 * 60_000);
    const changed = vi.fn();
    const t = new ScopedToken(mint, changed);
    expect(t.token).toBeNull();
    expect(t.ready).toBe(false);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.token).toBe('tok-1');
    expect(t.ready).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it('is renewed before it expires, again and again, for a session that outlasts many', async () => {
    const life = 15 * 60_000;
    const { mint, calls } = minter(life);
    const t = new ScopedToken(mint);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    // Two hours: the token in hand is never one that has already ended.
    const seen = new Set<string>();
    for (let minute = 0; minute < 120; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.token).not.toBeNull();
      seen.add(t.token as string);
      // The token it would send is always still good.
      const issued = calls.length;
      expect(issued).toBeGreaterThan(0);
    }
    expect(calls.length).toBeGreaterThanOrEqual(10);
    // Every renewal came before the end of the token it replaced: the gaps are under its life.
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBeLessThan(life);
    // And not so early that it asks every minute: about 70% of the life.
    expect(calls[1] - calls[0]).toBeGreaterThan(life * 0.6);
    expect(seen.size).toBe(calls.length);
    t.stop();
  });

  it('keeps the token it has when a renewal fails, tries again, and says nothing is wrong while one is held', async () => {
    let fail = false;
    let n = 0;
    const mint = vi.fn(async (): Promise<MintedToken> => {
      if (fail) throw new Error('gateway busy');
      return { token: `tok-${++n}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    const t = new ScopedToken(mint, () => undefined, 60_000);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    // 70% of 60 s: the renewal runs, fails, and the old token is still the one to send.
    await vi.advanceTimersByTimeAsync(43_000);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(t.token).toBe('tok-1');
    expect(t.error).toBeNull();
    fail = false;
    // Retried after ten seconds.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.token).toBe('tok-2');
    t.stop();
  });

  it('reports why there is no token when the first one cannot be had, and keeps trying', async () => {
    let fail = true;
    const mint = vi.fn(async (): Promise<MintedToken> => {
      if (fail) throw new Error('No such loaded module.');
      return { token: 'tok-1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    const t = new ScopedToken(mint);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ready).toBe(false);
    expect(String(t.error)).toContain('No such loaded module.');
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.token).toBe('tok-1');
    expect(t.error).toBeNull();
    t.stop();
  });

  it('asks for no more once it is stopped, and a token that arrives after is dropped', async () => {
    let release: (m: MintedToken) => void = () => undefined;
    const mint = vi.fn(() => new Promise<MintedToken>((resolve) => (release = resolve)));
    const t = new ScopedToken(mint);
    t.start();
    t.stop();
    release({ token: 'late', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.token).toBeNull();
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('can be told to get a new one now, as when the gateway refused the one in hand', async () => {
    const { mint } = minter(15 * 60_000);
    const t = new ScopedToken(mint);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    await t.refresh();
    expect(t.token).toBe('tok-2');
    // One timer, not two: the next renewal is a single one.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(mint).toHaveBeenCalledTimes(3);
    t.stop();
  });

  it('renews at 70% of the life the gateway gave, even when it gave less than was asked', async () => {
    const { mint, calls } = minter(10_000);
    const t = new ScopedToken(mint, () => undefined, 15 * 60_000);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7_100);
    expect(calls).toHaveLength(2);
    t.stop();
  });
});

describe('a token the gateway refuses', () => {
  it('is replaced at once, and the page is told while there is none that works', async () => {
    const { mint } = minter(15 * 60_000);
    const changed = vi.fn();
    const t = new ScopedToken(mint, changed);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.token).toBe('tok-1');
    await t.refresh('tok-1');
    expect(t.token).toBe('tok-2');
    expect(t.ready).toBe(true);
    expect(t.error).toBeNull();
    expect(mint).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it('is not asked for again when it was already replaced, and one renewal serves every request that was refused', async () => {
    const { mint } = minter(15 * 60_000);
    const t = new ScopedToken(mint);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    // Five requests carrying tok-1 are refused at about the same time.
    await Promise.all([1, 2, 3, 4, 5].map(() => t.refresh('tok-1')));
    expect(mint).toHaveBeenCalledTimes(2);
    // A request that had started with the old token and is refused later finds a new one in hand.
    await t.refresh('tok-1');
    expect(mint).toHaveBeenCalledTimes(2);
    expect(t.token).toBe('tok-2');
    t.stop();
  });

  it('is not sent again when there is no new one to be had, and says why, until there is', async () => {
    let fail = false;
    let n = 0;
    const mint = vi.fn(async (): Promise<MintedToken> => {
      if (fail) throw new Error('No such loaded module.');
      return { token: `tok-${++n}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    });
    const t = new ScopedToken(mint);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await t.refresh('tok-1');
    // The token it holds has not ended, but the gateway said no to it.
    expect(t.token).toBe('tok-1');
    expect(t.ready).toBe(false);
    expect(String(t.error)).toContain('No such loaded module.');
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.token).toBe('tok-2');
    expect(t.ready).toBe(true);
    expect(t.error).toBeNull();
    t.stop();
  });
});

describe('a token that ended while every renewal failed', () => {
  it('is no longer one to send: not ready, with the reason, and the page is told when it ended', async () => {
    let first = true;
    const mint = vi.fn(async (): Promise<MintedToken> => {
      if (!first) throw new Error('Gateway 502');
      first = false;
      return { token: 'tok-1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    const changed = vi.fn();
    const t = new ScopedToken(mint, changed, 60_000);
    t.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ready).toBe(true);
    const told = changed.mock.calls.length;
    // The renewals (at 70% and then every ten seconds) fail; the token in hand works until it ends.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.ready).toBe(true);
    expect(t.error).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.ready).toBe(false);
    expect(String(t.error)).toContain('Gateway 502');
    // It was told, so the page can say so, without waiting for a retry to fail again.
    expect(changed.mock.calls.length).toBeGreaterThan(told);
    t.stop();
  });

  it('is shown as a notice that no token could be had, and as the page again once one arrives', () => {
    const app = createFixtureClient();
    const plugin = { id: 'chat', name: 'Chat', api: ['GET /sessions'] };
    const listing = {
      data: {
        enforce: true,
        plugins: [{ id: 'chat', state: 'enabled', reason: null } as PluginInfo],
      },
    };
    const gone = decideAccess({
      plugin,
      app,
      listing,
      source: { client: app, token: { ready: false, error: new Error('Gateway 502') } },
    });
    expect(gone).toMatchObject({ status: 'unavailable' });
    expect((gone as { reason: string }).reason).toContain('a token');
    expect(
      decideAccess({
        plugin,
        app,
        listing,
        source: { client: app, token: { ready: true, error: null } },
      })
    ).toMatchObject({ status: 'ready', scoped: true });
  });
});

describe('why a plugin is not running', () => {
  const info = (over: Partial<PluginInfo>): PluginInfo =>
    ({ state: 'enabled', reason: null, ...over }) as PluginInfo;

  it('says it is off, and where to turn it on', () => {
    expect(whyNotRunning('Chat', info({ state: 'disabled' }))).toBe(
      'Chat is switched off. Turn it on in Settings → Plugins.'
    );
  });

  it('says it is waiting for approval and why', () => {
    const words = whyNotRunning('Chat', info({ state: 'awaiting_approval' }));
    expect(words).toContain('waiting for your approval');
    expect(words).toContain('Settings → Plugins');
  });

  it('gives the gateway’s own reason for anything else', () => {
    expect(whyNotRunning('Chat', info({ state: 'failed', reason: 'start() failed: boom' }))).toBe(
      'Chat is not running. start() failed: boom'
    );
    expect(whyNotRunning('Chat', info({ state: 'refused', reason: null }))).toContain(
      'Settings → Plugins says why'
    );
  });
});

describe('what a plugin’s page is given', () => {
  const app = createFixtureClient();
  const scoped = createFixtureClient();
  const declared = { id: 'chat', name: 'Chat', api: ['GET /sessions'] };
  const listing = (enforce: boolean, ...plugins: Array<Partial<PluginInfo>>) => ({
    data: {
      enforce,
      plugins: plugins.map(
        (p) => ({ id: 'chat', state: 'enabled', reason: null, ...p }) as PluginInfo
      ),
    },
  });
  const token = (over: { ready?: boolean; error?: unknown } = {}) => ({
    client: scoped,
    token: { ready: over.ready ?? true, error: over.error ?? null },
  });

  it('is the app’s own client for a plugin that declares nothing, whatever else is true', () => {
    for (const l of [{}, listing(true), { error: new Error('down') }]) {
      expect(decideAccess({ plugin: { id: 'x', name: 'X' }, app, listing: l })).toEqual({
        status: 'ready',
        client: app,
        scoped: false,
      });
    }
  });

  it('waits for the list, and says so when it cannot be had: a plugin that declares is not given the benefit of the doubt', () => {
    expect(decideAccess({ plugin: declared, app, listing: {} })).toEqual({ status: 'loading' });
    const down = decideAccess({
      plugin: declared,
      app,
      listing: { error: new Error('Gateway 502') },
    });
    expect(down).toMatchObject({ status: 'unavailable' });
    expect((down as { reason: string }).reason).toContain('Gateway 502');
  });

  it('is the app’s own client when checks are off and the plugin runs, or the gateway does not list it', () => {
    const own = { status: 'ready', client: app, scoped: false };
    expect(decideAccess({ plugin: declared, app, listing: listing(false, {}) })).toEqual(own);
    expect(decideAccess({ plugin: declared, app, listing: listing(false) })).toEqual(own);
    // Even with a token at hand: it is not asked for, and not used.
    expect(
      decideAccess({ plugin: declared, app, listing: listing(false, {}), source: token() })
    ).toEqual(own);
  });

  it('is nothing when the person switched it off or it is waiting for approval, with checks on or off', () => {
    for (const enforce of [false, true]) {
      for (const state of ['disabled', 'awaiting_approval', 'failed', 'refused']) {
        const got = decideAccess({
          plugin: declared,
          app,
          listing: listing(enforce, { state } as Partial<PluginInfo>),
        });
        expect(got, `${enforce} ${state}`).toMatchObject({ status: 'unavailable' });
      }
    }
  });

  it('is nothing when checks are on and the gateway does not list it: there is nothing that says what it may call', () => {
    const got = decideAccess({ plugin: declared, app, listing: listing(true) });
    expect(got).toMatchObject({ status: 'unavailable' });
    expect((got as { reason: string }).reason).toContain('not installed');
  });

  it('is a client of its own, not the app’s, once checks are on and its token has arrived', () => {
    const got = decideAccess({
      plugin: declared,
      app,
      listing: listing(true, {}),
      source: token(),
    });
    expect(got).toEqual({ status: 'ready', client: scoped, scoped: true });
    expect((got as { client: unknown }).client).not.toBe(app);
  });

  it('waits for the token, and never falls back to the app’s client while it does', () => {
    expect(decideAccess({ plugin: declared, app, listing: listing(true, {}) })).toEqual({
      status: 'loading',
    });
    expect(
      decideAccess({
        plugin: declared,
        app,
        listing: listing(true, {}),
        source: token({ ready: false }),
      })
    ).toEqual({
      status: 'loading',
    });
  });

  it('says why when a token cannot be had, and draws nothing', () => {
    const got = decideAccess({
      plugin: declared,
      app,
      listing: listing(true, {}),
      source: token({ ready: false, error: new Error('No such loaded module.') }),
    });
    expect(got).toMatchObject({ status: 'unavailable' });
    expect((got as { reason: string }).reason).toContain('No such loaded module.');
  });
});
