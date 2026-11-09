/**
 * Clerq module manifest schema and types.
 * Used by module loader (desktop + gateway) to validate and load modules.
 */

export interface ModuleManifest {
  /** Unique module identifier (e.g. my-module) */
  id: string;
  /** Machine-readable slug */
  slug: string;
  /** Human-readable module name */
  name: string;
  /** Semantic version or YYYY.Q */
  version: string;
  /** Short description */
  description?: string;
  /** Entry points for UI, routes, task intents */
  entryPoints?: {
    /** Path to UI component (relative to module root) */
    ui?: string;
    /** Paths to route handler files */
    routes?: string[];
    /** Task intent names this module handles */
    taskIntents?: string[];
  };
  /** Capabilities this module provides */
  capabilities?: string[];
  /** Dependencies (e.g. clerq-core: >=0.1.0) */
  dependencies?: Record<string, string>;
  /** Default settings, overlaid with the operator's ~/.clerq/modules/<id>.json. */
  config?: Record<string, unknown>;
  /** Core endpoints the module's UI token may call, e.g. `GET /runs/:id`. */
  coreEndpoints?: string[];
  /** launchd agents the module may start and stop. */
  services?: Array<string | { label: string; name?: string; plist?: string }>;
  /** What the module needs. Declared and shown to the operator; not enforced. */
  permissions?: {
    exec?: string[];
    fs?: { read?: string[]; write?: string[] };
    net?: string[];
    secrets?: string[];
    services?: string[];
    llm?: boolean;
  };
  /** What the module adds to the shell. */
  extensions?: Partial<Record<ExtensionPoint, ManifestExtensionItem[]>>;
}

export type ExtensionPoint =
  | 'nav'
  | 'home.tile'
  | 'record.panel'
  | 'record.action'
  | 'search'
  | 'inbox.item'
  | 'settings.page';

/** One entry at an extension point. `path` is inside the module's UI; `{ref}` is a record's ref. */
export interface ManifestExtensionItem {
  id: string;
  title?: string;
  path?: string;
  icon?: string;
  order?: number;
  size?: 's' | 'm' | 'l';
  /** `<module>:<type>`, e.g. `core:person`. */
  types?: string[];
  trigger?: string;
  confirm?: boolean;
  kind?: 'approval' | 'reply' | 'task' | 'alert';
}

export type ModuleSource = { type: 'path'; path: string } | { type: 'url'; url: string };

export interface ModuleConfigEntry {
  id: string;
  path?: string;
  url?: string;
}
