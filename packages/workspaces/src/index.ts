/**
 * Workspaces: where a run actually touches a repository.
 *
 * Each run gets its own `git worktree`, so concurrent runs against the same
 * repository never share a checkout, never fight over the index, and never see
 * each other's uncommitted changes. A worktree is cheap — it shares the object
 * database with the repo it came from — which is what makes per-run isolation
 * affordable.
 *
 * Remotes are cloned once into a content-addressed cache and reused; the cache
 * key is derived from the URL, so two automations targeting the same repository
 * share one clone and one object store.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, isRepo, currentBranch, headSha, defaultBranch, GitError } from './git.js';

export { git, isRepo, currentBranch, headSha, defaultBranch, GitError } from './git.js';
export * from './publish.js';

export type RepoKind = 'local' | 'remote';

export interface RepoRef {
  kind: RepoKind;
  /** Filesystem path for `local`, clone URL for `remote`. */
  location: string;
  /** Branch to base the run on. Defaults to the repository's default branch. */
  ref?: string;
}

export interface WorkspaceOptions {
  /** Where clones and worktrees live. Defaults to ~/.clerq/workspaces. */
  cacheDir?: string;
  /** Branch to create for the run. Omit to work on the base branch. */
  branch?: string;
  /** Credentials for cloning or fetching a private remote. */
  env?: Record<string, string>;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export class WorkspaceError extends Error {
  readonly code = 'workspace_error';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

function defaultCacheDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  return path.join(home, '.clerq', 'workspaces');
}

/**
 * Stable cache key for a remote. Derived from the URL so the same repository
 * resolves to the same clone regardless of which automation asked for it.
 */
export function cacheKey(url: string): string {
  const normalised = url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const hash = crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 12);
  const name = normalised.split(/[/:]/).pop() || 'repo';
  return `${name.replace(/[^a-zA-Z0-9._-]/g, '-')}-${hash}`;
}

/** A checked-out working copy for one run. */
export class Workspace {
  constructor(
    /** Working directory the run operates in. */
    readonly path: string,
    /** The repository this was cut from. */
    readonly repoRoot: string,
    /** Branch checked out in this worktree, or the base ref when detached. */
    readonly branch: string,
    /** Commit the branch started from. */
    readonly baseSha: string,
    private readonly env: Record<string, string> | undefined,
    private readonly isWorktree: boolean,
    /**
     * True when no branch was requested. git refuses to check out a branch that
     * is already checked out in another worktree — which the source repository
     * usually is — so a branchless workspace is detached at the base commit.
     */
    readonly detached: boolean = false
  ) {}

  private opts(extra?: Partial<{ allowFailure: boolean }>) {
    return { cwd: this.path, env: this.env, ...extra };
  }

  /** Files changed relative to HEAD, staged or not, including untracked. */
  async status(): Promise<string[]> {
    const r = await git(['status', '--porcelain=v1', '--untracked-files=all'], this.opts());
    return r.stdout
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  }

  async hasChanges(): Promise<boolean> {
    return (await this.status()).length > 0;
  }

  /**
   * Stage everything and commit.
   *
   * A trailer marks the commit as machine-generated, so such commits can be
   * found in the history later. Returns null when there was
   * nothing to commit — a no-op run should not produce an empty commit.
   */
  async commitAll(
    message: string,
    opts?: { author?: string; email?: string; trailer?: string }
  ): Promise<string | null> {
    if (!(await this.hasChanges())) return null;

    await git(['add', '--all'], this.opts());

    const trailer = opts?.trailer ?? 'Generated-by: OpenClerq';
    const full = `${message.trim()}\n\n${trailer}\n`;

    await git(['commit', '--no-verify', '-m', full], {
      ...this.opts(),
      env: {
        ...this.env,
        GIT_AUTHOR_NAME: opts?.author ?? 'OpenClerq',
        GIT_AUTHOR_EMAIL: opts?.email ?? 'openclerq@localhost',
        GIT_COMMITTER_NAME: opts?.author ?? 'OpenClerq',
        GIT_COMMITTER_EMAIL: opts?.email ?? 'openclerq@localhost',
      },
    });
    return headSha(this.path);
  }

