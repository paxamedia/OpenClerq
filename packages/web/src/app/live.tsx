/**
 * Live data: one cache of gateway reads, kept current by the event stream.
 *
 * A screen asks for a resource with `useResource(key, fetch, { on })`. Events
 * from the gateway refetch the resources whose families they touch, so pages
 * follow what happens without a refresh button. When the stream is down the
 * same resources are polled instead.
 *
 * The stream is tried in order: GET /events/stream through the client (the token
 * and tenant travel as headers, and a drop resumes from the last event id), then
 * the older GET /events, then polling, retried every 30 s.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { GatewayClient } from './client';

/** Groups of data an event can change. */
export type Family =
  | 'runs'
  | 'approvals'
  | 'automations'
  | 'sessions'
  | 'health'
  | 'memory'
  | 'records'
  | 'inbox'
  | 'modules'
  | 'devices';

export interface GatewayEvent {
  /** Set by /events/stream; the older /events has none. */
  id?: string;
  name: string;
  at: string;
  context: { runId?: string; sessionId?: string; [key: string]: unknown };
  payload: unknown;
}

/** The families an event touches. */
export function familiesOf(name: string): Family[] {
  const [group] = name.split('.');
  switch (group) {
    case 'run':
      return ['runs', 'automations', 'approvals', 'sessions'];
    case 'approval':
      return ['approvals', 'runs', 'inbox'];
    case 'record':
    case 'activity':
      return ['records'];
    case 'inbox':
      return ['inbox'];
    case 'notify':
    case 'service':
    case 'plugin':
    case 'module':
      return name === 'notify.posted' ? [] : ['modules'];
    case 'device':
      return ['devices'];
    case 'tool':
      return name === 'tool.approval_required' ? ['approvals', 'runs', 'inbox'] : ['runs'];
    case 'gate':
    case 'agent':
    case 'model':
    case 'budget':
      return ['runs'];
    case 'session':
      return ['sessions'];
    case 'memory':
      return ['memory'];
    case 'kill':
      return ['runs', 'approvals', 'automations', 'health', 'inbox'];
    case 'gateway':
      return ['health'];
    default:
      return [];
  }
}

export type StreamState = 'connecting' | 'live' | 'polling';

export interface ResourceState<T> {
  data: T | undefined;
  error: unknown;
  /** True until the first answer, and while a reload runs with nothing shown. */
  loading: boolean;
  /** Milliseconds since the epoch of the last good answer. */
  updatedAt: number;
}

