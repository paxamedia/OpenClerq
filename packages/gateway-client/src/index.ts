/**
 * Gateway API client for Clerq desktop and modules.
 * Base URL can be overridden via setGatewayBaseUrl (e.g. from saved settings).
 *
 * Every call goes to `/v1/...` and carries `Clerq-Api-Version`; see
 * docs/API.md. `checkCompatibility()` says whether a gateway speaks what this
 * client needs.
 */

import {
  API_VERSION,
  API_VERSION_HEADER,
  SUPPORTED_API_VERSIONS,
  apiPrefix,
  incompatibilityReason,
  parseApiVersion,
  type ApiVersionMismatch,
  type UnsupportedApiVersion,
  type VersionInfo,
} from './protocol.js';

export {
  API_VERSION,
  API_VERSION_HEADER,
  SUPPORTED_API_VERSIONS,
  apiPrefix,
  incompatibilityReason,
  parseApiVersion,
};
export type { ApiVersionMismatch, UnsupportedApiVersion, VersionInfo };

// A run in plain words, shared by the desktop app and the command line.
export { describeStep, previousModel, stepLabel, toolLabel, type StepWords } from './words.js';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18790';

let gatewayBaseUrl: string = DEFAULT_GATEWAY_URL;
let gatewayToken: string | null = null;
let gatewayTenant: string | null = null;

/** The gateway's address without a trailing slash. */
function baseUrl(): string {
  return gatewayBaseUrl.replace(/\/$/, '');
}

/** A route's full address: the base, `/v1`, then the route's own path. */
function apiUrl(path: string): string {
  return `${baseUrl()}${apiPrefix()}${path.startsWith('/') ? path : `/${path}`}`;
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

/** What every request carries: the protocol version, the token and the tenant, when set. */
function authHeaders(): Record<string, string> {
  return {
    [API_VERSION_HEADER]: String(API_VERSION),
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

/**
 * The refusal a gateway gives a version it does not serve (400, before auth),
 * in plain words; null for any other answer.
 */
function versionRefusal(status: number, body: Record<string, unknown> | null): GatewayError | null {
  if (status !== 400 || !body) return null;
  if (body.error !== 'unsupported_api_version' && body.error !== 'api_version_mismatch')
    return null;
  const supported = Array.isArray(body.supported)
    ? body.supported.filter((v): v is number => typeof v === 'number')
    : [];
  const reason = incompatibilityReason(supported);
  const message =
    body.error === 'api_version_mismatch'
      ? 'The address and the Clerq-Api-Version header name different API versions.'
      : reason ||
        (typeof body.message === 'string'
          ? body.message
          : 'The gateway does not serve this API version.');
  return new GatewayError(message, status, body);
}

/** Read an error response's body once: its text, and its JSON when it was JSON. */
async function readRefusal(
  res: Response
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return {
      text,
      json: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null,
    };
  } catch {
    return { text, json: null };
  }
}

/**
 * Why a redirect is refused. A redirect would carry the request, and with a 307
 * or 308 its body, to wherever it points, and a plain-http hop would send them
 * in the clear: whoever chose this address chose it, not what answered there.
 */
function redirectRefusal(): GatewayError {
  const message =
    `${baseUrl()} answered with a redirect, and a redirect is not followed: it would send your ` +
    'requests to wherever it points. Use the address it should be reached at (an https:// address, ' +
    'when a proxy redirects http to https).';
  return new GatewayError(message, 0, { error: 'redirect_refused', message });
}

/** The responses `fetch` follows, or, in a browser, the opaque one it gives for `redirect: 'manual'`. */
function isRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(res.status);
}

/**
 * Every request to the gateway goes through here, and never follows a redirect:
 * the gateway does not redirect, so one is something else answering at the
 * address, and following it would send the request (a POST's body included) on.
 *
 * `redirect: 'manual'` and a look at the answer, not `redirect: 'error'`: with
 * 'error', Node's fetch sometimes leaves a stream running after its signal is
 * aborted (an event stream that never ended, in about one run in eight of the
 * CLI's tests), and with 'manual' it does not.
 */
async function gatewayFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (isRedirect(res)) {
    void res.body?.cancel().catch(() => undefined);
    throw redirectRefusal();
  }
  return res;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await gatewayFetch(apiUrl(path), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options?.headers },
  });
  if (!res.ok) {
    const { text, json } = await readRefusal(res);
    throw (
      versionRefusal(res.status, json) ??
      new GatewayError(`Gateway ${res.status}: ${text || res.statusText}`, res.status, json)
    );
  }
  return res.json() as Promise<T>;
}

/** A DELETE that answers `{ ok: true }`, with the token the gateway needs. */
async function deleteOk(path: string): Promise<{ ok: boolean }> {
  const res = await gatewayFetch(apiUrl(path), { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const { json } = await readRefusal(res);
    throw (
      versionRefusal(res.status, json) ?? new Error(String(json?.error ?? `Gateway ${res.status}`))
    );
  }
  return { ok: true };
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
  /** The API versions the gateway serves; absent from a gateway older than 1.0. */
  api?: { version: number; supported: number[] };
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
  /** `subagent`: started by another run's agent (`sessions.spawn`); see `parentRunId`. */
  trigger: 'schedule' | 'event' | 'manual' | 'webhook' | 'subagent';
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
  /** A model a person named for this run, used as chosen: it never fell back to another. */
  modelOverride?: string;
  /** A sub-agent's run: the run whose agent started it. */
  parentRunId?: string;
  /** The session holding the run's transcript (a sub-agent's task and answer). */
  sessionId?: string;
  /**
   * What the sub-agents it started cost, on top of `costUsd`. Absent when it
   * started none (or none that cost anything), and from an older gateway.
   */
  childCostUsd?: number;
  /**
   * False when a sub-agent made a model call with no price, so `childCostUsd` is
   * a lower bound. Absent when every sub-agent's cost is known, when it had none,
   * and from an older gateway.
   */
  childCostKnown?: false;
}

/** A sub-agent a run started, as the run's detail lists it. */
export interface ChildRunSummary {
  id: string;
  status: string;
  /** Its task. */
  input?: string;
  exitReason?: string;
  costUsd: number;
  costKnown: boolean;
  sessionId?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ArtifactInfo {
  id: number;
  kind: 'diff' | 'log' | 'file' | 'report';
  name?: string;
  size: number;
  sha256: string;
}

/** What a memory record is: the five kinds a record can be. */
export type MemoryType = 'fact' | 'preference' | 'decision' | 'procedure' | 'note';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'fact',
  'preference',
  'decision',
  'procedure',
  'note',
];

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  key: string;
  value: unknown;
  /** Who wrote it: a person, an agent, an import of older data, or a summary the model made. */
  origin: 'user' | 'agent' | 'import' | 'consolidation';
  /** True when an agent wrote this record, or any record folded into it by a summary did. */
  agentDerived?: true;
  /** The chat session or run it was learned in. */
  sourceSession?: string;
  /** How sure the writer was, from 0 to 1. */
  confidence?: number;
  /** `superseded`: folded into the summary `supersededBy`, kept so it can be restored. */
  status: 'active' | 'superseded';
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  /** After this time the record is no longer read, and is removed. */
  expiresAt?: string;
}

