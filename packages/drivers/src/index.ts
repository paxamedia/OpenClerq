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
 * Where an agent CLI keeps its sign-in and state on this machine, as an
 * allow-list for the seatbelt profile:
 *
 *   readDirs    its state directories, readable (they are among the
 *               credential stores no profile otherwise lets a run read)
 *   writeDirs   the directories inside them it writes during a run: session,
 *               cache and log directories. Created before the run if missing.
 *   writeFiles  files it rewrites, as prefixes (`~/.claude.json` covers
 *               `~/.claude.json.tmp.1`): its sign-in, which it refreshes, and
 *               files it keeps state in. A copy would not do: refreshing a
 *               sign-in in a copy rotates the token away from the user's own.
 *
 * Everything else in the state directories is read-only: settings, hooks,
 * MCP servers, rules, skills, plugins, instructions, which would run code or
 * steer the CLI the next time it is used outside the sandbox. The lists are
 * from each vendor's documented layout, not observed against the real CLIs:
 * a CLI that writes somewhere else fails under seatbelt rather than gets it.
 */
export function agentStatePaths(
  id: DriverId,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): { readDirs: string[]; writeDirs: string[]; writeFiles: string[] } {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  switch (id) {
    case 'claude-code': {
      const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
      const inDir = (...names: string[]) => names.map((n) => path.join(dir, n));
      return {
        readDirs: [dir],
        writeDirs: [
          ...inDir(
            'todos',
            'shell-snapshots',
            'statsig',
            'debug',
            'session-env',
            'file-history',
            'plans',
            'telemetry',
            'ide'
          ),
          path.join(home, 'Library', 'Caches', 'claude-cli-nodejs'),
        ],
        writeFiles: [
          ...inDir('.credentials.json'),
          // Its main state file; it also holds user-scope MCP servers (see SECURITY.md).
          env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'),
        ],
      };
    }
    case 'codex': {
      const dir = env.CODEX_HOME || path.join(home, '.codex');
      const inDir = (...names: string[]) => names.map((n) => path.join(dir, n));
      return {
        readDirs: [dir],
        writeDirs: inDir('log', 'sessions'),
        writeFiles: inDir('auth.json', 'history.jsonl', 'version.json', 'models_cache.json'),
      };
    }
    case 'cursor-agent':
      return {
        readDirs: [path.join(home, '.cursor'), path.join(config, 'cursor')],
        writeDirs: [path.join(home, '.cursor', 'chats'), path.join(home, '.cursor', 'logs')],
        writeFiles: [path.join(config, 'cursor', 'auth.json')],
      };
    case 'builtin':
      return { readDirs: [], writeDirs: [], writeFiles: [] };
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
