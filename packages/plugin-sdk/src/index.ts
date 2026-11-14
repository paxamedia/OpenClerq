/**
 * @clerq/plugin-sdk: what an OpenClerq plugin's server code is given.
 *
 * A plugin's server entry (the manifest's `entry.server`) is one
 * self-contained ESM bundle that exports `definePlugin({ ... })` as its default:
 *
 * ```ts
 * import { definePlugin } from '@clerq/plugin-sdk';
 *
 * export default definePlugin({
 *   register(ctx) {
 *     ctx.routes.get('/hello', (_req, res) => res.json({ hello: ctx.id }));
 *   },
 *   async start(ctx) {
 *     ctx.setInterval(() => ctx.logger.info('still here'), 60_000);
 *   },
 * });
 * ```
 *
 * The gateway calls the hooks in this order: `upgrade` (only when the version
 * changed since the last start), `register`, `start`; and `stop` when the plugin
 * is disabled or the gateway closes. Everything the plugin set up through the
 * context is removed after `stop`.
 *
 * Plugin code runs inside the gateway process with the gateway's access. The
 * context is a namespace and, when the user turns enforcement on, a set of
 * checks on what goes *through the context*. It is not a sandbox: direct Node
 * APIs (`child_process`, `fs`, `fetch`) are not blocked.
 *
 * This entry is types plus a few small helpers with no runtime dependencies, so
 * a plugin bundle stays self-contained. The manifest validator is at
 * `@clerq/plugin-sdk/manifest`, the checksum helpers at `@clerq/plugin-sdk/node`
 * and the UI types at `@clerq/plugin-sdk/ui`.
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
 * One of the module's tables, scoped to the current tenant: every read,
 * update and delete filters on `tenant_id`, and every insert sets it.
 * `where` matches columns by equality (`null` matches NULL).
 */
export interface TenantTable {
  readonly name: string;
  insert(row: Record<string, SqlParam>): { id: number | bigint; changes: number };
  find(
    where?: Record<string, SqlParam>,
    opts?: { orderBy?: string; desc?: boolean; limit?: number }
  ): SqlRow[];
  get(where: Record<string, SqlParam>): SqlRow | undefined;
  update(where: Record<string, SqlParam>, set: Record<string, SqlParam>): number;
  delete(where: Record<string, SqlParam>): number;
  count(where?: Record<string, SqlParam>): number;
}

/**
 * The gateway's SQLite store. A module's tables are named `mod_<id>__<name>`
 * (hyphens in the id become underscores) and created by its migrations; the
 * store adds a `tenant_id` column to each. `rows('items')` reads and writes
 * the current tenant's rows. Raw SQL through `prepare` must filter on
 * `tenant_id = ctx.tenant` itself.
 */
