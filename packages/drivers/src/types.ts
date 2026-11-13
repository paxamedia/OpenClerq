import type { PolicyRules } from '@clerq/policy';
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
   * What kind of fault `reason` is, when the driver can say (builtin only):
   *
   *  - `no_key`      the model's provider has no key
   *  - `unreachable` a local server does not answer
   *  - `unpriced`    the run has a budget in dollars and the model has no price
   *  - `invalid`     the model reference itself is wrong: an unknown provider, one
   *                  that does not name its provider, a registry that cannot be read
   *
   * Another model can stand in for the first two. It cannot for the others, which
   * are faults in the spec: a caller that has a chain of models must not hide them
   * by moving on.
   */
  reasonKind?: 'no_key' | 'unreachable' | 'unpriced' | 'invalid';
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
  /**
   * The CLI runs inside a container image (the container profile), so the
   * host's copy of it, its options and its sign-in are not what the run uses
   * and are not checked. The image must provide the CLI.
   */
  inContainer?: boolean;
}

/**
 * The isolation a driver runs its agent (and the builtin agent its commands)
 * under: the sandbox settings that do not depend on the command.
 */
export type SandboxOptions = Pick<
  SandboxSpec,
  | 'profile'
  | 'network'
  | 'allowWrite'
  | 'allowWritePrefix'
  | 'readOnly'
  | 'protect'
  | 'denyRead'
  | 'readOnlyCwd'
  | 'image'
  | 'containerName'
  | 'labels'
  | 'runtime'
  | 'egressImage'
>;

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
  /**
   * The container the command runs in, under the container profile. The pid is
   * the runtime CLI's; stopping it does not stop the container, which is
   * removed by name.
   */
  container?: { runtime: string; name: string };
}

/**
 * A budget in US dollars that several agents spend from at once: a parent run
 * and its sub-agents. Each agent checks, before every model call, that what it
 * has spent, plus what the others have spent or hold for calls in flight, plus
 * the most the call may cost, stays within the run's `maxBudgetUsd`.
 */
export interface SharedBudget {
  /** What the other agents sharing the budget have spent, and hold for calls in flight. */
  othersUsd(): number;
  /**
   * Hold `usd` for a call about to be made. Returns the release, called with
   * what the call cost (0 when it failed or has no price).
   */
  hold(usd: number): (costUsd: number) => void;
}

/** What an agent asks for when it starts a sub-agent (`sessions.spawn`). */
export interface SubagentRequest {
  /** The parent's tool call that asked for it. */
  toolCallId: string;
  /** What the sub-agent is to do, in the parent's words. */
  task: string;
  /**
   * The tools it asks for, as policy rules (`fs.read`, `group:fs`, `risk:read`).
   * Omitted: the read-only tools.
   */
  tools?: string[];
  /** A model of its own, as provider/model; used as named, with no fallback. */
  model?: string;
  /** The rules the parent runs under, which the sub-agent's are cut from. */
  parentRules: PolicyRules;
  /** Aborts when the parent stops (cancelled, or out of time). */
  signal: AbortSignal;
  /** Epoch ms when the parent's own time limit runs out. */
  deadline: number;
}

/** How a sub-agent ended, as the parent is told. */
export interface SubagentOutcome {
  ok: boolean;
  /** Its final answer, or why it stopped. */
  answer: string;
  /** A line or two on what it did: its run, tool calls, turns, cost. */
  trace: string;
  runId?: string;
  sessionId?: string;
  costUsd: number | null;
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
  /**
   * Isolation for the agent process (for the builtin agent, for the commands
   * it runs). Defaults to the native profile.
   */
  sandbox?: SandboxOptions;
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
  /**
   * In-process drivers: start a sub-agent and wait for its answer. The agent is
   * offered `sessions.spawn` only when this is given and its policy allows it.
   * A sub-agent's own run is never given one, so agents nest one level deep.
   */
  onSubagent?: (request: SubagentRequest) => Promise<SubagentOutcome>;
  /**
   * In-process drivers: a budget `maxBudgetUsd` is shared with other agents
   * (a parent and its sub-agents). Without it the budget is this agent's alone.
   */
  sharedBudget?: SharedBudget;
  /**
   * In-process drivers: the rules to run under, in place of those made from
   * `permissionMode` and `allowedTools`. A sub-agent's narrowed policy.
   */
  policy?: PolicyRules;
  /** In-process drivers: the system prompt, in place of the driver's own. */
  system?: string;
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
  /**
   * The agent can start sub-agents through OpenClerq (`sessions.spawn`). Only
   * builtin: the CLIs have sub-agent features of their own, which run inside
   * the CLI and are not seen or limited by OpenClerq's policy.
   */
  subagents: boolean;
  /** The environment variable the CLI reads an API key from. */
  apiKeyEnv: string;
  /**
   * Hosts the agent process itself must reach to talk to its model provider
   * (sign-in included), allowed under an egress allowlist on top of the
   * spec's own hosts. Empty for builtin, whose model calls the gateway makes.
   */
  providerHosts: string[];
  /** The CLI's name inside a container image, run from the image's PATH. */
  cliName?: string;
  /** What the CLI is, in a sentence a user can read. */
  label: string;
}
