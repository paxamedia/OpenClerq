/**
 * The tools a skill may name in `tools_required`, and what is wrong with a name that is not one.
 *
 * These are the names `packages/policy` decides on: the builtin agent's tools, the tools a managed
 * chat adds (`memory.search`, `memory.write`, `automation.draft`), the memory types a note is read
 * or written as, and `http.request`. A skill's list is checked against them, and a managed chat's
 * tools are narrowed to the list with `narrowRules` over the same set.
 */

import { BUILTIN_UNIVERSE } from '@clerq/drivers';
import { groupOf, MEMORY_TYPES, memoryTool, ruleMatches, type ToolDescriptor } from '@clerq/policy';
import { nearestName } from '@clerq/plugin-sdk/skill';

/** Tools that exist in a managed chat besides the builtin agent's. */
const CHAT_AND_GATEWAY: readonly ToolDescriptor[] = [
  { name: 'memory.search', risk: 'read' },
  { name: 'memory.write', risk: 'write' },
  ...MEMORY_TYPES.map((t) => memoryTool('read', t)),
  ...MEMORY_TYPES.map((t) => memoryTool('write', t)),
  { name: 'automation.draft', risk: 'read' },
  // Named so a policy can deny them; no chat tool does any of these.
  ...['save', 'create', 'update', 'enable', 'disable', 'run', 'delete'].map(
    (a): ToolDescriptor => ({ name: `automation.${a}`, risk: 'write' })
  ),
  { name: 'http.request', risk: 'network' },
];

/** Every tool a skill may name. `sessions.spawn` is among them, though a chat never offers it. */
export const SKILL_TOOL_UNIVERSE: readonly ToolDescriptor[] = [
  ...BUILTIN_UNIVERSE,
  ...CHAT_AND_GATEWAY,
];

const NAMES = SKILL_TOOL_UNIVERSE.map((t) => t.name);
const GROUPS = [...new Set(SKILL_TOOL_UNIVERSE.map((t) => groupOf(t)))].sort();
const RISKS: string[] = [...new Set<string>(SKILL_TOOL_UNIVERSE.map((t) => t.risk))].sort();

/** Names people write that mean a tool OpenClerq has under another name. */
const ALIASES: Record<string, string> = {
  'shell.exec': 'runtime.shell',
  'shell.run': 'runtime.shell',
  shell: 'runtime.shell',
  exec: 'runtime.shell',
  bash: 'runtime.shell',
  'runtime.exec': 'runtime.shell',
  'file.read': 'fs.read',
  'file.write': 'fs.write',
  'file.edit': 'fs.edit',
  'fs.readfile': 'fs.read',
  'fs.writefile': 'fs.write',
  'web.fetch': 'http.request',
  'http.get': 'http.request',
  fetch: 'http.request',
  'git.commit': 'runtime.shell',
};

/**
 * What is wrong with one entry of `tools_required`, in words that follow the name; null when it
 * is a tool or a rule that matches at least one. A rule is a tool name, `prefix.*`, `group:<group>`
 * or `risk:<level>`.
 */
export function checkSkillTool(rule: string): string | null {
  const r = rule.trim();
  if (r === '*') return null;
  if (r.startsWith('group:')) {
    return GROUPS.includes(r.slice(6))
      ? null
      : `names no group of tools (the groups are ${GROUPS.join(', ')}).`;
  }
  if (r.startsWith('risk:')) {
    return RISKS.includes(r.slice(5))
      ? null
      : `names no kind of risk (they are ${RISKS.join(', ')}).`;
  }
  if (r.endsWith('.*')) {
    return SKILL_TOOL_UNIVERSE.some((t) => ruleMatches(r, t))
      ? null
      : `matches no tool (the tools are ${NAMES.join(', ')}).`;
  }
  if (NAMES.includes(r)) return null;
  const alias = ALIASES[r.toLowerCase()];
  const near = alias ?? nearestName(r, NAMES);
  return near
    ? `is not a tool OpenClerq has. Did you mean ${near}?`
    : `is not a tool OpenClerq has (the tools are ${NAMES.join(', ')}).`;
}
