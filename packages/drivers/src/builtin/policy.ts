/**
 * What the builtin agent may do, from the spec's permission mode and tool list.
 *
 * OpenClerq's default is full access: in `acceptEdits` (the default mode) the
 * agent reads, writes and runs commands in its worktree without asking. The
 * other modes narrow that, and `default` uses the approvals inbox for what
 * Claude Code would prompt for. Publishing from inside the agent (`git push`,
 * `gh pr create`) always waits for approval, in every mode that allows commands.
 */

import {
  evaluate,
  narrowRules,
  ruleMatches,
  SPAWN_TOOL,
  type PolicyRules,
  type ToolDescriptor,
} from '@clerq/policy';
import type { DriverRunInput } from '../types.js';
import { BUILTIN_TOOLS, SPAWN_AGENT, type BuiltinTool } from './tools.js';

export type PermissionMode = NonNullable<DriverRunInput['permissionMode']>;

/** Tool calls one run may make. A run that needs more is doing something else. */
export const BUILTIN_MAX_CALLS = 400;

const READ = ['fs.read', 'fs.list', 'fs.search', 'git.status', 'git.diff'];
const EVERYTHING = [...READ, 'fs.write', 'fs.edit', 'runtime.shell', 'git.push'];

/**
 * The rules for one run.
 *
 *   acceptEdits  everything in the worktree, without asking; a push waits
 *   default      reads freely; writes, commands and sub-agents wait for approval
 *   dontAsk      reads only; nothing is asked, the rest is refused
 *   plan         reads only
 *
 * `allowedTools`, in policy-rule syntax (`fs.read`, `fs.*`, `group:fs`,
 * `risk:read`), narrows the allow list to what it names; a push still waits.
 *
 * `sessions.spawn` (sub-agents) is opt-in: allowed in `acceptEdits` and
 * `default` only when `opts.subagents` is set or `allowedTools` names it
 * outright. A wildcard, `risk:write` or `group:sessions` alone does not.
 */
export function builtinPolicy(
  mode: PermissionMode = 'acceptEdits',
  allowedTools: string[] = [],
  opts: { subagents?: boolean } = {}
): PolicyRules {
  let allow: string[];
  let approvalRequired: string[] = ['git.push'];
  switch (mode) {
    case 'acceptEdits':
      allow = EVERYTHING;
      break;
    case 'default':
      allow = EVERYTHING;
      approvalRequired = ['risk:write', 'risk:execute', 'git.push'];
      break;
    case 'dontAsk':
    case 'plan':
      allow = READ;
      approvalRequired = [];
      break;
  }
  const spawnWanted =
    opts.subagents || allowedTools.some((rule) => rule.trim() === SPAWN_TOOL.name);
  if (spawnWanted && (mode === 'acceptEdits' || mode === 'default')) {
    allow = [...allow, SPAWN_TOOL.name];
  }
  if (allowedTools.length > 0) {
    allow = allow.filter((name) =>
      allowedTools.some((rule) => ruleMatches(rule, descriptorOf(name)))
    );
    // A push is part of what `runtime.shell` can do; naming the shell keeps it possible, with approval.
    if (
      allow.includes('runtime.shell') &&
      approvalRequired.includes('git.push') &&
      !allow.includes('git.push')
    ) {
      allow.push('git.push');
    }
  }
  return { allow, approvalRequired, maxCallsPerRun: BUILTIN_MAX_CALLS };
}

function descriptorOf(name: string): ToolDescriptor {
  if (name === 'git.push') return { name, risk: 'external' };
  if (name === SPAWN_TOOL.name) return SPAWN_TOOL;
  const tool = BUILTIN_TOOLS.find((t) => t.name === name);
  return { name, risk: tool?.risk ?? 'execute' };
}

/** Every tool the builtin agent's policy decides on, as policy sees each. */
export const BUILTIN_UNIVERSE: readonly ToolDescriptor[] = [
  ...BUILTIN_TOOLS.map((t) => ({ name: t.name, risk: t.risk })),
  { name: 'git.push', risk: 'external' },
  SPAWN_TOOL,
];

/**
 * The tools the model is shown: those the policy does not refuse outright.
 * `sessions.spawn` only when the run can start sub-agents (`spawn`).
 */
export function offeredTools(
  rules: PolicyRules,
  opts: {
    spawn?: boolean;
    /** False: no repository tools (a chat with no folder attached). Default true. */
    repository?: boolean;
    /** Tools of the caller's own, offered on the same terms. */
    extra?: readonly BuiltinTool[];
  } = {}
): readonly BuiltinTool[] {
  const tools = [
    ...(opts.repository === false ? [] : BUILTIN_TOOLS),
    ...(opts.spawn ? [SPAWN_AGENT] : []),
    ...(opts.extra ?? []),
  ];
  return tools.filter((t) => evaluate(rules, { name: t.name, risk: t.risk }).decision !== 'deny');
}

/** What a sub-agent gets when its spawn call names no tools: reading, nothing else. */
export const SUBAGENT_DEFAULT_TOOLS = ['risk:read'];

/**
 * A sub-agent's rules: the parent's, cut down to the tools the spawn call
 * asks for (by default the read-only ones), tool by tool the stricter of the
 * two. Never wider than the parent's. It never has `sessions.spawn`, so a
 * sub-agent cannot start sub-agents of its own (one level deep).
 */
export function subagentPolicy(parent: PolicyRules, requested?: string[]): PolicyRules {
  const asked = requested && requested.length > 0 ? requested : SUBAGENT_DEFAULT_TOOLS;
  const rules = narrowRules(parent, { allow: asked, deny: [SPAWN_TOOL.name] }, BUILTIN_UNIVERSE);
  return { ...rules, deny: [...(rules.deny ?? []), SPAWN_TOOL.name] };
}

/**
 * Why an `agent.allowed_tools` entry is not usable with the builtin driver, or
 * undefined when it names at least one of its tools.
 */
export function allowedToolProblem(rule: string): string | undefined {
  const names = [...BUILTIN_TOOLS.map((t) => t.name), 'git.push', SPAWN_TOOL.name];
  if (names.some((n) => ruleMatches(rule, descriptorOf(n)))) return undefined;
  return `"${rule}" names none of the builtin agent's tools (${BUILTIN_TOOLS.map((t) => t.name).join(', ')}).`;
}
