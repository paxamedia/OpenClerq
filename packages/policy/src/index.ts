/**
 * Capability policy.
 *
 * Policy governs what an agent is *allowed to ask for*. The sandbox governs
 * what the spawned process can *physically do*. They are different layers and
 * the project needs both: an allowlist that permits `exec` and then hands the
 * command to child_process on the host has authorised arbitrary code execution,
 * and the allowlist is decoration at that point.
 *
 * Rules here are deliberately boring and deny-by-default:
 *   - nothing is permitted unless it matches an allow rule
 *   - a deny rule always beats an allow rule
 *   - anything matching an approval rule stops for a human
 */

/** How much damage a tool can do if the model is wrong or steered. */
export type ToolRisk = 'read' | 'write' | 'network' | 'execute' | 'external';

export type Decision = 'allow' | 'deny' | 'needs_approval';

export interface ToolDescriptor {
  name: string;
  risk: ToolRisk;
  /** Group used by `group:*` rules. Derived from the name when omitted. */
  group?: string;
}

export interface PolicyRules {
  /** Rules granting access. Empty means nothing is allowed. */
  allow?: string[];
  /** Rules refusing access. Always beats allow. */
  deny?: string[];
  /** Rules requiring a human decision before the call proceeds. */
  approvalRequired?: string[];
  /** Cap on tool calls in a single run. Omit for unlimited. */
  maxCallsPerRun?: number;
  /** Cap on total tool runtime in a single run, milliseconds. */
  maxRuntimeMs?: number;
}

export interface PolicyResult {
  decision: Decision;
  /** Human-readable justification, safe to show in a UI or an audit log. */
  reason: string;
  /** The rule that decided it, when one did. */
  rule?: string;
}

/**
 * Groups exist so a policy can say "no network" without enumerating every tool.
 * A tool's group defaults to the segment before the first dot in its name, so
 * `fs.read` is in `fs` without needing to be registered.
 */
export const RISK_OF_GROUP: Record<string, ToolRisk> = {
  fs: 'read',
  runtime: 'execute',
  web: 'network',
  git: 'write',
  sessions: 'write',
  memory: 'write',
  automation: 'write',
  messaging: 'external',
};

