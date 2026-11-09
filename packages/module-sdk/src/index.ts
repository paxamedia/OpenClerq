/**
 * @clerq/module-sdk — what an OpenClerq module's server code is given.
 *
 * A module's server entry (`dist/routes.js` by default, one self-contained
 * ESM bundle) exports `register(ctx)`, or a default `defineModule({ register })`.
 * The gateway calls it once at start with a ModuleContext scoped to the module:
 *
 * ```ts
 * import { defineModule } from '@clerq/module-sdk';
 *
 * export default defineModule({
 *   register(ctx) {
 *     ctx.routes.get('/hello', (_req, res) => res.json({ hello: ctx.id }));
 *   },
 * });
 * ```
 *
 * Module code runs inside the gateway process with the gateway's access. The
 * context is a convenience and a namespace, not a sandbox.
 *
 * This package is types plus two small helpers, with no runtime dependencies,
 * so a module bundle stays self-contained.
 */

/** A request, as much of Express's as a module may rely on. */
export interface ModuleRequest {
  method: string;
  /** The path below `/api/modules/<id>`. */
  path: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** A response, as much of Express's as a module may rely on. */
export interface ModuleResponse {
  status(code: number): ModuleResponse;
  json(body: unknown): unknown;
  send(body?: unknown): unknown;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): unknown;
}

export type RouteHandler = (req: ModuleRequest, res: ModuleResponse) => unknown;

/** Routes mount under `/api/modules/<id>`; `ctx.routes.get('/x', …)` serves `/api/modules/<id>/x`. */
export interface ModuleRoutes {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
}

export type SqlParam = string | number | bigint | boolean | null | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: SqlParam[]): SqlRow | undefined;
  all(...params: SqlParam[]): SqlRow[];
}

/**
 * The gateway's SQLite store. A module's tables are named `mod_<id>_<name>`
 * (hyphens in the id become underscores) and created by its migrations;
 * `table('items')` gives the full name.
 */
