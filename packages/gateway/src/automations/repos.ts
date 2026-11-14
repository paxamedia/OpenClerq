/**
 * The repositories automations work on: `GET /repos`, `GET /repos/:id` and
 * `POST /repos`.
 *
 * A row in `repos` is made the first time an automation targeting a
 * repository is queued (`ensureRepoRow`): a local one by its path, a remote
 * one by its URL, with the clone in the workspace cache once a run has made it
 * and the name of the vault secret it is reached with. The two GETs only read.
 * `POST /repos` makes the same row by hand, through the same functions, so the
 * keys match and an automation naming the repository later finds it.
 *
 * The vault is only asked which secrets exist (`secretNames`, names without
 * opening any); a secret's value is never read into an answer. The one place a
 * token is opened is `POST /repos` with `check: true`, for the single `git
 * ls-remote` it hands it to, through the environment of that command.
 *
 * Each request makes one pass over `runs` (counts and the last run for every
 * repository together), reads the automations once, and asks the vault once.
 * `runs` has no `repo_id` index, so a query per repository would scan it each.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { audit } from '@clerq/store';
import { forgeAuthEnv, git, isRepo } from '@clerq/workspaces';
import { logger } from '../logger.js';
import { listRepoRuns, type RunRecord } from '../runs.js';
import { getStore } from '../store.js';
import { vaultCredentials, type ForgeCredential } from './credentials.js';
import { cacheDirOf, type RunnerDeps } from './runner.js';
import { parseRepoTarget, type RepoTarget } from './spec.js';
import {
  ensureLocalRepoRow,
  ensureRemoteRepo,
  expandHome,
  listAutomations,
  type Automation,
} from './store.js';

/** How many of a repository's latest runs its detail lists. */
export const REPO_RECENT_RUNS = 20;

/** Waiting for a place, or for the queue to pick it up. */
const QUEUED = ['queued', 'leased'];
/** Holding the repository: its worktree is in use, or its owner has been asked something. */
const RUNNING = ['preparing', 'executing', 'verifying', 'publishing', 'awaiting_approval'];

export interface RepoAutomation {
  id: string;
  name: string;
  enabled: boolean;
  credential: { secret: string; present: boolean } | null;
}

export interface RepoView {
  id: string;
  kind: 'local' | 'github' | 'gitlab';
  /** `owner/name` for a remote, the folder's name for a local repository. */
  name: string;
  /** The https URL of a remote; null for a local repository. */
  url: string | null;
  /**
   * Where it is on this computer: the repository itself (`repository`) or a
   * remote's clone in the workspace cache (`clone`). Null for a remote no run
   * has cloned yet. `exists: false` is a folder that has gone since.
   */
  path: { value: string; exists: boolean; role: 'repository' | 'clone' } | null;
  /**
   * The vault secret named by the last run queued for it: a name, never a
   * value. Automations can differ, so read `automations[].credential` first;
   * this is what is left when none targets it now.
   */
  credential: { secret: string; present: boolean } | null;
  /**
   * The automations whose spec targets it now, each with the secret its own
   * spec reaches the forge with (`publish.token_secret`, or the forge's default
   * name), since two automations can name different ones. `credential` is null
   * for a local repository the automation neither pushes nor opens a pull
   * request on.
   */
  automations: RepoAutomation[];
  runs: { queued: number; running: number };
  lastRun: {
    id: string;
    status: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
  } | null;
  createdAt: string;
}

export interface RepoDetailView extends RepoView {
  /** Its latest runs, newest first. */
  recentRuns: RunRecord[];
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `owner/name` from a forge URL, or the whole URL when it has no such path. */
function projectOf(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return p || url;
  } catch {
    return url;
  }
}

/** Which vault secrets exist, asked once per request. */
function vaultCheck(
  deps: Pick<RunnerDeps, 'getSecret' | 'secretNames'>
): (name: string) => boolean {
  let names: Set<string> | null = null;
  if (deps.secretNames) {
    try {
      names = new Set(deps.secretNames());
    } catch {
      names = new Set();
    }
  }
  return (name) => {
    if (names) return names.has(name);
    try {
      // No list to ask (a caller that only gave getSecret): the value goes no further than this test.
      return Boolean(deps.getSecret(name));
    } catch {
      return false;
    }
  };
}

/**
 * The automations by the repository their spec targets now: a local path
 * (resolved, as `ensureLocalRepo` keeps it) or a remote's URL. Built once per
 * request, so no spec is read twice.
 */
