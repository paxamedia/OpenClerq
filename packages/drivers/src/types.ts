import type { SandboxSpec } from '@clerq/sandbox';

/** Whether a driver's CLI can run on this machine. */
export interface DriverAvailability {
  id: string;
  available: boolean;
  /** Absolute path of the CLI, when found. */
  path?: string;
  version?: string;
  /**
   * Whether the CLI reports a signed-in account. Absent when the driver does
   * not check, or the CLI would not say.
   */
  signedIn?: boolean;
  /** Why it cannot run, in words a user can act on. */
  reason?: string;
  /** The model a run would use, as the driver resolved it (builtin only). */
  model?: string;
  /** Model providers and whether each has what it needs (builtin only). */
  providers?: Array<{ id: string; label: string; ready: boolean; local: boolean; reason?: string }>;
  /**
   * Why a model is refused, when the reason is that it has no price and the
   * run has a budget in dollars (builtin only). Unlike a missing key, that is
   * a fault in the spec, which no other model in a chain can make up for.
   */
  unpriced?: boolean;
}

/** What `detect` is told about the run it is checking for. */
export interface DetectOptions {
  /**
   * The run will give the CLI an API key of its own, so the CLI's sign-in is
   * not needed and is not checked.
   */
  apiKey?: boolean;
  /**
   * What the run will ask of the CLI. The options a run passes depend on them,
   * and `detect` checks that the installed CLI knows each one.
   */
  permissionMode?: 'acceptEdits' | 'default' | 'dontAsk' | 'plan';
  model?: string;
  /**
   * The spec sets a US-dollar budget. A driver that cannot price the model it
   * would use says so, rather than run with a budget it cannot keep.
   */
  budget?: boolean;
}

/** A tool call the agent wants to make that policy says a person must approve. */
export interface ToolApprovalRequest {
  toolCallId: string;
  /** The tool as policy names it, e.g. `runtime.shell` or `git.push`. */
  tool: string;
  risk: 'read' | 'write' | 'network' | 'execute' | 'external';
  /** Why approval is needed, from the policy decision. */
  reason: string;
  input: unknown;
  /** Aborts when the agent stops (cancelled, or out of time); the wait must end then. */
  signal: AbortSignal;
  /** Epoch ms when the agent's own time limit runs out. */
  deadline: number;
}

/** One model call an in-process driver made, with what it cost. */
export interface ModelCallInfo {
  /** `turn` for an agent turn; `compaction` for summarising older context. */
  purpose: 'turn' | 'compaction';
  provider: string;
  model: string;
  /** The agent turn this call belongs to, from 1. */
  turn: number;
  ok: boolean;
  error?: string;
  /** Why the model stopped, normalised (end_turn, tool_use, max_tokens, refusal, other). */
  stopReason?: string;
  toolCalls: number;
  /** The text the model wrote, if any. */
  text: string;
  /**
   * The call failed because the model cannot be used right now (the provider
   * is down, overloaded or rate limiting, did not answer, or does not accept
   * the key), as the provider adapter reports it. Never read from the agent's
   * own text.
   */
  unavailable?: boolean;
  tokensIn: number;
  tokensOut: number;
  /** US dollars; null when the model has no price in the registry. */
  costUsd: number | null;
  latencyMs: number;
}

/** A process a driver started, as the operating system knows it. */
export interface SpawnedProcess {
  pid: number;
  /** The process group, which the process leads. Killing it stops the descendants too. */
  pgid: number;
  /** The CLI that was started, as a path. */
  command: string;
}

export interface DriverRunInput {
  prompt: string;
  /** The workspace the agent works in. */
  cwd: string;
  model?: string;
  /**
   * Models to move to, in order, when the model in use becomes unavailable.
   * Only a driver that makes the model calls itself (builtin) can switch in
   * the middle of a run; for a CLI the caller starts a new attempt with the
   * next model instead. A model the key in `secrets` does not belong to
   * (another provider's) uses that provider's own key, never this one.
   */
  fallbackModels?: string[];
  /** Tools the agent may use without asking, in the CLI's own syntax. */
  allowedTools?: string[];
  /** How the agent treats edits and commands it has not been granted. */
  permissionMode?: 'acceptEdits' | 'default' | 'dontAsk' | 'plan';
  /** The CLI stops itself once it has spent this much. */
  maxBudgetUsd?: number;
  /** Wall-clock limit for the whole run. */
  timeoutMs?: number;
  /** Isolation for the agent process. Defaults to the native profile. */
  sandbox?: Pick<SandboxSpec, 'profile' | 'network' | 'allowWrite' | 'image'>;
  /** Plain environment variables, PATH among them. */
  env?: Record<string, string>;
  /** Environment variables redacted from everything the agent prints. */
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Called once, when the agent's process exists. The caller can record it, so
   * that a process still running after this one dies can be found and stopped.
   */
  onSpawn?: (process: SpawnedProcess) => void;
  /**
   * In-process drivers: a command one of the agent's tools started. Returns a
   * function the driver calls when the command has ended.
   */
  onToolProcess?: (process: SpawnedProcess) => () => void;
  /**
   * In-process drivers: asked when policy says a tool call needs a person.
   * Resolves true to run the call. Without it, such a call is refused.
   */
  onApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
}

