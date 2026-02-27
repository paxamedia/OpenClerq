/**
 * ModuleHost — renders a module's UI in a slot.
 * Supports bundled (build-time) and dynamic (runtime) modules.
 */

import type { BundledModuleMap, ModuleUIComponent } from './moduleSlots';
import type { AppConfig, ModuleState } from './configTypes';

export interface ModuleHostProps {
  moduleId: string;
  moduleDisplayName: string;
  onBack: () => void;
  onAbout: () => void;
  themeToggle: React.ReactNode;
  /** Map of module ID -> UI component for bundled modules. */
  bundledComponents: BundledModuleMap;
  /** Fallback when module has no UI (e.g. not implemented yet). */
  FallbackComponent: ModuleUIComponent;
  /** Optional: for modules that need persistence. */
  config?: AppConfig | null;
  moduleState?: ModuleState;
  onSaveModuleState?: (state: ModuleState) => void;
}

/**
 * Renders the UI for the selected module.
 * - Bundled: uses bundledComponents[moduleId]
 * - Dynamic: (future) loads from module path/URL
 */
export function ModuleHost({
  moduleId,
  moduleDisplayName,
  onBack,
  onAbout,
  themeToggle,
  bundledComponents,
  FallbackComponent,
  config,
  moduleState,
  onSaveModuleState,
}: ModuleHostProps) {
  const Component = bundledComponents[moduleId];

  if (Component) {
    return (
      <Component
        moduleDisplayName={moduleDisplayName}
        onBack={onBack}
        onAbout={onAbout}
        themeToggle={themeToggle}
        config={config}
        moduleState={moduleState}
        onSaveModuleState={onSaveModuleState}
      />
    );
  }

  return (
    <FallbackComponent
      moduleDisplayName={moduleDisplayName}
      onBack={onBack}
      onAbout={onAbout}
      themeToggle={themeToggle}
    />
  );
}
