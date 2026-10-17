/**
 * Automations as a module registration, bundled through the same contract as
 * the chat console. Disabling it hides the screens; the gateway keeps running
 * the automations that are switched on.
 */

import type { ModuleManifest } from '@clerq/module-schema';
import type { ModuleUIComponent } from '../../moduleSlots';
import { Automations } from './Automations';

export const AUTOMATIONS_ID = 'automations';

export const automationsManifest: ModuleManifest = {
  id: AUTOMATIONS_ID,
  slug: AUTOMATIONS_ID,
  name: 'Automations',
  version: '0.6.0',
  description:
    'Scheduled agent runs that end in a draft pull request, with their runs and approvals.',
  entryPoints: { ui: 'Automations' },
};

export const automationsComponent: ModuleUIComponent = Automations as ModuleUIComponent;

export { Automations };