function targetIndex(
  automations: Automation[],
  inVault: (name: string) => boolean
): Map<string, RepoAutomation[]> {
  const index = new Map<string, RepoAutomation[]>();
  for (const a of automations) {
    const spec = a.spec;
    if (!spec) continue;
    const local = spec.repo.kind === 'local';
    const key = local
      ? `local:${expandHome((spec.repo as { path: string }).path)}`
      : `url:${(spec.repo as { url: string }).url}`;
    // A remote is always reached with the token (clone, fetch); a local repository
    // only when the run pushes or opens a pull request.
    const needsToken = !local || spec.publish.push || spec.publish.pullRequest === 'draft';
    const secret = spec.publish.tokenSecret;
    const entry: RepoAutomation = {
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      credential: needsToken ? { secret, present: inVault(secret) } : null,
    };
    index.set(key, [...(index.get(key) ?? []), entry]);
  }
  return index;
}

interface RunFigures {
  runs: RepoView['runs'];
  lastRun: RepoView['lastRun'];
}

/**
 * Queued and running counts and the last run for every repository (or one), in
 * one query: sub-agent runs are left out, as they belong under their parent.
 */
function runFigures(repoId?: string): Map<string, RunFigures> {
  const marks = (list: string[]) => list.map(() => '?').join(',');
  const rows = getStore()
    .prepare(
      `SELECT repo_id, id, status, created_at, started_at, finished_at, queued, running FROM (
         SELECT repo_id, id, status, created_at, started_at, finished_at,
                ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY created_at DESC, rowid DESC) AS n,
                SUM(status IN (${marks(QUEUED)})) OVER (PARTITION BY repo_id) AS queued,
                SUM(status IN (${marks(RUNNING)})) OVER (PARTITION BY repo_id) AS running
         FROM runs
         WHERE repo_id IS NOT NULL AND parent_run_id IS NULL ${repoId ? 'AND repo_id = ?' : ''}
       ) WHERE n = 1`
    )
    .all(...QUEUED, ...RUNNING, ...(repoId ? [repoId] : []));
  const out = new Map<string, RunFigures>();
  for (const r of rows) {
    out.set(String(r.repo_id), {
      runs: { queued: Number(r.queued ?? 0), running: Number(r.running ?? 0) },
      lastRun: {
        id: String(r.id),
        status: String(r.status),
        createdAt: String(r.created_at),
        ...(r.started_at ? { startedAt: String(r.started_at) } : {}),
        ...(r.finished_at ? { finishedAt: String(r.finished_at) } : {}),
      },
    });
  }
  return out;
}

const NO_RUNS: RunFigures = { runs: { queued: 0, running: 0 }, lastRun: null };

interface Context {
  targets: Map<string, RepoAutomation[]>;
  figures: Map<string, RunFigures>;
  inVault: (name: string) => boolean;
}

function context(deps: Pick<RunnerDeps, 'getSecret' | 'secretNames'>, repoId?: string): Context {
  const inVault = vaultCheck(deps);
  return {
    targets: targetIndex(listAutomations(), inVault),
    figures: runFigures(repoId),
    inVault,
  };
}

function view(row: Record<string, unknown>, ctx: Context): RepoView {
  const id = String(row.id);
  const kind = String(row.kind) as RepoView['kind'];
  const localPath = row.local_path ? String(row.local_path) : null;
  const secret = row.credential_ref ? String(row.credential_ref) : null;
  const key =
    kind === 'local' && localPath ? `local:${localPath}` : row.url ? `url:${String(row.url)}` : '';
  const figures = ctx.figures.get(id) ?? NO_RUNS;
  return {
    id,
    kind,
    name:
      kind === 'local' && localPath
        ? path.basename(localPath)
        : row.url
          ? projectOf(String(row.url))
          : String(row.name),
    url: row.url ? String(row.url) : null,
    path: localPath
      ? {
          value: localPath,
          exists: isDirectory(localPath),
          role: kind === 'local' ? 'repository' : 'clone',
        }
      : null,
    credential: secret ? { secret, present: ctx.inVault(secret) } : null,
    automations: ctx.targets.get(key) ?? [],
    runs: figures.runs,
    lastRun: figures.lastRun,
    createdAt: String(row.created_at),
  };
}

export function listRepos(deps: Pick<RunnerDeps, 'getSecret' | 'secretNames'>): RepoView[] {
  const ctx = context(deps);
  return getStore()
    .prepare('SELECT * FROM repos ORDER BY name')
    .all()
    .map((row) => view(row, ctx));
}

export function getRepoDetail(
  id: string,
  deps: Pick<RunnerDeps, 'getSecret' | 'secretNames'>
): RepoDetailView | null {
  const row = getStore().prepare('SELECT * FROM repos WHERE id = ?').get(id);
  if (!row) return null;
  return { ...view(row, context(deps, id)), recentRuns: listRepoRuns(id, REPO_RECENT_RUNS) };
}