/**
 * What an agent did, in one shape whichever CLI did it, so the run view does
 * not need to know which driver produced a run.
 */
export type DriverEvent =
  | { type: 'started'; model?: string; tools?: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      id: string;
      output: string;
      isError: boolean;
      /** Refused by policy, or by the person asked. */
      denied?: boolean;
      /** Whether a person was asked, and what they said. Only drivers that ask set it. */
      approval?: 'not_required' | 'approved' | 'denied';
    }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  /** A model call the driver made itself, so its tokens and cost are recorded one by one. */
  | { type: 'model_call'; call: ModelCallInfo }
  /**
   * The model in use became unavailable and the driver moved on to the next
   * one in `fallbackModels`. The failed call is a `model_call` before this.
   */
  | {
      type: 'model_fallback';
      from: string;
      to: string;
      /** Why the first one was left: the provider's own error. */
      reason: string;
      /** Models passed over on the way, and why none of them could be used. */
      skipped?: Array<{ model: string; reason: string }>;
    }
  /** Older context was summarised or dropped to fit the model's window. */
  | {
      type: 'context';
      action: 'compacted';
      method: 'summary' | 'dropped';
      compactedMessages: number;
      keptMessages: number;
      tokensBefore: number;
      tokensAfter: number;
      summary?: string;
      error?: string;
    }
  | { type: 'finished'; result: DriverResult };

export interface DriverResult {
  ok: boolean;
  /** The agent's final message, or why it stopped. */
  summary: string;
  /** What the CLI reports the run cost; null when it does not say. */
  costUsd: number | null;
  tokensIn: number;
  tokensOut: number;
  turns?: number;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Tool calls the agent attempted and was refused. */
  permissionDenials: Array<{ tool: string; input?: unknown }>;
  /** Isolation warnings from the sandbox. */
  warnings: string[];
  /**
   * The agent's process ended without reporting a result: a crash, not a
   * decision. A run may be retried after one.
   */
  crashed?: boolean;
  /**
   * An error the CLI or the model provider reported about a failed run: an
   * API error the CLI printed, a stream error event, a line of its stderr.
   * Never the agent's own words, which may mention any error at all.
   */
  apiError?: string;
}

/**
 * A coding agent run as a subprocess. Preparing the workspace and collecting
 * the diff are the same for every driver, so they belong to the caller; a
 * driver only runs the agent and reports what it did.
 */
export interface Driver {
  readonly id: string;
  detect(options?: DetectOptions): Promise<DriverAvailability>;
  run(input: DriverRunInput): AsyncIterable<DriverEvent>;
}

/**
 * What a driver's CLI can honour. A spec that asks for more than its driver
 * can do is refused when it is saved, rather than quietly run without it.
 */
export interface DriverCapabilities {
  /** The CLI stops itself at a spend limit, so `maxBudgetUsd` is passed to it. */
  budgetLimit: boolean;
  /** The CLI reports what a run cost, which a monthly budget needs. */
  reportsCost: boolean;
  /** The CLI takes a list of tools the agent may use, in its own syntax. */
  allowedTools: boolean;
  /**
   * The CLI can be told which model to use, so a spec can name one and
   * escalate to others when the gates fail.
   */
  models: boolean;
  /**
   * The driver makes the model calls itself, so it can move to another model
   * in the middle of a run when one is unavailable (`fallbackModels`). A CLI
   * cannot: the caller starts a new attempt with the next model instead.
   */
  midRunModelSwitch: boolean;
  /** The environment variable the CLI reads an API key from. */
  apiKeyEnv: string;
  /** What the CLI is, in a sentence a user can read. */
  label: string;
}
