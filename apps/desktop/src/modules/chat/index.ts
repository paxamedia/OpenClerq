/**
 * Chat, bundled through the slot contract a third-party module uses. Leave it
 * out of BUNDLED_MODULES, or turn it off in Settings, and nothing else changes.
 */

import type { ModuleManifest } from '@clerq/module-schema';
import { CHAT_ID, chatModule } from '@clerq/web';
import type { BundledModule } from '../../moduleSlots';

export const chatManifest: ModuleManifest = {
  id: CHAT_ID,
  slug: CHAT_ID,
  name: 'Chat',
  version: '0.6.0',
  description: 'Talk to any model you have a key for, raw or managed.',
  entryPoints: { ui: 'chatModule' },
};

/** 0.5 called it the chat console. */
export const chat: BundledModule = {
  manifest: chatManifest,
  ui: chatModule,
  formerIds: ['chat-console'],
};