/** A search result: a record and how well it matched (higher is better; 0 for a substring match). */
export interface MemoryHit extends MemoryRecord {
  score: number;
}

export interface RunDetail extends RunSummary {
  steps: RunStep[];
  /** The tool calls its agent made, in order. Absent from an older gateway. */
  toolCalls?: ToolCallRecord[];
  artifacts: ArtifactInfo[];
  /** The sub-agents it started, oldest first. Absent from an older gateway. */
  children?: ChildRunSummary[];
}

/**
 * A repository an automation targets, as GET /repos lists it. A row is made the
 * first time a run of an automation naming it is queued.
 */
export interface RepoSummary {
  id: string;
  kind: 'local' | 'github' | 'gitlab';
  /** `owner/name` for a remote, the folder's name for a local repository. */
  name: string;
  /** The https URL of a remote; null for a local repository. */
  url: string | null;
  /**
   * Where it is on this computer: the repository (`repository`) or a remote's
   * clone in the workspace cache (`clone`). Null for a remote no run has
   * cloned yet. `exists: false` is a folder that has gone since.
   */
  path: { value: string; exists: boolean; role: 'repository' | 'clone' } | null;
  /**
   * The vault secret named by the last run queued for it: a name, never a
   * value. Automations can differ, so read `automations[].credential` first;
   * this is what is left when none targets it now.
   */
  credential: { secret: string; present: boolean } | null;
  /**
   * How a run would reach this GitHub repository by default (`publish.auth:
   * auto`): through the user's GitHub App when it is installed here, else the
   * secret above. Null for a local repository and for GitLab.
   */
  reachedWith?: RepoReach | null;
  /**
   * The automations whose spec targets it now, each with the secret its own spec
   * reaches the forge with (null for a local repository it neither pushes nor
   * opens a pull request on), its `publish.auth`, and what that reaches it with.
   */
  automations: Array<{
    id: string;
    name: string;
    enabled: boolean;
    credential: {
      secret: string;
      present: boolean;
      auth?: 'auto' | 'app' | 'token';
      reachedWith?: RepoReach | null;
    } | null;
  }>;
  /** Runs waiting for a place, and runs using it now (an approval wait counts). */
  runs: { queued: number; running: number };
  lastRun: {
    id: string;
    status: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
  } | null;
  createdAt: string;
}

/**
 * How a run would reach a repository's forge: through the GitHub App (a token
 * for this repository only), the vault secret, or not at all. Read from GitHub's
 * installation lookup, never by making a token.
 */
export interface RepoReach {
  /** `unknown`: the app is connected, but GitHub could not say whether it is installed here. */
  via: 'app' | 'secret' | 'none' | 'unknown';
  /** The connected app, and the installation on this repository when there is one. */
  app?: { slug: string; installationId?: number };
  /** The vault secret that is used (`secret`) or is missing (`none`). */
  secret?: string;
  /** Why the app is not used, or what a run would do. */
  note?: string;
}

/** One repository, with its latest 20 runs, newest first. */
export interface RepoDetail extends RepoSummary {
  recentRuns: RunSummary[];
}

/** What `check: true` found out about a remote repository. Nothing in it is a token. */
export interface RepoCheck {
  reachable: boolean;
  /** In words: what was reached, or why not. */
  message: string;
  /** The remote's default branch, when it said. */
  defaultBranch?: string;
  /** The vault secret asked for and whether the credential lookup found one; never its value. */
  credential: { secret: string; present: boolean; source?: string };
}

/** The answer to adding a repository by hand. */
export interface AddRepoResult extends RepoSummary {
  /** False when the repository was already listed: the existing row is returned. */
  created: boolean;
  /** Present when `check` was asked for and the target is a remote. */
  check?: RepoCheck;
}

// --- GitHub: the app, and the person's sign-in -----------------------------------------
//
// Every address in these answers has been checked by the gateway (https, on GitHub's
// website, and an avatar's only https), and a screen checks the scheme once more before it
// makes a link. A token is in none of them: see docs/GITHUB.md.

/** What `POST /github/app/manifest` answers: a page for the browser to post to, and what to post. */
export interface GithubManifestOffer {
  /** Where the browser posts a form with one field, `manifest`. */
  url: string;
  /** The JSON to put in that field. */
  manifest: Record<string, unknown>;
  state: string;
  /** When the state stops working: ten minutes after it was made. */
  expiresAt: string;
  /** Where GitHub sends the browser back to. */
  redirectUrl: string;
}

/** The connected GitHub App. Nothing in it is secret. */
export interface GithubAppInfo {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  owner: { login: string; type: string } | null;
  htmlUrl: string;
  /** Where to install the app on accounts and repositories. */
  installUrl: string;
  /** The app's settings page: its keys, "Enable Device Flow", and where it is deleted. */
  settingsUrl: string;
  source: 'manifest' | 'import';
  createdAt: string;
  keyUpdatedAt?: string;
  warnings?: string[];
}

