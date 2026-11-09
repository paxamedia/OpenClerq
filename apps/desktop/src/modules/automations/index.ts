/**
 * Automations, bundled through the slot contract. Leave it out of
 * BUNDLED_MODULES and its pages go; the gateway keeps running the
 * automations that are switched on.
 */

import type { ModuleManifest } from '@clerq/module-schema';
import { AUTOMATIONS_ID, automationsModule } from '@clerq/web';
import type { BundledModule } from '../../moduleSlots';

export const automationsManifest: ModuleManifest = {
  id: AUTOMATIONS_ID,
  slug: AUTOMATIONS_ID,
  name: 'Automations',
  version: '0.6.0',
  description: 'Scheduled agent runs that end in a draft pull request.',
  entryPoints: { ui: 'automationsModule' },
};

export const automations: BundledModule = { manifest: automationsManifest, ui: automationsModule };
