/**
 * Chat as a module. It ships bundled through the same contract a third-party
 * module uses; leave it out and nothing else changes.
 */

import { MessageSquare, Plus } from 'lucide-react';
import type { ModuleUI } from '../../app/modules';
import { ChatScreen } from './Chat';

export const CHAT_ID = 'chat';

export const chatModule: ModuleUI = {
  id: CHAT_ID,
  name: 'Chat',
  description: 'Talk to any model you have a key for, raw or managed.',
  icon: MessageSquare,
  rail: [{ id: CHAT_ID, label: 'Chat', icon: MessageSquare, path: `/m/${CHAT_ID}`, order: 40 }],
  component: ChatScreen,
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
