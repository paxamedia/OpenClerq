/** `clerq repo add | list | show`. */

import path from 'node:path';
import { GatewayError, gateway, type AddRepoResult, type RepoSummary } from '@clerq/gateway-client';
import { flag, type Call } from '../args.js';
import { connect } from '../connect.js';
import { expandTilde, isLoopbackHost } from '../connection.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { dateTime, oneLine, statusWords, table } from '../format.js';

/**
 * The target as `targets.repos` writes it. A folder (or `local:<folder>`) is made
 * absolute from where the command is run, since the gateway does not know that;
 * a `~` is expanded here only for a gateway on this computer, where it means the
 * same home. Anything else goes through as typed, so the gateway's own parser
 * says what is wrong with it.
 */
export function targetOf(
  arg: string,
  cwd: string,
  home: string,
  gatewayIsLocal: boolean
): { target: string; local: boolean } {
  const text = arg.trim();
  if (!text)
    throw new UsageError('A repository target is a folder, or something like github:acme/app.');
  if (/^(github|gitlab):/.test(text) || /^https?:\/\//i.test(text))
    return { target: text, local: false };
  // Some other address (ssh, git@host:...): the gateway's parser explains what it accepts.
  if (/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(text) || /^[\w.-]+@[\w.-]+:/.test(text)) {
    return { target: text, local: false };
  }
  const folder = text.startsWith('local:') ? text.slice(6) : text;
  const hash = folder.indexOf('#');
  const where = hash === -1 ? folder : folder.slice(0, hash);
  const ref = hash === -1 ? '' : folder.slice(hash);
  if (!where.trim()) throw new UsageError('local: needs a folder, e.g. local:~/code/app.');
  let resolved: string;
  if (where.startsWith('~') && !gatewayIsLocal) resolved = where;
  else resolved = path.resolve(cwd, gatewayIsLocal ? expandTilde(where, home) : where);
  return { target: `local:${resolved}${ref}`, local: true };
}

const repoLine = (r: Pick<AddRepoResult, 'name' | 'kind' | 'id'>) =>
  `${r.name} (${r.kind}, id ${r.id})`;

export async function runAdd(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const resolved = await connect(ctx);
  const gatewayIsLocal = isLoopbackHost(new URL(resolved.url).hostname);
  const { target, local } = targetOf(call.args[0], ctx.cwd, ctx.home, gatewayIsLocal);
  const check = flag(call, 'check');
  if (local && !gatewayIsLocal) {
    out.note(
      `${target.slice(6)} is a path on the gateway's computer (${resolved.url}), not on this one.`
    );
  }
  if (local && check) {
    out.note(
      '--check only means something for a remote repository; a folder is always checked to be a git work tree.'
    );
  }

  let added: AddRepoResult;
  try {
    added = await gateway.addRepo(target, check ? { check: true } : {});
  } catch (e) {
    if (e instanceof GatewayError && e.body?.error === 'repo_unreachable') {
      out.data({ ok: false, error: 'repo_unreachable', target, ...e.body });
      out.error(`${String(e.body.message)} Nothing was added.`);
      return EXIT.failed;
    }
    throw e;
  }

  out.data({ ok: true, ...added });
  out.say(
    added.created
      ? `Added ${repoLine(added)}.`
      : `${repoLine(added)} was already listed; nothing changed.`
  );
  const rows: Array<[string, string]> = [];
  if (added.path)
    rows.push([
      'Where',
      `${added.path.value}${added.path.exists ? '' : '  (the folder is missing)'}`,
    ]);
  if (added.url) rows.push(['Address', added.url]);
  if (added.credential) {
    rows.push([
      'Reached with',
      `${added.credential.secret} (${added.credential.present ? 'in the vault' : 'not in the vault: a private repository needs it'})`,
    ]);
  }
  if (added.check) {
    rows.push([
      'Check',
      `${added.check.message}${added.check.defaultBranch ? ` Default branch: ${added.check.defaultBranch}.` : ''}`,
    ]);
  }
  const width = Math.max(0, ...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out.say(`  ${k.padEnd(width)}  ${v}`);
  if (added.check && !added.check.reachable) {
    out.error(
      'The repository could not be reached, so its check failed. It was already listed, and still is.'
    );
    return EXIT.failed;
  }
  return EXIT.ok;
}

/** The end of a long path, which is the part that tells repositories apart. */
const tail = (text: string, max: number) =>
  text.length > max ? `…${text.slice(text.length - max + 1)}` : text;

const whereOf = (r: RepoSummary): string =>
  r.path ? `${r.path.value}${r.path.exists ? '' : ' (missing)'}` : (r.url ?? '');

const runsWords = (r: RepoSummary): string => {
  const parts = [
    r.runs.running ? `${r.runs.running} running` : '',
    r.runs.queued ? `${r.runs.queued} queued` : '',
  ];
  return parts.filter(Boolean).join(', ') || '-';
};

export async function runList(ctx: Context, _call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const { repos } = await gateway.repos();
  out.data({ repos });
  if (repos.length === 0) {
    out.say('No repositories yet. Add one with `clerq repo add <folder or github:owner/name>`.');
    return EXIT.ok;
  }
  const rows = repos.map((r) => [
    r.name,
    r.kind,
    tail(whereOf(r), 50),
    oneLine(r.automations.map((a) => a.name).join(', '), 40) || '-',
    runsWords(r),
    r.lastRun ? `${statusWords(r.lastRun.status)} ${dateTime(r.lastRun.createdAt)}` : '-',
    r.id,
  ]);
  for (const line of table(
    ['NAME', 'KIND', 'WHERE', 'AUTOMATIONS', 'RUNS', 'LAST RUN', 'ID'],
    rows
  ))
    out.say(line);
  return EXIT.ok;
}

/** A repository by id, or by its name (`acme/app`, a folder name) or address when that is unambiguous. */
async function findRepo(ref: string): Promise<string> {
  if (/^repo_/.test(ref)) return ref;
  const { repos } = await gateway.repos();
  const wanted = ref
    .replace(/^(github|gitlab):/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
  const hits = repos.filter(
    (r) =>
      r.name.toLowerCase() === wanted ||
      r.url === ref ||
      r.url
        ?.toLowerCase()
        .replace(/\.git$/, '')
        .endsWith(`/${wanted}`) ||
      r.path?.value === ref
  );
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    throw new CliError(
      `"${ref}" matches ${hits.length} repositories; use an id: ${hits.map((h) => h.id).join(', ')}`
    );
  }
  throw new CliError(
    `No repository "${ref}".${repos.length ? ` Known: ${repos.map((r) => r.name).join(', ')}.` : ' Add one with `clerq repo add`.'}`
  );
}

export async function runShow(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const id = await findRepo(call.args[0]);
  const r = await gateway.repo(id);
  out.data(r);
  out.say(`${out.bold(r.name)} (${r.kind})`);
  const rows: Array<[string, string]> = [
    ['Id', r.id],
    ...(r.url ? ([['Address', r.url]] as Array<[string, string]>) : []),
    [
      r.kind === 'local' ? 'Folder' : 'Clone',
      r.path
        ? `${r.path.value}${r.path.exists ? '' : '  (missing)'}`
        : 'not cloned yet: the first run makes it',
    ],
    [
      'Reached with',
      r.credential
        ? `${r.credential.secret} (${r.credential.present ? 'in the vault' : 'not in the vault'})`
        : 'nothing',
    ],
    ['Runs', runsWords(r)],
    ['Added', dateTime(r.createdAt)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out.say(`  ${k.padEnd(width)}  ${v}`);
  out.say('');
  if (r.automations.length === 0) out.say('No automation targets it yet.');
  else {
    out.say('Automations that target it');
    for (const a of r.automations) {
      out.say(
        `  ${a.name}  ${a.enabled ? 'on' : 'off'}${a.credential ? `  (${a.credential.secret} ${a.credential.present ? 'in the vault' : 'missing'})` : ''}`
      );
    }
  }
  if (r.recentRuns.length > 0) {
    out.say('');
    out.say('Latest runs');
    for (const line of table(
      ['RUN', 'STATE', 'AUTOMATION', 'STARTED'],
      r.recentRuns.map((x) => [
        x.id,
        statusWords(x.status),
        x.automationName ?? '-',
        dateTime(x.createdAt),
      ])
    )) {
      out.say(`  ${line}`);
    }
  }
  return EXIT.ok;
}
