/**
 * What the screens need from their surroundings: a gateway client and a host.
 *
 * The desktop passes the `gateway` object from @clerq/gateway-client and a host
 * over Tauri; the phone app passes its own client and host. The screens never
 * import a client themselves, so either can mount them.
 */

import { createContext, useContext } from 'react';
import type { AutomationSummary } from '@clerq/gateway-client';
import type { AppConfig, GatewayClient, Host, UpdateResult } from '@clerq/plugin-sdk/ui';
import type { ScopedClientFactory } from './plugin-access';

// These four are part of the plugin contract, so a plugin can type its UI without importing
// anything from the app: they are defined in `@clerq/plugin-sdk/ui` and re-exported here.
export type { AppConfig, GatewayClient, Host, UpdateResult };

/** An automation as the screens show it. */
export type AutomationInfo = AutomationSummary;

export interface Environment {
  client: GatewayClient;
  host: Host;
  /** Makes the client a plugin is given under enforcement; `createGatewayClient` unless the host brings its own. */
  scopedClient?: ScopedClientFactory;
  /** How long a plugin's UI token lives, in seconds (15 minutes unless a host or a test says otherwise). */
  pluginTokenSeconds?: number;
}

export const EnvironmentContext = createContext<Environment | null>(null);

export function useEnvironment(): Environment {
  const env = useContext(EnvironmentContext);
  if (!env) throw new Error('OpenClerq screens must be mounted inside <OpenClerqApp>.');
  return env;
}

export const useClient = (): GatewayClient => useEnvironment().client;
export const useHost = (): Host => useEnvironment().host;
