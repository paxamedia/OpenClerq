/**
 * The module slot contract: how a module adds pages to the app.
 *
 * A module gives an id, its rail entries and one component that draws every
 * route under `#/m/<id>/…`. Bundled modules (Automations, Chat) use it exactly
 * as a third-party module would, so either can be left out.
 */

import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { AppConfig, GatewayClient, Host } from './client';
import type { Route } from './router';

export interface RailEntry {
  /** Unique across the app, e.g. "automations". */
  id: string;
  label: string;
  icon: LucideIcon;
  /** The route the entry opens and owns, e.g. "/m/automations". */
  path: string;
  /** Where it sits in the rail: lower first. Core pages use 0–100 in steps of 10. */
  order?: number;
  /** Bottom group of the rail (Developer, Settings) rather than the top. */
  group?: 'main' | 'end';
  /** Keep it out of the phone's tab bar; it is listed under More instead. */
  secondary?: boolean;
  /** The module that adds it; core pages have none. */
  module?: string;
}

/** What a module's component receives. */
export interface ModuleProps {
  route: Route;
  /** The route's segments after `/m/<id>`, e.g. ["weekly-deps", "edit"]. */
  parts: string[];
  /** "/m/<id>", for building links to the module's own pages. */
  base: string;
  client: GatewayClient;
  host: Host;
  config: AppConfig | null;
  navigate: (to: string) => void;
}

export interface PaletteCommand {
  id: string;
  label: string;
  /** Shown faint after the label, e.g. the module or record type. */
  hint?: string;
  icon?: LucideIcon;
  keywords?: string;
  run: () => void;
}

export interface ModuleContext {
  client: GatewayClient;
  navigate: (to: string) => void;
  base: string;
}

export interface ModuleUI {
  id: string;
  name: string;
  description?: string;
  icon: LucideIcon;
  rail: RailEntry[];
  component: ComponentType<ModuleProps>;
  /** Actions for the palette that need no query, e.g. "New automation". */
  commands?: (ctx: ModuleContext) => PaletteCommand[];
  /** Records and actions matching a query, for the palette. */
  search?: (query: string, ctx: ModuleContext) => Promise<PaletteCommand[]>;
  /** Known only from a manifest on disk; the gateway's own entry for the module replaces it. */
  placeholder?: boolean;
}

/** The route base of a module's pages. */
export const moduleBase = (id: string): string => `/m/${encodeURIComponent(id)}`;

/** Draws a module's routes; the desktop supplies one that also hosts external module UIs. */
export type ModuleRenderer = (module: ModuleUI, props: ModuleProps) => ReactNode;

export const renderBundled: ModuleRenderer = (module, props) => {
  const Component = module.component;
  return <Component {...props} />;
};

const PINS_KEY = 'clerq-pinned-modules';

/** Modules pinned to the rail, by id; null until the user changes it, meaning all of them. */
export function storedPins(): string[] | null {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export function storePins(ids: string[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(ids));
  } catch {
    /* kept for this window only */
  }
}
