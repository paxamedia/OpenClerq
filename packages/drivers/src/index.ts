/**
 * Agent drivers.
 *
 * A driver runs a coding agent in a workspace prepared by the caller, and
 * reports what it did as a stream of events in one shape for every agent.
 * Three run a vendor's own CLI — Claude Code, Codex, Cursor's cursor-agent —
 * inside a sandbox, under the user's own account with that vendor. `builtin`
 * is OpenClerq's own tool loop, over any model in the provider registry.
 */

import os from 'node:os';
import path from 'node:path';
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
  SUBAGENT_SYSTEM_PROMPT,
  type BuiltinOptions,
} from './builtin/driver.js';
export {
  builtinPolicy,
  offeredTools,
  allowedToolProblem,
  subagentPolicy,
  BUILTIN_MAX_CALLS,
  BUILTIN_UNIVERSE,
  SUBAGENT_DEFAULT_TOOLS,
} from './builtin/policy.js';
export { BUILTIN_TOOLS, SPAWN_AGENT, shellDescriptor, type BuiltinTool } from './builtin/tools.js';

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
    subagents: false,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    // The API, and the two sign-in hosts its OAuth token is refreshed through.
    providerHosts: ['api.anthropic.com', 'console.anthropic.com', 'claude.ai'],
    cliName: 'claude',
    label: 'Claude Code',
  },
  codex: {
    budgetLimit: false,
    reportsCost: false,
    allowedTools: false,
    models: true,
    midRunModelSwitch: false,
    subagents: false,
    apiKeyEnv: 'CODEX_API_KEY',
    // The API, ChatGPT's backend for a ChatGPT sign-in, and its token refresh.
    providerHosts: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
    cliName: 'codex',
    label: 'Codex',
  },
  'cursor-agent': {
    budgetLimit: false,
    reportsCost: false,
    allowedTools: false,
    models: true,
    midRunModelSwitch: false,
    subagents: false,
    apiKeyEnv: 'CURSOR_API_KEY',
    providerHosts: ['api2.cursor.sh', '*.cursor.sh', 'api.cursor.com'],
    cliName: 'cursor-agent',
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
    subagents: true,
    apiKeyEnv: BUILTIN_KEY_ENV,
    // Its model calls are made by the gateway, outside the sandbox.
    providerHosts: [],
    label: 'the builtin agent',
  },
};

/**
 * Where an agent CLI keeps its sign-in and state on this machine: the
 * directories it writes, and files it rewrites through a temporary sibling
 * (`files` are prefixes: `~/.claude.json` covers `~/.claude.json.tmp.1`).
 * Under the seatbelt profile they are the only places outside the worktree
 * the agent may write: a CLI refreshes its sign-in there, and a copy would
 * rotate the refresh token away from the user's own sign-in.
 *
 * `protect` lists what inside them holds only configuration that would run
 * code the next time the CLI is used outside the sandbox (hooks, MCP servers,
 * a notify command, instructions it reads): kept read-only. A file the CLI
 * itself rewrites during a run (`~/.claude.json`) cannot be protected.
 */
export function agentStatePaths(
  id: DriverId,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): { dirs: string[]; files: string[]; protect: string[] } {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  switch (id) {
    case 'claude-code': {
      const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
      const protect = [
        'settings.json',
        'settings.local.json',
        'CLAUDE.md',
        'commands',
        'agents',
        'hooks',
        'plugins',
        'skills',
      ].map((p) => path.join(dir, p));
      return env.CLAUDE_CONFIG_DIR
        ? { dirs: [dir], files: [], protect }
        : {
            dirs: [dir, path.join(home, 'Library', 'Caches', 'claude-cli-nodejs')],
            files: [path.join(home, '.claude.json')],
            protect,
          };
    }
    case 'codex': {
      const dir = env.CODEX_HOME || path.join(home, '.codex');
      return {
        dirs: [dir],
        files: [],
        protect: ['config.toml', 'AGENTS.md', 'prompts'].map((p) => path.join(dir, p)),
      };
    }
    case 'cursor-agent':
      return {
        dirs: [path.join(home, '.cursor'), path.join(config, 'cursor')],
        files: [],
        protect: [path.join(home, '.cursor', 'mcp.json'), path.join(home, '.cursor', 'rules')],
      };
    case 'builtin':
      return { dirs: [], files: [], protect: [] };
  }
}

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
