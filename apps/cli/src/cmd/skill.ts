/**
 * `clerq skill list | show | trust | block | untrust | checksum`.
 *
 * A skill is a SKILL.md whose instructions go into a prompt. The gateway keeps whether you trust
 * each one (the exact files you looked at, by checksum) and, if you turn enforcement on in
 * Settings, what that decision does. `checksum` needs no gateway: it hashes a skill's folder on
 * this computer, the same way the gateway does, so an author can publish the value.
 */

import path from 'node:path';
import { GatewayError, gateway, type SkillInfo } from '@clerq/gateway-client';
import { readSkillDir, SkillFilesError, writeSkillChecksum } from '@clerq/plugin-sdk/node';
import { declaredChecksumIn, describeSkillNeeds } from '@clerq/plugin-sdk/skill';
import { flag, type Call } from '../args.js';
import { connect } from '../connect.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { table } from '../format.js';
import { confirm } from '../prompt.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How a state is said. */
const STATE: Record<SkillInfo['trust'], string> = {
  untrusted: 'not trusted',
  trusted: 'trusted',
  modified: 'changed',
  blocked: 'blocked',
};

const ORIGIN = (origin: string) =>
  origin === 'directory'
    ? 'skills folder'
    : origin.startsWith('plugin:')
      ? `plugin ${origin.slice(7)}`
      : origin.startsWith('module:')
        ? `module ${origin.slice(7)}`
        : origin;

/** What a skill declares, in a few words for a list. */
export function declaresShort(declared: SkillInfo['declared']): string {
  const parts = [
    declared.tools.length > 0 && plural(declared.tools.length, 'tool'),
    declared.domains.length > 0 && plural(declared.domains.length, 'host'),
    declared.paths.length > 0 && plural(declared.paths.length, 'path'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** Whether enforcement is on, asked of the gateway; undefined when it cannot say. */
async function enforcing(): Promise<boolean | undefined> {
  try {
    return (await gateway.pluginSettings()).enforce;
  } catch {
    return undefined;
  }
}

const ENFORCEMENT_WORDS = (on: boolean | undefined): string =>
  on === undefined
    ? ''
    : on
      ? 'Enforcement is on: only trusted skills are used, and a trusted skill narrows what a chat may do to what it declares.'
      : 'Enforcement is off: a skill is used whether or not you trust it (a blocked one is never used), and what it declares is shown, not enforced. Turn it on in Settings.';

/** The rows of what a skill is, for `show` and `trust`. */
function rows(ctx: Context, skill: SkillInfo): void {
  const width = 10;
  const row = (k: string, v: string) => ctx.out.say(`  ${ctx.out.bold(k.padEnd(width))}  ${v}`);
  row('State', `${STATE[skill.trust]}. ${skill.trustReason}`);
  row('From', ORIGIN(skill.origin));
  if (skill.version) row('Version', skill.version);
  row(
    'Checksum',
    skill.computedChecksum
      ? `${skill.computedChecksum} (${plural(skill.files.length, 'file')})`
      : `none: ${skill.problem ?? 'its files could not be hashed'}`
  );
  row(
    'Author’s',
    skill.checksum === null
      ? 'SKILL.md declares no checksum'
      : skill.checksumMatches
        ? `${skill.checksum}, which matches`
        : `${skill.checksum}, which does NOT match: the files are not what the author published`
  );
  const lines = describeSkillNeeds(skill.declared);
  if (lines.length === 0) row('Declares', 'nothing');
  lines.forEach((line, i) =>
    row(i === 0 ? 'Declares' : '', `${line.label.toLowerCase()}: ${line.items.join(', ')}`)
  );
  skill.warnings.forEach((w, i) => row(i === 0 ? 'Warnings' : '', w));
  if (skill.changes) {
    const c = skill.changes;
    const notes = [
      ...(c.version
        ? [`the version went from ${c.version.from ?? 'none'} to ${c.version.to ?? 'none'}`]
        : []),
      ...c.files.changed.map((f) => `${f} changed`),
      ...c.files.added.map((f) => `${f} was added`),
      ...c.files.removed.map((f) => `${f} was removed`),
      ...c.needs.map((n) => n.text.charAt(0).toLowerCase() + n.text.slice(1)),
    ];
    notes.forEach((n, i) => row(i === 0 ? 'Changed' : '', n));
  }
}

// ---- list ---------------------------------------------------------------------------------

export async function runList(ctx: Context, _call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const response = await gateway.skills();
  out.data(response);
  if (response.source === 'fallback') {
    out.say('There are no skills. Put a skill folder (with a SKILL.md) in the skills directory.');
    return EXIT.ok;
  }
  for (const line of table(
    ['SKILL', 'STATE', 'DECLARES', 'FROM'],
    response.skills.map((s) => [
      s.slug,
      STATE[s.trust],
      declaresShort(s.declared),
      ORIGIN(s.origin),
    ])
  )) {
    out.say(line);
  }
  out.say('');
  out.say(ENFORCEMENT_WORDS(response.enforce));
  out.say('`clerq skill show <skill>` has the details; `clerq skill trust <skill>` trusts one.');
  return EXIT.ok;
}

// ---- show ---------------------------------------------------------------------------------

async function detail(slug: string): Promise<{ skill: SkillInfo; body: string }> {
  try {
    const d = await gateway.skill(slug);
    return { skill: d.skill, body: d.body };
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) {
      throw new CliError(`There is no skill "${slug}". \`clerq skill list\` shows them.`);
    }
    throw e;
  }
}

export async function runShow(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const { skill, body } = await detail(call.args[0]);
  out.data({ skill, body });
  out.say(`${skill.name} (${skill.slug})`);
  rows(ctx, skill);
  out.say('');
  out.say(ctx.out.bold('Instructions'));
  out.say(body);
  return EXIT.ok;
}

// ---- trust, block, untrust ----------------------------------------------------------------

/** What a 409 from the skill routes means, in words. */
function refusal(e: unknown): never {
  if (e instanceof GatewayError && e.status === 409) {
    const code = e.body?.error;
    if (code === 'trust_stale') {
      throw new CliError(
        'The skill changed after you looked at it, so nothing was trusted. Look at it again with `clerq skill show` and try again.'
      );
    }
    if (code === 'not_trustable') {
      throw new CliError(String(e.body?.message ?? 'This skill cannot be trusted.'));
    }
  }
  throw e;
}

export async function runTrust(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const slug = call.args[0];
  await connect(ctx);
  const { skill } = await detail(slug);
  if (skill.origin.startsWith('plugin:')) {
    throw new CliError(
      `"${slug}" comes with the plugin ${skill.origin.slice(7)} and is approved with it, in Settings → Plugins. It cannot be trusted on its own.`
    );
  }
  if (!skill.computedChecksum) {
    throw new CliError(
      `"${slug}" cannot be trusted: ${skill.problem ?? 'its files could not be read'}`
    );
  }
  if (skill.trust === 'trusted') {
    out.data({ skill, changed: false });
    out.say(`"${slug}" is already trusted (${skill.trustReason}).`);
    return EXIT.ok;
  }
  out.say(`${skill.name} (${skill.slug})`);
  rows(ctx, skill);
  out.say('');
  out.say(
    `Trusting records exactly these files (${skill.computedChecksum}) and what they declare. If any file changes, you will be asked again.`
  );
  out.say(ENFORCEMENT_WORDS(await enforcing()));
  if (!flag(call, 'yes')) {
    out.say('`clerq skill show` prints its instructions.');
    const yes = await confirm(ctx.io, `Trust ${skill.name}?`);
    if (!yes) {
      out.error('Nothing was changed.');
      return EXIT.failed;
    }
  }
  try {
    const done = await gateway.trustSkill(slug, skill.computedChecksum);
    out.data({ ...done, changed: true });
    out.say(`Trusted ${done.skill.name}.`);
  } catch (e) {
    refusal(e);
  }
  return EXIT.ok;
}

export async function runBlock(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  try {
    const done = await gateway.blockSkill(call.args[0]);
    out.data(done);
    out.say(
      `Blocked ${done.skill.name}. It is not used, with enforcement on or off, until you untrust it.`
    );
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) {
      throw new CliError(`There is no skill "${call.args[0]}". \`clerq skill list\` shows them.`);
    }
    throw e;
  }
  return EXIT.ok;
}

export async function runUntrust(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  try {
    const done = await gateway.untrustSkill(call.args[0]);
    out.data(done);
    out.say(
      `${done.skill.name} is ${STATE[done.skill.trust]}: your decision about it was forgotten.`
    );
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) {
      throw new CliError(`There is no skill "${call.args[0]}". \`clerq skill list\` shows them.`);
    }
    throw e;
  }
  return EXIT.ok;
}