export function groupOf(tool: ToolDescriptor | string): string {
  const name = typeof tool === 'string' ? tool : (tool.group ?? tool.name);
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * Does `rule` match `tool`?
 *
 * Supported forms:
 *   `*`              everything
 *   `fs.read`        one tool, exactly
 *   `fs.*`           every tool in a name prefix
 *   `group:fs`       every tool in a group
 *   `risk:execute`   every tool of a risk level
 */
export function ruleMatches(rule: string, tool: ToolDescriptor): boolean {
  const r = rule.trim();
  if (!r) return false;
  if (r === '*') return true;
  if (r.startsWith('group:')) return groupOf(tool) === r.slice(6);
  if (r.startsWith('risk:')) return tool.risk === r.slice(5);
  if (r.endsWith('.*')) return tool.name.startsWith(r.slice(0, -1));
  return tool.name === r;
}

function firstMatch(rules: string[] | undefined, tool: ToolDescriptor): string | undefined {
  return (rules ?? []).find((r) => ruleMatches(r, tool));
}

/**
 * Decide whether `tool` may be called under `rules`.
 *
 * Order is fixed and not configurable: deny, then approval, then allow, then an
 * implicit deny. Making the order configurable would let a permissive profile
 * accidentally outrank a deny rule.
 */
export function evaluate(rules: PolicyRules, tool: ToolDescriptor): PolicyResult {
  const denied = firstMatch(rules.deny, tool);
  if (denied) {
    return {
      decision: 'deny',
      reason: `"${tool.name}" is denied by rule "${denied}".`,
      rule: denied,
    };
  }

  const allowed = firstMatch(rules.allow, tool);
  if (!allowed) {
    return {
      decision: 'deny',
      reason: `"${tool.name}" is not permitted: no allow rule matches it.`,
    };
  }

  const approval = firstMatch(rules.approvalRequired, tool);
  if (approval) {
    return {
      decision: 'needs_approval',
      reason: `"${tool.name}" requires approval by rule "${approval}".`,
      rule: approval,
    };
  }

  return {
    decision: 'allow',
    reason: `"${tool.name}" is permitted by rule "${allowed}".`,
    rule: allowed,
  };
}

/**
 * Named starting points. A profile is a suggestion: the automation spec can
 * narrow it, and `deny` in the spec still wins.
 */
export const PROFILES: Record<string, PolicyRules> = {
  /** Read-only inspection. The safe default for anything unattended. */
  minimal: {
    allow: ['fs.read', 'memory.*', 'calc.*'],
    deny: ['risk:execute', 'risk:external'],
  },
  /** Reading plus allow-listed HTTP. No writes, no execution. */
  research: {
    allow: ['fs.read', 'http.request', 'memory.*', 'calc.*'],
    deny: ['risk:execute', 'risk:write', 'risk:external'],
  },
  /** Editing a repository inside a sandbox. Execution needs approval. */
  coding: {
    allow: ['group:fs', 'group:git', 'group:runtime', 'memory.*', 'calc.*'],
    approvalRequired: ['risk:execute'],
    deny: ['risk:external'],
    maxCallsPerRun: 200,
  },
  /** Everything, every side effect confirmed. Never a default. */
  trusted: {
    allow: ['*'],
    approvalRequired: ['risk:execute', 'risk:external', 'risk:write'],
    maxCallsPerRun: 500,
  },
};

export function profile(name: string): PolicyRules {
  const p = PROFILES[name];
  if (!p) {
    throw new Error(
      `Unknown policy profile "${name}". Known: ${Object.keys(PROFILES).join(', ')}.`
    );
  }
  return p;
}

/**
 * Per-run budget enforcement. Policy answers "may this be asked for"; this
 * answers "has this run already asked for too much".
 */
export class RunBudget {
  private calls = 0;
  private runtimeMs = 0;

  constructor(private readonly rules: PolicyRules) {}

  /** Throws when the run has exhausted its allowance. */
  check(): void {
    const { maxCallsPerRun, maxRuntimeMs } = this.rules;
    if (maxCallsPerRun !== undefined && this.calls >= maxCallsPerRun) {
      throw new PolicyViolation(`Run exceeded its limit of ${maxCallsPerRun} tool calls.`);
    }
    if (maxRuntimeMs !== undefined && this.runtimeMs >= maxRuntimeMs) {
      throw new PolicyViolation(`Run exceeded its tool runtime budget of ${maxRuntimeMs}ms.`);
    }
  }

  record(durationMs: number): void {
    this.calls += 1;
    this.runtimeMs += Math.max(0, durationMs);
  }

  get stats(): { calls: number; runtimeMs: number } {
    return { calls: this.calls, runtimeMs: this.runtimeMs };
  }
}

export class PolicyViolation extends Error {
  readonly code = 'policy_violation';
  constructor(message: string) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

/**
 * Guard one tool call.
 *
 * `onApproval` is consulted when policy requires a human; returning false
 * refuses the call. Omitting it means approval-required is treated as a refusal,
 * which is the correct default for an unattended run.
 */
export async function guard<T>(
  rules: PolicyRules,
  tool: ToolDescriptor,
  budget: RunBudget,
  run: () => Promise<T>,
  onApproval?: (result: PolicyResult) => Promise<boolean>
): Promise<T> {
  budget.check();
  const verdict = evaluate(rules, tool);

  if (verdict.decision === 'deny') {
    throw new PolicyViolation(verdict.reason);
  }

  if (verdict.decision === 'needs_approval') {
    const approved = onApproval ? await onApproval(verdict) : false;
    if (!approved) {
      throw new PolicyViolation(
        onApproval ? `Approval denied: ${verdict.reason}` : `Approval required: ${verdict.reason}`
      );
    }
  }

  const started = Date.now();
  try {
    return await run();
  } finally {
    budget.record(Date.now() - started);
  }
}
