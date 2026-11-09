/**
 * Modules the gateway runs, and the extension points they fill: rail entries,
 * Home tiles, record panels and actions, search and inbox items. Paths in
 * extensions are inside the module's UI and open at `#/m/<module>/<path>`.
 */

import type { ExtensionItem, ExtensionPoint, SearchHit } from '@clerq/gateway-client';
import { useClient } from './client';
import { useResource } from './live';
import { moduleBase } from './modules';

export type Extensions = Record<ExtensionPoint, ExtensionItem[]>;

const EMPTY: Extensions = {
  nav: [],
  'home.tile': [],
  'record.panel': [],
  'record.action': [],
  search: [],
  'inbox.item': [],
  'settings.page': [],
};

export function useExtensions() {
  const client = useClient();
  return useResource(
    'extensions',
    async () => ({ ...EMPTY, ...(await client.extensions()) }) as Extensions,
    { on: ['modules'] }
  );
}

export function useGatewayModules() {
  const client = useClient();
  return useResource('modules', async () => (await client.modules()).modules, { on: ['modules'] });
}

/** `path` with `{ref}` filled in, for a page inside a module's UI. */
export function fillRef(path: string, ref?: string | null): string {
  return ref ? path.split('{ref}').join(encodeURIComponent(ref)) : path;
}

/** The shell route for a path inside a module's UI. */
export function moduleRoute(moduleId: string, path = '/', ref?: string | null): string {
  const inner = fillRef(path, ref).replace(/^\/+/, '');
  return inner ? `${moduleBase(moduleId)}/${inner}` : moduleBase(moduleId);
}

/** The id inside a ref: `core:person:per_1` → `per_1`. */
export function refId(ref: string): string {
  return ref.split(':').slice(2).join(':');
}

/** Where a search hit opens: its module page, or the record view for shared records. */
export function hitRoute(hit: Pick<SearchHit, 'ref' | 'moduleId' | 'path'>): string {
  if (hit.path) return moduleRoute(hit.moduleId, hit.path, hit.ref);
  if (hit.ref.startsWith('core:')) return `/records/${encodeURIComponent(refId(hit.ref))}`;
  return moduleBase(hit.moduleId);
}

/** Extensions that apply to a record of `type` (e.g. "person"); `types` absent means every type. */
export function forRecord(items: ExtensionItem[], type: string): ExtensionItem[] {
  return items
    .filter((i) => !i.types?.length || i.types.includes(`core:${type}`))
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
