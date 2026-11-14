/**
 * What a chosen skill does to a chat message's rules, with enforcement off and on. Narrowing is
 * `narrowRules` from packages/policy, which only takes tools away; here it is checked against the
 * chat's own rules over every permission mode.
 */

import { describe, expect, it } from 'vitest';
import { offeredTools } from '@clerq/drivers';
import { evaluate, isNarrowerOrEqual, MEMORY_TYPES, type PolicyRules } from '@clerq/policy';
import { chatPolicy, chatTools } from '../chat/tools.js';
import { CHAT_PERMISSION_MODES } from '../chat/sessions.js';
import { skillPolicy } from './enforce.js';
import { SKILL_TOOL_UNIVERSE, checkSkillTool } from './tool-universe.js';
import type { SkillChoice } from './use.js';

const READ_ALL = [...MEMORY_TYPES];

const rulesFor = (mode: (typeof CHAT_PERMISSION_MODES)[number], workspace: boolean) =>
  chatPolicy({ workspace, permissionMode: mode, memoryReadTypes: READ_ALL });

const where = (rules: PolicyRules, workspace: boolean, sandboxed = false) => ({
  workspace,
  sandboxed,
  offered: (r: PolicyRules) =>
    offeredTools(r, {
      repository: workspace,
      extra: chatTools({ sessionId: 's', runId: '', rules: r }),
    }).map((t) => t.name),
});

const choice = (over: Partial<SkillChoice> = {}): SkillChoice => ({
  slug: 'demo',
  name: 'Demo',
  instructions: 'x',
  trust: 'trusted',
  enforced: true,
  checksum: 'sha256:' + 'a'.repeat(64),
  source: 'directory',
  note: null,
  needs: { tools: [], domains: [], paths: [] },
  ...over,
});

describe('a skill that declares nothing', () => {
  it('changes nothing, whatever the state, and says nothing about needs', () => {
    const rules = rulesFor('acceptEdits', true);
    for (const c of [
      choice(),
      choice({ enforced: false, trust: 'untrusted', note: 'Used anyway.' }),
    ]) {
      const p = skillPolicy(rules, c, where(rules, true));
      expect(p.rules).toBe(rules);
      expect(p).toMatchObject({ narrowedTo: null, fileScope: null, network: null, removed: [] });
    }
  });

  it('is nothing when no skill was chosen, and still names the ones passed over', () => {
    const rules = rulesFor('acceptEdits', true);
    const p = skillPolicy(
      rules,
      {
        skipped: [
          {
            slug: 'old',
            name: 'Old',
            source: 'directory',
            trust: 'modified',
            checksum: null,
            used: false,
            note: 'Its files have changed. Enforcement is on, so only trusted skills are used.',
            needs: { tools: [], domains: [], paths: [] },
          },
        ],
      },
      where(rules, true)
    );
    expect(p.used).toBeNull();
    expect(p.rules).toBe(rules);
    expect(p.notes).toEqual([
      'The skill "old" (modified) matched but was not used. Its files have changed. Enforcement is on, so only trusted skills are used.',
    ]);
  });
});

describe('with enforcement off', () => {
  it('shows what was declared and narrows and limits nothing', () => {
    const rules = rulesFor('acceptEdits', true);
    const p = skillPolicy(
      rules,
      choice({
        enforced: false,
        trust: 'untrusted',
        note: 'You have not decided on this skill. Used anyway: enforcement is off.',
        needs: { tools: ['fs.read'], domains: ['api.example.com'], paths: ['src/**'] },
      }),
      where(rules, true, true)
    );
    expect(p.rules).toBe(rules);
    expect(p.narrowedTo).toBeNull();
    expect(p.fileScope).toBeNull();
    expect(p.network).toBeNull();
    expect(p.notes).toEqual([
      'The skill "demo" is untrusted. You have not decided on this skill. Used anyway: enforcement is off.',
      'The skill "demo" declares tools fs.read; hosts api.example.com; paths src/**.',
      'Enforcement is off: the declaration is shown and recorded, and nothing is narrowed or limited.',
    ]);
  });
});