  /** Diff against the commit this workspace started from. */
  async diffStat(): Promise<DiffStat> {
    const r = await git(['diff', '--numstat', `${this.baseSha}..HEAD`], this.opts());
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [add, del, file] = line.split('\t');
      if (!file) continue;
      files.push(file);
      insertions += Number(add) || 0;
      deletions += Number(del) || 0;
    }
    return { filesChanged: files.length, insertions, deletions, files };
  }

  /** Full patch against the base commit, for review or as a run artifact. */
  async diff(): Promise<string> {
    const r = await git(['diff', `${this.baseSha}..HEAD`], this.opts());
    return r.stdout;
  }

  async push(remote = 'origin', opts?: { force?: boolean; setUpstream?: boolean }): Promise<void> {
    if (this.detached) {
      throw new WorkspaceError(
        'This workspace is detached and has no branch to push. Open it with a `branch` option to publish from it.'
      );
    }
    const args = ['push'];
    if (opts?.setUpstream !== false) args.push('--set-upstream');
    // --force-with-lease refuses to overwrite work that arrived since we last
    // fetched; plain --force would discard it silently.
    if (opts?.force) args.push('--force-with-lease');
    args.push(remote, this.branch);
    await git(args, this.opts());
  }

  /** Remove the worktree. Safe to call twice. */
  async dispose(): Promise<void> {
    if (!this.isWorktree) return;
    try {
      await git(['worktree', 'remove', '--force', this.path], {
        cwd: this.repoRoot,
        allowFailure: true,
      });
    } catch {
      /* best effort */
    }
    try {
      if (fs.existsSync(this.path)) fs.rmSync(this.path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Ensure a local clone exists for `repo`, returning its path.
 * Local repositories are used in place; remotes are cloned into the cache and
 * fetched on subsequent calls.
 */
export async function ensureRepo(repo: RepoRef, options?: WorkspaceOptions): Promise<string> {
  const cacheDir = options?.cacheDir ?? defaultCacheDir();

  if (repo.kind === 'local') {
    const resolved = path.resolve(repo.location.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(resolved)) {
      throw new WorkspaceError(`Repository path does not exist: ${resolved}`);
    }
    if (!(await isRepo(resolved))) {
      throw new WorkspaceError(`Not a git repository: ${resolved}`);
    }
    return resolved;
  }

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const target = path.join(cacheDir, cacheKey(repo.location));

  if (fs.existsSync(target) && (await isRepo(target))) {
    await git(['fetch', '--all', '--prune'], { cwd: target, env: options?.env });
    return target;
  }

  fs.rmSync(target, { recursive: true, force: true });
  await git(['clone', repo.location, target], { cwd: cacheDir, env: options?.env });
  return target;
}

/**
 * Create an isolated workspace for one run.
 *
 * Always call `dispose()` when finished, or worktrees accumulate and the repo's
 * worktree list grows without bound.
 */
export async function openWorkspace(repo: RepoRef, options?: WorkspaceOptions): Promise<Workspace> {
  const repoRoot = await ensureRepo(repo, options);
  const base = repo.ref ?? (await defaultBranch(repoRoot));
  const cacheDir = options?.cacheDir ?? defaultCacheDir();

  const worktreeRoot = path.join(cacheDir, '.worktrees');
  fs.mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(worktreeRoot, 'run-'));
  // mkdtemp created it; git worktree add insists on creating it itself.
  fs.rmdirSync(dir);

  const detached = !options?.branch;
  const branch = options?.branch ?? base;
  const args = ['worktree', 'add'];
  if (options?.branch) {
    args.push('-b', options.branch);
  } else {
    // Without a branch of its own the worktree must detach: git refuses to
    // check out a ref that another worktree already holds, and the source
    // repository is normally sitting on exactly this branch.
    args.push('--detach');
  }
  args.push(dir, base);

  try {
    await git(args, { cwd: repoRoot, env: options?.env });
  } catch (e) {
    throw new WorkspaceError(
      `Could not create a worktree for ${repo.location} at ${base}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const sha = await headSha(dir);
  return new Workspace(dir, repoRoot, branch, sha, options?.env, true, detached);
}

/** Remove worktrees left behind by runs that died before disposing. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repoRoot, allowFailure: true });
}
