/**
 * Extension points: what a module adds to the shell, declared in its manifest
 * and rendered by the desktop (and the phone).
 *
 *   "extensions": {
 *     "nav":           [{ "id", "title", "path", "icon"?, "order"? }],
 *     "home.tile":     [{ "id", "title", "path", "size"?: "s" | "m" | "l" }],
 *     "record.panel":  [{ "id", "title", "types": ["core:person"], "path" }],
 *     "record.action": [{ "id", "title", "types", "path"? | "trigger"?, "confirm"? }],
 *     "search":        [{ "id", "title"?, "types"? }],
 *     "inbox.item":    [{ "id", "kind": "approval" | "reply" | "task" | "alert", "title" }],
 *     "settings.page": [{ "id", "title", "path" }]
 *   }
 *
 * A `path` is a path inside the module's UI, which the shell opens at
 * `#/m/<module>/<path>`; in record panels and actions `{ref}` stands for the
 * record's ref. `types` are `<module>:<type>`, e.g. `core:person`, `crm:deal`.
 */

export const EXTENSION_POINTS = [
  'nav',
  'home.tile',
  'record.panel',
  'record.action',
  'search',
  'inbox.item',
  'settings.page',
] as const;

export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

export interface ExtensionItem {
  id: string;
  title?: string;
  path?: string;
  icon?: string;
  order?: number;
  size?: 's' | 'm' | 'l';
  types?: string[];
  trigger?: string;
  confirm?: boolean;
  kind?: 'approval' | 'reply' | 'task' | 'alert';
}

export type Extensions = Record<ExtensionPoint, ExtensionItem[]>;

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const TYPE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$/;
const INBOX_KINDS = new Set(['approval', 'reply', 'task', 'alert']);

/** What each point requires besides `id`. */
const REQUIRED: Record<ExtensionPoint, Array<keyof ExtensionItem>> = {
  nav: ['title', 'path'],
  'home.tile': ['title', 'path'],
  'record.panel': ['title', 'types', 'path'],
  'record.action': ['title', 'types'],
  search: [],
  'inbox.item': ['kind', 'title'],
  'settings.page': ['title', 'path'],
};

export function emptyExtensions(): Extensions {
  return Object.fromEntries(EXTENSION_POINTS.map((p) => [p, []])) as unknown as Extensions;
}

function item(raw: unknown, where: string, warnings: string[]): ExtensionItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${where} should be an object.`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id)) {
    warnings.push(`${where} needs an id of a-z, 0-9, "_" and "-".`);
    return null;
  }
  const out: ExtensionItem = { id: r.id };
  if (typeof r.title === 'string' && r.title.trim()) out.title = r.title.trim();
  if (typeof r.path === 'string') {
    if (r.path.startsWith('/')) out.path = r.path;
    else warnings.push(`${where}.path should start with "/".`);
  }
  if (typeof r.icon === 'string') out.icon = r.icon;
  if (typeof r.order === 'number' && Number.isFinite(r.order)) out.order = r.order;
  if (r.size === 's' || r.size === 'm' || r.size === 'l') out.size = r.size;
  if (Array.isArray(r.types)) {
    out.types = r.types.filter((t): t is string => typeof t === 'string' && TYPE.test(t));
    if (out.types.length !== r.types.length) {
      warnings.push(`${where}.types should be "<module>:<type>" strings.`);
    }
  }
  if (typeof r.trigger === 'string' && ID.test(r.trigger)) out.trigger = r.trigger;
  if (typeof r.confirm === 'boolean') out.confirm = r.confirm;
  if (typeof r.kind === 'string') {
    if (INBOX_KINDS.has(r.kind)) out.kind = r.kind as ExtensionItem['kind'];
    else warnings.push(`${where}.kind should be approval, reply, task or alert.`);
  }
  return out;
}

/** Read `manifest.extensions`, keeping well-formed items and saying what is not. */
export function parseExtensions(manifest: Record<string, unknown>): {
  extensions: Extensions;
  warnings: string[];
} {
  const extensions = emptyExtensions();
  const warnings: string[] = [];
  const raw = manifest.extensions;
  if (raw === undefined) return { extensions, warnings };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { extensions, warnings: ['extensions should be an object.'] };
  }
  for (const [point, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!(EXTENSION_POINTS as readonly string[]).includes(point)) {
      warnings.push(`extensions.${point} is not an extension point.`);
      continue;
    }
    if (!Array.isArray(list)) {
      warnings.push(`extensions.${point} should be a list.`);
      continue;
    }
    const p = point as ExtensionPoint;
    list.forEach((raw, i) => {
      const where = `extensions.${p}[${i}]`;
      const it = item(raw, where, warnings);
      if (!it) return;
      const missing = REQUIRED[p].filter(
        (k) => it[k] === undefined || (k === 'types' && !it.types?.length)
      );
      if (p === 'record.action' && !it.path && !it.trigger) missing.push('path');
      if (missing.length > 0) {
        warnings.push(`${where} needs ${missing.join(', ')}.`);
        return;
      }
      if (extensions[p].some((e) => e.id === it.id)) {
        warnings.push(`${where}: id "${it.id}" is used twice.`);
        return;
      }
      extensions[p].push(it);
    });
  }
  return { extensions, warnings };
}
