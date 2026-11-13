/**
 * Agent drivers.
 *
 * A driver runs a coding agent in a workspace prepared by the caller, and
 * reports what it did as a stream of events in one shape for every agent.
 * Three run a vendor's own CLI — Claude Code, Codex, Cursor's cursor-agent —
 * inside a sandbox, under the user's own account with that vendor. `builtin`
 * is OpenClerq's own tool loop, over any model in the provider registry.
 */

import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { cursorAgent } from './cursor-agent.js';
import { builtin, BUILTIN_KEY_ENV } from './builtin/driver.js';
import type { Driver, DriverCapabilities } from './types.js';

export * from './types.js';
export {
  claudeCode,
  buildClaudeArgs,
  ClaudeStream,
  type ClaudeCodeOptions,
} from './claude-code.js';
export { codex, buildCodexArgs, CodexStream, type CodexOptions } from './codex.js';
export {
  cursorAgent,
  buildCursorArgs,
  CursorStream,
  type CursorAgentOptions,
} from './cursor-agent.js';
export { locate, commonBinDirs } from './locate.js';
export {
  builtin,
  priced,
  BUILTIN_KEY_ENV,
  DEFAULT_MAX_TURNS,
  redactDeep,
  SYSTEM_PROMPT,
  type BuiltinOptions,
} from './builtin/driver.js';
export {
  builtinPolicy,
  offeredTools,
  allowedToolProblem,
  BUILTIN_MAX_CALLS,
} from './builtin/policy.js';
export { BUILTIN_TOOLS, shellDescriptor, type BuiltinTool } from './builtin/tools.js';

/** The drivers this release ships, by id. */
export const DRIVER_IDS = ['claude-code', 'codex', 'cursor-agent', 'builtin'] as const;
export type DriverId = (typeof DRIVER_IDS)[number];

/**
 * What each driver's CLI can honour. A spec that asks for more is refused when
 * it is saved: a budget the CLI cannot enforce is not a budget.
 */
export const DRIVER_CAPABILITIES: Record<DriverId, DriverCapabilities> = {
  'claude-code': {
    budgetLimit: true,
    reportsCost: true,
    allowedTools: true,
    models: true,
    midRunModelSwitch: false,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'Claude Code',
  },
  codex: {
    budgetLimit: false,
    reportsCost: false,
    allowedTools: false,
    models: true,
    midRunModelSwitch: false,
    apiKeyEnv: 'CODEX_API_KEY',
    label: 'Codex',
  },
  'cursor-agent': {
    budgetLimit: false,
    reportsCost: false,
    allowedTools: false,
    models: true,
    midRunModelSwitch: false,
    apiKeyEnv: 'CURSOR_API_KEY',
    label: 'Cursor',
  },
  // Its cost is the registry price of each call; an unpriced cloud model with a
  // budget is refused when the spec is checked (see detect's `budget` option).
  builtin: {
    budgetLimit: true,
    reportsCost: true,
    allowedTools: true,
    models: true,
    midRunModelSwitch: true,
    apiKeyEnv: BUILTIN_KEY_ENV,
    label: 'the builtin agent',
  },
};

export function getDriver(id: string): Driver {
  switch (id) {
    case 'claude-code':
      return claudeCode();
    case 'codex':
      return codex();
    case 'cursor-agent':
      return cursorAgent();
    case 'builtin':
      return builtin();
    default:
      throw new Error(`Unknown driver "${id}". Known: ${DRIVER_IDS.join(', ')}.`);
  }
}
