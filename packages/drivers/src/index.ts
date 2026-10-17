/**
 * Agent drivers.
 *
 * A driver runs a coding agent's own CLI — Claude Code today; Codex and
 * cursor-agent next — inside a sandbox, in a workspace prepared by the caller,
 * and reports what it did as a stream of events in one shape for every agent.
 * The agent runs under the user's own account with its vendor.
 */

import { claudeCode } from './claude-code.js';
import type { Driver } from './types.js';

export * from './types.js';
export {
  claudeCode,
  buildClaudeArgs,
  ClaudeStream,
  type ClaudeCodeOptions,
} from './claude-code.js';
export { locate, commonBinDirs } from './locate.js';

/** The drivers this release ships, by id. */
export const DRIVER_IDS = ['claude-code'] as const;
export type DriverId = (typeof DRIVER_IDS)[number];

export function getDriver(id: string): Driver {
  switch (id) {
    case 'claude-code':
      return claudeCode();
    default:
      throw new Error(`Unknown driver "${id}". Known: ${DRIVER_IDS.join(', ')}.`);
  }
}
