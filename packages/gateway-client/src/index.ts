/**
 * Gateway API client for Clerq desktop and modules.
 * Base URL can be overridden via setGatewayBaseUrl (e.g. from saved settings).
 */

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18790';

let gatewayBaseUrl: string = DEFAULT_GATEWAY_URL;
let gatewayToken: string | null = null;
let gatewayTenant: string | null = null;

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

/**
 * Act in one tenant (sent as X-Clerq-Tenant). Null, the default, uses the
 * token's own tenant, or `default` for the gateway token.
 */
export function setGatewayTenant(tenant: string | null): void {
  gatewayTenant = tenant?.trim() || null;
}

export function hasGatewayToken(): boolean {
  return gatewayToken !== null;
}

function authHeaders(): Record<string, string> {
  return {
    ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
    ...(gatewayTenant ? { 'X-Clerq-Tenant': gatewayTenant } : {}),
  };
}

/** A refusal from the gateway, with its status and parsed JSON body when it had one. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> | null
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(getUrl(path), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    throw new GatewayError(`Gateway ${res.status}: ${body || res.statusText}`, res.status, parsed);
  }
  return res.json() as Promise<T>;
}

/** One SSE frame's fields. Comment lines (heartbeats) are skipped. */
function parseFrame(raw: string): { id?: string; event?: string; data?: string } {
  const out: { id?: string; event?: string; data?: string } = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') out.id = value;
    else if (field === 'event') out.event = value;
    else if (field === 'data') out.data = out.data === undefined ? value : `${out.data}\n${value}`;
  }
  return out;
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
  automationName?: string;
  /** The module whose trigger started the run, and which trigger. */
  moduleId?: string;
  triggerId?: string;
  repoId?: string;
  /** The branch an automation run committed to. */
  branch?: string;
  prUrl?: string;
}

export interface ArtifactInfo {
  id: number;
  kind: 'diff' | 'log' | 'file' | 'report';
  name?: string;
  size: number;
  sha256: string;
}

export interface RunDetail extends RunSummary {
  steps: RunStep[];
  artifacts: ArtifactInfo[];
}

export interface DriverInfo {
  id: string;
  available: boolean;
  path?: string;
  version?: string;
  /** Why it cannot run. */
  reason?: string;
}

export interface AutomationSummary {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: string | null;
  nextRunAt: string | null;
  driver: string | null;
  repo: string | null;
  /** Why a spec saved by an earlier release no longer passes; it needs editing. */
  problem: string | null;
  running: boolean;
  monthSpendUsd: number;
  /** The spec's `budget.max_usd_per_month`, or null when it sets none. */
  monthBudgetUsd: number | null;
  /** The next ten times the schedule fires, whether or not the automation is enabled. */
  nextFirings: string[];
  lastRun: {
    id: string;
    status: string;
    exitReason?: string;
    prUrl?: string;
    createdAt: string;
  } | null;
  updatedAt: string;
}

export interface AutomationPreview {
  nextRunAt: string | null;
  nextFirings: string[];
  repo: { path: string; origin?: string | null; project?: string | null; base?: string };
  driver: DriverInfo;
  checks: Array<{ level: 'ok' | 'warning' | 'error'; message: string }>;
  ready: boolean;
}

/** One event from the gateway's bus, as GET /events/stream sends it. */
export interface ClerqEvent<T = unknown> {
  /** `<epoch>-<seq>`; pass the last one seen to resume. */
  id: string;
  /** e.g. `run.started`, `approval.requested`, `module.<id>.<name>`. */
  name: string;
  at: string;
  context: { requestId?: string; sessionId?: string; runId?: string; toolCallId?: string };
  payload: T;
}

export interface EventStreamOptions {
  /** Keep only events whose name starts with one of these, e.g. `['run.', 'approval.']`. */
  names?: string[];
  /** Resume after this event id. */
  lastEventId?: string;
  /** Stops the stream. Without one it runs until the page or process goes away. */
  signal?: AbortSignal;
  /**
   * Events were missed and cannot be replayed (the gateway restarted, or the
   * gap is too old): refetch whatever is shown.
   */
  onReset?: () => void;
  /** The connection is open, the first time and after every reconnect. */
  onOpen?: () => void;
  /** Wait before reconnecting, in ms. Default 3000. */
  retryMs?: number;
}

