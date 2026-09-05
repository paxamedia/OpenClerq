/**
 * Process-wide handle to the durable store.
 *
 * Opened once during gateway startup. `openStore` is async only because the
 * driver picks its SQLite backend with a dynamic import, so callers await
 * `initStore()` once and then use the synchronous query API.
 */

import { openStore, importLegacyJson, type Database } from '@clerq/store';
import { logger } from './logger.js';

let db: Database | null = null;
let opening: Promise<Database> | null = null;

/**
 * Open the store and migrate it, importing any pre-0.5 JSON config on the way.
 * Safe to call repeatedly; concurrent callers share one open.
 *
 * @param dbPath override the location (tests pass ':memory:')
 */
export function initStore(dbPath?: string): Promise<Database> {
  if (db) return Promise.resolve(db);
  if (opening) return opening;

  opening = (async () => {
    const opened = await openStore(dbPath);
    db = opened;
    logger.info('Store opened', { backend: opened.backend });

    // Idempotent: entries already present are left alone. Skipped for in-memory
    // databases so tests never read or archive the real ~/.clerq files.
    try {
      if (dbPath !== ':memory:') {
        const imported = importLegacyJson(opened);
        if (imported.memory > 0 || imported.triggers > 0) {
          logger.info('Imported legacy JSON config', {
            memory: imported.memory,
            triggers: imported.triggers,
            archived: imported.archived,
          });
        }
      }
    } catch (e) {
      // A failed import must not stop the gateway starting.
      logger.warn('Legacy config import failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    return opened;
  })();

  return opening;
}

/** The open store. Throws if `initStore()` has not resolved yet. */
export function getStore(): Database {
  if (!db) {
    throw new Error('Store is not open yet. Call initStore() during startup.');
  }
  return db;
}

export function isStoreOpen(): boolean {
  return db !== null;
}

export function closeStore(): void {
  if (db) {
    db.close();
    db = null;
    opening = null;
  }
}
