/**
 * Module UI slot contract and context.
 * Used by ModuleHost to render bundled or dynamic module UIs.
 */

import type { ComponentType, ReactNode } from 'react';
import type { AppConfig } from './configTypes';

/** Context passed to module UI components. */
export interface ModuleContext {
  gatewayUrl: string;
  config: AppConfig | null;
  onNavigate: (view: string) => void;
  /** Display name from config or manifest. */
  moduleDisplayName: string;
  onBack: () => void;
  onAbout: () => void;
  themeToggle: ReactNode;
}

export type { ModuleState } from './configTypes';

/**
 * Module UI slot: a React component that receives ModuleContext.
 * Bundled modules implement this; dynamic modules load a component that implements it.
 */
export type ModuleUIComponent = ComponentType<{
  moduleDisplayName: string;
  onBack: () => void;
  onAbout: () => void;
  themeToggle: ReactNode;
  /** Optional: for modules that need jurisdiction persistence */
  config?: import('./configTypes').AppConfig | null;
  moduleState?: import('./configTypes').ModuleState;
  onSaveModuleState?: (state: import('./configTypes').ModuleState) => void;
}>;

/**
 * Registry of bundled module UI components (imported at build time).
 * Add entries here for modules shipped with the desktop app.
 */
export type BundledModuleMap = Record<string, ModuleUIComponent>;
