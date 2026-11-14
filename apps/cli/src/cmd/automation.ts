/** `clerq automation apply | list | show | enable | disable`. */

import fs from 'node:fs';
import path from 'node:path';
import {
  GatewayError,
  gateway,
  type AutomationPreview,
  type AutomationSummary,
} from '@clerq/gateway-client';
import { flag, str, type Call } from '../args.js';
import { connect } from '../connect.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { dateTime, money, oneLine, statusWords, table } from '../format.js';
import { readStdin } from '../prompt.js';

/** An automation by name or id. A name that is not there lists the ones that are. */
export async function findAutomation(ref: string): Promise<AutomationSummary> {
  const { automations } = await gateway.automations();
  const found = automations.find((a) => a.id === ref) ?? automations.find((a) => a.name === ref);
  if (found) return found;
  const names = automations.map((a) => a.name);
  throw new CliError(
    `No automation named "${ref}".` +
      (names.length
        ? ` The ones that exist: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}.`
        : ' None exist yet: write a spec and run `clerq automation apply -f <file>`.')
  );
}

/** What a spec looks like for comparing: line endings and trailing blank space do not count. */
const comparable = (text: string) =>
  text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');

interface SpecProblem {
  line: number | null;
  column: number | null;
  message: string;
}

/** A refusal of the spec itself (400 `invalid_spec`), or null for any other failure. */
function specProblem(e: unknown): SpecProblem | null {
  if (!(e instanceof GatewayError) || e.body?.error !== 'invalid_spec') return null;
  const message = String(e.body.message ?? e.message).replace(/^Line \d+, column \d+: /, '');
  return {
    line: typeof e.body.line === 'number' ? e.body.line : null,
    column: typeof e.body.column === 'number' ? e.body.column : null,
    message,
  };
}

/** `nightly.yaml:13:7: error: ...`, the shape an editor can jump from. */
function placed(label: string, p: SpecProblem): string {
  const at = p.line ? `${label}:${p.line}${p.column ? `:${p.column}` : ''}` : label;
  return `${at}: ${p.message}`;
}

export async function runApply(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const file = str(call, 'file');
  if (!file)
    throw new UsageError('"clerq automation apply" needs -f <file> (use - for standard input).');
  const label = file === '-' ? 'standard input' : file;
  let text: string;
  if (file === '-') text = await readStdin(ctx.io.stdin);
  else {
    try {
      text = fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8');
    } catch (e) {
      throw new CliError(
        `Could not read ${file}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`
      );
    }
  }
  text = text.replace(/^﻿/, '');
  const dryRun = flag(call, 'dry-run');
  const enable = flag(call, 'enable');
  await connect(ctx);

  // 1. Check it against this gateway's machine before anything is saved.
  let preview: AutomationPreview;
  try {
    preview = await gateway.previewAutomation(text);
  } catch (e) {
    const problem = specProblem(e);
    if (!problem) throw e;
    out.data({ ok: false, dryRun, errors: [problem], warnings: [] });
    out.error(placed(label, problem));
    return EXIT.failed;
  }
  const errors = preview.checks.filter((c) => c.level === 'error').map((c) => c.message);
  const warnings = preview.checks.filter((c) => c.level === 'warning').map((c) => c.message);
  for (const w of warnings) out.warn(`${label}: ${w}`);
  if (errors.length > 0) {
    out.data({
      ok: false,
      dryRun,
      name: preview.spec?.name ?? null,
      errors: errors.map((message) => ({ line: null, column: null, message })),
      warnings,
    });
    for (const m of errors) out.error(`${label}: ${m}`);
    out.error('Nothing was saved. Fix the above and apply again.');
    return EXIT.failed;
  }
  const name = preview.spec?.name;
  if (!name)
    throw new CliError(
      'The gateway did not say what the automation is called. Is it older than this CLI?'
    );

  // 2. Create it, or update the one with this name, or see that nothing differs.
  const { automations } = await gateway.automations();
  const existing = automations.find((a) => a.name === name);
  let action: 'created' | 'updated' | 'unchanged';
  if (!existing) action = 'created';
  else {
    const saved = await gateway.automation(existing.id);
    action = comparable(saved.source) === comparable(text) ? 'unchanged' : 'updated';
  }

  let id = existing?.id ?? null;
  let enabled = existing?.enabled ?? false;
  const switchOn = enable && !enabled;
  if (!dryRun) {
    try {
      if (action === 'created') {
        id = (await gateway.createAutomation(text)).id;
      } else if (action === 'updated') {
        await gateway.updateAutomation(existing!.id, text);
      }
    } catch (e) {
      const problem = specProblem(e);
      if (!problem) throw e;
      out.data({ ok: false, dryRun, name, errors: [problem], warnings });
      out.error(placed(label, problem));
      return EXIT.failed;
    }
    if (switchOn) {
      await gateway.setAutomationEnabled(id as string, true);
      enabled = true;
    }
  }

  const finalEnabled = dryRun ? enabled || switchOn : enabled;
  out.data({
    ok: true,
    dryRun,
    action,
    name,
    id,
    enabled: finalEnabled,
    switchedOn: switchOn,
    errors: [],
    warnings,
  });
  if (action === 'unchanged') out.say(`Unchanged: ${name} already has this spec.`);
  else {
    const verb = { created: ['Created', 'Would create'], updated: ['Updated', 'Would update'] }[
      action
    ];
    out.say(`${verb[dryRun ? 1 : 0]} ${name}${id ? ` (${id})` : ''}.`);
  }
  if (switchOn) out.say(`${dryRun ? 'Would switch' : 'Switched'} on ${name}.`);
  else if (action === 'created' && !enable) {
    out.say(
      `${name} is switched off. Switch it on with \`clerq automation enable ${name}\`, or apply with --enable.`
    );
  } else if (finalEnabled) out.say(`${name} is switched on.`);
  else out.say(`${name} is switched off.`);
  if (dryRun) out.note('Dry run: nothing was changed.');
  return EXIT.ok;
}

