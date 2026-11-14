/**
 * What a bundled plugin's page is drawn inside, and what it can reach from there.
 *
 * A plugin's page shares the app's React tree, so what it is handed is what it can use:
 *
 *  - **A live store of its own.** The shell's store holds what the app read with the app's own
 *    client (`plugins`, the inbox, runs…), receives every event the gateway sends, and is what
 *    the shell decides things from. A plugin that could write into it, take over a fetcher in it
 *    or read it would be reading with the operator's token and could change what the shell
 *    believes, so `useResource` in a plugin's page reads and writes a store that belongs to that
 *    plugin, filled by the client it was given. The shell tells that store which kinds of data
 *    changed (`sessions`, `approvals`…), never the events themselves.
 *  - **A reduced host.** `kind`, `version` and an `openUrl` that opens only `https:` addresses.
 *    Not the one that repoints the app's client, writes its settings or key, or posts a form.
 */

import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { EnvironmentContext, type GatewayClient, type Host } from './client';
import { LiveContext, LiveStore, familiesOf, useLive, useStoreRefresh, type Family } from './live';

/** The host a plugin's page is given. */
export function reducedHost(host: Host): Host {
  return {
    kind: host.kind,
    version: host.version,
    openUrl(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol === 'https:') host.openUrl(url);
    },
  };
}

/** Provides one plugin's page its client, its reduced host and its own live store. */
export function PluginSurface({
  store,
  client,
  host,
  children,
}: {
  /** The plugin's store: the shell keeps one per plugin, so a page that was left comes back warm. */
  store: LiveStore;
  client: GatewayClient;
  /** Already reduced (`reducedHost`). */
  host: Host;
  children: ReactNode;
}) {
  const shell = useLive();
  const env = useMemo(() => ({ client, host }), [client, host]);

  useEffect(() => {
    const follow = () => store.setStream(shell.stream);
    follow();
    const offStream = shell.subscribeStream(follow);
    // Which kinds of data changed, so the plugin's store refetches them with the plugin's client.
    const offEvents = shell.onEvent((e) => {
      const families = familiesOf(e.name);
      if (families.length) store.invalidate(families, e.context?.runId);
    });
    return () => {
      offStream();
      offEvents();
    };
  }, [shell, store]);
  useStoreRefresh(store);

  return (
    <EnvironmentContext.Provider value={env}>
      <LiveContext.Provider value={store}>{children}</LiveContext.Provider>
    </EnvironmentContext.Provider>
  );
}

/**
 * Refetch what the plugin's own store holds for these kinds of data (all of it when none are named).
 * It reaches that store and no other.
 */
export function useInvalidate(): (families?: Family[], runId?: string) => void {
  const store = useLive();
  return useCallback((families, runId) => store.invalidate(families, runId), [store]);
}
