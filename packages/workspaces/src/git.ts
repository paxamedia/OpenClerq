/**
 * Thin git wrapper.
 *
 * Arguments are always passed as an array, never through a shell, so a branch
 * name or commit message containing shell metacharacters cannot become a
 * command. Everything an agent influences — branch names, messages — reaches
 * git as a single argv element.
 */

import { spawn } from 'node:child_process';

export class GitError extends Error {
  readonly code = 'git_error';
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface GitOptions {
  cwd: string;
  /** Extra environment. Credentials belong here, never in the argv. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
}

const DEFAULT_TIMEOUT = 120_000;

export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Never block on an interactive credential or SSH prompt: a hung
        // prompt in an unattended run is indistinguishable from a deadlock.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        SSH_ASKPASS: 'echo',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new GitError(`Could not run git: ${e.message}`, null, ''));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !opts.allowFailure) {
        reject(
          new GitError(
            `git ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
            code,
            stderr
          )
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** Is `dir` inside a git working tree? */
export async function isRepo(dir: string): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd: dir, allowFailure: true });
    return r.code === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(dir: string): Promise<string> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return r.stdout.trim();
}

export async function headSha(dir: string): Promise<string> {
  const r = await git(['rev-parse', 'HEAD'], { cwd: dir });
  return r.stdout.trim();
}

/**
 * Resolve the repository's default branch, falling back sensibly when there is
 * no configured origin HEAD.
 */
export async function defaultBranch(dir: string): Promise<string> {
  const remote = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: dir,
    allowFailure: true,
  });
  if (remote.code === 0 && remote.stdout.trim()) {
    return remote.stdout.trim().replace(/^origin\//, '');
  }
  for (const candidate of ['main', 'master']) {
    const has = await git(['rev-parse', '--verify', candidate], { cwd: dir, allowFailure: true });
    if (has.code === 0) return candidate;
  }
  return currentBranch(dir);
}
