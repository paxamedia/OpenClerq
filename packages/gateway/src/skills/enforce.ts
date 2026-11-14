/**
 * What a chosen skill does to one managed chat message, when the user has turned enforcement on.
 *
 * Only a **trusted** skill, chosen while enforcement is on, narrows or limits anything: a skill
 * that is not trusted is not used at all with enforcement on, and with it off a declaration is
 * shown and nothing is held back. Three things are enforced, each only where there is a place to
 * enforce it, and the notes say which:
 *
 *  - `tools_required`: the tools the model is offered, and how each is decided, are cut to the
 *    list with `narrowRules` from `packages/policy`, which only takes away. A skill that lists no
 *    tools narrows nothing; an empty list declares nothing.
 *  - `filesystem_scope`: with a folder attached, the file tools (read, list, search, write, edit)
 *    refuse a path outside the list, and `git_diff` shows only the changed files in it. Commands
 *    run by `run_shell` are not path checked, and neither is `git_status`.
 *  - `network_domains`: in a Sandboxed conversation, commands get a network through the sandbox's
 *    egress proxy, which allows these hosts (instead of no network at all). macOS filters by
 *    port, not by host, so a command can still reach an outside host on the proxy's own port
 *    (SECURITY.md). At other levels commands run with the user's own network, which OpenClerq does
 *    not limit.
 */

import { narrowRules, type PolicyRules } from '@clerq/policy';
import type { SkillUse } from './catalog.js';
import { SKILL_TOOL_UNIVERSE } from './tool-universe.js';
import { declaresLine, skippedLine, type SkillChoice } from './use.js';

export interface SkillPolicy {
  /** The skill whose instructions are in the prompt. */
  used: SkillUse | null;
  skipped: SkillUse[];
  /** The rules to run under: the chat's own, narrowed when the skill is trusted and lists tools. */
  rules: PolicyRules;
  /** The tools offered after narrowing; null when nothing was narrowed. */
  narrowedTo: string[] | null;
  /** The tools narrowing took away; empty when nothing was narrowed. */
  removed: string[];
  /** Paths the file tools are limited to; null when they are not limited. */
  fileScope: string[] | null;
  /** Hosts a Sandboxed chat's commands may reach; null when that is not changed. */
  network: string[] | null;
  /** What happened, in plain words, for the run's trace and the mode diff. */
  notes: string[];
}

export function skillPolicy(
  rules: PolicyRules,
  choice: SkillChoice,
  where: {
    workspace: boolean;
    sandboxed: boolean;
    /** The names of the tools a set of rules offers. */
    offered(rules: PolicyRules): string[];
  }
): SkillPolicy {
  const notes: string[] = [];
  for (const s of choice.skipped ?? []) notes.push(skippedLine(s));

  const used: SkillUse | null =
    choice.slug && choice.trust && choice.needs
      ? {
          slug: choice.slug,
          name: choice.name ?? choice.slug,
          source: choice.source ?? 'directory',
          trust: choice.trust,
          checksum: choice.checksum ?? null,
          used: true,
          note: choice.note ?? null,
          needs: choice.needs,
        }
      : null;
  const none = (): SkillPolicy => ({
    used,
    skipped: choice.skipped ?? [],
    rules,
    narrowedTo: null,
    removed: [],
    fileScope: null,
    network: null,
    notes,
  });
  if (!used) return none();

  if (used.trust !== 'trusted') {
    notes.push(`The skill "${used.slug}" is ${used.trust}. ${used.note ?? ''}`.trim());
  }
  const declared = declaresLine(used.needs);
  if (!declared) return none();
  notes.push(`The skill "${used.slug}" declares ${declared}.`);

  // Only trusted skills are used with enforcement on, so this is "enforcement is on" and "trusted".
  if (!choice.enforced || used.trust !== 'trusted') {
    notes.push(
      'Enforcement is off: the declaration is shown and recorded, and nothing is narrowed or limited.'
    );
    return none();
  }

  const { needs } = used;
  let narrowed = rules;
  let narrowedTo: string[] | null = null;
  let removed: string[] = [];
  if (needs.tools.length > 0) {
    const before = where.offered(rules);
    narrowed = narrowRules(rules, { allow: needs.tools }, SKILL_TOOL_UNIVERSE);
    narrowedTo = where.offered(narrowed);
    removed = before.filter((t) => !narrowedTo?.includes(t));
    notes.push(
      `Tools narrowed to ${narrowedTo.length > 0 ? narrowedTo.join(', ') : 'none'}` +
        (removed.length > 0 ? ` (taken away: ${removed.join(', ')}).` : ' (nothing taken away).')
    );
  }

  let fileScope: string[] | null = null;
  if (needs.paths.length > 0) {
    if (where.workspace) {
      fileScope = [...needs.paths];
      notes.push(
        `File tools limited to ${needs.paths.join(', ')}; shell commands and git status are not checked against it.`
      );
    } else {
      notes.push(
        'Declared paths are not enforced: no folder is attached, so there are no file tools.'
      );
    }
  }

  let network: string[] | null = null;
  if (needs.domains.length > 0) {
    if (where.sandboxed && where.workspace) {
      network = [...needs.domains];
      notes.push(
        `Commands in the sandbox reach the network only through a proxy that allows ${needs.domains.join(', ')} (macOS filters by port, not by host).`
      );
    } else {
      notes.push(
        'Declared hosts are not enforced: only a Sandboxed conversation with a folder limits the network of its commands.'
      );
    }
  }

  return {
    used,
    skipped: choice.skipped ?? [],
    rules: narrowed,
    narrowedTo,
    removed,
    fileScope,
    network,
    notes,
  };
}
