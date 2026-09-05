import { describe, it, expect, vi } from 'vitest';
import {
  evaluate,
  ruleMatches,
  groupOf,
  guard,
  profile,
  PROFILES,
  RunBudget,
  PolicyViolation,
  type ToolDescriptor,
} from './index.js';

const read: ToolDescriptor = { name: 'fs.read', risk: 'read' };
const write: ToolDescriptor = { name: 'fs.write', risk: 'write' };
const exec: ToolDescriptor = { name: 'runtime.exec', risk: 'execute' };
const http: ToolDescriptor = { name: 'http.request', risk: 'network' };
const slack: ToolDescriptor = { name: 'messaging.send', risk: 'external' };

describe('rule matching', () => {
  it('derives a group from the tool name', () => {
    expect(groupOf(read)).toBe('fs');
    expect(groupOf({ name: 'calc', risk: 'read' })).toBe('calc');
    expect(groupOf({ name: 'x.y', risk: 'read', group: 'custom' })).toBe('custom');
  });

  it('matches exact names, prefixes, groups, risks and the wildcard', () => {
    expect(ruleMatches('fs.read', read)).toBe(true);
    expect(ruleMatches('fs.read', write)).toBe(false);
    expect(ruleMatches('fs.*', write)).toBe(true);
    expect(ruleMatches('group:fs', write)).toBe(true);
    expect(ruleMatches('group:fs', http)).toBe(false);
    expect(ruleMatches('risk:execute', exec)).toBe(true);
    expect(ruleMatches('risk:execute', read)).toBe(false);
    expect(ruleMatches('*', exec)).toBe(true);
  });

  it('ignores empty rules', () => {
    expect(ruleMatches('', read)).toBe(false);
    expect(ruleMatches('   ', read)).toBe(false);
  });

  it('does not let a prefix rule leak across group boundaries', () => {
    expect(ruleMatches('fs.*', { name: 'fsx.delete', risk: 'write' })).toBe(false);
  });
});

describe('evaluate', () => {
  it('denies by default when nothing matches', () => {
    expect(evaluate({}, read).decision).toBe('deny');
    expect(evaluate({ allow: ['http.request'] }, read).decision).toBe('deny');
  });

  it('allows an explicit match', () => {
    const r = evaluate({ allow: ['fs.read'] }, read);
    expect(r.decision).toBe('allow');
    expect(r.rule).toBe('fs.read');
  });

  it('lets deny beat allow, even a wildcard allow', () => {
    const r = evaluate({ allow: ['*'], deny: ['risk:execute'] }, exec);
    expect(r.decision).toBe('deny');
    expect(r.rule).toBe('risk:execute');
  });

  it('requires approval when a rule says so', () => {
    const r = evaluate({ allow: ['*'], approvalRequired: ['risk:execute'] }, exec);
    expect(r.decision).toBe('needs_approval');
  });

  it('prefers deny over approval', () => {
    const r = evaluate({ allow: ['*'], approvalRequired: ['*'], deny: ['runtime.exec'] }, exec);
    expect(r.decision).toBe('deny');
  });

  it('gives a reason naming the tool', () => {
    expect(evaluate({}, exec).reason).toContain('runtime.exec');
  });
});

describe('profiles', () => {
  it('minimal permits reading and refuses execution', () => {
    expect(evaluate(PROFILES.minimal, read).decision).toBe('allow');
    expect(evaluate(PROFILES.minimal, exec).decision).toBe('deny');
    expect(evaluate(PROFILES.minimal, write).decision).toBe('deny');
  });

  it('research adds allow-listed HTTP but still no writes', () => {
    expect(evaluate(PROFILES.research, http).decision).toBe('allow');
    expect(evaluate(PROFILES.research, write).decision).toBe('deny');
  });

  it('coding permits repo work but gates execution on approval', () => {
    expect(evaluate(PROFILES.coding, write).decision).toBe('allow');
    expect(evaluate(PROFILES.coding, exec).decision).toBe('needs_approval');
    expect(evaluate(PROFILES.coding, slack).decision).toBe('deny');
  });

  it('never lets any profile permit external messaging silently', () => {
    for (const [name, rules] of Object.entries(PROFILES)) {
      const d = evaluate(rules, slack).decision;
      expect(d, `profile ${name}`).not.toBe('allow');
    }
  });

  it('throws on an unknown profile name', () => {
    expect(() => profile('nope')).toThrow(/Unknown policy profile/);
  });
});

describe('RunBudget', () => {
  it('permits calls under the cap', () => {
    const b = new RunBudget({ maxCallsPerRun: 2 });
    b.check();
    b.record(1);
    b.check();
  });

  it('refuses once the call cap is reached', () => {
    const b = new RunBudget({ maxCallsPerRun: 1 });
    b.record(1);
    expect(() => b.check()).toThrow(/limit of 1 tool calls/);
  });

  it('refuses once the runtime budget is spent', () => {
    const b = new RunBudget({ maxRuntimeMs: 100 });
    b.record(150);
    expect(() => b.check()).toThrow(/runtime budget/);
  });

  it('is unlimited when no caps are set', () => {
    const b = new RunBudget({});
    for (let i = 0; i < 1000; i++) b.record(10);
    expect(() => b.check()).not.toThrow();
  });
});

describe('guard', () => {
  const rules = { allow: ['fs.read'], approvalRequired: ['risk:execute'] };

  it('runs an allowed tool', async () => {
    const out = await guard(rules, read, new RunBudget({}), async () => 'ok');
    expect(out).toBe('ok');
  });

  it('refuses a denied tool without running it', async () => {
    const fn = vi.fn(async () => 'ran');
    await expect(guard(rules, exec, new RunBudget({}), fn)).rejects.toThrow(PolicyViolation);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses an approval-required tool when no approver is wired', async () => {
    const r = { allow: ['*'], approvalRequired: ['risk:execute'] };
    const fn = vi.fn(async () => 'ran');
    // Unattended runs must fail closed rather than proceed.
    await expect(guard(r, exec, new RunBudget({}), fn)).rejects.toThrow(/Approval required/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs when an approver says yes', async () => {
    const r = { allow: ['*'], approvalRequired: ['risk:execute'] };
    const out = await guard(
      r,
      exec,
      new RunBudget({}),
      async () => 'ok',
      async () => true
    );
    expect(out).toBe('ok');
  });

  it('refuses when an approver says no', async () => {
    const r = { allow: ['*'], approvalRequired: ['risk:execute'] };
    const fn = vi.fn(async () => 'ran');
    await expect(guard(r, exec, new RunBudget({}), fn, async () => false)).rejects.toThrow(
      /Approval denied/
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('counts a call against the budget even when the tool throws', async () => {
    const b = new RunBudget({ maxCallsPerRun: 5 });
    await expect(
      guard(rules, read, b, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(b.stats.calls).toBe(1);
  });

  it('stops a run that has exhausted its call budget', async () => {
    const b = new RunBudget({ maxCallsPerRun: 1 });
    await guard(rules, read, b, async () => 'first');
    await expect(guard(rules, read, b, async () => 'second')).rejects.toThrow(/limit of 1/);
  });
});
