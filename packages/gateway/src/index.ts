/**
 * Clerq Gateway — local administrative agent runtime
 *
 * The gateway is the control plane for the Clerq agent:
 * - Loads skills from workspace
 * - Routes messages to the AI model (guidance only)
 * - Invokes local Rust calculation engine for deterministic math
 * - Manages subscription/license validation (when used in a hosted context)
 */

export { createGateway } from './gateway.js';
export type { GatewayConfig, GatewayContext } from './types.js';
export {
  loadModulesFromDir,
  mountModuleRoutes,
  getModuleSkillsDirs,
  type ModuleRouteHandler,
  type LoadedModule,
  type ModuleManifestStub,
} from './module-loader.js';
