/**
 * Gateway API client for Clerq desktop and modules.
 * Base URL can be overridden via setGatewayBaseUrl (e.g. from saved settings).
 */

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18790';

let gatewayBaseUrl: string = DEFAULT_GATEWAY_URL;
let gatewayToken: string | null = null;

function getUrl(path: string): string {
  const base = gatewayBaseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function setGatewayBaseUrl(baseUrl: string): void {
  gatewayBaseUrl = baseUrl?.trim() || DEFAULT_GATEWAY_URL;
}

/**
 * Set the bearer token sent with every request. Read from ~/.clerq/gateway-token
 * by the host application; every endpoint except /health requires it.
 */
export function setGatewayToken(token: string | null): void {
  gatewayToken = token?.trim() || null;
}

export function hasGatewayToken(): boolean {
  return gatewayToken !== null;
}

function authHeaders(): Record<string, string> {
  return gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {};
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(getUrl(path), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options?.headers },
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

export interface ProviderInfo {
  id: string;
  label: string;
  /** True when the provider runs on this machine and needs no key. */
  local: boolean;
  ready: boolean;
  /** Why the provider is not ready, e.g. "Set DEEPSEEK_API_KEY". */
  reason?: string;
  defaultModel: string | null;
  models: Array<{
    id: string;
    /** Qualified reference to pass as `model`, e.g. "deepseek/deepseek-chat". */
    ref: string;
    context?: number;
    inputPerM?: number;
    outputPerM?: number;
  }>;
}

export interface RunStep {
  seq: number;
  kind: 'llm' | 'shell' | 'fs' | 'git' | 'gate' | 'tool';
  input?: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** US dollars; null when the model has no price in the registry. */
  costUsd?: number | null;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  status: string;
  trigger: 'schedule' | 'event' | 'manual' | 'webhook';
  automationId?: string;
  input?: string;
  exitReason?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  /** Sum of priced model calls — a lower bound when `costKnown` is false. */
  costUsd: number;
  costKnown: boolean;
  tokensIn: number;
  tokensOut: number;
}

export type PipelineMode = 'raw' | 'managed';

export interface ChatSession {
  id: string;
  title: string | null;
  mode: PipelineMode;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ComparisonColumn {
  model: string;
  provider?: string;
  text?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
  latencyMs?: number;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Provider, model, tokens, cost, the request body, and comparison columns. */
  meta?: {
    mode?: PipelineMode | 'compare';
    provider?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    usageReported?: boolean;
    costUsd?: number | null;
    latencyMs?: number;
    request?: unknown;
    runId?: string;
    chosen?: number | null;
    columns?: ComparisonColumn[];
    [key: string]: unknown;
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

  metrics(): Promise<{
    version: string;
    uptime_seconds: number;
    service: string;
    llm_cost_usd_total?: number;
    llm_unpriced_calls_total?: number;
  }> {
    return fetchJson('/metrics');
  },

  /**
   * SSE endpoint URL. EventSource cannot set headers, so the token travels as a
   * query parameter — accepted by the gateway on this endpoint only.
   */
  logsStreamUrl(): string {
    const url = getUrl('/logs/stream');
    return gatewayToken ? `${url}?token=${encodeURIComponent(gatewayToken)}` : url;
  },

  models(): Promise<{ models: string[]; current: string }> {
    return fetchJson<{ models: string[]; current: string }>('/models');
  },

  /** Every provider in the registry, with readiness and qualified model references. */
  providers(): Promise<{
    providers: ProviderInfo[];
    current: { provider: string; model: string };
  }> {
    return fetchJson('/providers');
  },

  // --- Chat console -----------------------------------------------------

  sessions(limit = 50): Promise<{ sessions: ChatSession[] }> {
    return fetchJson(`/sessions?limit=${encodeURIComponent(String(limit))}`);
  },

  createSession(
    input: { title?: string; mode?: PipelineMode; model?: string } = {}
  ): Promise<ChatSession> {
    return fetchJson('/sessions', { method: 'POST', body: JSON.stringify(input) });
  },

  session(id: string): Promise<ChatSession & { messages: ChatMessage[] }> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}`);
  },

  updateSession(
    id: string,
    patch: { title?: string; mode?: PipelineMode; model?: string | null }
  ): Promise<ChatSession> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  deleteSession(id: string): Promise<{ ok: boolean }> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /**
   * Send a message and stream the answer.
   *
   * EventSource cannot POST, so this reads the response body directly. `onDelta`
   * is called with each piece; the promise resolves with the stored message.
   */
  async sendMessage(
    id: string,
    input: { text: string; mode?: PipelineMode; model?: string },
    onDelta?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<{ runId: string; message: ChatMessage }> {
    const res = await fetch(getUrl(`/sessions/${encodeURIComponent(id)}/send`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...input, stream: Boolean(onDelta) }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gateway ${res.status}: ${body || res.statusText}`);
    }
    if (!onDelta) return (await res.json()) as { runId: string; message: ChatMessage };
    if (!res.body) throw new Error('Gateway returned an empty stream.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: { runId: string; message: ChatMessage } | undefined;

    const handle = (frame: string): void => {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as {
          type: string;
          text?: string;
          error?: string;
          runId?: string;
          message?: ChatMessage;
        };
        if (event.type === 'delta' && event.text) onDelta(event.text);
        else if (event.type === 'error') throw new Error(event.error ?? 'The model call failed.');
        else if (event.type === 'done' && event.message) {
          result = { runId: event.runId ?? '', message: event.message };
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        handle(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    if (buffer.trim()) handle(buffer);

    if (!result) throw new Error('The stream ended without an answer.');
    return result;
  },

  compare(
    id: string,
    input: { text: string; models: string[] }
  ): Promise<{ runId: string; messageId: number; columns: ComparisonColumn[] }> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}/compare`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  promote(id: string, messageId: number, index: number): Promise<ChatMessage> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      body: JSON.stringify({ messageId, index }),
    });
  },

  runs(limit = 50): Promise<{ runs: RunSummary[] }> {
    return fetchJson(`/runs?limit=${encodeURIComponent(String(limit))}`);
  },

  run(id: string): Promise<RunSummary & { steps: RunStep[] }> {
    return fetchJson(`/runs/${encodeURIComponent(id)}`);
  },

  secrets(): Promise<
    | { secrets: string[]; keySource: 'env' | 'keychain' | 'file' | 'none'; keychain: string }
    | { error: string }
  > {
    return fetchJson('/secrets');
  },

  setSecret(name: string, value: string): Promise<{ ok: boolean }> {
    return fetchJson<{ ok: boolean }>('/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, value }),
    });
  },

  async deleteSecret(name: string): Promise<{ ok: boolean }> {
    const res = await fetch(getUrl(`/secrets/${encodeURIComponent(name)}`), {
      method: 'DELETE',
      headers: authHeaders(),
    });
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

  saveCapabilities(config: {
    fsRoot?: string;
    fsAllowWrite?: boolean;
    httpAllowlist?: string[];
  }): Promise<{ ok: boolean }> {
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
    patch: {
      inputSchema?: Record<string, unknown> | null;
      outputSchema?: Record<string, unknown> | null;
      dependsOn?: string[] | null;
    }
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

  filingPrep(body: { form_type?: string; data?: Record<string, unknown> }): Promise<{
    form_type: string;
    draft: Record<string, unknown>;
    status: string;
    note?: string;
  }> {
    return fetchJson('/filing/prep', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  explain(
    question: string,
    context?: Record<string, unknown>,
    model?: string
  ): Promise<ExplainResponse> {
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
    return fetchJson<{ systemPrompt: string; userContent: string; estimatedInputTokens?: number }>(
      '/context/preview',
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
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