export async function runList(ctx: Context, _call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const { automations } = await gateway.automations();
  out.data({ automations });
  if (automations.length === 0) {
    out.say('No automations yet. Write a spec and run `clerq automation apply -f <file>`.');
    return EXIT.ok;
  }
  const rows = automations.map((a) => [
    a.name,
    a.problem ? 'needs editing' : a.enabled ? 'on' : 'off',
    a.schedule ?? 'by hand',
    a.driver ?? '-',
    oneLine(a.repo ?? '', 40) || '-',
    a.running
      ? 'running'
      : a.queued
        ? 'queued'
        : a.lastRun
          ? `${statusWords(a.lastRun.status)} ${dateTime(a.lastRun.createdAt)}`
          : '-',
  ]);
  for (const line of table(['NAME', 'STATE', 'SCHEDULE', 'AGENT', 'REPOSITORY', 'LAST RUN'], rows))
    out.say(line);
  return EXIT.ok;
}

export async function runShow(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const found = await findAutomation(call.args[0]);
  const a = await gateway.automation(found.id);
  if (flag(call, 'source')) {
    out.raw(a.source);
    return EXIT.ok;
  }
  out.data(a);
  out.say(
    `${out.bold(a.name)}  ${a.problem ? 'needs editing' : a.enabled ? 'switched on' : 'switched off'}`
  );
  if (a.description) out.say(a.description);
  const rows: Array<[string, string]> = [
    ['Id', a.id],
    [
      'Schedule',
      a.schedule
        ? `${a.schedule}${a.nextRunAt ? `  (next ${dateTime(a.nextRunAt)})` : ''}`
        : 'none: runs when started by hand',
    ],
    ['Agent', a.driver ?? '-'],
    ['Repository', a.repo ?? '-'],
    [
      'This month',
      a.monthBudgetUsd !== null
        ? `${money(a.monthSpendUsd)} of ${money(a.monthBudgetUsd)}`
        : money(a.monthSpendUsd),
    ],
    [
      'Last run',
      a.lastRun
        ? `${statusWords(a.lastRun.status)}, ${a.lastRun.id}, ${dateTime(a.lastRun.createdAt)}${a.lastRun.prUrl ? `, ${a.lastRun.prUrl}` : ''}`
        : 'none yet',
    ],
    ...(a.running ? ([['Now', 'a run is going']] as Array<[string, string]>) : []),
    ...(a.queued ? ([['Now', 'a run is waiting for a place']] as Array<[string, string]>) : []),
    ...(a.authoredBy
      ? ([['Written by', a.authoredBy.startsWith('chat') ? 'a chat' : a.authoredBy]] as Array<
          [string, string]
        >)
      : []),
    ...(a.problem ? ([['Problem', a.problem]] as Array<[string, string]>) : []),
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out.say(`  ${k.padEnd(width)}  ${v}`);
  out.say('');
  out.say(`The spec as saved: clerq automation show ${a.name} --source`);
  return EXIT.ok;
}

async function setEnabled(ctx: Context, call: Call, enabled: boolean): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const found = await findAutomation(call.args[0]);
  if (found.enabled === enabled) {
    out.data({ ok: true, name: found.name, id: found.id, enabled, changed: false });
    out.say(`${found.name} is already switched ${enabled ? 'on' : 'off'}.`);
    return EXIT.ok;
  }
  await gateway.setAutomationEnabled(found.id, enabled);
  out.data({ ok: true, name: found.name, id: found.id, enabled, changed: true });
  out.say(`Switched ${enabled ? 'on' : 'off'} ${found.name}.`);
  return EXIT.ok;
}

export const runEnable = (ctx: Context, call: Call) => setEnabled(ctx, call, true);
export const runDisable = (ctx: Context, call: Call) => setEnabled(ctx, call, false);
