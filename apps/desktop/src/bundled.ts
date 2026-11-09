/** The modules shipped with the desktop app, and which of them the user turned off. */

import type { AppConfig } from '@clerq/web';
import type { BundledModule } from './moduleSlots';
import { automations } from './modules/automations';
import { chat } from './modules/chat';

/** Removing a bundled module is deleting its line here. */
export const BUNDLED_MODULES: BundledModule[] = [automations, chat];

/** Off when config.json lists it, under its id or an earlier one, with enabled: false. */
export function isTurnedOff(config: AppConfig, m: BundledModule): boolean {
  const ids = [m.manifest.id, ...(m.formerIds ?? [])];
  return (config.modules ?? []).some((e) => ids.includes(e.id) && e.enabled === false);
}
