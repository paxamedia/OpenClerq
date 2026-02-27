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
}

export type ModuleSource =
  | { type: 'path'; path: string }
  | { type: 'url'; url: string };

export interface ModuleConfigEntry {
  id: string;
  path?: string;
  url?: string;
}