export interface ModuleStore {
  /** `mod_<id>_<name>`. */
  table(name: string): string;
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  /** Run `fn` in a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T;
}

/**
 * Vault secrets under `<id>/`. `get('api-key')` reads the vault entry
 * `<id>/api-key`; names never include the prefix.
 */
export interface ModuleSecrets {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
  /** Names without the prefix. */
  list(): string[];
}

export type RiskTier = 'low' | 'medium' | 'high';

/** The approvals inbox the operator already uses for agent tool calls. */
export interface ModuleApprovals {
  /** Ask a person. `runId` defaults to the run this call belongs to, if any. */
  request(input: {
    action: string;
    reason: string;
    tier?: RiskTier;
    details?: unknown;
    runId?: string;
  }): Promise<{ id: number }>;
  /** Resolves true on approval; false on denial or after `timeoutMs` (default 5 min). */
  wait(id: number, timeoutMs?: number): Promise<boolean>;
}

/** The append-only audit log. Entries are recorded as `module.<id>.<action>`. */
export interface ModuleAudit {
  append(action: string, subject?: string, detail?: unknown): void;
}

/** One event from the gateway's bus, as subscribers and GET /events/stream see it. */
export interface ClerqEvent<T = unknown> {
  id: string;
  name: string;
  at: string;
  context: { requestId?: string; sessionId?: string; runId?: string; toolCallId?: string };
  payload: T;
}

/**
 * The typed event bus. A module emits under its own namespace: `emit('greeted')`
 * puts `module.<id>.greeted` on the bus, where the UI stream and other modules
 * see it. It can subscribe to any event.
 */
export interface ModuleEvents {
  /** `name` is lower-case letters, digits, `.`, `_` and `-`. Returns the event as sent. */
  emit<T>(name: string, payload: T, context?: { runId?: string }): ClerqEvent<T>;
  /** Events whose name starts with `prefix` (`'*'` for all). Returns an unsubscribe function. */
  subscribe(prefix: string, fn: (event: ClerqEvent) => void): () => void;
}

export type TriggerSource = 'cron' | 'file' | 'webhook' | 'manual';

/** What a trigger's handler is called with. */
export interface TriggerEvent {
  triggerId: string;
  /** `manual` when fired by hand through its endpoint (cron and file triggers). */
  source: TriggerSource;
  /** The run this firing is recorded as. */
  runId: string;
  /** A webhook's JSON body. */
  payload?: unknown;
  /** The path that changed, for a file trigger. */
  path?: string;
  /** Aborts when the run is cancelled (the kill switch, or POST /runs/:id/cancel). */
  signal: AbortSignal;
}

export interface ModuleTriggerDef {
  /** a-z, 0-9, `_` and `-`; unique within the module. */
  id: string;
  kind: 'cron' | 'file' | 'webhook';
  /** For `cron`: a cron expression, in the host's time zone. */
  schedule?: string;
  /** For `file`: a file or directory to watch. */
  path?: string;
  description?: string;
  /** Its return value, if any, is recorded on the run as JSON. A throw fails the run. */
  handler(event: TriggerEvent): unknown;
}

/**
 * Handler triggers. Each firing is a run in run history. Any trigger can also
 * be fired with `POST /api/modules/<id>/triggers/<triggerId>`, which is how a
 * webhook trigger is called; the JSON body becomes `payload`.
 */
export interface ModuleTriggers {
  register(def: ModuleTriggerDef): void;
}

export interface ModuleNotification {
  title: string;
  body?: string;
  /** Default `info`. */
  level?: 'info' | 'success' | 'warning' | 'error';
  /** A path in the module's UI to open, e.g. `/campaigns/42`. */
  link?: string;
}

/**
 * Tell the person. The gateway puts a `notify.posted` event on the bus; the
 * desktop shows it as a native notification and paired devices get a push.
 * At most 30 a minute per module; more are dropped with a warning.
 */
export interface ModuleNotify {
  (notification: ModuleNotification): { id: string } | null;
  /** A short badge for the module, e.g. `671/1000`; null clears it. Sent as `notify.badge`. */
  badge(text: string | null): void;
}

export interface ServiceStatus {
  label: string;
  name?: string;
  /** launchd has the agent. */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExitCode: number | null;
}

/**
 * The launchd agents the manifest declares under `services`, and only those
 * (macOS). Start loads the agent if needed and starts it; stop unloads it.
 */
export interface ModuleServices {
  list(): Array<{ label: string; name?: string; plist: string }>;
  status(label: string): Promise<ServiceStatus>;
  start(label: string): Promise<ServiceStatus>;
  stop(label: string): Promise<ServiceStatus>;
}

export interface ModuleLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ModuleContext {
  /** The manifest id. */
  readonly id: string;
  /** The module's directory on disk. */
  readonly dir: string;
  readonly version: string;
  /**
   * Settings: the manifest's `config` defaults, overlaid with
   * `~/.clerq/modules/<id>.json` when that file exists.
   */
  readonly config: Readonly<Record<string, unknown>>;
  routes: ModuleRoutes;
  store: ModuleStore;
  secrets: ModuleSecrets;
  events: ModuleEvents;
  triggers: ModuleTriggers;
  notify: ModuleNotify;
  services: ModuleServices;
  approvals: ModuleApprovals;
  audit: ModuleAudit;
  logger: ModuleLogger;
}

export interface ClerqModule {
  register(ctx: ModuleContext): void | Promise<void>;
}

/** Identity at runtime; it exists so a module's `register` is type-checked. */
export function defineModule(module: ClerqModule): ClerqModule {
  return module;
}

/** The prefix a module's tables carry: `mod_<id>_`, hyphens as underscores. */
export function tablePrefix(moduleId: string): string {
  return `mod_${moduleId.replace(/-/g, '_')}_`;
}
