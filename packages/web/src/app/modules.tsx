/**
 * The module slot contract: how a module adds pages to the app.
 *
 * A module gives an id, its rail entries and one component that draws every
 * route under `#/m/<id>/…`. Bundled modules (Automations, Chat) use it exactly
 * as a third-party module would, so either can be left out.
 */

import type { ReactNode } from 'react';
import type {
  PaletteCommand,
  PluginProps,
  PluginRenderer,
  PluginUI,
  PluginUIContext,
  RailEntry,
} from '@clerq/plugin-sdk/ui';

export type { PaletteCommand, RailEntry };

// The slot contract is `@clerq/plugin-sdk/ui`, so a plugin can type its UI without importing the
// app. The names this file always had stay, as aliases.

/** @deprecated Use `PluginProps` from `@clerq/plugin-sdk/ui`. */
export type ModuleProps = PluginProps;
/** @deprecated Use `PluginUIContext` from `@clerq/plugin-sdk/ui`: `ModuleContext` is now the server's. */
export type ModuleContext = PluginUIContext;
/** @deprecated Use `PluginUI` from `@clerq/plugin-sdk/ui`. */
export type ModuleUI = PluginUI;
/** @deprecated Use `PluginRenderer` from `@clerq/plugin-sdk/ui`. */
export type ModuleRenderer = PluginRenderer;

/** The route base of a module's pages. */
export const moduleBase = (id: string): string => `/m/${encodeURIComponent(id)}`;

export const renderBundled = (module: PluginUI, props: PluginProps): ReactNode => {
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