interface Entry {
  state: ResourceState<unknown>;
  fetcher?: () => Promise<unknown>;
  on: Family[];
  runId?: string;
  listeners: Set<() => void>;
  inflight: boolean;
  again: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const EMPTY: ResourceState<never> = { data: undefined, error: null, loading: true, updatedAt: 0 };

/** Polling interval while the stream is down; slower safety refresh while it is up. */
const POLL_MS = 5_000;
const SAFETY_MS = 60_000;
/** Events arrive in bursts; one refetch per resource per burst. */
const SETTLE_MS = 300;
const RETRY_MS = 30_000;

export class LiveStore {
  private entries = new Map<string, Entry>();
  private stateListeners = new Set<() => void>();
  private eventListeners = new Set<(e: GatewayEvent) => void>();
  stream: StreamState = 'connecting';

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { state: EMPTY, on: [], listeners: new Set(), inflight: false, again: false };
      this.entries.set(key, e);
    }
    return e;
  }

  snapshot = (key: string): ResourceState<unknown> => this.entries.get(key)?.state ?? EMPTY;

  register(key: string, fetcher: () => Promise<unknown>, on: Family[], runId?: string): void {
    const e = this.entry(key);
    e.fetcher = fetcher;
    e.on = on;
    e.runId = runId;
  }

  subscribe(key: string, fn: () => void): () => void {
    const e = this.entry(key);
    e.listeners.add(fn);
    return () => e.listeners.delete(fn);
  }

  private set(key: string, state: ResourceState<unknown>): void {
    const e = this.entry(key);
    e.state = state;
    e.listeners.forEach((fn) => fn());
  }

  /** Replace a resource's data now, as after an action the gateway confirmed. */
  write<T>(key: string, update: (current: T | undefined) => T): void {
    const e = this.entry(key);
    this.set(key, { ...e.state, data: update(e.state.data as T | undefined), loading: false });
  }

  async fetch(key: string): Promise<void> {
    const e = this.entry(key);
    if (!e.fetcher) return;
    if (e.inflight) {
      e.again = true;
      return;
    }
    e.inflight = true;
    if (e.state.data === undefined && !e.state.loading)
      this.set(key, { ...e.state, loading: true });
    try {
      const data = await e.fetcher();
      this.set(key, { data, error: null, loading: false, updatedAt: Date.now() });
    } catch (error) {
      this.set(key, { ...e.state, error, loading: false });
    } finally {
      e.inflight = false;
      if (e.again) {
        e.again = false;
        void this.fetch(key);
      }
    }
  }

  private soon(key: string): void {
    const e = this.entry(key);
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      void this.fetch(key);
    }, SETTLE_MS);
  }

  /** Refetch every watched resource in these families (all of them when none are named). */
  invalidate(families?: Family[], runId?: string): void {
    for (const [key, e] of this.entries) {
      if (!e.listeners.size || !e.fetcher) continue;
      if (families && !e.on.some((f) => families.includes(f))) continue;
      if (e.runId && runId && e.runId !== runId) continue;
      this.soon(key);
    }
  }

  /** Refetch watched resources that follow live data; used by the poll and on focus. */
  refreshLive(): void {
    for (const [key, e] of this.entries) {
      if (e.listeners.size && e.fetcher && e.on.length) void this.fetch(key);
    }
  }

  private seen = new Set<string>();

  dispatch(event: GatewayEvent): void {
    // A reconnect can replay what was already delivered.
    if (event.id) {
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
    }
    this.eventListeners.forEach((fn) => fn(event));
    const families = familiesOf(event.name);
    if (families.length) this.invalidate(families, event.context?.runId);
  }

  onEvent(fn: (e: GatewayEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  setStream(state: StreamState): void {
    if (state === this.stream) return;
    this.stream = state;
    this.stateListeners.forEach((fn) => fn());
  }

  subscribeStream = (fn: () => void): (() => void) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };
}

/** Candidate EventSource URLs for the older gateways: GET /events, derived from the log stream's. */
export function streamUrls(client: GatewayClient): string[] {
  const out: string[] = [];
  try {
    out.push(client.logsStreamUrl().replace('/logs/stream', '/events'));
  } catch {
    /* no log stream either: poll */
  }
  return [...new Set(out)].filter((u) => /^https?:/.test(u));
}

/** How long GET /events/stream has to open before the older stream is tried. */
const OPEN_WAIT_MS = 8000;

/**
 * Opens the event stream and feeds its events to the store. Returns a closer.
 * GET /events/stream goes through the client, so the token is a header; only a
 * gateway without it falls back to an EventSource on GET /events.
 */
export function connectStream(store: LiveStore, client: GatewayClient): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();

  const poll = (again: () => void) => {
    store.setStream('polling');
    retry = setTimeout(again, RETRY_MS);
  };

  /** The older GET /events: it replays recent events on connect, which are history, not news. */
  const legacy = () => {
    if (closed) return;
    const urls = streamUrls(client);
    if (typeof EventSource === 'undefined' || !urls.length) return poll(start);
    const openedAt = Date.now();
    let opened = false;
    const es = new EventSource(urls[0]);
    source = es;
    es.onopen = () => {
      opened = true;
      store.setStream('live');
      store.refreshLive();
    };
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as GatewayEvent;
        if (!event?.name) return;
        if (event.at && Date.parse(event.at) < openedAt - 1000) return;
        store.dispatch(event);
      } catch {
        /* not an event frame */
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        if (opened) legacy();
        else poll(start);
      } else {
        // The browser reconnects by itself; poll until it does.
        store.setStream('polling');
      }
    };
  };

  function start() {
    if (closed) return;
    if (typeof client.streamEvents !== 'function' || typeof fetch === 'undefined') return legacy();
    let opened = false;
    const run = new AbortController();
    abort.signal.addEventListener('abort', () => run.abort(), { once: true });
    // No answer from /events/stream: an older gateway, so use /events.
    giveUp = setTimeout(() => {
      if (opened || closed) return;
      run.abort();
      legacy();
    }, OPEN_WAIT_MS);
    client
      .streamEvents((event) => store.dispatch(event as unknown as GatewayEvent), {
        signal: run.signal,
        onOpen: () => {
          opened = true;
          clearTimeout(giveUp);
          store.setStream('live');
          // Catch up on whatever changed while the stream was down.
          store.refreshLive();
        },
        onReset: () => store.refreshLive(),
      })
      .catch(() => {
        // A refused token will not get better by retrying quickly.
        clearTimeout(giveUp);
        if (!closed && !run.signal.aborted) poll(start);
      });
  }

  start();
  return () => {
    closed = true;
    abort.abort();
    clearTimeout(retry);
    clearTimeout(giveUp);
    source?.close();
  };
}

