/**
 * The repositories automations work on, read-only: `GET /repos` and
 * `GET /repos/:id`.
 *
 * A row in `repos` is made the first time an automation targeting a
 * repository is queued (`ensureRepoRow`): a local one by its path, a remote
 * one by its URL, with the clone in the workspace cache once a run has made it
 * and the name of the vault secret it is reached with. Nothing here writes.
 *
 * The vault is only asked whether a secret exists. A secret's value is never
 * read into an answer.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { logger } from '../logger.js';
import { listRepoRuns, type RunRecord } from '../runs.js';
import { getStore } from '../store.js';
import type { RunnerDeps } from './runner.js';
import { expandHome, listAutomations } from './store.js';

/** How many of a repository's latest runs its detail lists. */
export const REPO_RECENT_RUNS = 20;

/** Waiting for a place, or for the queue to pick it up. */
const QUEUED = ['queued', 'leased'];
/** Holding the repository: its worktree is in use, or its owner has been asked something. */
const RUNNING = ['preparing', 'executing', 'verifying', 'publishing', 'awaiting_approval'];

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
  /** The vault secret it is reached with: its name, never its value. */
  credential: { secret: string; present: boolean } | null;
  /** The automations whose spec targets it now. */
  automations: Array<{ id: string; name: string; enabled: boolean }>;
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

/** The automations whose spec targets this repository now, by path or URL. */
function targeting(row: Record<string, unknown>): RepoView['automations'] {
  const url = row.url ? String(row.url) : null;
  const local = row.kind === 'local' && row.local_path ? String(row.local_path) : null;
  return listAutomations()
    .filter((a) => {
      const repo = a.spec?.repo;
      if (!repo) return false;
      return repo.kind === 'local' ? local === expandHome(repo.path) : url === repo.url;
    })
    .map((a) => ({ id: a.id, name: a.name, enabled: a.enabled }));
}

function counts(repoId: string): RepoView['runs'] {
  const marks = (list: string[]) => list.map(() => '?').join(',');
  const row = getStore()
    .prepare(
      `SELECT
         COALESCE(SUM(status IN (${marks(QUEUED)})), 0) AS queued,
         COALESCE(SUM(status IN (${marks(RUNNING)})), 0) AS running
       FROM runs WHERE repo_id = ? AND parent_run_id IS NULL`
    )
    .get(...QUEUED, ...RUNNING, repoId);
  return { queued: Number(row?.queued ?? 0), running: Number(row?.running ?? 0) };
}

function lastRunOf(repoId: string): RepoView['lastRun'] {
  const r = getStore()
    .prepare(
      `SELECT id, status, created_at, started_at, finished_at FROM runs
       WHERE repo_id = ? AND parent_run_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(repoId);
  if (!r) return null;
  return {
    id: String(r.id),
    status: String(r.status),
    createdAt: String(r.created_at),
    ...(r.started_at ? { startedAt: String(r.started_at) } : {}),
    ...(r.finished_at ? { finishedAt: String(r.finished_at) } : {}),
  };
}

function view(row: Record<string, unknown>, deps: Pick<RunnerDeps, 'getSecret'>): RepoView {
  const kind = String(row.kind) as RepoView['kind'];
  const localPath = row.local_path ? String(row.local_path) : null;
  const secret = row.credential_ref ? String(row.credential_ref) : null;
  let present = false;
  if (secret) {
    try {
      // Only whether there is one: the value goes no further than this test.
      present = Boolean(deps.getSecret(secret));
    } catch {
      present = false;
    }
  }
  return {
    id: String(row.id),
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
    credential: secret ? { secret, present } : null,
    automations: targeting(row),
    runs: counts(String(row.id)),
    lastRun: lastRunOf(String(row.id)),
    createdAt: String(row.created_at),
  };
}

export function listRepos(deps: Pick<RunnerDeps, 'getSecret'>): RepoView[] {
  return getStore()
    .prepare('SELECT * FROM repos ORDER BY name')
    .all()
    .map((row) => view(row, deps));
}

export function getRepoDetail(
  id: string,
  deps: Pick<RunnerDeps, 'getSecret'>
): RepoDetailView | null {
  const row = getStore().prepare('SELECT * FROM repos WHERE id = ?').get(id);
  if (!row) return null;
  return { ...view(row, deps), recentRuns: listRepoRuns(id, REPO_RECENT_RUNS) };
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
