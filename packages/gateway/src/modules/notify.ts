/**
 * ctx.notify: the gateway's half of module notifications. It puts events on
 * the bus; the desktop turns `notify.posted` into a native notification and
 * `notify.badge` into a badge, and the push publisher sends it to devices.
 */

import crypto from 'node:crypto';
import type { ModuleNotify } from '@clerq/module-sdk';
import { emit } from '../events.js';
import { logger } from '../logger.js';

const PER_MINUTE = 30;
const LEVELS = new Set(['info', 'success', 'warning', 'error']);

export interface NotificationPayload {
  id: string;
  moduleId: string;
  title: string;
  body?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  link?: string;
}

/** Current badges by module, for GET /modules. */
const badges = new Map<string, string>();

export function badgeOf(moduleId: string): string | null {
  return badges.get(moduleId) ?? null;
}

export function createNotify(moduleId: string): ModuleNotify {
  let windowStart = 0;
  let sent = 0;
  const notify = (n: Parameters<ModuleNotify>[0]) => {
    const title = typeof n?.title === 'string' ? n.title.trim().slice(0, 200) : '';
    if (!title) throw new Error('A notification needs a title.');
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      sent = 0;
    }
    if (++sent > PER_MINUTE) {
      if (sent === PER_MINUTE + 1) {
        logger.warn('Module notifications dropped: more than 30 a minute', { moduleId });
      }
      return null;
    }
    const payload: NotificationPayload = {
      id: `ntf_${crypto.randomUUID()}`,
      moduleId,
      title,
      body: typeof n.body === 'string' ? n.body.slice(0, 2000) : undefined,
      level: n.level && LEVELS.has(n.level) ? n.level : 'info',
      link: typeof n.link === 'string' ? n.link : undefined,
    };
    emit('notify.posted', payload);
    return { id: payload.id };
  };
  return Object.assign(notify, {
    badge(text: string | null) {
      const value = typeof text === 'string' && text.trim() ? text.trim().slice(0, 32) : null;
      if (value === badgeOf(moduleId)) return;
      if (value === null) badges.delete(moduleId);
      else badges.set(moduleId, value);
      emit('notify.badge', { moduleId, badge: value });
    },
  });
}
