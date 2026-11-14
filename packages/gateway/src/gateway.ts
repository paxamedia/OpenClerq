import express, { Request, Response } from 'express';
import fssync from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { GatewayConfig } from './types.js';
import { licenseCheck } from './middleware/license.js';
import { requireAuth, resolveGatewayToken } from './security/auth.js';
import { logger } from './logger.js';
import { getCalcBinaryPath, runEvalCalc } from './calc.js';
import { getSkillsDir, saveSkillFrontmatter } from './skills-loader.js';
import type { ChatMessage } from '@clerq/providers';
import { getExplanation, buildContextPreview } from './agent/explain.js';
import { getLLMProviderStatus, getAvailableModels, listProviders } from './agent/llm-provider.js';
import { runTask } from './agent/task.js';
import { getModuleSkillSources } from './module-loader.js';
import { SkillCatalog } from './skills/catalog.js';
import { BUNDLED_SKILLS } from './skills/bundled-skills.js';
import { mountSkillRoutes } from './skills/routes.js';
import { skillChoiceOf, skillTaskTrace } from './skills/use.js';
import { ModuleHost } from './modules/host.js';
import { BUNDLED_PLUGINS } from './modules/bundled-plugins.js';
import { mountPluginRoutes } from './modules/plugin-routes.js';
import { mountModuleRoutes } from './modules/routes.js';
import { mountRecordRoutes } from './records/routes.js';
import { mountInboxRoutes } from './inbox/routes.js';
import { mountRemoteRoutes, refuseDevicesWhenRemoteOff } from './remote/routes.js';
import { startPushPublisher } from './remote/push.js';
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
import {
  listSecrets,
  setSecret,
  deleteSecret,
  vaultKeyStatus,
  getSecret,
} from './secrets-vault.js';
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
import { mountMemoryRoutes } from './memory-routes.js';
import { memoryBlock } from './memory-context.js';
import { pruneExpired } from './memory-layer.js';
import { closeStore, getStore, initStore, isStoreOpen } from './store.js';
import { schemaVersion, StoreBackupError, StoreBusyError, StoreTooNewError } from '@clerq/store';
import {
  API_VERSION,
  API_VERSION_HEADER,
  SUPPORTED_API_VERSIONS,
} from '@clerq/gateway-client/protocol';
import { negotiateApiVersion, stampApiVersion, versionInfo } from './api-version.js';
import {
  recordRun,
  listRuns,
  getRun,
  listToolCalls,
  currentRunId,
  cancelRun,
  cancelAllRuns,
  activeRunIds,
} from './runs.js';
import { emit, subscribeEvents, recentEvents } from './events.js';
import { streamEvents } from './event-stream.js';
import { listPending, decide, denyAllPending } from './approvals.js';
import {
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  listMessages,
  conversation,
  SessionError,
} from './chat/sessions.js';
import {
  sendMessage,
  validateSend,
  compare,
  promote,
  type ManagedPipeline,
} from './chat/console.js';
import { managedContext, runManagedTurn, toolPrompt, type ManagedDeps } from './chat/managed.js';
import { setGatewayStateDirs } from './chat/environment.js';
import { DraftError, dryRunDraft, getDraft, listDrafts, saveDraft } from './chat/drafts.js';
import { SpecError } from './automations/spec.js';
import { AutomationError } from './automations/store.js';
import { defaultDriver } from './automations/runner.js';
import { resolveTarget } from './agent/llm-provider.js';

import { mountAutomationRoutes, recoverAfterRestart } from './automations/routes.js';
import {
  GithubApp,
  GithubSignIn,
  githubAppCredentials,
  isReservedSecret,
  mountGithubRoutes,
  realVault,
  reservedInVault,
} from './github/index.js';
import { mountRoutingRoutes } from './routing-routes.js';
import { apiErrors } from './error-handler.js';
import { startAutomationSchedules, stopAutomationSchedules } from './automations/scheduler.js';
import { readKillPause, writeKillPause } from './kill-state.js';
import {
  cancelQueuedRuns,
  pauseAutomationQueue,
  resumeAutomationQueue,
  startAutomationQueue,
  stopAutomationQueue,
} from './automations/queue.js';
import { userShellPath } from './automations/shell-path.js';
import type { RunnerDeps } from './automations/runner.js';

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
export const GATEWAY_VERSION = '0.5.1';

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