describe('with enforcement on and a trusted skill', () => {
  it('narrows the tools to its list, and says what was taken away', () => {
    const rules = rulesFor('acceptEdits', true);
    const w = where(rules, true);
    const before = w.offered(rules);
    expect(before).toContain('runtime.shell');
    const p = skillPolicy(
      rules,
      choice({ needs: { tools: ['fs.read', 'group:git'], domains: [], paths: [] } }),
      w
    );
    expect(p.narrowedTo).toEqual(['fs.read', 'git.status', 'git.diff']);
    expect(w.offered(p.rules)).toEqual(p.narrowedTo);
    expect(p.removed).toEqual(before.filter((t) => !p.narrowedTo?.includes(t)));
    expect(p.removed).toEqual(
      expect.arrayContaining([
        'runtime.shell',
        'fs.write',
        'fs.edit',
        'memory.search',
        'automation.draft',
      ])
    );
    expect(p.notes.at(-1)).toMatch(
      /^Tools narrowed to fs\.read, git\.status, git\.diff \(taken away: /
    );
    // A call is decided by the narrowed rules: what is left is as it was, the rest is refused.
    expect(evaluate(p.rules, { name: 'fs.read', risk: 'read' }).decision).toBe('allow');
    expect(evaluate(p.rules, { name: 'runtime.shell', risk: 'execute' }).decision).toBe('deny');
  });

  it('keeps an approval a tool needed, and the chat’s hard denials', () => {
    const rules = rulesFor('default', true);
    const p = skillPolicy(
      rules,
      choice({
        needs: {
          tools: ['fs.write', 'automation.save', 'sessions.spawn', 'memory.write.preference'],
          domains: [],
          paths: [],
        },
      }),
      where(rules, true)
    );
    // `default` asks before a write: still asked. Never-allowed tools stay denied even if named.
    expect(evaluate(p.rules, { name: 'fs.write', risk: 'write' }).decision).toBe('needs_approval');
    expect(evaluate(p.rules, { name: 'memory.write.preference', risk: 'write' }).decision).toBe(
      'needs_approval'
    );
    expect(evaluate(p.rules, { name: 'automation.save', risk: 'write' }).decision).toBe('deny');
    expect(evaluate(p.rules, { name: 'sessions.spawn', risk: 'write' }).decision).toBe('deny');
    expect(p.rules.maxCallsPerRun).toBe(rules.maxCallsPerRun);
  });

  it('cannot give a conversation a tool it did not have: no folder, no file or shell tool', () => {
    const rules = rulesFor('acceptEdits', false);
    const p = skillPolicy(
      rules,
      choice({ needs: { tools: ['*'], domains: [], paths: [] } }),
      where(rules, false)
    );
    expect(isNarrowerOrEqual(p.rules, rules, SKILL_TOOL_UNIVERSE)).toBe(true);
    expect(evaluate(p.rules, { name: 'fs.read', risk: 'read' }).decision).toBe('deny');
    expect(evaluate(p.rules, { name: 'runtime.shell', risk: 'execute' }).decision).toBe('deny');
  });

  it('is never wider than the chat’s own rules, for any list, in every mode, with and without a folder', () => {
    const lists = [
      ['*'],
      ['fs.read'],
      ['group:fs', 'group:git'],
      ['risk:read'],
      ['risk:write', 'risk:execute', 'risk:external', 'risk:network'],
      ['fs.*', 'memory.*', 'automation.*'],
      ['git.push'],
      ['memory.write.fact'],
      ['unknown.tool', 'shell.exec'],
      [],
    ];
    for (const mode of CHAT_PERMISSION_MODES) {
      for (const workspace of [true, false]) {
        const rules = rulesFor(mode, workspace);
        for (const tools of lists) {
          const p = skillPolicy(
            rules,
            choice({ needs: { tools, domains: [], paths: [] } }),
            where(rules, workspace)
          );
          const label = `${mode} ${workspace ? 'folder' : 'no folder'} ${JSON.stringify(tools)}`;
          expect(isNarrowerOrEqual(p.rules, rules, SKILL_TOOL_UNIVERSE), label).toBe(true);
          // What is offered after is a subset of what was offered before.
          const w = where(rules, workspace);
          expect(
            w.offered(p.rules).every((t) => w.offered(rules).includes(t)),
            label
          ).toBe(true);
        }
      }
    }
  });

  it('a tool name that is not one narrows to nothing it names: a typo cannot widen', () => {
    const rules = rulesFor('acceptEdits', true);
    const w = where(rules, true);
    const p = skillPolicy(
      rules,
      choice({ needs: { tools: ['shell.exec'], domains: [], paths: [] } }),
      w
    );
    expect(p.narrowedTo).toEqual([]);
    expect(checkSkillTool('shell.exec')).toBe(
      'is not a tool OpenClerq has. Did you mean runtime.shell?'
    );
  });

  it('limits the file tools to the paths, only with a folder attached', () => {
    const rules = rulesFor('acceptEdits', true);
    const needs = { tools: [], domains: [], paths: ['src/**', '~/Notes'] };
    const withFolder = skillPolicy(rules, choice({ needs }), where(rules, true));
    expect(withFolder.fileScope).toEqual(['src/**', '~/Notes']);
    expect(withFolder.notes.at(-1)).toBe(
      'File tools limited to src/**, ~/Notes; shell commands and git status are not checked against it.'
    );
    const none = rulesFor('acceptEdits', false);
    const noFolder = skillPolicy(none, choice({ needs }), where(none, false));
    expect(noFolder.fileScope).toBeNull();
    expect(noFolder.notes.at(-1)).toBe(
      'Declared paths are not enforced: no folder is attached, so there are no file tools.'
    );
  });

  it('limits a Sandboxed conversation’s network to the hosts, and says it does not elsewhere', () => {
    const rules = rulesFor('sandboxed', true);
    const needs = { tools: [], domains: ['api.example.com', '*.example.org'], paths: [] };
    const sandboxed = skillPolicy(rules, choice({ needs }), where(rules, true, true));
    expect(sandboxed.network).toEqual(['api.example.com', '*.example.org']);
    expect(sandboxed.notes.at(-1)).toBe(
      'Commands in the sandbox reach the network only through a proxy that allows api.example.com, *.example.org (macOS filters by port, not by host).'
    );
    const full = rulesFor('acceptEdits', true);
    const native = skillPolicy(full, choice({ needs }), where(full, true, false));
    expect(native.network).toBeNull();
    expect(native.notes.at(-1)).toBe(
      'Declared hosts are not enforced: only a Sandboxed conversation with a folder limits the network of its commands.'
    );
  });
});