/** A module the gateway found, as GET /modules lists it. */
export interface ModuleInfo {
  id: string;
  name: string;
  version: string | null;
  dir: string;
  status: 'loaded' | 'failed';
  error: string | null;
  /** Core endpoints its UI token may call, e.g. `GET /runs/:id`. */
  coreEndpoints: string[];
  /** Where its UI is served, e.g. `/api/modules/<id>/ui/`; null without one. */
  ui: string | null;
  badge: string | null;
  /** What the manifest declares it needs. Not enforced. */
  permissions: {
    exec: string[];
    fs: { read: string[]; write: string[] };
    net: string[];
    secrets: string[];
    services: string[];
    llm: boolean;
  };
  /** Parts of `permissions` that were malformed and ignored. */
  permissionWarnings: string[];
  triggers: Array<{
    id: string;
    kind: 'cron' | 'file' | 'webhook';
    schedule?: string;
    path?: string;
    description?: string;
    nextRunAt: string | null;
    running: boolean;
    lastFiredAt: string | null;
  }>;
}

/** The payload of a `notify.posted` event. */
export interface ModuleNotification {
  id: string;
  moduleId: string;
  title: string;
  body?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  /** A path in the module's UI. */
  link?: string;
}

export type CoreRecordType = 'person' | 'organisation' | 'activity';

/** A shared record; `ref` is `core:<type>:<id>`. */
export interface CoreRecord {
  id: string;
  ref: string;
  tenantId: string;
  type: CoreRecordType;
  name: string | null;
  data: Record<string, unknown>;
  emails: string[];
  phones: string[];
  domains: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordLink {
  from: string;
  to: string;
  kind: string;
  createdBy: string | null;
  createdAt: string;
}

export type ExtensionPoint =
  | 'nav'
  | 'home.tile'
  | 'record.panel'
  | 'record.action'
  | 'search'
  | 'inbox.item'
  | 'settings.page';

export interface ExtensionItem {
  moduleId: string;
  id: string;
  title?: string;
  /** A path in the module's UI; the shell opens `#/m/<module>/<path>`. `{ref}` stands for a record's ref. */
  path?: string;
  icon?: string;
  order?: number;
  size?: 's' | 'm' | 'l';
  /** `<module>:<type>`, e.g. `core:person`. */
  types?: string[];
  trigger?: string;
  confirm?: boolean;
  kind?: 'approval' | 'reply' | 'task' | 'alert';
}

export interface SearchHit {
  ref: string;
  moduleId: string;
  type?: string;
  title: string;
  subtitle?: string;
  path?: string;
  score: number;
}

export interface InboxItem {
  /** `apr_<n>` for a pending approval, `inb_…` otherwise. */
  id: string;
  moduleId: string | null;
  externalId: string | null;
  kind: 'approval' | 'reply' | 'task' | 'alert';
  title: string;
  body: string | null;
  ref: string | null;
  link: string | null;
  status: 'open' | 'done' | 'dismissed';
  priority: number;
  dueAt: string | null;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface Approval {
  id: number;
  runId: string;
  tool: string;
  tier: 'low' | 'medium' | 'high';
  reason: string;
  requestedAt: string;
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

export interface ContextPreview {
  systemPrompt: string;
  /** Earlier turns of the session, sent between the system prompt and the user turn. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userContent: string;
  estimatedInputTokens?: number;
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

  /**
   * URL for an EventSource on GET /events/stream. EventSource sends
   * Last-Event-ID itself when it reconnects; `lastEventId` sets where a first
   * connection starts. The token travels as a query parameter, as for logs.
   */
  eventsStreamUrl(opts: { names?: string[]; lastEventId?: string } = {}): string {
    const params = new URLSearchParams();
    if (gatewayToken) params.set('token', gatewayToken);
    if (opts.names?.length) params.set('names', opts.names.join(','));
    if (opts.lastEventId) params.set('lastEventId', opts.lastEventId);
    const query = params.toString();
    return query ? `${getUrl('/events/stream')}?${query}` : getUrl('/events/stream');
  },

  /**
   * Follow GET /events/stream without EventSource (the token goes in a
   * header), reconnecting after a drop and resuming from the last event seen.
   * Resolves when `signal` aborts.
   */
  async streamEvents(onEvent: (event: ClerqEvent) => void, opts: EventStreamOptions = {}) {
    let lastId = opts.lastEventId;
    const retry = opts.retryMs ?? 3000;
    const { signal } = opts;
    while (!signal?.aborted) {
      try {
        const query = opts.names?.length
          ? `?names=${encodeURIComponent(opts.names.join(','))}`
          : '';
        const res = await fetch(getUrl(`/events/stream${query}`), {
          headers: { ...authHeaders(), ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
          signal,
        });
        if (!res.ok || !res.body) throw new GatewayError(`Gateway ${res.status}`, res.status, null);
        opts.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const frame = parseFrame(buffer.slice(0, sep));
            buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
            if (frame.id) lastId = frame.id;
            if (frame.event === 'reset') opts.onReset?.();
            else if (frame.data) onEvent(JSON.parse(frame.data) as ClerqEvent);
          }
        }
      } catch (e) {
        if (signal?.aborted) break;
        // A refused token will not get better by retrying.
        if (e instanceof GatewayError && e.status === 401) throw e;
      }
      if (signal?.aborted) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, retry);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
    }
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
   *
   * Aborting `signal` stops the run on the gateway by id, not just by hanging
   * up: the desktop sidecar runs under Bun, which cannot see a hang-up.
   */
  async sendMessage(
    id: string,
    input: {
      text: string;
      mode?: PipelineMode;
      model?: string;
      /** Finish and record the run even if this client disconnects. */
      continueOnDisconnect?: boolean;
    },
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
    let runId: string | undefined;
    const cancelOnAbort = () => {
      if (runId) void gateway.cancelRun(runId).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancelOnAbort, { once: true });

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
        if (event.type === 'start' && event.runId) runId = event.runId;
        else if (event.type === 'delta' && event.text) onDelta(event.text);
        else if (event.type === 'error') throw new Error(event.error ?? 'The model call failed.');
        else if (event.type === 'done' && event.message) {
          result = { runId: event.runId ?? '', message: event.message };
        }
      }
    };