export interface GithubInstallation {
  id: number;
  account: string | null;
  accountType: string | null;
  repositorySelection: 'all' | 'selected' | null;
  suspended: boolean;
  permissions: Record<string, string>;
  htmlUrl: string | null;
}

/** `GET /github/app`. */
export interface GithubAppStatus {
  connected: boolean;
  app?: GithubAppInfo;
  /** Which secrets are in the vault, never what they are. */
  secrets?: { privateKey: boolean; clientSecret: boolean };
  /** Where the app is installed; null when GitHub could not be asked (see `installationsError`). */
  installations?: GithubInstallation[] | null;
  /** Why GitHub could not be asked. A key GitHub refused says to generate a new one and import it. */
  installationsError?: string;
  warnings?: string[];
}

export interface GithubImportInput {
  appId: number | string;
  clientId: string;
  /** The contents of the .pem file. */
  privateKey: string;
  clientSecret?: string;
}

export interface GithubImportResult {
  connected: true;
  app: GithubAppInfo;
  /** The same app's key was replaced. */
  replacedKey: boolean;
}

/** `DELETE /github/app`. The app itself stays on GitHub. */
export interface GithubDisconnectResult {
  disconnected: true;
  slug: string;
  appDeletedOnGitHub: false;
  settingsUrl: string;
  /** Present when somebody was signed in: they were signed out with the app. */
  user?: GithubSignOutResult;
  message: string;
}

/** `POST /github/login`: what to type on GitHub. */
export interface GithubLoginStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  /** Seconds between looks. */
  interval: number;
}

export type GithubLoginState = 'pending' | 'approved' | 'denied' | 'expired' | 'disabled' | 'error';

/** Who is signed in, as GitHub says. An address that is not safe is null. */
export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
}

/** `GET /github/login/{flowId}`. */
export interface GithubLoginStatus {
  status: GithubLoginState;
  message?: string;
  /** For `disabled`: the app's settings page, where Enable Device Flow is. */
  settingsUrl?: string;
  user?: GithubUser | null;
  /** While pending: when the code stops working, and the seconds between looks now. */
  expiresAt?: string;
  interval?: number;
}

/** `GET /github/user`. */
export interface GithubUserStatus {
  signedIn: boolean;
  user?: GithubUser;
  /** When the user token stops working, if the app expires them. */
  expiresAt?: string;
  /** A renewal is possible (a refresh token and the app's client secret). */
  refreshable: boolean;
  /** Why not signed in (ran out, revoked) or what is wrong, in words. */
  message?: string;
}

/** `DELETE /github/user`. */
export interface GithubSignOutResult {
  signedOut: true;
  /** GitHub revoked the authorization too. */
  revoked: boolean;
  message: string;
  /** Where a person revokes an app's access on GitHub themselves. */
  authorizationsUrl: string;
}

/** One repository the signed-in person reaches through the app. */
export interface GithubUserRepository {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string | null;
  installationId: number;
  account: string | null;
  /** OpenClerq already has a repository row for it. */
  added: boolean;
  repoId?: string;
}

/** `GET /github/user/repositories`. */
export interface GithubUserRepositories {
  repositories: GithubUserRepository[];
  /** The list stops at `limit`; there are more. */
  truncated: boolean;
  limit: number;
  message?: string;
  warnings?: string[];
}

export interface DriverInfo {
  id: string;
  available: boolean;
  path?: string;
  version?: string;
  /** Whether the CLI reports a signed-in account. Absent when it was not checked. */
  signedIn?: boolean;
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
  /** A run is waiting in the queue: for a place under the limit, or a retry's backoff. */
  queued?: boolean;
  /** The spec's `on.catch_up`. */
  catchUp?: boolean;
  /** The latest schedule slots skipped because nobody was awake for them. */
  missedSlots?: {
    count: number;
    capped: boolean;
    first: string;
    last: string | null;
    reason: 'catch_up_off' | 'paused' | 'already_queued' | 'enqueue_failed';
    error?: string;
    noticed: string;
    at: string;
  } | null;
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
  /** Where the spec came from when not typed by a person: `chat <session id>` for a chat draft. */
  authoredBy?: string | null;
  updatedAt: string;
}

export interface AutomationPreview {
  /** The spec as the gateway read it. Only `name` is promised here. */
  spec?: { name: string; [key: string]: unknown };
  nextRunAt: string | null;
  nextFirings: string[];
  /**
   * The repository as the spec names it (`target`): a local `path` with its
   * `origin`, or a remote's `url`, with the forge and project either way.
   * `cache` is a remote's clone, once a run has made it.
   */
  repo: {
    target: string;
    path?: string;
    origin?: string | null;
    url?: string;
    forge?: 'github' | 'gitlab' | null;
    project?: string | null;
    base?: string;
    cache?: string;
  };
  driver: DriverInfo;
  checks: Array<{ level: 'ok' | 'warning' | 'error'; message: string }>;
  ready: boolean;
  /** The rules a run would be decided by; `approvalRequired` lists what waits for a person. */
  policy?: {
    allow?: string[];
    deny?: string[];
    approvalRequired?: string[];
    maxCallsPerRun?: number;
  };
}

/** What saving a chat draft and running it would do, worked out without doing it. */
export interface DraftDryRun extends AutomationPreview {
  draftId: string;
  /** The host's time zone, which the schedule and `nextFirings` are in. */
  timeZone: string;
  estimate: {
    /** Average cost of past finished runs of the same driver and model; null without any. */
    perRunUsd: number | null;
    perMonthUsd: number | null;
    basedOnRuns: number;
    /** Firings in the next 30 days. Null without a schedule. */
    firingsPerMonth: number | null;
    capPerRunUsd: number | null;
    capPerMonthUsd: number | null;
    note: string;
  };
  /** Always false: a dry run executes nothing. */
  executed: false;
}

