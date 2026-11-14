/**
 * Search across modules: core records, then every module that registered a
 * handler with ctx.search.register, each given at most 1.5 seconds. A module
 * that fails or is slow is reported, not fatal.
 */

import type { SearchHandler, SearchResult } from '@clerq/plugin-sdk';
import {
  listRecords,
  normaliseEmail,
  normaliseDomain,
  normalisePhone,
} from '../records/records.js';

const TIMEOUT_MS = 1500;

export interface Hit extends SearchResult {
  moduleId: string;
  score: number;
}

const handlers = new Map<string, SearchHandler>();

export function registerSearch(moduleId: string, handler: SearchHandler): void {
  if (typeof handler !== 'function') throw new Error('A search handler must be a function.');
  handlers.set(moduleId, handler);
}

export function unregisterSearch(moduleId: string): void {
  handlers.delete(moduleId);
}

export function searchModules(): string[] {
  return [...handlers.keys()];
}

/** Core people and organisations: an exact identity first, then the name. */
function searchCore(q: string, limit: number): Hit[] {
  const lower = q.toLowerCase();
  const exact = new Set(
    [normaliseEmail(q), normalisePhone(q), normaliseDomain(q)].filter((v): v is string => !!v)
  );
  return listRecords({ q, limit: limit * 2 })
    .filter((r) => r.type !== 'activity')
    .map((r) => {
      const ids = [...r.emails, ...r.phones, ...r.domains];
      const name = (r.name ?? '').toLowerCase();
      const score = ids.some((i) => exact.has(i))
        ? 1
        : name.startsWith(lower)
          ? 0.8
          : name.includes(lower)
            ? 0.6
            : 0.4;
      return {
        ref: r.ref,
        moduleId: 'core',
        type: `core:${r.type}`,
        title: r.name ?? ids[0] ?? r.id,
        subtitle: ids.slice(0, 2).join(' · ') || undefined,
        score,
      };
    });
}

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      controller.abort();
      reject(new Error(`No answer within ${ms} ms.`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function search(
  q: string,
  opts: { limit?: number; types?: string[] } = {}
): Promise<{ results: Hit[]; errors: Array<{ moduleId: string; error: string }> }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const types = opts.types?.filter(Boolean);
  const wants = (type: string) => !types?.length || types.includes(type);
  const errors: Array<{ moduleId: string; error: string }> = [];
  const results: Hit[] =
    types?.length && !types.some((t) => t.startsWith('core:')) ? [] : searchCore(q, limit);

  await Promise.all(
    [...handlers.entries()].map(async ([moduleId, handler]) => {
      const controller = new AbortController();
      try {
        const out = await withTimeout(
          Promise.resolve(handler(q, { limit, types, signal: controller.signal })),
          TIMEOUT_MS,
          controller
        );
        for (const r of Array.isArray(out) ? out.slice(0, limit) : []) {
          if (!r || typeof r.ref !== 'string' || typeof r.title !== 'string') continue;
          const type = typeof r.type === 'string' ? r.type : r.ref.split(':').slice(0, 2).join(':');
          results.push({
            ...r,
            type,
            moduleId,
            score: typeof r.score === 'number' ? Math.min(Math.max(r.score, 0), 1) : 0.5,
          });
        }
      } catch (e) {
        errors.push({ moduleId, error: e instanceof Error ? e.message : String(e) });
      }
    })
  );

  return {
    results: results
      .filter((r) => wants(r.type ?? ''))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit),
    errors,
  };
}
