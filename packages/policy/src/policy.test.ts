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
  MEMORY_TYPES,
  isMemoryType,
  memoryReadRules,
  memoryTool,
  readableMemoryTypes,
  writableMemoryTypes,
  narrowRules,
  isNarrowerOrEqual,
  SPAWN_TOOL,
  type PolicyRules,
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

describe('memory types', () => {
  it('has a small, fixed set, each its own tool in the memory group', () => {
    expect(MEMORY_TYPES).toEqual(['fact', 'preference', 'decision', 'procedure', 'note']);
    expect(memoryTool('read', 'procedure')).toEqual({
      name: 'memory.read.procedure',
      risk: 'read',
    });
    expect(memoryTool('write', 'note')).toEqual({ name: 'memory.write.note', risk: 'write' });
    expect(MEMORY_TYPES.every((t) => groupOf(memoryTool('read', t)) === 'memory')).toBe(true);
    expect(isMemoryType('fact')).toBe(true);
    expect(isMemoryType('FACT')).toBe(false);
    expect(isMemoryType(undefined)).toBe(false);
  });

  it('reads nothing unless a rule allows it', () => {
    expect(readableMemoryTypes({})).toEqual([]);
    expect(readableMemoryTypes({ allow: ['fs.read'] })).toEqual([]);
  });

  it('reads the types a rule names, and any form of rule works', () => {
    expect(
      readableMemoryTypes({ allow: ['memory.read.procedure', 'memory.read.preference'] })
    ).toEqual(['preference', 'procedure']);
    expect(readableMemoryTypes({ allow: ['memory.read.*'] })).toEqual([...MEMORY_TYPES]);
    expect(readableMemoryTypes({ allow: ['group:memory'] })).toEqual([...MEMORY_TYPES]);
    expect(readableMemoryTypes({ allow: ['*'] })).toEqual([...MEMORY_TYPES]);
  });

  it('keeps reading and writing apart', () => {
    const rules = { allow: ['memory.read.*', 'memory.write.note'] };
    expect(readableMemoryTypes(rules)).toEqual([...MEMORY_TYPES]);
    expect(writableMemoryTypes(rules)).toEqual(['note']);
    expect(writableMemoryTypes({ allow: ['memory.read.*'] })).toEqual([]);
  });

  it('lets a deny rule beat an allow, and does not read a type that needs approval', () => {
    expect(
      readableMemoryTypes({
        allow: ['memory.read.*'],
        deny: ['memory.read.note', 'memory.read.decision'],
      })
    ).toEqual(['fact', 'preference', 'procedure']);
    // Nobody can be asked while a prompt is being built.
    expect(
      readableMemoryTypes({ allow: ['memory.read.*'], approvalRequired: ['memory.read.fact'] })
    ).toEqual(['preference', 'decision', 'procedure', 'note']);
  });

  it('builds rules for exactly the types given', () => {
    const rules = memoryReadRules(['fact', 'procedure']);
    expect(rules).toEqual({ allow: ['memory.read.fact', 'memory.read.procedure'] });
    expect(readableMemoryTypes(rules)).toEqual(['fact', 'procedure']);
    expect(readableMemoryTypes(memoryReadRules([]))).toEqual([]);
  });

  it('is covered by the profiles that already allow memory.*, under their own denials', () => {
    expect(readableMemoryTypes(profile('minimal'))).toEqual([...MEMORY_TYPES]);
    expect(readableMemoryTypes(profile('coding'))).toEqual([...MEMORY_TYPES]);
    // Writing a record is a write like any other, which research refuses.
    expect(readableMemoryTypes(profile('research'))).toEqual([...MEMORY_TYPES]);
    expect(writableMemoryTypes(profile('research'))).toEqual([]);
  });
});

describe('narrowing a policy for a sub-agent', () => {
  const push: ToolDescriptor = { name: 'git.push', risk: 'external' };
  const universe = [read, write, exec, http, slack, push, SPAWN_TOOL];

  it('takes the stricter decision of parent and request, tool by tool', () => {
    const parent: PolicyRules = {
      allow: ['fs.*', 'runtime.exec', 'git.push', 'sessions.spawn'],
      approvalRequired: ['git.push', 'risk:execute'],
      maxCallsPerRun: 400,
    };
    const child = narrowRules(parent, { allow: ['*'], deny: ['sessions.*'] }, universe);
    expect(evaluate(child, read).decision).toBe('allow');
    expect(evaluate(child, write).decision).toBe('allow');
    expect(evaluate(child, exec).decision).toBe('needs_approval');
    expect(evaluate(child, push).decision).toBe('needs_approval');
    expect(evaluate(child, http).decision).toBe('deny');
    expect(evaluate(child, SPAWN_TOOL).decision).toBe('deny');
    expect(child.maxCallsPerRun).toBe(400);
    // A tool the universe does not know is denied, whatever the request says.
    expect(evaluate(child, { name: 'fs.other', risk: 'read' }).decision).toBe('deny');
  });

  it("keeps the parent's deny rules and the lower of the limits", () => {
    const child = narrowRules(
      { allow: ['*'], deny: ['risk:external'], maxCallsPerRun: 50, maxRuntimeMs: 1_000 },
      { allow: ['*'], maxCallsPerRun: 80 },
      universe
    );
    expect(child.deny).toEqual(['risk:external']);
    expect(child.maxCallsPerRun).toBe(50);
    expect(child.maxRuntimeMs).toBe(1_000);
    expect(evaluate(child, slack).decision).toBe('deny');
  });

  it('is never wider than the parent, over many parent and request rule sets', () => {
    // A fixed generator, so the test is the same on every run.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const vocabulary = [
      '*',
      'fs.read',
      'fs.write',
      'fs.*',
      'group:fs',
      'group:runtime',
      'group:sessions',
      'sessions.spawn',
      'risk:read',
      'risk:write',
      'risk:execute',
      'risk:external',
      'git.push',
      'http.request',
      'runtime.*',
    ];
    const pick = () =>
      Array.from({ length: rand(4) }, () => vocabulary[rand(vocabulary.length)] as string);
    const rules = (): PolicyRules => ({ allow: pick(), deny: pick(), approvalRequired: pick() });
    for (let i = 0; i < 2_000; i++) {
      const parent = rules();
      const requested = rules();
      const child = narrowRules(parent, requested, universe);
      expect(isNarrowerOrEqual(child, parent, universe)).toBe(true);
      expect(isNarrowerOrEqual(child, requested, universe)).toBe(true);
      // Narrowing again changes nothing.
      expect(isNarrowerOrEqual(narrowRules(child, requested, universe), child, universe)).toBe(
        true
      );
    }
  });
});
