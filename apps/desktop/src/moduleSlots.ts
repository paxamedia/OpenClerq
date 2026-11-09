/**
 * The module slot contract, as the desktop uses it. The types live in
 * @clerq/web, so every app that mounts the screens shares one contract.
 *
 * A module gives its manifest and a ModuleUI: rail entries, palette commands
 * and search, and one component for the routes under `#/m/<id>/…`.
 */

import type { ModuleManifest } from '@clerq/module-schema';
import type { ModuleUI } from '@clerq/web';

export type {
  ModuleContext,
  ModuleProps,
  ModuleRenderer,
  ModuleUI,
  PaletteCommand,
  RailEntry,
} from '@clerq/web';

/** A module that ships inside the desktop app. */
export interface BundledModule {
  manifest: ModuleManifest;
  ui: ModuleUI;
  /** Ids this module had in earlier releases, so a saved on/off setting still applies. */
  formerIds?: string[];
}
