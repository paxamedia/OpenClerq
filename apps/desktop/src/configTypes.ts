/** Shared config types to avoid circular imports. */

export interface ModuleEntry {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
}

export interface ModulePathEntry {
  id: string;
  path?: string;
  url?: string;
}

export interface AppConfig {
  settings?: {
    gatewayUrl?: string;
    defaultModule?: string;
    /** Skills/abilities directory path. Gateway reads from ~/.clerq/config.json. Restart gateway after changing. */
    skillsDir?: string;
    /** Persistent run: manual | auto */
    runMode?: 'manual' | 'auto';
    /** When auto: runs per period (e.g. 1 = once per period). */
    runFrequencyCount?: number;
    /** When auto: hour | day | week | month */
    runFrequencyPeriod?: 'hour' | 'day' | 'week' | 'month';
    /** Message to send when scheduled run triggers (e.g. "Check pending tasks") */
    runTaskMessage?: string;
  };
  modules?: ModuleEntry[];
  modulePaths?: ModulePathEntry[];
  /** Per-module persisted state (client name, etc.) */
  moduleState?: Record<string, ModuleState>;
}

/** Per-module state */
export interface ModuleState {
  /** Current client name for context (e.g. "Working as: Acme Ltd") */
  clientName?: string;
}
