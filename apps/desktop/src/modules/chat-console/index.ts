/**
 * The chat console as a module registration.
 *
 * It ships bundled, through the same contract a third-party module uses: an id,
 * a manifest and a UI component.
 *
 * To remove it: drop its entries from `bundledComponents` and `DEFAULT_MODULES`
 * in App.tsx, or disable the module in ~/.clerq/config.json. Nothing else
 * depends on it.
 */

import type { ModuleManifest } from '@clerq/module-schema';
import type { ModuleUIComponent } from '../../moduleSlots';
import { ChatConsole } from './ChatConsole';

export const CHAT_CONSOLE_ID = 'chat-console';

export const chatConsoleManifest: ModuleManifest = {
  id: CHAT_CONSOLE_ID,
  slug: CHAT_CONSOLE_ID,
  name: 'Chat console',
  version: '0.5.0',
  description: 'Talk to any model you have a key for, raw or through the full pipeline.',
  entryPoints: { ui: 'ChatConsole' },
};

export const chatConsoleComponent: ModuleUIComponent = ChatConsole as ModuleUIComponent;

export { ChatConsole };
