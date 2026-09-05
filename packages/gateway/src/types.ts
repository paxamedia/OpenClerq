export interface GatewayConfig {
  port?: number;
  /** Interface to bind. Defaults to 127.0.0.1; widen only deliberately. */
  host?: string;
  /** Override the bearer token. Defaults to CLERQ_GATEWAY_TOKEN or ~/.clerq/gateway-token. */
  authToken?: string;
  workspaceDir?: string;
  skillsDir?: string;
  /** Path to clerq-calc binary. */
  calculationEnginePath?: string;
  /** Directory containing pluggable modules (or CLERQ_MODULES_DIR env). */
  modulesDir?: string;
  /** Development conveniences. Does NOT affect authentication. */
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
