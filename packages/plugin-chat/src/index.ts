/**
 * The chat console, as a plugin: the reference first-party plugin on `@clerq/plugin-sdk`.
 *
 * It ships bundled and is declared the way a third-party plugin's UI is: a
 * manifest (`../manifest.json`) that says what it needs, and a `PluginUI` that
 * draws every route under `#/m/chat/…`. Leave it out of the app's bundled list and
 * the console goes; nothing else changes. Its server side (sessions, the managed
 * loop, drafts) is the gateway's own code: see docs/PLUGINS.md.
 */

import { MessageSquare, Plus } from 'lucide-react';
import type { PluginUI } from '@clerq/plugin-sdk/ui';
import manifest from '../manifest.json';
import { ChatScreen } from './Chat';

export const CHAT_ID = manifest.id;

/** The manifest the gateway reads from the folder this package ships, as a value. */
export const chatManifest = manifest;

export const chatPlugin: PluginUI = {
  id: CHAT_ID,
  name: 'Chat',
  description: 'Talk to any model you have a key for, raw or managed.',
  icon: MessageSquare,
  rail: [{ id: CHAT_ID, label: 'Chat', icon: MessageSquare, path: `/m/${CHAT_ID}`, order: 40 }],
  component: ChatScreen,
  // The endpoints the console calls: the manifest's own list, so the two cannot differ.
  api: manifest.permissions.api,
  commands: ({ client, navigate, base }) => [
    {
      id: 'chat:new',
      label: 'New conversation',
      icon: Plus,
      keywords: 'chat message ask',
      run: () => {
        void client
          .createSession({ mode: 'raw' })
          .then((s) => navigate(`${base}/${encodeURIComponent(s.id)}`));
      },
    },
  ],
  search: async (query, { client, navigate, base }) => {
    const q = query.toLowerCase();
    const { sessions } = await client.sessions(100);
    return sessions
      .filter((s) => (s.title ?? '').toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => ({
        id: `session:${s.id}`,
        label: s.title ?? 'Untitled',
        hint: 'Conversation',
        icon: MessageSquare,
        run: () => navigate(`${base}/${encodeURIComponent(s.id)}`),
      }));
  },
};

export { ChatScreen };
