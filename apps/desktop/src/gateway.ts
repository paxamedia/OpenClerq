/**
 * Gateway API client — delegates to @clerq/gateway-client.
 * Applies VITE_GATEWAY_URL from Vite env when available.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  setGatewayBaseUrl,
  setGatewayToken,
  hasGatewayToken,
  gateway,
  type HealthResponse,
  type SkillMeta,
  type SkillsResponse,
  type ExplainResponse,
  type TaskResponse,
} from '@clerq/gateway-client';

const viteUrl = (import.meta as unknown as { env?: { VITE_GATEWAY_URL?: string } }).env?.VITE_GATEWAY_URL;
if (viteUrl) setGatewayBaseUrl(viteUrl);

/**
 * Load the gateway bearer token from ~/.clerq/gateway-token via the Tauri host.
 *
 * The gateway writes this file on first start, so on a cold launch it may not
 * exist yet — callers retry. Every endpoint except /health needs it.
 */
export async function initGatewayAuth(retries = 10, delayMs = 500): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const token = await invoke<string>('gateway_token');
      if (token) {
        setGatewayToken(token);
        return true;
      }
    } catch {
      // Gateway still starting; fall through to the retry delay.
    }
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

export { setGatewayBaseUrl, setGatewayToken, hasGatewayToken, gateway };
export type { HealthResponse, SkillMeta, SkillsResponse, ExplainResponse, TaskResponse };