/** An automation a model drafted in a chat. Saving it is a person's action, and it starts off. */
export interface ChatDraft {
  id: string;
  sessionId: string;
  runId: string | null;
  name: string;
  /** The YAML as drafted. */
  source: string;
  summary: {
    name: string;
    description?: string;
    schedule: string | null;
    nextRunAt: string | null;
    repo: string;
    driver: string;
    model: string | null;
    push: boolean;
    pullRequest: 'draft' | 'none';
    /** What the draft asked for; the first push waits for approval either way. */
    pushApproval: 'manual' | 'auto';
    maxUsdPerRun: number | null;
    maxUsdPerMonth: number | null;
    prompt: string;
    /** Each gate command and diff assertion, as written. */
    gates: string[];
    sandbox: { profile: string; network: 'all' | string[] | null };
    permissionMode: string;
    allowedTools: string[];
    memoryRead: string[];
    memoryIncludeAgent: boolean;
    /** What to look at before saving, in words: push without asking, no isolation, gates. */
    warnings: string[];
  } | null;
  /** Why it no longer passes the checks. */
  problem?: string;
  /** The automation it was saved as. */
  automationId: string | null;
  savedAt: string | null;
  /** When this YAML was dry-run; saving needs one. */
  dryRunAt: string | null;
  createdAt: string;
}

/** One tool call of a run's agent, as GET /runs/:id and /runs/:id/tool-calls list it. */
export interface ToolCallRecord {
  id: number;
  /** The run step that shows it. */
  stepSeq?: number;
  callId?: string;
  /** The tool as policy names it (`fs.write`, `memory.write.fact`, `automation.draft`). */
  name: string;
  input?: unknown;
  output?: string;
  status: 'running' | 'ok' | 'error' | 'denied';
  durationMs?: number;
  /** Whether a person was asked; null when the driver does not say (a CLI agent). */
  approvalState: 'not_required' | 'approved' | 'denied' | null;
  createdAt: string;
  finishedAt?: string;
}

/** What managed mode adds to a message, beside what raw sends (POST /sessions/:id/mode-diff). */
export interface ModeDiff {
  raw: {
    system: null;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    tools: [];
    memory: null;
    model: string | null;
    fallbackModels: [];
  };
  managed: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    skill: { slug?: string; name?: string; instructions?: string } | null;
    memory: { text: string; count: number } | null;
    tools: Array<{
      name: string;
      modelName: string;
      risk: string;
      decision: 'allow' | 'needs_approval';
    }>;
    model: string;
    /** A model a person chose: used as chosen, with no fallback. */
    chosen: boolean;
    fallbackModels: string[];
    workspace: string | null;
    permissionMode: ChatPermissionMode;
  };
}

/** What a managed message streams besides its text. */
export type ChatStreamEvent =
  | { type: 'tool'; id: string; name: string; status: 'running' | 'ok' | 'error' | 'denied' }
  | { type: 'approval'; approval: Approval & { input?: unknown } }
  | { type: 'approval_decided'; id: number; approved: boolean }
  | { type: 'draft'; draft: Pick<ChatDraft, 'id' | 'name' | 'summary'> };

