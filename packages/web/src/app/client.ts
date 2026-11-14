/**
 * What the screens need from their surroundings: a gateway client and a host.
 *
 * The desktop passes the `gateway` object from @clerq/gateway-client and a host
 * over Tauri; the phone app passes its own client and host. The screens never
 * import a client themselves, so either can mount them.
 */

import { createContext, useContext } from 'react';
import type { AutomationSummary, gateway } from '@clerq/gateway-client';

/** The gateway calls the screens make: the @clerq/gateway-client object, or one shaped like it. */
export type GatewayClient = typeof gateway;

/** An automation as the screens show it. */
export type AutomationInfo = AutomationSummary;

/** Saved app settings: ~/.clerq/config.json on the desktop. */
export interface AppConfig {
  settings?: {
    gatewayUrl?: string;
    /** The page the app opens on, as a route such as "/automations". */
    defaultModule?: string;
    skillsDir?: string;
    runMode?: 'manual' | 'auto';
    runFrequencyCount?: number;
    runFrequencyPeriod?: 'hour' | 'day' | 'week' | 'month';
    runTaskMessage?: string;
    [key: string]: unknown;
  };
  modules?: Array<{ id: string; name: string; description: string; enabled?: boolean }>;
  modulePaths?: Array<{ id: string; path?: string; url?: string }>;
  moduleState?: Record<string, { clientName?: string }>;
  [key: string]: unknown;
}

export type UpdateResult = 'up-to-date' | 'installing';

/** What the app around the screens can do. Every member but `openUrl` is optional. */
export interface Host {
  kind: 'desktop' | 'mobile' | 'web';
  /** The app's own version, shown in the status bar. */
  version: string;
  openUrl(url: string): void;
  /**
   * Post a form to an https address in the person's default browser. The desktop's own
   * window cannot: GitHub's app manifest has to be posted from the browser GitHub
   * will ask to confirm it, and the window is not that. Without it, a screen posts the
   * form into a window it opens itself.
   */
  openForm?(url: string, fields: Record<string, string>): Promise<void>;
  readConfig?(): Promise<AppConfig>;
  writeConfig?(config: AppConfig): Promise<void>;
  /** Point the client at another gateway address. */
  setGatewayUrl?(url: string): void;
  /** Store the Anthropic key for the background service; it applies after a restart. */
  saveApiKey?(key: string): Promise<void>;
  checkForUpdates?(): Promise<UpdateResult>;
  /** Show a system notification; `onClick` runs when it is clicked, where the system allows. */
  notify?(n: { title: string; body?: string; onClick?: () => void }): void;
  /** The number on the app's icon: what is waiting in the inbox. 0 clears it. */
  setBadge?(count: number): void;
}

interface Environment {
  client: GatewayClient;
  host: Host;
}

export const EnvironmentContext = createContext<Environment | null>(null);

function useEnvironment(): Environment {
  const env = useContext(EnvironmentContext);
  if (!env) throw new Error('OpenClerq screens must be mounted inside <OpenClerqApp>.');
  return env;
}

export const useClient = (): GatewayClient => useEnvironment().client;
export const useHost = (): Host => useEnvironment().host;
