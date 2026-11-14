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
  /**
   * Plugin host overrides. `bundled` lists first-party plugins shipped with the
   * gateway, by id and the checksum they ship with: one found with exactly that
   * checksum is approved when it is first seen. None is bundled yet. Tests pass a
   * `fetch` for `ctx.fetch` and a shorter limit for hooks.
   */
  plugins?: {
    bundled?: Readonly<Record<string, string>>;
    fetch?: typeof fetch;
    hookTimeoutMs?: number;
  };
  /** Development conveniences. Does NOT affect authentication. */
  devMode?: boolean;
  model?: string;
  /** Store location. Defaults to ~/.clerq/clerq.db; tests pass ':memory:'. */
  dbPath?: string;
  /** Optional configuration for built-in generic tools (fs, http, etc.). */
  toolsConfig?: import('./tools.js').ToolConfig;
  /** Automation runner overrides; tests pass a fake driver, forge and vault. */
  automations?: Partial<import('./automations/runner.js').RunnerDeps>;
  /**
   * The agent a managed chat message runs. Default: the builtin driver over the
   * gateway's model registry. Tests pass one with a scripted model.
   */
  chatDriver?: import('@clerq/drivers').Driver;
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