/** How long `git ls-remote` may take before the answer is "no". */
const CHECK_TIMEOUT_MS = 20_000;

/** What `check: true` found out about a remote. Nothing in it is a token. */
export interface RepoCheck {
  reachable: boolean;
  /** In words: what was reached, or why not. */
  message: string;
  /** The remote's default branch, when it said. */
  defaultBranch?: string;
  /** The vault secret asked for and what the credential hook answered, never the token. */
  credential: { secret: string; present: boolean; source?: string };
}

/** Any of `secrets` taken out of `text`. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out;
}

/**
 * Whether a remote can be reached, by one `git ls-remote` that sends the
 * credential the runner would clone with (the hook, purpose `fetch`) as an HTTP
 * header in the command's environment. Hardened as every git command the
 * gateway runs; nothing is cloned or stored.
 */
async function checkRemote(
  remote: Extract<RepoTarget, { project: string }>,
  secretName: string,
  deps: RunnerDeps
): Promise<RepoCheck> {
  const where = `${remote.kind === 'github' ? 'github.com' : 'gitlab.com'}/${remote.project}`;
  let credential: ForgeCredential | undefined;
  try {
    credential = await (deps.forgeCredentials ?? vaultCredentials(deps.getSecret))({
      forge: remote.kind,
      project: remote.project,
      purpose: 'fetch',
      secretName,
      automationId: '',
      runId: '',
    });
  } catch (e) {
    return {
      reachable: false,
      message: `Could not look up the credential ${secretName}: ${e instanceof Error ? e.message : String(e)}`,
      credential: { secret: secretName, present: false },
    };
  }
  const known = { secret: secretName, present: Boolean(credential), source: credential?.source };
  const env = credential ? forgeAuthEnv(remote.kind, credential.token) : undefined;
  // The token, and the Basic form git would send it in, are taken out of anything said back.
  const hidden = credential
    ? [
        credential.token,
        Buffer.from(`x-access-token:${credential.token}`).toString('base64'),
        Buffer.from(`oauth2:${credential.token}`).toString('base64'),
      ]
    : [];

  const cwd = cacheDirOf(deps);
  try {
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const r = await git(['ls-remote', '--symref', remote.url, 'HEAD'], {
      cwd,
      harden: true,
      env,
      timeoutMs: CHECK_TIMEOUT_MS,
      allowFailure: true,
    });
    if (r.code === 0) {
      const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(r.stdout)?.[1];
      return {
        reachable: true,
        message: `Reached ${where}${credential ? ` with ${secretName}` : ' without a credential (a public repository)'}.`,
        ...(branch ? { defaultBranch: branch } : {}),
        credential: known,
      };
    }
    const detail = scrub(
      (r.stderr.split('\n').find((l) => /fatal|error/i.test(l)) ?? r.stderr.trim()).trim(),
      hidden
    );
    let why: string;
    if (r.code === null) {
      why = `${where} did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`;
    } else if (
      /could not read Username|Authentication failed|terminal prompts disabled/i.test(r.stderr)
    ) {
      why = credential
        ? `${where} refused ${secretName}: it may be wrong, expired or without access to this repository.`
        : `${where} asked for a login. There is no ${secretName} in the vault: store a token as ${secretName} if this repository is private.`;
    } else if (/not found/i.test(r.stderr)) {
      why = credential
        ? `${where} was not found, or ${secretName} cannot see it.`
        : `${where} was not found. If it is private, store a token as ${secretName}.`;
    } else {
      why = `Could not reach ${where}.`;
    }
    return {
      reachable: false,
      message: detail ? `${why} (git said: ${detail})` : why,
      credential: known,
    };
  } catch (e) {
    return {
      reachable: false,
      message: scrub(
        `Could not reach ${where}: ${e instanceof Error ? e.message : String(e)}`,
        hidden
      ),
      credential: known,
    };
  }
}

