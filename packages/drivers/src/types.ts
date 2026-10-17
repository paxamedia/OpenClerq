import type { SandboxSpec } from '@clerq/sandbox';

/** Whether a driver's CLI can run on this machine. */
export interface DriverAvailability {
  id: string;
  available: boolean;
  /** Absolute path of the CLI, when found. */
  path?: string;
  version?: string;
  /** Why it cannot run, in words a user can act on. */
  reason?: string;
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
  detect(): Promise<DriverAvailability>;
  run(input: DriverRunInput): AsyncIterable<DriverEvent>;
}