/** One event from the gateway's bus, as GET /events/stream sends it. */
export interface ClerqEvent<T = unknown> {
  /** `<epoch>-<seq>`; pass the last one seen to resume. */
  id: string;
  /** e.g. `run.started`, `approval.requested`, `module.<id>.<name>`. */
  name: string;
  at: string;
  context: {
    requestId?: string;
    sessionId?: string;
    runId?: string;
    /** For a sub-agent's run: the run whose agent started it. */
    parentRunId?: string;
    toolCallId?: string;
  };
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
  /** `plugin` has a manifest of version 1; `legacy` is a module written before it. */
  kind?: 'plugin' | 'legacy';
  state?: PluginState;
  /** Where its UI is served, e.g. `/api/modules/<id>/ui/`; null without one. */
  ui: string | null;
  badge: string | null;
  /** What the manifest declares it needs. Checked only when plugin enforcement is on. */
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

/** What a plugin declares it needs; shown, recorded and approved. */
export interface PluginPermissionsInfo {
  exec: string[];
  fs: { read: string[]; write: string[] };
  net: string[];
  secrets: string[];
  services: string[];
  llm: boolean;
  /** Core endpoints, as `METHOD /path`. */
  api: string[];
  memory: { read: string[]; write: string[] };
}

export type PluginState = 'disabled' | 'awaiting_approval' | 'enabled' | 'failed' | 'refused';

/** One thing that changed in what a plugin declares since it was approved. */
export interface PluginPermissionChange {
  change: 'added' | 'removed';
  key: string;
  item: string;
  /** "Can now connect to api.example.com". */
  text: string;
}

/** A module or plugin, as GET /plugins lists it. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  /** `plugin` has a manifest of version 1; `legacy` is a module written before it. */
  kind: 'plugin' | 'legacy';
  dir: string;
  state: PluginState;
  /** Why it is not enabled: the error, the engine, what it waits for. */
  reason: string | null;
  /** The person turned it off. */
  switchedOff: boolean;
  /** The API version it needs; null for a legacy module. */
  engine: number | null;
  /** What its manifest declares. */
  permissions: PluginPermissionsInfo;
  /** Of what it declares and of its code: an approval names both. */
  permissionsHash: string | null;
  checksum: string | null;
  warnings: string[];
  approval: {
    status: 'approved' | 'not_approved' | 'changed';
    approvedAt: string | null;
    approvedBy: string | null;
    approvedVersion: string | null;
    changes: { code: boolean; permissions: boolean; version: boolean };
    permissionChanges: PluginPermissionChange[];
  };
  /** The files on disk differ from what is running. */
  needsRestart: boolean;
  ui: string | null;
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

export interface RemoteSettings {
  enabled: boolean;
  /** The HTTPS address of the user's tunnel or reverse proxy. */
  publicUrl: string | null;
  ntfyServer: string;
}

export interface Device {
  id: string;
  tenantId: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Where the gateway publishes this device's pushes (ntfy). */
  push: { server: string; topic: string } | null;
}

export interface Approval {
  id: number;
  runId: string;
  tool: string;
  tier: 'low' | 'medium' | 'high';
  reason: string;
  requestedAt: string;
  /** Asked by a sub-agent: the run that started it. */
  parentRunId?: string;
  /** Asked from a chat: the conversation waiting for the answer. */
  sessionId?: string;
}

export type PipelineMode = 'raw' | 'managed';

/**
 * How a managed conversation's agent treats the attached folder: full access, ask first,
 * read only, or (macOS) sandboxed: writes only in the folder, no network, credentials unreadable.
 */
export type ChatPermissionMode = 'acceptEdits' | 'default' | 'plan' | 'sandboxed';

export interface ChatSession {
  id: string;
  title: string | null;
  mode: PipelineMode;
  model: string | null;
  /** A folder attached to a managed conversation; its agent works there. Absent from an older gateway. */
  workspace?: string | null;
  permissionMode?: ChatPermissionMode;
  /** Whether this machine can run the Sandboxed access level. */
  sandboxAvailable?: boolean;
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
    /** Managed: tool calls made, drafts proposed, the skill and the saved notes read. */
    toolCalls?: number;
    drafts?: Array<{ id: string; name: string }>;
    skillSlug?: string;
    memoryCount?: number;
    workspace?: string;
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

/** How a gateway answers "do you speak what this client needs". */
export type CompatibilityKind =
  /** It serves this client's API version. */
  | 'compatible'
  /** It serves only newer versions. */
  | 'gateway_newer'
  /** It serves only older versions, or predates versioned APIs (before 1.0). */
  | 'gateway_older'
  /** Nothing answered at the address. */
  | 'unreachable'
  /** Something answered, but not like an OpenClerq gateway. */
  | 'unexpected';

export interface CompatibilityResult {
  ok: boolean;
  kind: CompatibilityKind;
  /** The gateway's own release, when it said. */
  gateway: string | null;
  /** The API versions it serves; null when it said nothing (older than 1.0, unreachable). */
  api: { version: number; supported: number[] } | null;
  /** Plain words for what is wrong; null when `ok`. */
  reason: string | null;
}

function incompatible(
  kind: CompatibilityKind,
  reason: string,
  gateway: string | null = null,
  api: CompatibilityResult['api'] = null
): CompatibilityResult {
  return { ok: false, kind, gateway, api, reason };
}

/** Ask an address that is not answering /v1 whether it is a gateway from before 1.0. */
async function probeOlderGateway(): Promise<CompatibilityResult> {
  const where = baseUrl();
  let answered = false;
  let health = null as { service?: unknown; version?: unknown; api?: unknown } | null;
  try {
    // Without the version header or a token: a plain GET needs no CORS preflight,
    // which a gateway from before 1.0 would refuse for the header.
    const res = await gatewayFetch(`${where}/health`);
    answered = true;
    if (res.ok) health = (await res.json()) as typeof health;
  } catch (e) {
    // An address that redirects is something answering, not nothing: say so.
    if (e instanceof GatewayError && e.body?.error === 'redirect_refused') {
      return incompatible('unexpected', e.message);
    }
    /* nothing there, or not JSON */
  }
  if (!answered) {
    return incompatible('unreachable', `Nothing answered at ${where}. Is OpenClerq running?`);
  }
  if (!health || health.service !== 'clerq-gateway' || health.api !== undefined) {
    return incompatible(
      'unexpected',
      `Something answered at ${where}, but not like an OpenClerq gateway.`
    );
  }
  const version = typeof health.version === 'string' ? health.version : null;
  return incompatible(
    'gateway_older',
    `This gateway${version ? ` (version ${version})` : ''} is older than 1.0 and does not report an API version. ` +
      'Update the gateway, or the background service it runs in.',
    version
  );
}

async function checkCompatibility(): Promise<CompatibilityResult> {
  let res: Response;
  try {
    res = await gatewayFetch(apiUrl('/version'), {
      headers: { [API_VERSION_HEADER]: String(API_VERSION) },
    });
  } catch (e) {
    if (e instanceof GatewayError && e.body?.error === 'redirect_refused') {
      return incompatible('unexpected', e.message);
    }
    // A gateway from before 1.0 refuses the version header in a browser's
    // preflight, which looks the same as nothing listening. Ask it plainly.
    return probeOlderGateway();
  }

  if (res.ok) {
    let info: Partial<VersionInfo> | null = null;
    try {
      info = (await res.json()) as Partial<VersionInfo>;
    } catch {
      /* not JSON */
    }
    const supported = info?.api?.supported;
    if (!info || !Array.isArray(supported) || typeof info.api?.version !== 'number') {
      return incompatible(
        'unexpected',
        `Something answered at ${baseUrl()}, but not like an OpenClerq gateway.`
      );
    }
    const api = {
      version: info.api.version,
      supported: supported.filter((v) => typeof v === 'number'),
    };
    const gatewayVersion = typeof info.gateway === 'string' ? info.gateway : null;
    if (api.supported.includes(API_VERSION)) {
      return { ok: true, kind: 'compatible', gateway: gatewayVersion, api, reason: null };
    }
    const newer = Math.max(...api.supported) > API_VERSION;
    return incompatible(
      newer ? 'gateway_newer' : 'gateway_older',
      incompatibilityReason(api.supported),
      gatewayVersion,
      api
    );
  }

  const { json } = await readRefusal(res);
  const refused = versionRefusal(res.status, json);
  if (refused) {
    const supported = Array.isArray(json?.supported)
      ? (json.supported as unknown[]).filter((v): v is number => typeof v === 'number')
      : [];
    const newer = supported.length > 0 && Math.max(...supported) > API_VERSION;
    return incompatible(
      newer ? 'gateway_newer' : 'gateway_older',
      refused.message,
      null,
      supported.length > 0 ? { version: Math.max(...supported), supported } : null
    );
  }
  // A gateway from before 1.0 has no /v1 and no public /version: 404 with a token, 401 without.
  if (res.status === 404 || res.status === 401) return probeOlderGateway();
  return incompatible('unexpected', `The gateway answered ${res.status} to GET /version.`);
}

export const gateway = {
  getUrl: () => gatewayBaseUrl,

  health(): Promise<HealthResponse> {
    return fetchJson<HealthResponse>('/health');
  },

  /** GET /version: the gateway's release, the API versions it serves, the store's schema. */
  version(): Promise<VersionInfo> {
    return fetchJson<VersionInfo>('/version');
  },

  /**
   * Whether this gateway speaks the API version this client needs. Never
   * throws: an unreachable or older gateway is an answer, with the reason in
   * plain words. It needs no token (GET /version is public).
   */
  async checkCompatibility(): Promise<CompatibilityResult> {
    try {
      return await checkCompatibility();
    } catch {
      // A connection that dropped while the answer was being read.
      return incompatible('unreachable', `Nothing answered at ${baseUrl()}. Is OpenClerq running?`);
    }
  },

  metrics(): Promise<{
    version: string;
    uptime_seconds: number;
    service: string;
    llm_cost_usd_total?: number;
    llm_unpriced_calls_total?: number;
    /** Times a call or a run moved to a fallback model because the one in use was unavailable. */
    llm_fallbacks_total?: number;
  }> {
    return fetchJson('/metrics');
  },

  /**
   * SSE endpoint URL. EventSource cannot set headers, so the token travels as a
   * query parameter — accepted by the gateway on this endpoint only.
   */
  logsStreamUrl(): string {
    const url = apiUrl('/logs/stream');
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
    return query ? `${apiUrl('/events/stream')}?${query}` : apiUrl('/events/stream');
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
        const res = await gatewayFetch(apiUrl(`/events/stream${query}`), {
          headers: { ...authHeaders(), ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
          signal,
        });
        if (!res.ok || !res.body) {
          const { json } = res.ok ? { json: null } : await readRefusal(res);
          throw (
            versionRefusal(res.status, json) ??
            new GatewayError(`Gateway ${res.status}`, res.status, json)
          );
        }
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
        // A refused token, or a version the gateway does not serve, will not get
        // better by retrying.
        if (
          e instanceof GatewayError &&
          (e.status === 401 ||
            e.body?.error === 'redirect_refused' ||
            versionRefusal(e.status, e.body))
        ) {
          throw e;
        }
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

  /**
   * The default model, and the models chat and tasks use, in order, when it is
   * unavailable. A call that names a model of its own never falls back.
   */
  routing(): Promise<{
    default: { provider: string; model: string };
    fallback: string[];
    maxFallback: number;
  }> {
    return fetchJson('/routing');
  },

  setRouting(fallback: string[]): Promise<{ fallback: string[] }> {
    return fetchJson('/routing', { method: 'PUT', body: JSON.stringify({ fallback }) });
  },

  // --- Chat console -----------------------------------------------------

  sessions(limit = 50): Promise<{ sessions: ChatSession[] }> {
    return fetchJson(`/sessions?limit=${encodeURIComponent(String(limit))}`);
  },

  createSession(
    input: {
      title?: string;
      mode?: PipelineMode;
      model?: string;
      workspace?: string;
      permissionMode?: ChatPermissionMode;
    } = {}
  ): Promise<ChatSession> {
    return fetchJson('/sessions', { method: 'POST', body: JSON.stringify(input) });
  },

  session(id: string): Promise<ChatSession & { messages: ChatMessage[] }> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}`);
  },

  updateSession(
    id: string,
    patch: {
      title?: string;
      mode?: PipelineMode;
      model?: string | null;
      /** A folder path to attach, or null to detach. */
      workspace?: string | null;
      permissionMode?: ChatPermissionMode;
    }
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
    signal?: AbortSignal,
    /** Managed: tool activity, approvals to answer, drafts, as they happen (streaming only). */
    onEvent?: (event: ChatStreamEvent) => void
  ): Promise<{ runId: string; message: ChatMessage }> {
    const res = await gatewayFetch(apiUrl(`/sessions/${encodeURIComponent(id)}/send`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...input, stream: Boolean(onDelta) }),
      signal,
    });
    if (!res.ok) {
      const { text, json } = await readRefusal(res);
      throw (
        versionRefusal(res.status, json) ??
        new Error(`Gateway ${res.status}: ${text || res.statusText}`)
      );
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
        else if (
          event.type === 'tool' ||
          event.type === 'approval' ||
          event.type === 'approval_decided' ||
          event.type === 'draft'
        )
          onEvent?.(event as unknown as ChatStreamEvent);
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

  /** What managed mode would add to `text` over raw, in this conversation. Calls no model. */
  modeDiff(id: string, input: { text: string; model?: string }): Promise<ModeDiff> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}/mode-diff`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /** Automations a model drafted in this conversation, oldest first. */
  drafts(id: string): Promise<{ drafts: ChatDraft[] }> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}/drafts`);
  },

  draft(id: string, draftId: string): Promise<ChatDraft> {
    return fetchJson(`/sessions/${encodeURIComponent(id)}/drafts/${encodeURIComponent(draftId)}`);
  },

  /** Check a draft against this machine and expand its schedule; executes nothing. */
  dryRunDraft(id: string, draftId: string): Promise<DraftDryRun> {
    return fetchJson(
      `/sessions/${encodeURIComponent(id)}/drafts/${encodeURIComponent(draftId)}/dry-run`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Save a draft as an automation. It starts switched off; enabling it is a separate action. */
  saveDraft(
    id: string,
    draftId: string
  ): Promise<{ id: string; name: string; enabled: false; authoredBy: string; source: string }> {
    return fetchJson(
      `/sessions/${encodeURIComponent(id)}/drafts/${encodeURIComponent(draftId)}/save`,
      { method: 'POST', body: '{}' }
    );
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

  /** The repositories automations target. Read-only. */
  repos(): Promise<{ repos: RepoSummary[] }> {
    return fetchJson('/repos');
  },

  repo(id: string): Promise<RepoDetail> {
    return fetchJson(`/repos/${encodeURIComponent(id)}`);
  },

  /**
   * Add a repository by hand, as an automation's `targets.repos` names it:
   * `local:<absolute path>` (a git work tree), `github:owner/name`,
   * `gitlab:group/name` or an https URL on either. Adding one that is listed
   * returns its row (`created: false`). With `check`, a remote is reached first
   * with the credential a run would use, and nothing is added if it cannot be:
   * that is a 422 `repo_unreachable` whose body carries `check`.
   */
  addRepo(target: string, opts: { check?: boolean } = {}): Promise<AddRepoResult> {
    return fetchJson('/repos', {
      method: 'POST',
      body: JSON.stringify(opts.check === undefined ? { target } : { target, check: opts.check }),
    });
  },

  automations(): Promise<{ automations: AutomationSummary[] }> {
    return fetchJson('/automations');
  },

  // --- GitHub: the app (operator only) --------------------------------------------------
  //
  // GET /github/app/callback is GitHub's own redirect to the browser, so it has no method
  // here: a client never calls it.

  /**
   * Start creating the app from a manifest. `baseUrl` is the address the person's
   * **browser** reaches this gateway at (GitHub sends it back there): http://127.0.0.1:<port>
   * on this computer, https anywhere else. The browser then posts `manifest` to `url`
   * as a form field named `manifest`; then poll `githubApp()` until it is connected.
   */
  githubManifest(input: {
    baseUrl: string;
    owner?: string;
    name?: string;
  }): Promise<GithubManifestOffer> {
    return fetchJson('/github/app/manifest', { method: 'POST', body: JSON.stringify(input) });
  },

  /** Use an app that exists: its id, client ID and private key (and, to renew sign-ins, its client secret). */
  importGithubApp(input: GithubImportInput): Promise<GithubImportResult> {
    return fetchJson('/github/app/import', { method: 'POST', body: JSON.stringify(input) });
  },

  /** The connected app and where it is installed. `refresh` asks GitHub again instead of the minute's cache. */
  githubApp(opts: { refresh?: boolean } = {}): Promise<GithubAppStatus> {
    return fetchJson(`/github/app${opts.refresh ? '?refresh=1' : ''}`);
  },

  /** Forget the app and its key (and sign the person out). The app stays on GitHub; the answer says where to delete it. */
  disconnectGithubApp(): Promise<GithubDisconnectResult> {
    return fetchJson('/github/app', { method: 'DELETE' });
  },

  // --- GitHub: the person's sign-in (the app's device flow) ------------------------------
  //
  // The user token is for who is signed in and which repositories they reach through the
  // app. It is not used to clone, push or open a pull request: runs use installation tokens.

  /** Start a device flow. The person types `userCode` at `verificationUri`; poll `githubLogin(flowId)`. */
  startGithubLogin(): Promise<GithubLoginStart> {
    return fetchJson('/github/login', { method: 'POST', body: '{}' });
  },

  githubLogin(flowId: string): Promise<GithubLoginStatus> {
    return fetchJson(`/github/login/${encodeURIComponent(flowId)}`);
  },

  cancelGithubLogin(flowId: string): Promise<{ cancelled: boolean }> {
    return fetchJson(`/github/login/${encodeURIComponent(flowId)}`, { method: 'DELETE' });
  },

  /** Who is signed in to GitHub, if anyone. */
  githubUser(): Promise<GithubUserStatus> {
    return fetchJson('/github/user');
  },

  /** Sign out, and revoke the authorization on GitHub when the app's client secret allows it. */
  githubSignOut(): Promise<GithubSignOutResult> {
    return fetchJson('/github/user', { method: 'DELETE' });
  },

  /** The repositories the signed-in person reaches through the app (at most 1,000; `truncated` says). */
  githubRepositories(): Promise<GithubUserRepositories> {
    return fetchJson('/github/user/repositories');
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

  /**
   * Start a run now. Resolves once the run exists; follow it with run().
   * `queued` is true when the run waits for a place under the limit on runs at once.
   * `model` runs it with that model instead of the spec's primary, used as chosen:
   * if it is unavailable the run fails, and does not fall back to another.
   */
  runAutomation(id: string, model?: string): Promise<{ runId: string; queued?: boolean }> {
    return fetchJson(`/automations/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify(model ? { model } : {}),
    });
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

