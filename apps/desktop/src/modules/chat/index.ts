/**
 * Chat, bundled as the reference first-party plugin: the manifest and the UI come from
 * `@clerq/plugin-chat`, the same pieces a third-party plugin has. Leave it out of
 * BUNDLED_MODULES (and out of the bundled plugin resources in tauri.conf.json), or
 * turn it off in Settings, and nothing else changes.
 */

import type { ModuleManifest } from '@clerq/module-schema';
import { CHAT_ID, chatManifest, chatPlugin } from '@clerq/plugin-chat';
import type { BundledModule } from '../../moduleSlots';

export const chatDesktopManifest: ModuleManifest = {
  id: CHAT_ID,
  slug: CHAT_ID,
  name: 'Chat',
  version: chatManifest.version,
  description: 'Talk to any model you have a key for, raw or managed.',
  entryPoints: { ui: 'chatPlugin' },
};

/** 0.5 called it the chat console. */
export const chat: BundledModule = {
  manifest: chatDesktopManifest,
  ui: chatPlugin,
  formerIds: ['chat-console'],
};