    try {
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
    } finally {
      signal?.removeEventListener('abort', cancelOnAbort);
    }

    if (!result) throw new Error('The stream ended without an answer.');
    return result;
  },

  compare(
    id: string,
    input: { text: string; models: string[]; continueOnDisconnect?: boolean }
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

  // --- Kill switch ------------------------------------------------------

  /**
   * Stop things now. By default: refuse pending approvals, cancel every run in
   * flight, and pause triggers. Pass false to leave any part out.
   */
  kill(opts: { approvals?: boolean; runs?: boolean; triggers?: boolean } = {}): Promise<{
    ok: boolean;
    deniedApprovals: number;
    cancelledRuns: number;
    triggersPaused: boolean;
  }> {
    return fetchJson('/kill', { method: 'POST', body: JSON.stringify(opts) });
  },

  killStatus(): Promise<{ triggersPaused: boolean; since: string | null; activeRuns: number }> {
    return fetchJson('/kill');
  },

  /** Restart triggers paused by the kill switch. */
  resume(): Promise<{ ok: boolean; triggersResumed: boolean; wasPaused: boolean }> {
    return fetchJson('/resume', { method: 'POST', body: '{}' });
  },

  /** Stop a run in flight. Rejects when the run is not running. */
  cancelRun(id: string): Promise<{ ok: boolean; id: string }> {
    return fetchJson(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  },

  artifact(runId: string, artifactId: number): Promise<ArtifactInfo & { content: string }> {
    return fetchJson(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(String(artifactId))}`
    );
  },

  drivers(): Promise<{ drivers: DriverInfo[] }> {
    return fetchJson('/drivers');
  },

  automations(): Promise<{ automations: AutomationSummary[] }> {
    return fetchJson('/automations');
  },

  automation(id: string): Promise<AutomationSummary & { source: string }> {
    return fetchJson(`/automations/${encodeURIComponent(id)}`);
  },

  /** Check a spec against this machine without saving or running it. */
  previewAutomation(spec: string, id?: string): Promise<AutomationPreview> {
    return fetchJson('/automations/preview', {
      method: 'POST',
      body: JSON.stringify({ spec, id }),
    });
  },

  /** Save a new automation. It starts disabled. */
  createAutomation(spec: string): Promise<AutomationSummary & { source: string }> {
    return fetchJson('/automations', { method: 'POST', body: JSON.stringify({ spec }) });
  },

  updateAutomation(id: string, spec: string): Promise<AutomationSummary & { source: string }> {
    return fetchJson(`/automations/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    });
  },

