/**
 * What the builtin agent may do, from the spec's permission mode and tool list.
 *
 * OpenClerq's default is full access: in `acceptEdits` (the default mode) the
 * agent reads, writes and runs commands in its worktree without asking. The
 * other modes narrow that, and `default` uses the approvals inbox for what
 * Claude Code would prompt for. Publishing from inside the agent (`git push`,
 * `gh pr create`) always waits for approval, in every mode that allows commands.
 */

import { evaluate, ruleMatches, type PolicyRules } from '@clerq/policy';
import type { DriverRunInput } from '../types.js';
import { BUILTIN_TOOLS } from './tools.js';

export type PermissionMode = NonNullable<DriverRunInput['permissionMode']>;

/** Tool calls one run may make. A run that needs more is doing something else. */
export const BUILTIN_MAX_CALLS = 400;

const READ = ['fs.read', 'fs.list', 'fs.search', 'git.status', 'git.diff'];
const EVERYTHING = [...READ, 'fs.write', 'fs.edit', 'runtime.shell', 'git.push'];

/**
 * The rules for one run.
 *
 *   acceptEdits  everything in the worktree, without asking; a push waits
 *   default      reads freely; writes and commands wait for approval
 *   dontAsk      reads only; nothing is asked, the rest is refused
 *   plan         reads only
 *
 * `allowedTools`, in policy-rule syntax (`fs.read`, `fs.*`, `group:fs`,
 * `risk:read`), narrows the allow list to what it names; a push still waits.
 */
export function builtinPolicy(
  mode: PermissionMode = 'acceptEdits',
  allowedTools: string[] = []
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

function descriptorOf(name: string) {
  if (name === 'git.push') return { name, risk: 'external' as const };
  const tool = BUILTIN_TOOLS.find((t) => t.name === name);
  return { name, risk: tool?.risk ?? ('execute' as const) };
}

/** The tools the model is shown: those the policy does not refuse outright. */
export function offeredTools(rules: PolicyRules) {
  return BUILTIN_TOOLS.filter(
    (t) => evaluate(rules, { name: t.name, risk: t.risk }).decision !== 'deny'
  );
}

/**
 * Why an `agent.allowed_tools` entry is not usable with the builtin driver, or
 * undefined when it names at least one of its tools.
 */
export function allowedToolProblem(rule: string): string | undefined {
  const names = [...BUILTIN_TOOLS.map((t) => t.name), 'git.push'];
  if (names.some((n) => ruleMatches(rule, descriptorOf(n)))) return undefined;
  return `"${rule}" names none of the builtin agent's tools (${BUILTIN_TOOLS.map((t) => t.name).join(', ')}).`;
}