// ---- checksum -----------------------------------------------------------------------------

/**
 * The checksum of a skill's folder on this computer. Prints only the value, so
 * `sum=$(clerq skill checksum ./my-skill)` works; `--write` also puts it in SKILL.md's frontmatter.
 */
export async function runChecksum(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const dir = path.resolve(ctx.cwd, call.args[0]);
  const write = flag(call, 'write');
  try {
    const before = await readSkillDir(dir);
    if (!before.skillMd) {
      throw new CliError(`There is no SKILL.md in ${dir}. A skill is a folder with one.`);
    }
    const declared = declaredChecksumIn(before.skillMd.toString('latin1'));
    const checksum = write ? await writeSkillChecksum(dir) : before.checksum;
    out.data({
      checksum,
      path: dir,
      written: write,
      declared,
      matches: declared === null ? null : declared === checksum,
      files: before.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    });
    out.say(checksum);
    if (write) {
      out.aside(`Written to ${path.join(dir, 'SKILL.md')}.`);
    } else if (declared !== null && declared !== checksum) {
      out.aside(
        `SKILL.md declares ${declared}, which does not match these files. \`clerq skill checksum ${call.args[0]} --write\` updates it.`
      );
    } else if (declared === null) {
      out.aside('SKILL.md does not declare a checksum. --write adds one.');
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof SkillFilesError) throw new CliError(e.message);
    if (e instanceof UsageError || e instanceof CliError) throw e;
    throw new CliError(`Could not read ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
