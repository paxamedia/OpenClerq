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
}

/**
 * What an agent did, in one shape whichever CLI did it, so the run view does
 * not need to know which driver produced a run.
 */
export type DriverEvent =
  | { type: 'started'; model?: string; tools?: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
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
  /** The environment variable the CLI reads an API key from. */
  apiKeyEnv: string;
  /** What the CLI is, in a sentence a user can read. */
  label: string;
}
