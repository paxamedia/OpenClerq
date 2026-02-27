/**
 * Gateway API client — delegates to @clerq/gateway-client.
 * Applies VITE_GATEWAY_URL from Vite env when available.
 */

import {
  setGatewayBaseUrl,
  gateway,
  type HealthResponse,
  type SkillMeta,
  type SkillsResponse,
  type ExplainResponse,
  type TaskResponse,
} from '@clerq/gateway-client';

const viteUrl = (import.meta as unknown as { env?: { VITE_GATEWAY_URL?: string } }).env?.VITE_GATEWAY_URL;
if (viteUrl) setGatewayBaseUrl(viteUrl);

export { setGatewayBaseUrl, gateway };
export type { HealthResponse, SkillMeta, SkillsResponse, ExplainResponse, TaskResponse };