/**
 * How long `close()` lets requests in flight finish before it ends them. The
 * server app's own stop deadline is 10 s; this leaves it the rest.
 */
export const CLOSE_GRACE_MS = 8_000;

export interface Gateway {
  app: express.Express;
  server: Server;
  /**
   * Settles once the store is open and modules are loaded. Rejects, after the
   * server has stopped, when the store cannot be used at all: a database from
   * a newer OpenClerq, one that could not be backed up before an upgrade, or
   * one that another process was still upgrading after two minutes. It also
   * rejects when the port cannot be bound, and when `close()` came first.
   */
  ready: Promise<void>;
  /**
   * Stop for good, for a process that is about to exit. At once: stop
   * accepting connections and answer any new request 503, stop the schedules,
   * the queue, the triggers and the push publisher (so nothing waiting is
   * started from here on), and end the event streams (`GET /events`,
   * `/events/stream`, `/logs/stream`), which never end by themselves. Then let
   * requests already in flight finish, for up to `graceMs` (default 8 s);
   * those still open after that are ended (an event stream is finished, an
   * unanswered request gets a 503, anything else is cut). Then close the store.
   *
   * A chat reply still being generated when the grace is over is lost: the
   * message that was sent is kept, the reply is not stored, and the run is
   * settled as interrupted by the next start.
   *
   * Runs in flight are not cancelled and not waited for. Nothing is written
   * to them: their leases stop being renewed when the process exits, and the
   * next start reclaims them the way it reclaims those of a crashed gateway
   * (retried when the spec allows, else failed as interrupted). Agent and gate
   * processes are not signalled either; the next start stops what is left of
   * them, and a service manager or container that ends the whole process
   * group or control group does so sooner.
   *
   * Safe to call more than once; every call returns the same promise.
   */
  close(options?: { graceMs?: number }): Promise<void>;
}

const isEventStream = (res: Response): boolean =>
  String(res.getHeader('content-type') ?? '').startsWith('text/event-stream');

/**
 * Finish the open event streams (`GET /events`, `/events/stream`,
 * `/logs/stream`): they are open for as long as a client wants, never work in
 * progress, and a client reconnects (or not). A chat reply is also
 * `text/event-stream`, but it is a POST and is work in progress: not touched.
 */
function endEventStreams(live: ReadonlySet<Response>): void {
  for (const res of [...live]) {
    try {
      if (res.req?.method === 'GET' && isEventStream(res) && !res.writableEnded) res.end();
    } catch {
      /* the connection is already gone */
    }
  }
}

/**
 * End what is still open when the grace period is over, in the way each kind
 * can be ended well: an event stream is finished, a request that has not been
 * answered gets a 503, and anything else is cut. Works the same under Node and
 * Bun.
 */
function endLiveResponses(live: ReadonlySet<Response>): void {
  for (const res of [...live]) {
    try {
      if (res.writableEnded) continue;
      if (isEventStream(res)) {
        res.end();
      } else if (!res.headersSent) {
        res.status(503).set('Retry-After', '5').json({
          error: 'server_stopping',
          message: 'The server is stopping. Try again shortly.',
        });
      } else {
        res.destroy();
      }
    } catch {
      /* the connection is already gone */
    }
  }
}

