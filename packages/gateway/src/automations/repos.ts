/**
 * The repositories automations work on, read-only: `GET /repos` and
 * `GET /repos/:id`.
 *
 * A row in `repos` is made the first time an automation targeting a
 * repository is queued (`ensureRepoRow`): a local one by its path, a remote
 * one by its URL, with the clone in the workspace cache once a run has made it
 * and the name of the vault secret it is reached with. Nothing here writes.
 *
 * The vault is only asked which secrets exist (`secretNames`, names without
 * opening any); a secret's value is never read into an answer.
 *
 * Each request makes one pass over `runs` (counts and the last run for every
 * repository together), reads the automations once, and asks the vault once.
 * `runs` has no `repo_id` index, so a query per repository would scan it each.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { logger } from '../logger.js';
import { listRepoRuns, type RunRecord } from '../runs.js';
import { getStore } from '../store.js';
import type { RunnerDeps } from './runner.js';
import { expandHome, listAutomations, type Automation } from './store.js';

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

/**
 * `GET /repos` and `GET /repos/:id`. They sit behind the same token check as
 * every other route (a scoped token reaches them only if its scopes name them),
 * and only read.
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
