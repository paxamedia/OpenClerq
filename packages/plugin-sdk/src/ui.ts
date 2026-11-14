/**
 * @clerq/plugin-sdk/ui: the slot contract. How a plugin adds pages to the
 * OpenClerq interface, typed without importing anything from the app.
 *
 * A plugin gives an id, its rail entries and one component that draws every
 * route under `#/m/<id>/…`. Bundled plugins (Automations, Chat) use it exactly
 * as a third-party plugin would, so either can be left out. A plugin that runs
 * in the gateway and ships a web page instead is drawn in a frame by the shell;
 * this contract is for a plugin whose UI is a component in the app's own bundle.
 *
 * Types only: this file has no runtime code. It needs `react` and `lucide-react`
 * types to be installed next to the plugin.
 */

import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { gateway } from '@clerq/gateway-client';

/** The icon type the interface draws: a `lucide-react` glyph. */
export type PluginIcon = LucideIcon;

/**
 * The gateway calls a screen makes: the `@clerq/gateway-client` object, or one
 * shaped like it. The desktop passes the real one. A plugin never imports a
 * client itself, so the host can hand it a client of any kind (a recorded one, a
 * phone's). With plugin checks on, the shell hands a bundled plugin one made by
 * `createGatewayClient` over its module UI token, limited to the endpoints it
 * declared: see "How the scoped client works" in docs/PLUGINS.md.
 */
export type GatewayClient = typeof gateway;

/** Saved app settings: `~/.clerq/config.json` on the desktop. */
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

/** What the app around the screens can do. Every member but `kind`, `version` and `openUrl` is optional. */
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

/** Where the app is: the hash route without its `#`. */
export interface PluginRoute {
  /** The path without the leading `#`, e.g. "/runs/abc123". */
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export interface RailEntry {
  /** Unique across the app, e.g. "automations". */
  id: string;
  label: string;
  icon: PluginIcon;
  /** The route the entry opens and owns, e.g. "/m/automations". */
  path: string;
  /** Where it sits in the rail: lower first. Core pages use 0–100 in steps of 10. */
  order?: number;
  /** Bottom group of the rail (Developer, Settings) rather than the top. */
  group?: 'main' | 'end';
  /** Keep it out of the phone's tab bar; it is listed under More instead. */
  secondary?: boolean;
  /** The plugin that adds it; core pages have none. */
  module?: string;
}

/** What a plugin's component receives. */
export interface PluginProps {
  route: PluginRoute;
  /** The route's segments after `/m/<id>`, e.g. ["weekly-deps", "edit"]. */
  parts: string[];
  /** "/m/<id>", for building links to the plugin's own pages. */
  base: string;
  client: GatewayClient;
  host: Host;
  config: AppConfig | null;
  navigate: (to: string) => void;
}

export interface PaletteCommand {
  id: string;
  label: string;
  /** Shown faint after the label, e.g. the plugin or record type. */
  hint?: string;
  icon?: PluginIcon;
  keywords?: string;
  run: () => void;
}

/** What a plugin's palette hooks receive. (`ModuleContext` in the app before 1.0; that name now belongs to the server context.) */
export interface PluginUIContext {
  client: GatewayClient;
  navigate: (to: string) => void;
  base: string;
}

export interface PluginUI {
  id: string;
  name: string;
  description?: string;
  icon: PluginIcon;
  rail: RailEntry[];
  component: ComponentType<PluginProps>;
  /** Actions for the palette that need no query, e.g. "New automation". */
  commands?: (ctx: PluginUIContext) => PaletteCommand[];
  /** Records and actions matching a query, for the palette. */
  search?: (query: string, ctx: PluginUIContext) => Promise<PaletteCommand[]>;
  /** Known only from a manifest on disk; the gateway's own entry for the plugin replaces it. */
  placeholder?: boolean;
  /**
   * The core endpoints this UI calls, as `METHOD /path` patterns: the same list as the
   * manifest's `permissions.api`. A bundled plugin declares them here; having them is what
   * makes the shell give the plugin a client limited to them when plugin checks are on.
   */
  api?: string[];
}

/** Draws a plugin's routes; the desktop supplies one that also hosts plugin UIs served by the gateway. */
export type PluginRenderer = (plugin: PluginUI, props: PluginProps) => ReactNode;