  /** Every module and plugin, with its state, what it declares and what was approved. */
  plugins(): Promise<{ plugins: PluginInfo[]; enforce: boolean }> {
    return fetchJson('/plugins');
  },

  /** Turn a plugin on. With enforcement on and no approval it waits for one. */
  enablePlugin(id: string): Promise<{ plugin: PluginInfo }> {
    return fetchJson(`/plugins/${encodeURIComponent(id)}/enable`, { method: 'POST', body: '{}' });
  },

  /** Turn a plugin off: it is stopped and what it set up is removed. */
  disablePlugin(id: string): Promise<{ plugin: PluginInfo }> {
    return fetchJson(`/plugins/${encodeURIComponent(id)}/disable`, { method: 'POST', body: '{}' });
  },

  /**
   * Approve a plugin: send the `permissionsHash` and `checksum` the list showed. A plugin
   * that has changed since gets 409 `approval_stale`: list it again and review what changed.
   */
  approvePlugin(
    id: string,
    seen: { permissionsHash: string; checksum: string }
  ): Promise<{ plugin: PluginInfo }> {
    return fetchJson(`/plugins/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify(seen),
    });
  },

  /** Whether plugin permissions are enforced. Off unless the person turned it on. */
  pluginSettings(): Promise<{ enforce: boolean }> {
    return fetchJson('/plugins/settings');
  },

  setPluginSettings(settings: { enforce: boolean }): Promise<{ enforce: boolean }> {
    return fetchJson('/plugins/settings', { method: 'PUT', body: JSON.stringify(settings) });
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

  // --- Remote mode and devices ----------------------------------------

  remote(): Promise<RemoteSettings> {
    return fetchJson('/remote');
  },

  setRemote(patch: Partial<RemoteSettings>): Promise<RemoteSettings> {
    return fetchJson('/remote', { method: 'PUT', body: JSON.stringify(patch) });
  },

  /** A single-use code (five minutes) and the QR payload `{ url, code, expires }`. */
  createPairingCode(): Promise<{ code: string; url: string; expiresAt: string; qr: string }> {
    return fetchJson('/devices/pairing', { method: 'POST', body: '{}' });
  },

  /** Used by the phone: needs no token, returns its device token. */
  pairDevice(input: {
    code: string;
    deviceName: string;
    platform: string;
  }): Promise<{ device: Device; token: string; expiresAt: string; scopes: string[] }> {
    return fetchJson('/devices/pair', { method: 'POST', body: JSON.stringify(input) });
  },

  devices(): Promise<{ devices: Device[] }> {
    return fetchJson('/devices');
  },

  /** The calling device itself (device token only). */
  thisDevice(): Promise<Device> {
    return fetchJson('/devices/me');
  },

  revokeDevice(id: string): Promise<Device> {
    return fetchJson(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  approvals(): Promise<{ approvals: Approval[] }> {
    return fetchJson('/approvals');
  },

  /**
   * Answer a pending approval. `by` says who decided, for the audit log (default
   * `operator`); `reason` is kept with the decision.
   */
  decideApproval(
    id: number,
    decision: 'approve' | 'deny',
    opts: { by?: string; reason?: string } = {}
  ): Promise<{ ok: boolean }> {
    return fetchJson(`/approvals/${id}/${decision}`, {
      method: 'POST',
      body: JSON.stringify({
        ...(opts.by ? { by: opts.by } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      }),
    });
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

  /** The tool calls a run's agent made, in order. */
  runToolCalls(id: string): Promise<{ toolCalls: ToolCallRecord[] }> {
    return fetchJson(`/runs/${encodeURIComponent(id)}/tool-calls`);
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

  deleteSecret(name: string): Promise<{ ok: boolean }> {
    return deleteOk(`/secrets/${encodeURIComponent(name)}`);
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

  /** Every record in use. A key may appear more than once; each record has its own id. */
  memory(): Promise<{ entries: MemoryRecord[] }> {
    return fetchJson('/memory');
  },

  getMemory(key: string): Promise<MemoryRecord> {
    return fetchJson(`/memory/${encodeURIComponent(key)}`);
  },

  /** Set a key: the newest record of that key and type is updated, or one is made. */
  setMemory(
    key: string,
    value: unknown,
    extra: {
      type?: MemoryType;
      confidence?: number | null;
      /** An ISO date and time in the future; the record is removed after it. */
      expiresAt?: string | null;
    } = {}
  ): Promise<{ ok: boolean; record?: MemoryRecord }> {
    return fetchJson('/memory', { method: 'POST', body: JSON.stringify({ key, value, ...extra }) });
  },

  /** Forget a key: every record under it, summaries and the records behind them too. */
  async deleteMemory(key: string): Promise<{ ok: boolean }> {
    return deleteOk(`/memory/${encodeURIComponent(key)}`);
  },

  /** Records, newest first. `status: 'superseded'` lists those folded into a summary. */
  memoryRecords(
    filter: { type?: MemoryType; key?: string; status?: 'active' | 'superseded' | 'all' } = {}
  ): Promise<{ records: MemoryRecord[] }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) q.set(k, v);
    return fetchJson(`/memory/records${q.size ? `?${q}` : ''}`);
  },

  /** Add a record. Unlike setMemory it never overwrites: a key may hold any number. */
  addMemoryRecord(input: {
    key: string;
    value: unknown;
    type?: MemoryType;
    confidence?: number | null;
    expiresAt?: string | null;
    sourceSession?: string;
  }): Promise<{ record: MemoryRecord }> {
    return fetchJson('/memory/records', { method: 'POST', body: JSON.stringify(input) });
  },

  updateMemoryRecord(
    id: string,
    patch: {
      key?: string;
      value?: unknown;
      type?: MemoryType;
      confidence?: number | null;
      expiresAt?: string | null;
    }
  ): Promise<{ record: MemoryRecord }> {
    return fetchJson(`/memory/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  /** Delete one record. A summary takes the records folded into it along. */
  deleteMemoryRecord(id: string): Promise<{ ok: boolean }> {
    return deleteOk(`/memory/records/${encodeURIComponent(id)}`);
  },

  /** Search by the words in a record's key and value; `mode` says whether the FTS index served it. */
  searchMemory(
    q: string,
    types?: MemoryType[],
    limit?: number
  ): Promise<{ query: string; mode: 'fts5' | 'substring'; results: MemoryHit[] }> {
    const params = new URLSearchParams({ q });
    if (types?.length) params.set('types', types.join(','));
    if (limit) params.set('limit', String(limit));
    return fetchJson(`/memory/search?${params}`);
  },

  /**
   * Fold the records of one key into a single record written by a model. They are
   * kept, as `superseded`, and `unconsolidateMemory` restores them. A `model` is
   * used as chosen; without one the default may fall back.
   */
  consolidateMemory(
    key: string,
    opts: { type?: MemoryType; model?: string } = {}
  ): Promise<{ record: MemoryRecord; superseded: string[]; model?: string }> {
    return fetchJson('/memory/consolidate', {
      method: 'POST',
      body: JSON.stringify({ key, ...opts }),
    });
  },

  /** Undo a summary: it is removed and the records folded into it are in use again. */
  unconsolidateMemory(id: string): Promise<{ restored: string[] }> {
    return fetchJson(`/memory/records/${encodeURIComponent(id)}/unconsolidate`, {
      method: 'POST',
      body: '{}',
    });
  },

  /** The types of memory managed chats and tasks may read. An empty list turns it off for them. */
  memoryPolicy(): Promise<{ readTypes: MemoryType[]; types: MemoryType[] }> {
    return fetchJson('/memory/policy');
  },

  setMemoryPolicy(
    readTypes: MemoryType[]
  ): Promise<{ readTypes: MemoryType[]; types: MemoryType[] }> {
    return fetchJson('/memory/policy', { method: 'PUT', body: JSON.stringify({ readTypes }) });
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