export interface ModuleStore {
  /** `mod_<id>__<name>`. */
  table(name: string): string;
  /** The current tenant's rows of `mod_<id>__<name>`. */
  rows(name: string): TenantTable;
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

export type CoreRecordType = 'person' | 'organisation' | 'activity';

/** A shared record. Its ref is `core:<type>:<id>`. */
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

export interface Identities {
  emails?: string[];
  phones?: string[];
  domains?: string[];
}

/**
 * Shared records: people, organisations and activities every module points
 * at, so a contact exists once. A module keeps its own types in its own
 * tables and links them to core records by ref (`<module>:<type>:<id>`).
 * Writes are recorded as made by `module:<id>`.
 */
export interface ModuleRecords {
  /** `<this module>:<type>:<id>`, the ref of one of this module's own records. */
  ref(type: string, id: string | number): string;
  /**
   * The person or organisation these identities belong to, created unless
   * `create` is false. Throws when they belong to two different records.
   */
  resolve(
    type: 'person' | 'organisation',
    input: Identities & { name?: string; data?: Record<string, unknown>; create?: boolean }
  ): { record: CoreRecord | null; created: boolean; matchedBy: string[] };
  get(id: string): CoreRecord | null;
  list(opts?: { type?: CoreRecordType; q?: string; limit?: number }): CoreRecord[];
  update(
    id: string,
    patch: {
      name?: string | null;
      data?: Record<string, unknown>;
      add?: Identities;
      remove?: Identities;
    }
  ): CoreRecord;
  link(from: string, to: string, kind: string): RecordLink;
  unlink(from: string, to: string, kind: string): boolean;
  links(ref: string): RecordLink[];
  /** Something that happened about one or more refs: `{ kind: 'email.sent', summary, refs }`. */
  addActivity(input: {
    kind: string;
    summary: string;
    refs: string[];
    at?: string;
    data?: Record<string, unknown>;
  }): CoreRecord;
  activities(ref: string, limit?: number): CoreRecord[];
}

export interface SearchResult {
  /** `<module>:<type>:<id>`. */
  ref: string;
  title: string;
  subtitle?: string;
  /** `<module>:<type>`; taken from the ref when absent. */
  type?: string;
  /** A path in the module's UI that opens it. */
  path?: string;
  /** 0 to 1; default 0.5. */
  score?: number;
}

export type SearchHandler = (
  q: string,
  opts: { limit: number; types?: string[]; signal: AbortSignal }
) => SearchResult[] | Promise<SearchResult[]>;

/** Global search. A handler gets 1.5 seconds; after that its results are left out. */
export interface ModuleSearch {
  register(handler: SearchHandler): void;
}

export type InboxKind = 'approval' | 'reply' | 'task' | 'alert';

export interface InboxItem {
  id: string;
  moduleId: string | null;
  externalId: string | null;
  kind: InboxKind;
  title: string;
  body: string | null;
  ref: string | null;
  link: string | null;
  status: 'open' | 'done' | 'dismissed';
  priority: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/**
 * The one inbox: what is waiting for a person. Adding an item with the same
 * `externalId` again updates and reopens it.
 */
export interface ModuleInbox {
  add(item: {
    kind: InboxKind;
    title: string;
    body?: string;
    /** The record it is about. */
    ref?: string;
    /** A path in this module's UI. */
    link?: string;
    priority?: number;
    dueAt?: string;
    externalId?: string;
  }): InboxItem;
  /** Close (or reopen) one of this module's items, by its inbox id or externalId. */
  resolve(idOrExternalId: string, status?: 'done' | 'dismissed' | 'open'): InboxItem;
  /**
   * A person answered one of this module's items (POST /inbox/items/:id/respond).
   * Unless the handler throws, the item is then done.
   */
  onRespond(
    handler: (item: InboxItem, response: { text?: string; data?: unknown; by: string }) => unknown
  ): void;
}

export interface ModuleLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * What a manifest's `permissions` declare: shown to the person, recorded, part
 * of what they approve, and (when they turn enforcement on) checked on what a
 * plugin does through its context.
 */
export interface PluginPermissions {
  /** Exact commands it runs through `ctx.exec`. */
  exec: string[];
  /** Directories it reads and writes through `ctx.fs`. */
  fs: { read: string[]; write: string[] };
  /** Hosts it calls through `ctx.fetch`: `api.example.com`, `*.example.com`, `host:443`. */
  net: string[];
  /** Its vault names, without the `<id>/` prefix. */
  secrets: string[];
  /** launchd labels. */
  services: string[];
  /** Whether it calls models. Recorded; the context offers no model helper yet. */
  llm: boolean;
  /**
   * The core endpoints its UI or server calls, as `METHOD /path` patterns
   * (`GET /runs/:id`, `* /records/*`). A UI token reaches these and nothing else of the core API.
   */
  api: string[];
  /** The memory types it reads and writes. Recorded; the context offers no memory helper yet. */
  memory: { read: string[]; write: string[] };
}

/** The pre-1.0 name of {@link PluginPermissions}. */
export type ModulePermissions = PluginPermissions;

/** Raised, and audited, when enforcement is on and a plugin goes beyond what it declared. */
export class PluginPermissionError extends Error {
  readonly code = 'plugin_permission_denied';
  constructor(
    message: string,
    /** Which permission: `secrets`, `services`, `exec`, `net`, `fs.read` or `fs.write`. */
    readonly permission: string,
    /** What it asked for: a secret name, a label, a command, a host, a path. */
    readonly subject: string
  ) {
    super(message);
    this.name = 'PluginPermissionError';
  }
}

/** What `ctx.exec` gives back. A command that ran and failed still resolves, with its exit code. */
export interface ExecResult {
  /** The exit code; null when a signal ended it. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The command ran past its time limit and was stopped. */
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  /** Added to a small default environment (PATH, HOME, LANG, TMPDIR, USER); the gateway's own environment is not passed on. */
  env?: Record<string, string>;
  /** Default 60 000. */
  timeoutMs?: number;
  /** Written to the command's standard input. */
  input?: string;
  /** Output kept per stream, in bytes. Default 1 MiB; more is cut. */
  maxOutputBytes?: number;
}

/**
 * Run a program, without a shell. With enforcement on, `cmd` must be one of the
 * manifest's `permissions.exec`, written exactly as it is declared. With it off
 * it runs anyway and a use outside the declaration is audited. The arguments and
 * what the program does are not checked.
 */
export interface PluginExec {
  (cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/**
 * `fetch` for declared hosts. With enforcement on, the host (and port, when the
 * declaration names one) of the URL, and of every redirect it follows, must be in
 * `permissions.net`. Only `http` and `https` are allowed.
 */
export type PluginFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Files, for declared directories. Paths are absolute (or start with `~/`). With
 * enforcement on, the path must be inside a directory of `permissions.fs.read`
 * (reading) or `permissions.fs.write` (writing) after symbolic links are
 * resolved; `..` and a link that leads out are refused.
 */
export interface PluginFs {
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

/** What `ctx.setInterval` and `ctx.setTimeout` give back. */
export interface PluginTimer {
  /** Cancel it. Safe to call again. */
  clear(): void;
}

export interface PluginContext {
  /** The manifest id. */
  readonly id: string;
  /** The plugin's directory on disk. */
  readonly dir: string;
  readonly version: string;
  /**
   * Settings: the manifest's `config` defaults, overlaid with
   * `~/.clerq/modules/<id>.json` when that file exists.
   */
  readonly config: Readonly<Record<string, unknown>>;
  /** What the manifest declares. */
  readonly permissions: Readonly<PluginPermissions>;
  /**
   * The tenant this call runs in: the request's, or `default` for background
   * work (triggers, timers). A single-tenant install only ever sees `default`.
   */
  readonly tenant: string;
  /** Run `fn` as tenant `tenantId`, e.g. a nightly job going through each tenant. */
  withTenant<T>(tenantId: string, fn: () => T): T;
  routes: ModuleRoutes;
  store: ModuleStore;
  secrets: ModuleSecrets;
  events: ModuleEvents;
  triggers: ModuleTriggers;
  notify: ModuleNotify;
  services: ModuleServices;
  records: ModuleRecords;
  search: ModuleSearch;
  inbox: ModuleInbox;
  approvals: ModuleApprovals;
  audit: ModuleAudit;
  logger: ModuleLogger;
  exec: PluginExec;
  fetch: PluginFetch;
  fs: PluginFs;
  /**
   * Timers the gateway cancels when the plugin stops. A callback that throws or
   * rejects is logged; it never takes the gateway down. They never keep the
   * process alive.
   */
  setInterval(fn: () => unknown, ms: number): PluginTimer;
  setTimeout(fn: () => unknown, ms: number): PluginTimer;
}

/** The pre-1.0 name of {@link PluginContext}: the same object. */
export type ModuleContext = PluginContext;

/** What a plugin exports, as its default or as named exports. Every hook is optional but `register`. */
export interface PluginDefinition {
  /**
   * Called once at every start, after the plugin's migrations. Set things up:
   * routes, triggers, subscriptions, handlers.
   */
  register(ctx: PluginContext): void | Promise<void>;
  /** Called after `register` succeeded. Begin work: connect, start timers. */
  start?(ctx: PluginContext): void | Promise<void>;
  /**
   * Called when the plugin is disabled or the gateway closes, only for a plugin
   * whose `start` finished. It has five seconds when disabled and two at close;
   * after that the host moves on. Whatever the plugin registered through the
   * context is removed afterwards.
   */
  stop?(ctx: PluginContext): void | Promise<void>;
  /**
   * Called before `register` when the version differs from the one that last
   * started (`from`). It may run again if a later hook failed, so make it safe to repeat.
   */
  upgrade?(ctx: PluginContext, info: { from: string }): void | Promise<void>;
}

/** The pre-1.0 contract: `register` only. */
export type ClerqModule = PluginDefinition;

/** Identity at runtime; it exists so a plugin's hooks are type-checked. */
export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

/** Identity at runtime; the pre-1.0 spelling of {@link definePlugin}. */
export function defineModule(module: PluginDefinition): PluginDefinition {
  return module;
}

/** The prefix a plugin's tables carry: `mod_<id>__`, hyphens in the id as underscores; the double underscore keeps one plugin's prefix from covering another's. */
export function tablePrefix(moduleId: string): string {
  return `mod_${moduleId.replace(/-/g, '_')}__`;
}
