export interface GatewayConfig {
  port?: number;
  workspaceDir?: string;
  skillsDir?: string;
  /** Path to clerq-calc binary. */
  calculationEnginePath?: string;
  /** Directory containing pluggable modules (or CLERQ_MODULES_DIR env). */
  modulesDir?: string;
  /** Bypass license check when set (e.g. "1", "true") */
  devMode?: boolean;
  model?: string;
  /** Optional configuration for built-in generic tools (fs, http, etc.). */
  toolsConfig?: import('./tools.js').ToolConfig;
}

export interface GatewayContext {
  userId?: string;
  license?: LicenseStatus;
}

export interface LicenseStatus {
  valid: boolean;
  tier: 'starter' | 'professional' | 'business' | 'enterprise' | 'oss';
  expiresAt?: Date;
  gracePeriodHoursRemaining?: number;
}
