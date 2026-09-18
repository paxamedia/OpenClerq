import express, { Request, Response } from 'express';
import fssync from 'node:fs';
import type { Server } from 'node:http';
import type { GatewayConfig } from './types.js';
import { licenseCheck } from './middleware/license.js';
import { requireAuth, resolveGatewayToken } from './security/auth.js';
import { logger } from './logger.js';
import { getCalcBinaryPath, runEvalCalc } from './calc.js';
import {
  getSkillsDir,
  loadSkillsFromDir,
  loadSkillContent,
  saveSkillFrontmatter,
} from './skills-loader.js';
import { getExplanation, buildContextPreview } from './agent/explain.js';
import { getLLMProviderStatus, getAvailableModels, listProviders } from './agent/llm-provider.js';
import { runTask } from './agent/task.js';
import { selectSkill } from './agent/skill-selector.js';
import { loadModulesFromDir, mountModuleRoutes, getModuleSkillsDirs } from './module-loader.js';
import { createToolRegistry } from './tools.js';
import {
  loadCapabilities,
  saveCapabilities,
  capabilitiesToToolConfig,
  type CapabilitiesConfig,
} from './capabilities.js';
import { loadReasoning, saveReasoning, type ReasoningConfig } from './reasoning-config.js';
import { loadSystemPrompt, saveSystemPrompt, DEFAULT_PROMPT } from './system-prompt.js';
import { getObservability } from './observability.js';
import { getLogBuffer, subscribe, type LogEntry } from './log-stream.js';
import { listSecrets, setSecret, deleteSecret, vaultKeyStatus } from './secrets-vault.js';
import {
  startTriggers,
  stopTriggers,
  getTriggers,
  saveTriggers,
  getWebhookMessage,
  markTriggerFired,
  TriggerConfigError,
  type TriggerSource,
} from './triggers.js';
import { listMemory, getMemory, setMemory, deleteMemory, searchMemory } from './memory-layer.js';
import { initStore } from './store.js';
import {
  recordRun,
  listRuns,
  getRun,
  currentRunId,
  cancelRun,
  cancelAllRuns,
  activeRunIds,
} from './runs.js';
import { emit, subscribeEvents, recentEvents } from './events.js';
import { listPending, decide, denyAllPending } from './approvals.js';
import {
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  listMessages,
  SessionError,
} from './chat/sessions.js';
import {
  sendMessage,
  validateSend,
  compare,
  promote,
  type ManagedPipeline,
} from './chat/console.js';

const DEFAULT_PORT = 18790;

/**
 * Origins allowed to call the gateway from a browser context: the Vite dev server
 * and the Tauri webview on each platform. Override with CLERQ_CORS_ORIGINS.
 */
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'tauri://localhost',
  'http://tauri.localhost',
].join(',');

/** Single source of truth for the version reported over the API. */
export const GATEWAY_VERSION = '0.5.0';

/**
 * A provider problem — no key, unreachable endpoint, vendor error — is a
 * service being unavailable, not a gateway fault.
 */
function isProviderError(e: unknown): boolean {
  return (e as { code?: unknown })?.code === 'provider_error';
}

/**
 * A run that was stopped on purpose — kill switch, or the client hanging up —
 * answers 409, distinct from the 503 a provider failure gets.
 */
function isCancelled(e: unknown): boolean {
  return (e as { cancelled?: unknown })?.cancelled === true;
}

function cancelledResponse(res: Response, e: unknown): Response {
  return res.status(409).json({
    error: 'run_cancelled',
    message: e instanceof Error ? e.message : 'The run was cancelled.',
  });
}

/**
 * A signal that aborts when the client goes away before its response is
 * complete, so a model call nobody is waiting for stops — and stops costing.
 *
 * A caller that wants the work finished regardless sends
 * `continueOnDisconnect: true` and reads the outcome from GET /runs/:id later.
 *
 * This works under Node. Under Bun — the compiled desktop sidecar — nothing
 * signals a hang-up once the request body has been read: no event fires and
 * no state changes (verified on Bun 1.3.10). So a client should not rely on
 * hanging up alone; the streamed answer names its run first, and
 * POST /runs/:id/cancel stops it on any runtime.
 */
