/**
 * Gateway API client for Clerq desktop and modules.
 * Base URL can be overridden via setGatewayBaseUrl (e.g. from saved settings).
 */

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18790';

let gatewayBaseUrl: string = DEFAULT_GATEWAY_URL;

function getUrl(path: string): string {
  const base = gatewayBaseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function setGatewayBaseUrl(baseUrl: string): void {
  gatewayBaseUrl = baseUrl?.trim() || DEFAULT_GATEWAY_URL;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(getUrl(path), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  /** LLM mode: api (cloud) or local (Ollama, LM Studio) */
  llm?: {
    mode: 'api' | 'local';
    provider: string;
    model: string;
    available: boolean;
  };
}

export interface SkillMeta {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  dependsOn?: string[];
}

export interface SkillsResponse {
  skills: SkillMeta[];
  source: string;
}

export interface ExplainResponse {
  explanation: string;
  model: string;
  disclaimer: string;
}

export interface EvalCalcResponse {
  values: Record<string, number>;
  proof: Record<string, unknown>;
}

export interface TaskResponse {
  intent: 'explain';
  skillSlug?: string;
  explanation: string;
  model?: string;
  disclaimer?: string;
  error?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export const gateway = {
  getUrl: () => gatewayBaseUrl,

  health(): Promise<HealthResponse> {
    return fetchJson<HealthResponse>('/health');
  },

  metrics(): Promise<{ version: string; uptime_seconds: number; service: string }> {
    return fetchJson('/metrics');
  },

  logsStreamUrl(): string {
    return getUrl('/logs/stream');
  },

  models(): Promise<{ models: string[]; current: string }> {
    return fetchJson<{ models: string[]; current: string }>('/models');
  },

  secrets(): Promise<{ secrets: string[] } | { error: string }> {
    return fetchJson<{ secrets: string[] } | { error: string }>('/secrets');
  },

  setSecret(name: string, value: string): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, value }),
    });
  },

  async deleteSecret(name: string): Promise<{ ok: boolean }> {
    const res = await fetch(getUrl(`/secrets/${encodeURIComponent(name)}`), { method: 'DELETE' });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `Gateway ${res.status}`);
    }
    return { ok: true };
  },

  triggers(): Promise<{
    cron?: Array<{ id: string; schedule: string; message: string }>;
    file?: Array<{ id: string; path: string; message: string }>;
    webhooks?: Record<string, { message: string }>;
  }> {
    return fetchJson('/triggers');
  },

  saveTriggers(config: {
    cron?: Array<{ id: string; schedule: string; message: string }>;
    file?: Array<{ id: string; path: string; message: string }>;
    webhooks?: Record<string, { message: string }>;
  }): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/triggers', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  systemPrompt(): Promise<{ prompt: string; default: string }> {
    return fetchJson('/system-prompt');
  },

  saveSystemPrompt(prompt: string): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/system-prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  },

  reasoning(): Promise<{ temperature?: number; maxTokens?: number }> {
    return fetchJson('/reasoning');
  },

  saveReasoning(config: { temperature?: number; maxTokens?: number }): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/reasoning', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  capabilities(): Promise<{ fsRoot?: string; fsAllowWrite?: boolean; httpAllowlist?: string[] }> {
    return fetchJson('/capabilities');
  },

  saveCapabilities(config: { fsRoot?: string; fsAllowWrite?: boolean; httpAllowlist?: string[] }): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/capabilities', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  skills(): Promise<SkillsResponse> {
    return fetchJson<SkillsResponse>('/skills');
  },

  skill(slug: string): Promise<{ meta: SkillMeta; body: string }> {
    return fetchJson<{ meta: SkillMeta; body: string }>(`/skills/${encodeURIComponent(slug)}`);
  },

  memory(): Promise<{ entries: Array<{ key: string; value: unknown; createdAt: string }> }> {
    return fetchJson('/memory');
  },

  getMemory(key: string): Promise<{ key: string; value: unknown; createdAt: string }> {
    return fetchJson(`/memory/${encodeURIComponent(key)}`);
  },

  setMemory(key: string, value: unknown): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/memory', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
  },

  async deleteMemory(key: string): Promise<{ ok: boolean }> {
    const res = await fetch(getUrl(`/memory/${encodeURIComponent(key)}`), { method: 'DELETE' });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `Gateway ${res.status}`);
    }
    return { ok: true };
  },

  updateSkill(
    slug: string,
    patch: { inputSchema?: Record<string, unknown> | null; outputSchema?: Record<string, unknown> | null; dependsOn?: string[] | null }
  ): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>(`/skills/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  },

  calculateEval(body: {
    expression?: string;
    inputs?: Record<string, number>;
    spec?: { id?: string; formulas?: Record<string, string>; output_names?: string[] };
  }): Promise<EvalCalcResponse> {
    return fetchJson<EvalCalcResponse>('/calculate/eval', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  filingPrep(body: {
    form_type?: string;
    data?: Record<string, unknown>;
  }): Promise<{ form_type: string; draft: Record<string, unknown>; status: string; note?: string }> {
    return fetchJson('/filing/prep', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  explain(question: string, context?: Record<string, unknown>, model?: string): Promise<ExplainResponse> {
    return fetchJson<ExplainResponse>('/explain', {
      method: 'POST',
      body: JSON.stringify({ question, context, model }),
    });
  },

  contextPreview(body: {
    question?: string;
    context?: Record<string, unknown>;
    skillSlug?: string;
    skillName?: string;
  }): Promise<{ systemPrompt: string; userContent: string; estimatedInputTokens?: number }> {
    return fetchJson<{ systemPrompt: string; userContent: string; estimatedInputTokens?: number }>('/context/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  task(message: string, model?: string, dryRun?: boolean): Promise<TaskResponse> {
    return fetchJson<TaskResponse>('/task', {
      method: 'POST',
      body: JSON.stringify({ message, model, dryRun }),
    });
  },

  tools(): Promise<{ tools: ToolInfo[] }> {
    return fetchJson<{ tools: ToolInfo[] }>('/tools');
  },

  runTool(name: string, input: unknown): Promise<{ name: string; result: unknown }> {
    return fetchJson<{ name: string; result: unknown }>('/tools/run', {
      method: 'POST',
      body: JSON.stringify({ name, input }),
    });
  },
};
