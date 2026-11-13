/**
 * Agent drivers.
 *
 * A driver runs a coding agent's own CLI — Claude Code, Codex, Cursor's
 * cursor-agent — inside a sandbox, in a workspace prepared by the caller, and
 * reports what it did as a stream of events in one shape for every agent. The
 * agent runs under the user's own account with its vendor.
 */

import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { cursorAgent } from './cursor-agent.js';
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

/** The drivers this release ships, by id. */
export const DRIVER_IDS = ['claude-code', 'codex', 'cursor-agent'] as const;
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
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'Claude Code',
  },
  codex: {
    budgetLimit: false,
    reportsCost: false,
    allowedTools: false,
    apiKeyEnv: 'CODEX_API_KEY',
    label: 'Codex',
  },
  'cursor-agent': {
    budgetLimit: false,
    reportsCost: false,
    allowedTools: false,
    apiKeyEnv: 'CURSOR_API_KEY',
    label: 'Cursor',
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
    default:
      throw new Error(`Unknown driver "${id}". Known: ${DRIVER_IDS.join(', ')}.`);
  }
}