function disconnectSignal(res: Response, continueOnDisconnect: unknown): AbortSignal | undefined {
  if (continueOnDisconnect === true) return undefined;
  const controller = new AbortController();
  res.on('close', () => {
    // 'close' also fires after a normal finish; only an early close is a hang-up.
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

export function createGateway(config: GatewayConfig = {}): {
  app: express.Express;
  server: Server;
} {
  const port = config.port ?? DEFAULT_PORT;
  // Loopback unless an operator deliberately opts out. Binding a wider interface
  // exposes tool execution to the network and is gated on explicit configuration.
  const host = config.host ?? process.env.CLERQ_HOST ?? '127.0.0.1';
  const devMode =
    config.devMode ?? (process.env.CLERQ_DEV === '1' || process.env.CLERQ_DEV === 'true');
  // Authentication is not optional and has no dev bypass. Licensing is separate.
  const auth = config.authToken
    ? { token: config.authToken, source: 'config' as const }
    : resolveGatewayToken();
  const skillsDir = config.skillsDir ?? getSkillsDir();
  const calcPath = config.calculationEnginePath ?? getCalcBinaryPath();
  const initialToolsConfig = config.toolsConfig ?? capabilitiesToToolConfig(loadCapabilities());
  let toolRegistry = createToolRegistry(initialToolsConfig);

  const app = express();
  let loadedModules: Awaited<ReturnType<typeof loadModulesFromDir>> = [];

  // Origins are reflected only when explicitly allow-listed. There is no wildcard
  // path: a wildcard lets any page the user visits drive their local gateway.
  const corsOrigins = new Set(
    (process.env.CLERQ_CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && corsOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Clerq-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // Body limit: an unbounded JSON parser is a trivial memory exhaustion vector.
  app.use(express.json({ limit: process.env.CLERQ_MAX_BODY ?? '1mb' }));
  app.use(requireAuth(auth.token));
  app.use(licenseCheck(devMode));

  app.get('/health', (_req, res) => {
    const llmStatus = getLLMProviderStatus();
    res.json({
      status: 'ok',
      service: 'clerq-gateway',
      version: GATEWAY_VERSION,
      llm: {
        mode: llmStatus.mode,
        provider: llmStatus.provider,
        model: llmStatus.model,
        available: llmStatus.available,
      },
    });
  });

  const startTime = Date.now();
  app.get('/models', async (_req, res) => {
    try {
      const [models, status] = await Promise.all([
        getAvailableModels(),
        Promise.resolve(getLLMProviderStatus()),
      ]);
      res.json({ models, current: status.model });
    } catch (e) {
      logger.error('models list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'models_list_failed' });
    }
  });

  app.get('/providers', (_req, res) => {
    try {
      const status = getLLMProviderStatus();
      res.json({
        providers: listProviders(),
        current: { provider: status.provider, model: status.model },
      });
    } catch (e) {
      // Most likely an invalid ~/.clerq/providers.yaml; the message says which line.
      const message = e instanceof Error ? e.message : String(e);
      logger.error('providers list error', { err: message });
      res.status(500).json({ error: 'providers_list_failed', message });
    }
  });

  app.get('/secrets', (_req, res) => {
    const result = listSecrets();
    if (Array.isArray(result)) {
      // Names only — values never leave the vault through this endpoint. The
      // key's location is reported so an operator can see it is not in an
      // environment variable.
      const { source, backend } = vaultKeyStatus();
      res.json({ secrets: result, keySource: source, keychain: backend });
    } else {
      res.status(503).json(result);
    }
  });

  app.post('/secrets', (req: Request, res: Response) => {
    const body = req.body as { name?: string; value?: string };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const value = typeof body?.value === 'string' ? body.value : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const out = setSecret(name, value);
    if (out.ok) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: out.error });
    }
  });

  app.get('/capabilities', (_req, res) => {
    res.json(loadCapabilities());
  });

  app.get('/system-prompt', (_req, res) => {
    res.json({ prompt: loadSystemPrompt(), default: DEFAULT_PROMPT });
  });

  app.post('/system-prompt', (req: Request, res: Response) => {
    const body = req.body as { prompt?: string };
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    try {
      saveSystemPrompt(prompt);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  app.get('/reasoning', (_req, res) => {
    res.json(loadReasoning());
  });

  app.post('/reasoning', (req: Request, res: Response) => {
    const body = req.body as Partial<ReasoningConfig>;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid config' });
    }
    try {
      const current = loadReasoning();
      const c: ReasoningConfig = { ...current };
      if (body.temperature !== undefined) {
        c.temperature =
          typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2
            ? body.temperature
            : undefined;
      }
      if (body.maxTokens !== undefined) {
        c.maxTokens =
          typeof body.maxTokens === 'number' && body.maxTokens >= 1 && body.maxTokens <= 128000
            ? body.maxTokens
            : undefined;
      }
      saveReasoning(c);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  app.post('/capabilities', (req: Request, res: Response) => {
    const body = req.body as CapabilitiesConfig;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid config' });
    }
    try {
      const positive = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
      const c: CapabilitiesConfig = {
        fsRoot: typeof body.fsRoot === 'string' ? body.fsRoot : undefined,
        fsMaxReadBytes: positive(body.fsMaxReadBytes),
        httpAllowlist: Array.isArray(body.httpAllowlist)
          ? body.httpAllowlist.filter((h): h is string => typeof h === 'string')
          : undefined,
        httpAllowedSchemes: Array.isArray(body.httpAllowedSchemes)
          ? body.httpAllowedSchemes.filter((h): h is string => typeof h === 'string')
          : undefined,
        httpMaxBytes: positive(body.httpMaxBytes),
        httpTimeoutMs: positive(body.httpTimeoutMs),
        httpAllowPrivateAddresses:
          typeof body.httpAllowPrivateAddresses === 'boolean'
            ? body.httpAllowPrivateAddresses
            : undefined,
      };
      saveCapabilities(c);
      toolRegistry = createToolRegistry(capabilitiesToToolConfig(loadCapabilities()));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  app.delete('/secrets/:name', (req: Request, res: Response) => {
    const name = (typeof req.params?.name === 'string' ? req.params.name : '') || '';
    const out = deleteSecret(name);
    if (out.ok) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: out.error });
    }
  });

  app.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (entry: LogEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    getLogBuffer().forEach(send);
    const unsub = subscribe(send);
    req.on('close', unsub);
  });

  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
      version: GATEWAY_VERSION,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      service: 'clerq-gateway',
      ...getObservability(),
    });
  });

  app.get('/tools', (_req, res) => {
    try {
      const tools = toolRegistry.list();
      res.json({ tools });
    } catch (e) {
      logger.error('tools list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'tools_list_failed' });
    }
  });

  app.post('/tools/run', async (req: Request, res: Response) => {
    const body = req.body as { name?: string; input?: unknown };
    const name = body?.name;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'tool_name_required' });
    }
    try {
      const result = await toolRegistry.run(name, body.input);
      res.json({ name, result });
    } catch (e) {
      logger.error('tools run error', { name, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({
        error: 'tool_run_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.get('/skills', async (_req, res) => {
    try {
      const skills = await loadSkillsFromDir(skillsDir);
      const moduleSkillsDirs = getModuleSkillsDirs(loadedModules);
      for (const dir of moduleSkillsDirs) {
        const fromModule = await loadSkillsFromDir(dir);
        const seen = new Set(skills.map((s) => s.slug));
        for (const s of fromModule) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            skills.push(s);
          }
        }
      }
      if (skills.length === 0) {
        return res.json({
          skills: [
            {
              slug: 'example',
              name: 'Example',
              description:
                'Add skills in your skills directory. See skills/example for a template.',
            },
          ],
          source: 'fallback',
        });
      }
      res.json({ skills, source: moduleSkillsDirs.length > 0 ? 'disk+modules' : 'disk' });
    } catch (e) {
      logger.error('skills load error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'skills_load_failed' });
    }
  });

  app.get('/skills/:slug', async (req: Request, res: Response) => {
    const slug = typeof req.params?.slug === 'string' ? req.params.slug : '';
    if (!slug) return res.status(400).json({ error: 'slug required' });
    try {
      const content = await loadSkillContent(skillsDir, slug);
      if (!content) return res.status(404).json({ error: 'skill_not_found', slug });
      res.json({ meta: content.meta, body: content.body });
    } catch (e) {
      logger.error('skill load error', { slug, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'skill_load_failed' });
    }
  });

  app.put('/skills/:slug', async (req: Request, res: Response) => {
    const slug = typeof req.params?.slug === 'string' ? req.params.slug : '';
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const body = req.body as {
      inputSchema?: Record<string, unknown> | null;
      outputSchema?: Record<string, unknown> | null;
      dependsOn?: string[] | null;
    };
    try {
      const ok = await saveSkillFrontmatter(skillsDir, slug, {
        inputSchema: body.inputSchema,
        outputSchema: body.outputSchema,
        dependsOn: body.dependsOn,
      });
      if (!ok) return res.status(404).json({ error: 'skill_not_found', slug });
      res.json({ ok: true });
    } catch (e) {
      logger.error('skill save error', { slug, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'skill_save_failed' });
    }
  });

  app.get('/memory', (_req, res) => {
    try {
      const entries = listMemory();
      res.json({ entries });
    } catch (e) {
      logger.error('memory list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_list_failed' });
    }
  });

  app.get('/memory/:key', (req: Request, res: Response) => {
    const key = typeof req.params?.key === 'string' ? req.params.key : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const entry = getMemory(key);
      if (!entry) return res.status(404).json({ error: 'memory_not_found', key });
      res.json(entry);
    } catch (e) {
      logger.error('memory get error', { key, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_get_failed' });
    }
  });

  app.post('/memory', (req: Request, res: Response) => {
    const body = req.body as { key?: string; value?: unknown };
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      setMemory(key, body.value);
      res.json({ ok: true });
    } catch (e) {
      logger.error('memory set error', { key, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_set_failed' });
    }
  });

  app.delete('/memory/:key', (req: Request, res: Response) => {
    const key = typeof req.params?.key === 'string' ? req.params.key : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const ok = deleteMemory(key);
      if (!ok) return res.status(404).json({ error: 'memory_not_found', key });
      res.json({ ok: true });
    } catch (e) {
      logger.error('memory delete error', { key, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_delete_failed' });
    }
  });

  app.get('/approvals', (_req: Request, res: Response) => {
    try {
      res.json({ approvals: listPending() });
    } catch (e) {
      logger.error('approvals list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'approvals_list_failed' });
    }
  });

  const decideRoute = (verdict: 'approved' | 'denied') => (req: Request, res: Response) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });
    const body = (req.body ?? {}) as { by?: string; reason?: string };
    try {
      const ok = decide(id, {
        decision: verdict,
        decidedBy: typeof body.by === 'string' ? body.by : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      if (!ok) {
        return res.status(404).json({ error: 'approval_not_pending', id });
      }
      res.json({ ok: true, id, decision: verdict });
    } catch (e) {
      logger.error('approval decide error', {
        id,
        err: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ error: 'approval_decide_failed' });
    }
  };

  app.post('/approvals/:id/approve', decideRoute('approved'));
  app.post('/approvals/:id/deny', decideRoute('denied'));

  /**
   * Kill switch: stop everything and refuse every pending approval.
   * Required by SECURITY.md, and reachable from any client.
   */
  /**
   * The kill switch. By default it does all three: refuses every pending
   * approval, cancels every run in flight (their model calls stop mid-stream
   * and the runs are recorded as cancelled), and pauses triggers so nothing new
   * starts on its own. Any part can be left out — `{ "triggers": false }` stops
   * what is running without pausing the schedule.
   *
   * Triggers stay paused until POST /resume, or a restart. A person can still
   * run tasks by hand while they are paused.
   */
  let triggersPausedAt: string | null = null;

  app.get('/kill', (_req: Request, res: Response) => {
    res.json({
      triggersPaused: triggersPausedAt !== null,
      since: triggersPausedAt,
      activeRuns: activeRunIds().length,
    });
  });

  app.post('/kill', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { approvals?: boolean; runs?: boolean; triggers?: boolean };
    try {
      const deniedApprovals = body.approvals === false ? 0 : denyAllPending('Kill switch engaged');
      const cancelledRuns = body.runs === false ? 0 : cancelAllRuns('Kill switch engaged');
      let triggersPaused = triggersPausedAt !== null;
      if (body.triggers !== false) {
        stopTriggers();
        triggersPausedAt ??= new Date().toISOString();
        triggersPaused = true;
      }
      emit('kill.engaged', { deniedApprovals, cancelledRuns, triggersPaused });
      logger.warn('Kill switch engaged', { deniedApprovals, cancelledRuns, triggersPaused });
      res.json({ ok: true, deniedApprovals, cancelledRuns, triggersPaused });
    } catch (e) {
      logger.error('kill switch error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'kill_failed' });
    }
  });

  app.post('/resume', (_req: Request, res: Response) => {
    try {
      const wasPaused = triggersPausedAt !== null;
      triggersPausedAt = null;
      startTriggers(runTriggered);
      emit('kill.released', { wasPaused });
      logger.info('Triggers resumed', { wasPaused });
      res.json({ ok: true, triggersResumed: true, wasPaused });
    } catch (e) {
      logger.error('resume error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'resume_failed' });
    }
  });

  app.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    for (const e of recentEvents(100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const unsub = subscribeEvents((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', unsub);
  });

  // ---------------------------------------------------------------------
  // Chat console. A message is a run; the console is one client of these
  // endpoints, not their definition — `clerq chat` will be another.
  // ---------------------------------------------------------------------

  /** Chat problems are the caller's mistake (400) unless something else broke. */
  function chatError(res: Response, e: unknown, code: string): Response {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof SessionError)
      return res.status(400).json({ error: 'invalid_session', message });
    if (isCancelled(e)) return cancelledResponse(res, e);
    if (isProviderError(e)) {
      return res.status(503).json({ error: 'ai_unavailable', message: message.slice(0, 200) });
    }
    logger.error(code, { err: message });
    return res.status(500).json({ error: code });
  }

  app.get('/sessions', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query?.limit ?? 50) || 50, 500);
    try {
      res.json({ sessions: listSessions(limit) });
    } catch (e) {
      return chatError(res, e, 'sessions_list_failed');
    }
  });

  app.post('/sessions', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { title?: string; mode?: unknown; model?: string };
    try {
      res.status(201).json(createSession(body));
    } catch (e) {
      return chatError(res, e, 'session_create_failed');
    }
  });

  app.get('/sessions/:id', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    try {
      const session = getSession(id);
      if (!session) return res.status(404).json({ error: 'session_not_found', id });
      res.json({ ...session, messages: listMessages(id) });
    } catch (e) {
      return chatError(res, e, 'session_get_failed');
    }
  });

  app.post('/sessions/:id/update', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    try {
      const session = updateSession(id, (req.body ?? {}) as { title?: string; mode?: unknown });
      if (!session) return res.status(404).json({ error: 'session_not_found', id });
      res.json(session);
    } catch (e) {
      return chatError(res, e, 'session_update_failed');
    }
  });

  app.delete('/sessions/:id', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    try {
      if (!deleteSession(id)) return res.status(404).json({ error: 'session_not_found', id });
      res.json({ ok: true });
    } catch (e) {
      return chatError(res, e, 'session_delete_failed');
    }
  });

  /**
   * Send a message. Streams by default: the answer arrives as it is generated,
   * then a final event carries the stored message with its tokens and cost.
   * Pass stream: false for a single JSON response.
   */
  app.post('/sessions/:id/send', async (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as {
      text?: string;
      mode?: unknown;
      model?: string;
      stream?: boolean;
      continueOnDisconnect?: boolean;
    };
    const streaming = body.stream !== false;
    const input = { sessionId: id, text: body.text ?? '', mode: body.mode, model: body.model };

    // Refuse a bad request with a status code before any stream is opened or
    // anything is spent.
    try {
      validateSend(input);
    } catch (e) {
      return chatError(res, e, 'session_send_failed');
    }
    const signal = disconnectSignal(res, body.continueOnDisconnect);

    const managed: ManagedPipeline = async (message, model) => {
      const result = await runTaskFromContext(message, model);
      return {
        explanation: result.explanation,
        model: result.model,
        skillSlug: result.skillSlug,
      };
    };

    if (!streaming) {
      try {
        const result = await sendMessage({ ...input, managed, signal });
        return res.json(result);
      } catch (e) {
        return chatError(res, e, 'session_send_failed');
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (event: Record<string, unknown>) => {
      // After a hang-up there is nobody to write to.
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await sendMessage({
        ...input,
        managed,
        signal,
        // The run id comes first, so the client can cancel by id.
        onStart: (runId) => send({ type: 'start', runId }),
        onDelta: (text) => send({ type: 'delta', text }),
      });
      send({ type: 'done', ...result });
    } catch (e) {
      // The stream has already been accepted, so the failure is an event on it
      // rather than a status code.
      send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    if (!res.writableEnded) res.end();
  });

  app.post('/sessions/:id/compare', async (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as {
      text?: string;
      models?: unknown;
      continueOnDisconnect?: boolean;
    };
    try {
      res.json(
        await compare({
          sessionId: id,
          text: body.text ?? '',
          models: body.models,
          signal: disconnectSignal(res, body.continueOnDisconnect),
        })
      );
    } catch (e) {
      return chatError(res, e, 'session_compare_failed');
    }
  });

  app.post('/sessions/:id/promote', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as { messageId?: number; index?: number };
    try {
      res.json(promote(id, Number(body.messageId), Number(body.index)));
    } catch (e) {
      return chatError(res, e, 'session_promote_failed');
    }
  });

  app.get('/runs', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query?.limit ?? 50) || 50, 500);
    try {
      res.json({ runs: listRuns(limit) });
    } catch (e) {
      logger.error('runs list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'runs_list_failed' });
    }
  });

  /** Stop one run. Works on every runtime, unlike detecting a hang-up. */
  app.post('/runs/:id/cancel', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    if (!cancelRun(id, 'Cancelled by request')) {
      return res.status(404).json({ error: 'run_not_active', id });
    }
    res.json({ ok: true, id });
  });

  app.get('/runs/:id', (req: Request, res: Response) => {
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const run = getRun(id);
      if (!run) return res.status(404).json({ error: 'run_not_found', id });
      res.json(run);
    } catch (e) {
      logger.error('run get error', { id, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'run_get_failed' });
    }
  });

  app.post('/calculate/eval', async (req: Request, res: Response) => {
    if (!fssync.existsSync(calcPath)) {
      return res.status(503).json({
        error: 'calculation_engine_unavailable',
        message: 'Arithmetic engine not built. Run: pnpm build:core',
        path: calcPath,
      });
    }
    const body = req.body as {
      expression?: string;
      inputs?: Record<string, number>;
      spec?: { id?: string; formulas?: Record<string, string>; output_names?: string[] };
    };
    if (!body.expression && !body.spec?.formulas) {
      return res.status(400).json({ error: 'expression or spec.formulas required' });
    }
    try {
      const spec = body.spec?.formulas ? { ...body.spec, formulas: body.spec.formulas } : undefined;
      const result = await runEvalCalc(
        {
          expression: body.expression,
          inputs: body.inputs,
          spec,
        },
        calcPath
      );
      res.json(result);
    } catch (e) {
      logger.error('calc eval error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({
        error: 'calculation_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.post('/explain', async (req: Request, res: Response) => {
    const body = req.body as {
      question?: string;
      context?: Record<string, unknown>;
      model?: string;
      continueOnDisconnect?: boolean;
    };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }
    try {
      const result = await getExplanation({
        question,
        context: body.context,
        model: typeof body.model === 'string' ? body.model : undefined,
        signal: disconnectSignal(res, body.continueOnDisconnect),
      });
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isCancelled(e)) return cancelledResponse(res, e);
      if (isProviderError(e)) {
        return res.status(503).json({
          error: 'ai_unavailable',
          message: msg.slice(0, 200),
        });
      }
      logger.error('explain error', { err: msg });
      res.status(500).json({
        error: 'explain_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.post('/context/preview', (req: Request, res: Response) => {
    const body = req.body as {
      question?: string;
      context?: Record<string, unknown>;
      skillSlug?: string;
      skillName?: string;
    };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    try {
      const preview = buildContextPreview({
        question: question || '(no question)',
        context: body.context,
        skillSlug: body.skillSlug,
        skillName: body.skillName,
      });
      res.json(preview);
    } catch (e) {
      logger.error('context preview error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'context_preview_failed' });
    }
  });

  app.post('/filing/prep', async (req: Request, res: Response) => {
    const body = req.body as { form_type?: string; data?: Record<string, unknown> };
    const formType = body.form_type ?? 'generic';
    const data = body.data ?? {};
    res.json({
      form_type: formType,
      draft: { ...data, _prepared_at: new Date().toISOString() },
      status: 'draft',
      note: 'Draft only; user submits manually.',
    });
  });

  app.post('/webhook/:id', async (req: Request, res: Response) => {
    const id = (typeof req.params?.id === 'string' ? req.params.id : '') || '';
    if (triggersPausedAt !== null) {
      return res.status(503).json({
        error: 'triggers_paused',
        message: 'Triggers are paused by the kill switch. POST /resume to resume them.',
      });
    }
    const message = getWebhookMessage(id);
    if (!message) {
      return res.status(404).json({ error: 'webhook not found' });
    }
    const body = req.body as { message?: string };
    const override = typeof body?.message === 'string' ? body.message.trim() : null;
    const effective = override || message;
    markTriggerFired(id);
    try {
      // The caller gets the run id so it can follow the run at GET /runs/:id.
      const runId = await recordRun({ trigger: 'webhook', message: effective }, async () => {
        await runTaskFromContext(effective, undefined);
        return currentRunId();
      });
      res.json({ ok: true, runId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isCancelled(e)) return cancelledResponse(res, e);
      if (isProviderError(e)) {
        return res.status(503).json({ error: 'ai_unavailable', message: msg.slice(0, 200) });
      }
      logger.error('webhook task failed', { id, err: msg });
      res.status(500).json({ error: 'task_failed' });
    }
  });

  app.get('/triggers', (_req, res) => {
    try {
      res.json(getTriggers());
    } catch (e) {
      logger.error('triggers list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'triggers_list_failed' });
    }
  });

  app.post('/triggers', (req: Request, res: Response) => {
    try {
      saveTriggers(req.body);
      // Saving while the kill switch holds them paused stores the change
      // without starting anything; POST /resume starts them.
      if (triggersPausedAt === null) startTriggers(runTriggered);
      res.json({ ok: true, paused: triggersPausedAt !== null });
    } catch (e) {
      if (e instanceof TriggerConfigError) {
        return res.status(400).json({ error: 'invalid config', message: e.message });
      }
      logger.error('triggers save error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'triggers_save_failed' });
    }
  });

  /** A cron firing is a scheduled run; a watched file changing is an event. */
  function runTriggered(message: string, source: TriggerSource) {
    return recordRun({ trigger: source === 'cron' ? 'schedule' : 'event', message }, () =>
      runTaskFromContext(message)
    );
  }

  async function runTaskFromContext(message: string, model?: string, dryRun?: boolean) {
    let skills: Awaited<ReturnType<typeof loadSkillsFromDir>> = [];
    try {
      skills = await loadSkillsFromDir(skillsDir);
      const moduleSkillsDirs = getModuleSkillsDirs(loadedModules);
      for (const dir of moduleSkillsDirs) {
        const fromModule = await loadSkillsFromDir(dir);
        const seen = new Set(skills.map((s) => s.slug));
        for (const s of fromModule) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            skills.push(s);
          }
        }
      }
    } catch {
      // continue
    }
    const selection = selectSkill(message.trim(), skills);
    const runCalc = fssync.existsSync(calcPath)
      ? async (expression: string, inputs?: Record<string, number>) => {
          const r = await runEvalCalc({ expression, inputs: inputs ?? {} }, calcPath);
          return { values: r.values };
        }
      : undefined;
    return runTask({
      message: message.trim(),
      skillSlug: selection.skillSlug,
      skillName: selection.skill?.name,
      runCalc,
      model,
      dryRun,
    });
  }

  app.post('/task', async (req: Request, res: Response) => {
    const body = req.body as {
      message?: string;
      model?: string;
      dryRun?: boolean;
      continueOnDisconnect?: boolean;
    };
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    try {
      // A dry run performs no work, so it does not warrant a run record.
      const exec = () =>
        runTaskFromContext(
          message.trim(),
          typeof body.model === 'string' ? body.model : undefined,
          body.dryRun === true
        );
      const result =
        body.dryRun === true
          ? await exec()
          : await recordRun(
              {
                trigger: 'manual',
                message: message.trim(),
                signal: disconnectSignal(res, body.continueOnDisconnect),
              },
              exec
            );
      logger.info('task', { skill: result.skillSlug ?? 'none' });
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isCancelled(e)) return cancelledResponse(res, e);
      if (isProviderError(e)) {
        return res.status(503).json({
          error: 'ai_unavailable',
          message: msg.slice(0, 200),
        });
      }
      logger.error('task error', { err: msg });
      res.status(500).json({
        error: 'task_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  const server = app.listen(port, host, async () => {
    logger.info('Gateway started', { host, port, url: `http://${host}:${port}` });
    try {
      await initStore(config.dbPath);
    } catch (e) {
      logger.error('Store failed to open; memory and run history are unavailable', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      logger.warn(
        'Gateway is bound to a non-loopback interface and is reachable from the network. ' +
          'Ensure it sits behind TLS and that the gateway token is not shared.',
        { host }
      );
    }
    if (auth.source === 'generated') {
      logger.info('Generated a new gateway token at ~/.clerq/gateway-token (mode 0600).');
    }
    startTriggers(runTriggered);
    try {
      const modules = await loadModulesFromDir(config.modulesDir ?? process.env.CLERQ_MODULES_DIR);
      loadedModules = modules;
      if (modules.length > 0) {
        for (const mod of modules) {
          if (mod.routeHandlers.length > 0) {
            mountModuleRoutes(app, mod);
          } else {
            logger.info('Module loaded', { moduleId: mod.id, routes: 0 });
          }
        }
      }
    } catch (e) {
      logger.warn('Module load error', { err: e instanceof Error ? e.message : String(e) });
    }
  });

  return { app, server };
}