/** A refused `POST /repos`: a status, a code the CLI can read, and words for a person. */
class AddRepoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** The git work tree's top folder for `dir`, or null when `dir` is in none. */
async function topLevelOf(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: dir, allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The local repository a target names: it must be an absolute path to a git work tree's top folder. */
async function checkLocal(repoPath: string): Promise<string> {
  if (!/^~(?=$|[\\/])/.test(repoPath) && !path.isAbsolute(repoPath)) {
    throw new AddRepoError(
      400,
      'invalid_target',
      `"${repoPath}" is not a full path. Give an absolute path, or one that starts with ~: the gateway does not know where you are working from.`
    );
  }
  const resolved = expandHome(repoPath);
  if (!fs.existsSync(resolved)) {
    throw new AddRepoError(400, 'repo_path_missing', `${resolved} does not exist.`);
  }
  if (!isDirectory(resolved)) {
    throw new AddRepoError(400, 'not_a_repository', `${resolved} is not a folder.`);
  }
  if (!(await isRepo(resolved))) {
    // git refuses a folder another user owns: say that, not that it is no repository.
    const asked = await git(['rev-parse', '--is-inside-work-tree'], {
      cwd: resolved,
      allowFailure: true,
    }).catch(() => null);
    if (asked && /dubious ownership/i.test(asked.stderr)) {
      throw new AddRepoError(
        400,
        'not_a_repository',
        `git will not use ${resolved}: it belongs to another user than the one the gateway runs as. ` +
          `As that account, run: git config --global --add safe.directory ${resolved}`
      );
    }
    throw new AddRepoError(
      400,
      'not_a_repository',
      `${resolved} is not a git work tree. Run git init there, or give the folder of an existing clone.`
    );
  }
  const top = await topLevelOf(resolved);
  if (top && fs.realpathSync(resolved) !== fs.realpathSync(top)) {
    throw new AddRepoError(
      400,
      'not_a_repository',
      `${resolved} is inside the git repository at ${top}, not its top folder. Add ${top} instead.`
    );
  }
  return resolved;
}

/**
 * Add a repository by hand: the same row `ensureRepoRow` makes when an
 * automation naming it is queued, so the keys match, and adding it twice
 * returns the row it made. A remote with `check` is reached first, and no row is
 * made for one that cannot be.
 */
async function addRepo(
  body: { target?: unknown; check?: unknown },
  deps: RunnerDeps
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (body.check !== undefined && typeof body.check !== 'boolean') {
    throw new AddRepoError(400, 'invalid_check', '"check" must be true or false.');
  }
  const parsed = parseRepoTarget(body.target);
  if (!parsed.ok) throw new AddRepoError(400, 'invalid_target', parsed.message);
  const target = parsed.repo;

  let made: { id: string; created: boolean };
  let check: RepoCheck | undefined;
  if (target.kind === 'local') {
    made = ensureLocalRepoRow(await checkLocal(target.path));
  } else {
    const existing = getStore()
      .prepare('SELECT credential_ref FROM repos WHERE url = ?')
      .get(target.url);
    // What a run of an automation using this row would reach it with: the secret the row
    // already names, else the forge's default (the spec's own default).
    const secret = existing?.credential_ref
      ? String(existing.credential_ref)
      : target.kind === 'gitlab'
        ? 'GITLAB_TOKEN'
        : 'GITHUB_TOKEN';
    if (body.check === true) {
      check = await checkRemote(target, secret, deps);
      if (!check.reachable && !existing) {
        throw new AddRepoError(422, 'repo_unreachable', check.message, { check });
      }
    }
    made = ensureRemoteRepo(target, secret, undefined, { keepCredential: true });
  }

  const db = getStore();
  if (made.created) {
    audit(db, {
      actor: 'operator',
      action: 'repo.added',
      subject: made.id,
      detail: { target: target.kind === 'local' ? `local:${expandHome(target.path)}` : target.url },
    });
  }
  const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(made.id);
  if (!row) throw new AddRepoError(500, 'repo_add_failed', 'The repository was not saved.');
  return {
    status: made.created ? 201 : 200,
    body: {
      ...view(row, context(deps, made.id)),
      created: made.created,
      ...(check ? { check } : {}),
    },
  };
}

/**
 * `GET /repos`, `GET /repos/:id` and `POST /repos`. They sit behind the same
 * token check as every other route (a scoped token reaches them only if its
 * scopes name them). The GETs only read; the POST adds a row.
 */
export function mountRepoRoutes(app: Express, deps: RunnerDeps): void {
  app.get('/repos', (_req: Request, res: Response) => {
    try {
      res.json({ repos: listRepos(deps) });
    } catch (e) {
      logger.error('repos list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'repos_list_failed' });
    }
  });

  app.post('/repos', async (req: Request, res: Response) => {
    try {
      const { status, body } = await addRepo((req.body ?? {}) as Record<string, unknown>, deps);
      res.status(status).json(body);
    } catch (e) {
      if (e instanceof AddRepoError) {
        return res.status(e.status).json({ error: e.code, message: e.message, ...e.extra });
      }
      logger.error('repo add error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'repo_add_failed', message: 'The repository was not added.' });
    }
  });

  app.get('/repos/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const repo = getRepoDetail(id, deps);
      if (!repo) return res.status(404).json({ error: 'repo_not_found', id });
      res.json(repo);
    } catch (e) {
      logger.error('repo get error', { id, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'repo_get_failed' });
    }
  });
}
