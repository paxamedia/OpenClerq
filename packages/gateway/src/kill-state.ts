/**
 * The kill switch's pause, kept in the store so a restart does not undo it:
 * a gateway that starts while it is engaged starts no triggers, schedules or
 * queued runs until POST /resume, and slots missed meanwhile are never caught up.
 */

import { getStore, isStoreOpen } from './store.js';
import { logger } from './logger.js';

const KEY = 'kill.pausedAt';

/** When the kill switch paused triggers, or null when it is not engaged. */
export function readKillPause(): string | null {
  if (!isStoreOpen()) return null;
  try {
    const row = getStore().prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    return row?.value ? String(row.value) : null;
  } catch (e) {
    logger.warn('Could not read the kill switch state', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Record the pause (an ISO time), or its end (null). */
export function writeKillPause(at: string | null): void {
  if (!isStoreOpen()) return;
  try {
    if (at === null) {
      getStore().prepare('DELETE FROM settings WHERE key = ?').run(KEY);
      return;
    }
    getStore()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(KEY, at, new Date().toISOString());
  } catch (e) {
    logger.warn('Could not record the kill switch state', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
