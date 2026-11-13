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
import { git, isRepo, currentBranch, headSha, defaultBranch, GitError, SAFE_DIFF } from './git.js';

export {
  git,
  isRepo,
  currentBranch,
  headSha,
  defaultBranch,
  GitError,
  HARDENED_GIT,
  SAFE_DIFF,
} from './git.js';
export * from './publish.js';
export * from './forge.js';

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
  /**
   * Fetch a remote that is already in the cache. Default true; a caller that
   * fetches what it needs itself (one branch) turns it off.
   */
  fetch?: boolean;
}

/** Where a worktree's git data lives. */
export interface GitDirs {
  /** The repository's git directory: objects, refs, config, hooks. */
  commonDir: string;
  /** This worktree's own directory inside it: its HEAD and index. */
  adminDir: string;
  /** The `.git` file in the worktree that points at `adminDir`. */
  gitFile: string;
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
    readonly detached: boolean = false,
    /** The branch or ref the workspace was cut from: where its changes would merge. */
    readonly baseRef: string = ''
  ) {}

  /** Every git command here runs hardened: an agent has written to this worktree. */
  private opts(extra?: Partial<{ allowFailure: boolean }>) {
    return { cwd: this.path, env: this.env, harden: true, ...extra };
  }

  /** Files changed relative to HEAD, staged or not, including untracked. */
  async status(): Promise<string[]> {
    const r = await git(
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'],
      this.opts()
    );
    return r.stdout
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  }

  /**
   * Whether the worktree's content differs from the base: what the run's one
   * commit would hold. Read from the files themselves into a private index,
   * never from the worktree's own index, which an agent can rewrite.
   */
  async hasChanges(): Promise<boolean> {
    const { tree } = await this.snapshot(this.head ?? this.baseSha);
    return tree !== (await this.treeOf(this.baseSha));
  }

  /** The run's commit, once `commitAll` has made it. */
  head: string | undefined;

  /** The ref the run's commit goes on: its branch, or HEAD when detached. */
  private get ref(): string {
    return this.detached ? 'HEAD' : `refs/heads/${this.branch}`;
  }

  private async treeOf(commit: string): Promise<string> {
    return (await git(['rev-parse', `${commit}^{tree}`], this.opts())).stdout.trim();
  }

  /**
   * The worktree's files as a tree, built in an index of the gateway's own
   * (in a directory no sandbox can write), started from `parent`, with the
   * submodule entries it would add. Nothing the agent left in the worktree's
   * index, HEAD or merge state takes part.
   */
  private async snapshot(parent: string): Promise<{ tree: string; gitlinks: string[] }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-index-'));
    const env = { ...this.env, GIT_INDEX_FILE: path.join(dir, 'index') };
    try {
      await git(['read-tree', parent], { ...this.opts(), env });
      await git(['add', '--all'], { ...this.opts(), env });
      const index = await git(['ls-files', '--stage', '-z'], { ...this.opts(), env });
      const tree = (await git(['write-tree'], { ...this.opts(), env })).stdout.trim();
      return { tree, gitlinks: await this.newGitlinks(index.stdout) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Commit the worktree's content as the run's one commit, on the base.
   *
   * Made with plumbing: the tree from a private index (`snapshot`), a commit
   * whose only parent is the base (`commit-tree -p`), and the branch moved to
   * it only from the value it had just before (`update-ref` with the old
   * value). A merge the agent set up (MERGE_HEAD), a commit of its own or a
   * rewritten index adds nothing to it: the branch is the base plus this one
   * commit, so what is diffed, scanned and pushed is all there is. An agent's
   * own commits are folded into it.
   *
   * A trailer marks the commit as machine-generated. Returns null when there
   * is nothing to commit; a no-op run should not produce an empty commit.
   */
  async commitAll(
    message: string,
    opts?: { author?: string; email?: string; trailer?: string }
  ): Promise<string | null> {
    const { tree, gitlinks } = await this.snapshot(this.baseSha);
    // A nested repository staged as a gitlink would be pushed as a submodule
    // pointer, and is how an agent gets git to run its config: refused.
    if (gitlinks.length > 0) {
      throw new WorkspaceError(
        `The changes add a nested git repository (a submodule entry) at ${gitlinks
          .slice(0, 5)
          .join(', ')}, which is not committed or pushed. Remove it from the worktree.`
      );
    }
    if (tree === (await this.treeOf(this.baseSha))) return null;

    const trailer = opts?.trailer ?? 'Generated-by: OpenClerq';
    const full = `${message.trim()}\n\n${trailer}\n`;
    const who = {
      GIT_AUTHOR_NAME: opts?.author ?? 'OpenClerq',
      GIT_AUTHOR_EMAIL: opts?.email ?? 'openclerq@localhost',
      GIT_COMMITTER_NAME: opts?.author ?? 'OpenClerq',
      GIT_COMMITTER_EMAIL: opts?.email ?? 'openclerq@localhost',
    };
    const commit = (
      await git(['commit-tree', '--no-gpg-sign', tree, '-p', this.baseSha, '-m', full], {
        ...this.opts(),
        env: { ...this.env, ...who },
      })
    ).stdout.trim();
    // Only from the value read now: anything that moves it meanwhile fails this.
    const before = (await git(['rev-parse', '--verify', this.ref], this.opts())).stdout.trim();
    await git(['update-ref', '-m', 'OpenClerq run commit', this.ref, commit, before], this.opts());
    this.head = commit;
    await this.clearOperationState();
    // The worktree's own index, in step with the commit (for gates and the agent's next attempt).
    await git(['read-tree', commit], this.opts({ allowFailure: true }));
    return commit;
  }

  /**
   * Remove what a merge, cherry-pick, revert, rebase or bisect in progress
   * leaves in the worktree's git entry, so no later git command picks it up.
   */
  async clearOperationState(): Promise<void> {
    const { adminDir } = await this.gitDirs();
    for (const name of [
      'MERGE_HEAD',
      'MERGE_MSG',
      'MERGE_MODE',
      'MERGE_RR',
      'AUTO_MERGE',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
      'BISECT_START',
      'BISECT_TERMS',
      'BISECT_EXPECTED_REV',
      'sequencer',
      'rebase-merge',
      'rebase-apply',
    ]) {
      fs.rmSync(path.join(adminDir, name), { recursive: true, force: true });
    }
  }

  /**
   * Check the branch is the base plus exactly the run's commit, with the base
   * as its only parent: what was diffed and scanned is all that would be pushed.
   */
  async verifyHistory(): Promise<void> {
    if (!this.head) throw new WorkspaceError('There is no run commit to publish.');
    const tip = (await git(['rev-parse', '--verify', this.ref], this.opts())).stdout.trim();
    if (tip !== this.head) {
      throw new WorkspaceError(
        `The branch was moved after the run's commit (${tip}); not published.`
      );
    }
    const lines = (
      await git(['rev-list', '--parents', `${this.baseSha}..${this.head}`], this.opts())
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (lines.length !== 1 || lines[0] !== `${this.head} ${this.baseSha}`) {
      throw new WorkspaceError(
        "The branch is not the base plus the run's one commit; not published."
      );
    }
  }

  /** Diff of the run's commit (HEAD before it exists) against the base. */
  async diffStat(): Promise<DiffStat> {
    const r = await git(
      ['diff', '--numstat', ...SAFE_DIFF, `${this.baseSha}..${this.head ?? 'HEAD'}`],
      this.opts()
    );
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

  /**
   * Full patch of the run's commit against the base, for review or as a run
   * artifact. `text` shows every file as text, binary or marked `-diff` in
   * `.gitattributes`, which is what a scan for secrets needs.
   */
  async diff(options: { text?: boolean } = {}): Promise<string> {
    const r = await git(
      [
        'diff',
        ...SAFE_DIFF,
        ...(options.text ? ['--text'] : []),
        `${this.baseSha}..${this.head ?? 'HEAD'}`,
      ],
      this.opts()
    );
    return r.stdout;
  }

  /**
   * Gitlinks (mode 160000, a submodule's commit) that the base commit does not
   * have, by path: in `indexListing` (`ls-files --stage -z`), or the
   * worktree's own index.
   */
  async newGitlinks(indexListing?: string): Promise<string[]> {
    // Both list "<mode> …<TAB><path>", one entry per NUL.
    const links = (text: string) =>
      new Set(
        text
          .split('\0')
          .filter((e) => e.startsWith('160000 '))
          .map((e) => e.slice(e.indexOf('\t') + 1))
      );
    const index = indexListing ?? (await git(['ls-files', '--stage', '-z'], this.opts())).stdout;
    const base = await git(['ls-tree', '-r', '-z', this.baseSha], this.opts());
    const before = links(base.stdout);
    return [...links(index)].filter((p) => !before.has(p));
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
    // The run's commit itself, not whatever the branch points at by now.
    args.push(remote, this.head ? `${this.head}:refs/heads/${this.branch}` : this.branch);
    await git(args, this.opts());
  }

  /**
   * Where this worktree's git data is: the repository's git directory, and the
   * worktree's own part of it. A sandbox needs them to let the agent read the
   * history while keeping it from rewriting what the gateway's own git
   * commands will later trust (config, hooks, the pointer files).
   */
  async gitDirs(): Promise<GitDirs> {
    const r = await git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'],
      this.opts()
    );
    const [commonDir, adminDir] = r.stdout.trim().split('\n');
    return { commonDir, adminDir, gitFile: path.join(this.path, '.git') };
  }

  /** Remove the worktree. Safe to call twice. */
  async dispose(): Promise<void> {
    if (!this.isWorktree) return;
    try {
      await git(['worktree', 'remove', '--force', this.path], {
        cwd: this.repoRoot,
        allowFailure: true,
        harden: true,
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

  // One clone per cache entry at a time: two runs of the same remote must not
  // both clone into it, or one remove the other's half-made clone.
  return once(target, async () => {
    if (fs.existsSync(target) && (await isRepo(target))) {
      if (options?.fetch !== false) {
        await git(['fetch', '--all', '--prune'], { cwd: target, env: options?.env });
      }
      return target;
    }

    fs.rmSync(target, { recursive: true, force: true });
    // Into a temporary name, then moved: an interrupted clone is never taken
    // for a finished one. No checkout: runs work in worktrees of their own.
    const partial = `${target}.partial-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await git(['clone', '--no-checkout', repo.location, partial], {
        cwd: cacheDir,
        env: options?.env,
        timeoutMs: 600_000,
      });
      fs.renameSync(partial, target);
    } finally {
      fs.rmSync(partial, { recursive: true, force: true });
    }
    return target;
  });
}

const inFlight = new Map<string, Promise<unknown>>();

/** Run `work` for `key` after any earlier work for the same key has ended. */
function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = inFlight.get(key) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(work);
  inFlight.set(key, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (inFlight.get(key) === next) inFlight.delete(key);
    });
  return next;
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
  return new Workspace(dir, repoRoot, branch, sha, options?.env, true, detached, base);
}

/** Remove worktrees left behind by runs that died before disposing. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repoRoot, allowFailure: true });
}