  deleteAutomation(id: string): Promise<{ ok: boolean }> {
    return fetchJson(`/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationSummary> {
    return fetchJson(`/automations/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
      body: '{}',
    });
  },

  /** Start a run now. Resolves once the run exists; follow it with run(). */
  runAutomation(id: string): Promise<{ runId: string }> {
    return fetchJson(`/automations/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' });
  },

  modules(): Promise<{ modules: ModuleInfo[] }> {
    return fetchJson('/modules');
  },

  /** A short-lived token for a module's UI (default 15 minutes). Needs the gateway token. */
  moduleToken(
    id: string,
    ttlSeconds?: number
  ): Promise<{ token: string; expiresAt: string; scopes: string[] }> {
    return fetchJson(`/modules/${encodeURIComponent(id)}/token`, {
      method: 'POST',
      body: JSON.stringify({ ttlSeconds }),
    });
  },

  revokeModuleTokens(id: string): Promise<{ ok: boolean; revoked: number }> {
    return fetchJson(`/modules/${encodeURIComponent(id)}/tokens`, { method: 'DELETE' });
  },

  /** Fire a module's trigger now. Resolves once its run exists. */
  fireModuleTrigger(
    id: string,
    triggerId: string,
    payload: unknown = {}
  ): Promise<{ runId: string }> {
    return fetchJson(
      `/api/modules/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerId)}`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },

  // --- Shared records, extensions, search, inbox ----------------------

  records(
    opts: { type?: CoreRecordType; q?: string; limit?: number } = {}
  ): Promise<{ records: CoreRecord[] }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) params.set(k, String(v));
    return fetchJson(`/records${params.size ? `?${params}` : ''}`);
  },

  record(id: string): Promise<CoreRecord & { links: RecordLink[] }> {
    return fetchJson(`/records/${encodeURIComponent(id)}`);
  },

  /** Find a person or organisation by email, phone or domain; created unless `create: false`. */
  resolveRecord(input: {
    type: 'person' | 'organisation';
    name?: string;
    emails?: string[];
    phones?: string[];
    domains?: string[];
    create?: boolean;
  }): Promise<{ record: CoreRecord; created: boolean; matchedBy: string[] }> {
    return fetchJson('/records/resolve', { method: 'POST', body: JSON.stringify(input) });
  },

  links(ref: string): Promise<{ links: RecordLink[] }> {
    return fetchJson(`/links?ref=${encodeURIComponent(ref)}`);
  },

  activities(recordId: string, limit = 50): Promise<{ activities: CoreRecord[] }> {
    return fetchJson(`/records/${encodeURIComponent(recordId)}/activities?limit=${limit}`);
  },

  extensions(): Promise<Record<ExtensionPoint, ExtensionItem[]>> {
    return fetchJson('/extensions');
  },

  search(
    q: string,
    opts: { types?: string[]; limit?: number } = {}
  ): Promise<{ results: SearchHit[]; errors: Array<{ moduleId: string; error: string }> }> {
    const params = new URLSearchParams({ q });
    if (opts.types?.length) params.set('types', opts.types.join(','));
    if (opts.limit) params.set('limit', String(opts.limit));
    return fetchJson(`/search?${params}`);
  },

  inbox(
    opts: { status?: InboxItem['status']; kind?: InboxItem['kind']; module?: string } = {}
  ): Promise<{ items: InboxItem[] }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) params.set(k, String(v));
    return fetchJson(`/inbox${params.size ? `?${params}` : ''}`);
  },

  setInboxStatus(id: string, status: InboxItem['status']): Promise<InboxItem> {
    return fetchJson(`/inbox/items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  /** Answer an item; its module acts on it and the item is closed. */
  respondInboxItem(
    id: string,
    response: { text?: string; data?: unknown }
  ): Promise<{ item: InboxItem; result: unknown }> {
    return fetchJson(`/inbox/items/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      body: JSON.stringify(response),
    });
  },

  approvals(): Promise<{ approvals: Approval[] }> {
    return fetchJson('/approvals');
  },

  decideApproval(id: number, decision: 'approve' | 'deny'): Promise<{ ok: boolean }> {
    return fetchJson(`/approvals/${id}/${decision}`, { method: 'POST', body: '{}' });
  },

  /** Newest first. `since` keeps runs created at or after it, and allows up to 5000. */
  runs(limit = 50, opts: { since?: string | Date } = {}): Promise<{ runs: RunSummary[] }> {
    const since = opts.since instanceof Date ? opts.since.toISOString() : (opts.since ?? undefined);
    const query = `limit=${encodeURIComponent(String(limit))}${
      since ? `&since=${encodeURIComponent(since)}` : ''
    }`;
    return fetchJson(`/runs?${query}`);
  },

  run(id: string): Promise<RunDetail> {
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

  capabilities(): Promise<{ fsRoot?: string; httpAllowlist?: string[] }> {
    return fetchJson('/capabilities');
  },

  saveCapabilities(config: {
    fsRoot?: string;
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
    /** Include this chat session's conversation, as a managed turn sends it. */
    sessionId?: string;
  }): Promise<ContextPreview> {
    return fetchJson<ContextPreview>('/context/preview', {
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
