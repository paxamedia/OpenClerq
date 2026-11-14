import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '@clerq/drivers';
import { chatTools } from '../chat/tools.js';
import { CHAT_NEVER } from '../chat/tools.js';
import { checkSkillTool, SKILL_TOOL_UNIVERSE } from './tool-universe.js';

const names = SKILL_TOOL_UNIVERSE.map((t) => t.name);

describe('the tools a skill may name', () => {
  it('include every tool the builtin agent and a managed chat have, and the ones policy denies by name', () => {
    for (const t of BUILTIN_TOOLS) expect(names, t.name).toContain(t.name);
    for (const t of chatTools({ sessionId: 's', runId: '', rules: {} })) {
      expect(names, t.name).toContain(t.name);
    }
    for (const n of [
      ...CHAT_NEVER,
      'git.push',
      'http.request',
      'memory.read.fact',
      'memory.write.note',
    ]) {
      expect(names, n).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('accepts a name, a prefix, a group, a risk and *', () => {
    for (const ok of [
      'fs.read',
      'runtime.shell',
      'git.push',
      'fs.*',
      'memory.read.*',
      'group:fs',
      'group:memory',
      'risk:read',
      'risk:execute',
      '*',
    ]) {
      expect(checkSkillTool(ok), ok).toBeNull();
    }
  });

  it('says what is wrong with a name, with a suggestion when one is near', () => {
    expect(checkSkillTool('shell.exec')).toBe(
      'is not a tool OpenClerq has. Did you mean runtime.shell?'
    );
    expect(checkSkillTool('fs.reed')).toBe('is not a tool OpenClerq has. Did you mean fs.read?');
    expect(checkSkillTool('FS.READ')).toContain('Did you mean fs.read?');
    expect(checkSkillTool('browser.open')).toMatch(
      /^is not a tool OpenClerq has \(the tools are fs\.read, /
    );
    expect(checkSkillTool('group:browser')).toMatch(/^names no group of tools \(the groups are /);
    expect(checkSkillTool('risk:huge')).toMatch(/^names no kind of risk/);
    expect(checkSkillTool('browser.*')).toMatch(/^matches no tool/);
  });
});