export function createGateway(config: GatewayConfig = {}): Gateway {
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

  const vaultGet =
    config.automations?.getSecret ?? ((name: string) => getSecret(name) ?? undefined);
  // The user's own GitHub App, when one is connected: installation tokens for runs.
  // Its key is always read from the vault itself, whatever `getSecret` a caller gave the automations.
  const githubApp = new GithubApp({ getSecret });
  const githubSignIn = new GithubSignIn({ vault: realVault });
  const automationDeps: RunnerDeps = {
    getSecret: vaultGet,
    secretNames:
      config.automations?.secretNames ??
      (config.automations?.getSecret
        ? undefined
        : () => {
            const names = listSecrets();
            return Array.isArray(names) ? names : [];
          }),
    path: config.automations?.path ?? userShellPath,
    driverFor: config.automations?.driverFor,
    fetcher: config.automations?.fetcher,
    workspaceCacheDir: config.automations?.workspaceCacheDir,
    // The GitHub App's installation token when it is installed on the repository, else the
    // vault's secret (docs/GITHUB.md). A caller may replace it.
    forgeCredentials:
      config.automations?.forgeCredentials ?? githubAppCredentials(githubApp, vaultGet),
    forgeApp: config.automations?.forgeApp ?? ((_forge, project) => githubApp.access(project)),
    repoCheckTimeoutMs: config.automations?.repoCheckTimeoutMs,
    maxConcurrent:
      config.automations?.maxConcurrent ?? (Number(process.env.CLERQ_MAX_CONCURRENT_RUNS) || 2),
  };

  const app = express();
  const modules = new ModuleHost(app, {
    bundled: config.plugins?.bundled ?? BUNDLED_PLUGINS,
    fetchImpl: config.plugins?.fetch,
    hookTimeoutMs: config.plugins?.hookTimeoutMs,
  });
  // Every use of a skill goes through here: read once, hashed, judged (skills/catalog.ts).
  const skills = new SkillCatalog({
    sources: () => [
      { dir: skillsDir, source: 'directory' },
      ...getModuleSkillSources(modules.loaded()),
    ],
    enforcing: () => modules.enforcing(),
    pluginApproved: (id) => modules.pluginApproved(id),
    bundled: config.skills?.bundled ?? BUNDLED_SKILLS,
    beforeRead: config.skills?.beforeRead,
  });

  // Origins are reflected only when explicitly allow-listed. There is no wildcard
  // path: a wildcard lets any page the user visits drive their local gateway.
  const corsOrigins = new Set(
    (process.env.CLERQ_CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );
  // Every response still open, so `close()` can end them. Under Bun,
  // `closeAllConnections()` does not end an event stream (verified on 1.3.10),
  // and the server would never finish closing.
  const live = new Set<Response>();
  let closeRequested = false;
  app.use((_req, res, next) => {
    live.add(res);
    const done = () => live.delete(res);
    res.once('finish', done);
    res.once('close', done);
    next();
  });
  // First of all, so every response carries the API version: a preflight, a 401, a 404.
  app.use(stampApiVersion);
  // Once `close()` has begun, a request that arrives (on a connection that was
  // already open) is refused; the ones already under way carry on.
  app.use((_req, res, next) => {
    if (!closeRequested) return next();
    res
      .status(503)
      .set({ 'Retry-After': '5', Connection: 'close' })
      .json({ error: 'server_stopping', message: 'The server is stopping. Try again shortly.' });
  });
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && corsOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type, Authorization, Last-Event-ID, X-Clerq-Token, X-Clerq-Tenant, ${API_VERSION_HEADER}`
    );
    // Without this a browser client cannot read the version a response was served as.
    res.setHeader('Access-Control-Expose-Headers', API_VERSION_HEADER);
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // Before the body parser and before auth: a client learns why it was refused
  // without a token, and `/v1/x` reaches every later layer as `/x`.
  app.use(negotiateApiVersion());
  // Body limit: an unbounded JSON parser is a trivial memory exhaustion vector.
  app.use(express.json({ limit: process.env.CLERQ_MAX_BODY ?? '1mb' }));
  app.use(requireAuth(auth.token));
  app.use(refuseDevicesWhenRemoteOff);
  app.use(licenseCheck(devMode));

  app.get('/health', (_req, res) => {
    const llmStatus = getLLMProviderStatus();
    res.json({
      status: 'ok',
      service: 'clerq-gateway',
      version: GATEWAY_VERSION,
      api: { version: API_VERSION, supported: [...SUPPORTED_API_VERSIONS] },
      llm: {
        mode: llmStatus.mode,
        provider: llmStatus.provider,
        model: llmStatus.model,
        available: llmStatus.available,
      },
    });
  });

  // The newest core migration applied; null until the store is open.
  app.get('/version', (_req, res) => {
    res.json(versionInfo(GATEWAY_VERSION, isStoreOpen() ? schemaVersion(getStore()) : null));
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
    if (isReservedSecret(name)) {
      return res.status(400).json({ error: reservedInVault(name, 'set') });
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
    if (isReservedSecret(name)) {
      return res.status(400).json({ error: reservedInVault(name, 'delete') });
    }
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

  mountSkillRoutes(app, skills, { enforcing: () => modules.enforcing() });

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

  mountMemoryRoutes(app);

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
      const cancelledRuns =
        body.runs === false
          ? 0
          : cancelAllRuns('Kill switch engaged') + cancelQueuedRuns('Kill switch engaged');
      let triggersPaused = triggersPausedAt !== null;
      if (body.triggers !== false) {
        stopTriggers();
        stopAutomationSchedules();
        // Queued automation runs wait too: starting one is new autonomous work.
        pauseAutomationQueue();
        modules.triggers.pause();
        triggersPausedAt ??= new Date().toISOString();
        // Kept in the store, so a restart does not release it.
        writeKillPause(triggersPausedAt);
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
      writeKillPause(null);
      startTriggers(runTriggered);
      // Slots missed while paused are skipped, never caught up.
      startAutomationSchedules(automationDeps, { resume: true });
      resumeAutomationQueue();
      modules.triggers.resume();
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

  app.get('/events/stream', streamEvents);

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

    const managed: ManagedPipeline = async ({ onDelta, onEvent, ...turn }) => {
      const result = await runManagedTurn(managedDeps, {
        ...turn,
        onEvent: (e) => (e.type === 'delta' ? onDelta?.(e.text) : onEvent?.(e)),
      });
      const slash = result.model.indexOf('/');
      return {
        text: result.text,
        meta: {
          provider: result.model.slice(0, slash),
          model: result.model.slice(slash + 1),
          tokensIn: result.result.tokensIn,
          tokensOut: result.result.tokensOut,
          costUsd: result.result.costUsd,
          latencyMs: result.result.durationMs,
          turns: result.result.turns,
          toolCalls: result.toolCalls,
          ...(result.context.skill ? { skillSlug: result.context.skill.slug } : {}),
          ...(result.context.memory ? { memoryCount: result.context.memory.count } : {}),
          ...(result.drafts.length ? { drafts: result.drafts } : {}),
          ...(result.context.workspace ? { workspace: result.context.workspace } : {}),
        },
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
        // Managed: tool activity, approvals to answer, drafts.
        onEvent: (event) => send(event),
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

  /**
   * What managed mode adds to a message, beside what raw sends: the system
   * prompt (configured prompt, skill, memory block, tool instructions), the
   * tools offered and how policy decides each, the model and its fallback
   * chain. Nothing is sent to a model.
   */
  app.post('/sessions/:id/mode-diff', async (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as { text?: unknown; model?: unknown };
    try {
      const session = getSession(id);
      if (!session) return res.status(404).json({ error: 'session_not_found', id });
      if (body.model !== undefined && typeof body.model !== 'string') {
        throw new SessionError('model must be a model reference string.');
      }
      const text = typeof body.text === 'string' ? body.text : '';
      const model = (body.model as string | undefined)?.trim() || session.model || undefined;
      const history = conversation(id);
      const messages = [
        ...history,
        ...(text.trim() ? [{ role: 'user' as const, content: text }] : []),
      ];
      let rawModel: string | null = null;
      try {
        const t = resolveTarget(model);
        rawModel = `${t.provider.id}/${t.model}`;
      } catch {
        // Unresolvable: the managed side says why.
      }
      const managed = await managedContext(managedDeps, session, text, model, { preview: true });
      res.json({
        raw: {
          system: null,
          messages,
          tools: [],
          memory: null,
          model: rawModel,
          fallbackModels: [],
        },
        managed: {
          system: managed.system,
          messages,
          skill: managed.skill,
          skillPolicy: managed.skillPolicy,
          memory: managed.memory,
          tools: managed.tools,
          model: managed.model,
          chosen: managed.chosen,
          fallbackModels: managed.fallbackModels,
          workspace: managed.workspace,
          permissionMode: managed.permissionMode,
        },
      });
    } catch (e) {
      return chatError(res, e, 'mode_diff_failed');
    }
  });

  /** A spec problem in a draft is the caller's to see, with its line. */
  function draftError(res: Response, e: unknown, code: string): Response {
    if (e instanceof SpecError) {
      return res
        .status(400)
        .json({ error: 'invalid_spec', message: e.message, line: e.line, column: e.column });
    }
    if (e instanceof AutomationError || e instanceof DraftError) {
      return res
        .status(e.code === 'not_found' ? 404 : 409)
        .json({ error: e.code, message: e.message });
    }
    return chatError(res, e, code);
  }

  // Automations drafted in a conversation: read, dry-run and save, by a person.
  // Saving makes an automation that is switched off; nothing here switches one on.
  app.get('/sessions/:id/drafts', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    try {
      if (!getSession(id)) return res.status(404).json({ error: 'session_not_found', id });
      res.json({ drafts: listDrafts(id) });
    } catch (e) {
      return draftError(res, e, 'drafts_list_failed');
    }
  });

  app.get('/sessions/:id/drafts/:draftId', (req: Request, res: Response) => {
    const draft = getDraft(String(req.params?.id ?? ''), String(req.params?.draftId ?? ''));
    if (!draft) return res.status(404).json({ error: 'draft_not_found' });
    res.json(draft);
  });

  app.post('/sessions/:id/drafts/:draftId/dry-run', async (req: Request, res: Response) => {
    try {
      res.json(
        await dryRunDraft(
          String(req.params?.id ?? ''),
          String(req.params?.draftId ?? ''),
          automationDeps
        )
      );
    } catch (e) {
      return draftError(res, e, 'draft_dry_run_failed');
    }
  });

  app.post('/sessions/:id/drafts/:draftId/save', (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params?.id ?? '');
      const automation = saveDraft(sessionId, String(req.params?.draftId ?? ''));
      res.status(201).json({
        id: automation.id,
        name: automation.name,
        enabled: automation.enabled,
        authoredBy: automation.authoredBy ?? null,
        source: automation.source,
      });
    } catch (e) {
      return draftError(res, e, 'draft_save_failed');
    }
  });

  app.get('/runs', (req: Request, res: Response) => {
    // `since` (an ISO time) bounds the list by age, for views over a period;
    // it may then hold more runs than the default page.
    const rawSince = req.query?.since;
    let since: string | undefined;
    if (rawSince !== undefined) {
      const t = typeof rawSince === 'string' ? Date.parse(rawSince) : NaN;
      if (Number.isNaN(t)) {
        return res
          .status(400)
          .json({ error: 'invalid_since', message: 'since must be an ISO time.' });
      }
      since = new Date(t).toISOString();
    }
    const limit = Math.min(Number(req.query?.limit ?? 50) || 50, since ? 5000 : 500);
    try {
      res.json({ runs: listRuns(limit, { since }) });
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

  /** The tool calls a run's agent made, in order. */
  app.get('/runs/:id/tool-calls', (req: Request, res: Response) => {
    const id = String(req.params?.id ?? '');
    try {
      if (!getRun(id)) return res.status(404).json({ error: 'run_not_found', id });
      res.json({ toolCalls: listToolCalls(id) });
    } catch (e) {
      logger.error('tool calls error', { id, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'tool_calls_failed' });
    }
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

  mountModuleRoutes(app, modules);
  mountPluginRoutes(app, modules);
  mountRecordRoutes(app);
  mountInboxRoutes(app);
  mountRemoteRoutes(app);

  // Automations: scheduled agent runs that end in a draft pull request.
  // Their schedules pause with the triggers under the kill switch.
  mountAutomationRoutes(app, automationDeps, () => triggersPausedAt === null);
  mountRoutingRoutes(app);
  mountGithubRoutes(app, { app: githubApp, signin: githubSignIn });

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

  app.post('/context/preview', async (req: Request, res: Response) => {
    const body = req.body as {
      question?: string;
      context?: Record<string, unknown>;
      skillSlug?: string;
      skillName?: string;
      sessionId?: string;
    };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    const skillSlug = typeof body?.skillSlug === 'string' ? body.skillSlug : undefined;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
    try {
      if (sessionId && !getSession(sessionId)) {
        return res.status(404).json({ error: 'session_not_found', id: sessionId });
      }
      // The skill is chosen as /task chooses it (read once, judged on what was read), so the
      // preview shows what a task with this skill would send, and says when it would not be used.
      const picked = skillSlug ? await skills.use(skillSlug) : null;
      const passedOver = Boolean(picked && !picked.use && picked.skipped.length > 0);
      const preview = buildContextPreview({
        question: question || '(no question)',
        context: body.context,
        skillSlug: passedOver ? undefined : skillSlug,
        skillName: passedOver
          ? undefined
          : typeof body?.skillName === 'string'
            ? body.skillName
            : picked?.use?.name,
        skillInstructions: picked?.view?.body,
        skillTrust: picked?.use?.trust,
        history: sessionId ? conversation(sessionId) : undefined,
        // What a managed turn would carry from memory, under the memory policy.
        memory: savedNotes(question)?.text,
      });
      // A managed chat message ends its system prompt with the word on its tools.
      const session = sessionId ? getSession(sessionId) : null;
      if (session) preview.systemPrompt += `\n\n${toolPrompt(session.workspace)}`;
      res.json({
        ...preview,
        ...(picked ? { skill: picked.use, skillsSkipped: picked.skipped } : {}),
      });
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
        // The message may come from the caller of the webhook: no memory is read for it.
        await runTaskFromContext(effective, { memory: false });
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
    // Nobody is there to ask for notes: a firing reads no memory.
    return recordRun({ trigger: source === 'cron' ? 'schedule' : 'event', message }, () =>
      runTaskFromContext(message, { memory: false })
    );
  }

  /** What a managed chat message runs with. */
  const managedDeps: ManagedDeps = {
    driver: config.chatDriver ?? defaultDriver('builtin'),
    async selectSkill(message, opts) {
      return skillChoiceOf(await skills.pick(message, { record: !opts?.preview }));
    },
    memory: (message) => savedNotes(message),
    path: () => automationDeps.path(),
    // A command in an attached folder that prints the token does not hand it to the model.
    secrets: () => ({ CLERQ_GATEWAY_TOKEN: auth.token }),
  };
  // The store's directory, besides ~/.clerq, cannot be a chat's folder.
  setGatewayStateDirs(
    config.dbPath && config.dbPath !== ':memory:' ? [path.dirname(path.resolve(config.dbPath))] : []
  );

  /**
   * The managed pipeline. Only a chat session passes history; /task and triggers are single-turn.
   * It reads saved notes unless `memory` is false, which triggers and webhooks say: they run
   * unattended, and a webhook's message may be written by whoever calls it.
   */
  async function runTaskFromContext(
    message: string,
    opts: { model?: string; dryRun?: boolean; history?: ChatMessage[]; memory?: boolean } = {}
  ) {
    const picked = await skills.pick(message.trim());
    const runCalc = fssync.existsSync(calcPath)
      ? async (expression: string, inputs?: Record<string, number>) => {
          const r = await runEvalCalc({ expression, inputs: inputs ?? {} }, calcPath);
          return { values: r.values };
        }
      : undefined;
    return runTask({
      message: message.trim(),
      skillSlug: picked.use?.slug,
      skillName: picked.use?.name,
      skillInstructions: picked.view?.body,
      skillTrust: picked.use?.trust,
      skillTrace: skillTaskTrace(picked),
      runCalc,
      model: opts.model,
      dryRun: opts.dryRun,
      history: opts.history,
      memory: opts.memory === false ? undefined : savedNotes(message),
    });
  }

  /**
   * The saved notes a managed turn may read (memory policy: every type unless
   * the user chose fewer). Memory that cannot be read is no memory, never a
   * failed answer. The console's raw mode does not come through here.
   */
  function savedNotes(message: string) {
    try {
      return memoryBlock(message.trim()) ?? undefined;
    } catch (e) {
      logger.warn('Could not read memory for a prompt', {
        err: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
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
        runTaskFromContext(message.trim(), {
          model: typeof body.model === 'string' ? body.model : undefined,
          dryRun: body.dryRun === true,
        });
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

  let markReady: () => void = () => undefined;
  let failReady: (e: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // A host that never looks at `ready` is not crashed by it rejecting; the
  // reason is logged, and a host that does look still sees the rejection.
  ready.catch(() => undefined);
  let stopPush: (() => void) | undefined;
  /** What the listen callback is doing, so `close()` can wait for it before closing the store. */
  let startup: Promise<void> = Promise.resolve();

  const closedEarly = () => new Error('The gateway was closed before it finished starting.');
  /** Whether `close()` came while starting; if so, `ready` says so and nothing more starts. */
  const abandoned = (): boolean => {
    if (!closeRequested) return false;
    failReady(closedEarly());
    return true;
  };

  const begin = async (listenError?: Error): Promise<void> => {
    if (listenError) {
      // Express hands a failed bind (address in use, no permission) to the
      // callback; carrying on would leave a process that serves nothing.
      logger.error(`Could not listen on ${host}:${port}: ${listenError.message}`);
      failReady(listenError);
      return;
    }
    logger.info('Gateway started', { host, port, url: `http://${host}:${port}` });
    try {
      await initStore(config.dbPath);
      // Records past their expiry are removed; reads skip them either way.
      if (!closeRequested) pruneExpired();
    } catch (e) {
      // A database from a newer OpenClerq, one that could not be backed up
      // before an upgrade, or one another process is still upgrading, is not
      // something to run beside half-working: say why in plain words, stop
      // serving, and let `ready` reject.
      if (
        e instanceof StoreTooNewError ||
        e instanceof StoreBackupError ||
        e instanceof StoreBusyError
      ) {
        logger.error(e.message);
        server.close();
        server.closeAllConnections?.();
        failReady(e);
        return;
      }
      logger.error('Store failed to open; memory and run history are unavailable', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    if (abandoned()) return;
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
    // The kill switch, if it was engaged when the gateway stopped, still is.
    triggersPausedAt = readKillPause();
    if (triggersPausedAt !== null) {
      logger.warn(
        'The kill switch is engaged; triggers, schedules and queued runs wait for POST /resume',
        {
          since: triggersPausedAt,
        }
      );
    } else {
      startTriggers(runTriggered);
    }
    stopPush = startPushPublisher();
    try {
      await recoverAfterRestart();
      if (abandoned()) return;
      // Queued runs, from before the restart too, start as the limits allow.
      startAutomationQueue(automationDeps);
      if (triggersPausedAt !== null) pauseAutomationQueue();
      else startAutomationSchedules(automationDeps);
    } catch (e) {
      logger.error('Automations failed to start', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      // The plugins that ship with the app come first, so a folder in the modules directory cannot
      // take a bundled plugin's id.
      const bundledDir = config.bundledPluginsDir ?? process.env.CLERQ_BUNDLED_PLUGINS_DIR;
      if (bundledDir) await modules.loadAll(bundledDir);
      await modules.loadAll(config.modulesDir ?? process.env.CLERQ_MODULES_DIR);
      if (triggersPausedAt !== null) modules.triggers.pause();
    } catch (e) {
      logger.warn('Module load error', { err: e instanceof Error ? e.message : String(e) });
    }
    if (abandoned()) return;
    markReady();
  };

  // After every route (a module's own routers carry theirs, see modules/host.ts): a failed
  // request gets a JSON answer that holds nothing from the request.
  app.use(apiErrors);

  const server = app.listen(port, host, (listenError?: Error) => {
    startup = begin(listenError).catch((e: unknown) => {
      logger.error('Gateway start failed', { err: e instanceof Error ? e.message : String(e) });
      failReady(e);
    });
  });
  // Settles when the server is listening or has failed to; `close()` waits for it.
  const bound = new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
    server.once('error', () => resolve());
  });

  server.on('close', () => {
    stopAutomationSchedules();
    stopAutomationQueue();
  });

  let closing: Promise<void> | undefined;
  const close = (options: { graceMs?: number } = {}): Promise<void> => {
    closing ??= (async () => {
      closeRequested = true;
      await bound;
      // First, before any waiting: nothing new starts from here. A run waiting
      // for a slot stays queued, for the next start; one dispatched now would
      // have its agent killed with the process.
      stopAutomationSchedules();
      stopAutomationQueue();
      stopTriggers();
      githubSignIn.close();
      modules.triggers.pause();
      stopPush?.();
      stopPush = undefined;
      // No new connections, and the event streams, which are not work, end now.
      const ended = new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
      server.closeIdleConnections?.();
      endEventStreams(live);
      // Requests already under way get until the grace is over, then go.
      const drop = setTimeout(
        () => {
          endLiveResponses(live);
          server.closeAllConnections?.();
        },
        Math.max(0, options.graceMs ?? CLOSE_GRACE_MS)
      );
      await ended;
      clearTimeout(drop);
      // Whatever start-up was in the middle of finishes (or notices `closeRequested`)
      // before the store is closed under it.
      await startup;
      // Plugins stop while the store is still open, and after the requests they were serving.
      await modules.stopAll().catch((e: unknown) =>
        logger.error('Plugins did not all stop', {
          err: e instanceof Error ? e.message : String(e),
        })
      );
      // Let a request that was dropped write how it ended before the store goes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      closeStore();
    })();
    return closing;
  };

  return { app, server, ready, close };
}