export const LiveContext = createContext<LiveStore | null>(null);

/** Holds the cache and the stream for everything inside it. */
export function LiveProvider({
  client,
  store: given,
  children,
}: {
  client: GatewayClient;
  /** A prepared store, as the fixtures and tests use; otherwise one is made. */
  store?: LiveStore;
  children: ReactNode;
}) {
  const store = useMemo(() => given ?? new LiveStore(), [given]);

  useEffect(() => connectStream(store, client), [store, client]);
  useStoreRefresh(store);

  return <LiveContext.Provider value={store}>{children}</LiveContext.Provider>;
}

/**
 * Keeps what a store holds fresh when the stream is not doing it: every few seconds while the
 * stream is down, now and then while it is up, and when the window is focused.
 */
export function useStoreRefresh(store: LiveStore): void {
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (store.stream !== 'live') store.refreshLive();
    };
    const poll = setInterval(tick, POLL_MS);
    const safety = setInterval(() => store.refreshLive(), SAFETY_MS);
    const onFocus = () => store.refreshLive();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(poll);
      clearInterval(safety);
      window.removeEventListener('focus', onFocus);
    };
  }, [store]);
}

export function useLive(): LiveStore {
  const store = useContext(LiveContext);
  if (!store) throw new Error('useLive needs a <LiveProvider>.');
  return store;
}

export function useStreamState(): StreamState {
  const store = useLive();
  return useSyncExternalStore(
    store.subscribeStream,
    () => store.stream,
    () => store.stream
  );
}

export interface ResourceOptions {
  /** Families whose events refetch it. Empty: fetched once per mount, never polled. */
  on?: Family[];
  /** Only events about this run refetch it. */
  runId?: string;
}

export interface Resource<T> extends ResourceState<T> {
  reload: () => Promise<void>;
}

/**
 * A gateway read, cached under `key` and shared by every component that asks
 * for the same key. A null key fetches nothing.
 */
export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: ResourceOptions = {}
): Resource<T> {
  const store = useLive();
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const on = (options.on ?? []).join(',');

  const subscribe = useCallback(
    (fn: () => void) => (key ? store.subscribe(key, fn) : () => {}),
    [store, key]
  );
  const state = useSyncExternalStore(
    subscribe,
    () => (key ? store.snapshot(key) : EMPTY),
    () => (key ? store.snapshot(key) : EMPTY)
  ) as ResourceState<T>;

  useEffect(() => {
    if (!key) return;
    store.register(
      key,
      () => fetchRef.current(),
      on ? (on.split(',') as Family[]) : [],
      options.runId
    );
    const current = store.snapshot(key);
    // Shared keys are fetched once; a later mount reuses a recent answer.
    if (!current.updatedAt || Date.now() - current.updatedAt > 2_000 || current.error) {
      void store.fetch(key);
    }
  }, [store, key, on, options.runId]);

  const reload = useCallback(async () => {
    if (key) await store.fetch(key);
  }, [store, key]);

  return { ...state, loading: key ? state.loading : false, reload };
}
