/**
 * @clerq/web/testing: what a plugin's tests need to draw its UI the way the app does.
 *
 * `PluginTestFrame` supplies the client, the host, live data and toasts a plugin's
 * components read; with a fixture client (`@clerq/web/fixtures`) a plugin's pieces can
 * be drawn without a gateway.
 */

import type { ReactNode } from 'react';
import { EnvironmentContext, type GatewayClient, type Host } from './app/client';
import { LiveProvider, type LiveStore } from './app/live';
import { ToastProvider } from './ui/Toast';

const TEST_HOST: Host = { kind: 'web', version: '0.0.0', openUrl: () => undefined };

export function PluginTestFrame({
  client,
  host = TEST_HOST,
  store,
  children,
}: {
  client: GatewayClient;
  host?: Host;
  store?: LiveStore;
  children: ReactNode;
}) {
  return (
    <EnvironmentContext.Provider value={{ client, host }}>
      <LiveProvider client={client} store={store}>
        <ToastProvider>{children}</ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}
