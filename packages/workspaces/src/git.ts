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
  /** True when `timeoutMs` ran out and git (with every helper it started) was killed. */
  timedOut?: boolean;
}

/**
 * Configuration for every git command the gateway runs in a worktree after an
 * agent has worked in it. The agent may have planted a nested repository
 * (`sub/.git` with its own config) and staged it, or a `.gitattributes`
 * entry; git would then run code from them on the gateway's behalf, outside
 * any sandbox. Options given with `-c` win over every config file and reach
 * child git processes (a submodule's) too:
 *
 *   core.fsmonitor=false      no filesystem-monitor command
 *   core.hooksPath=/dev/null  no hooks, of the repository or a submodule
 *   submodule.recurse=false   no recursing into submodules
 *   protocol.file.allow=user  no file:// transport started on a submodule's
 *                             behalf (a push to a local path still works)
 *
 * Diffs also pass `--no-ext-diff --no-textconv --ignore-submodules=all`, and
 * status `--ignore-submodules=all`. Filter drivers (clean/smudge) are not
 * turned off: they are defined only in config files, which a sandboxed agent
 * cannot write (the user's own and the repository's), and the run's own LFS
 * would break without them. Under the native profile none of this is a
 * boundary: the agent can run anything as the user anyway.
 */
export const HARDENED_GIT = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'submodule.recurse=false',
  '-c',
  'protocol.file.allow=user',
];

/** Options that keep a diff from running anything the repository names. */
export const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];

export interface GitOptions {
  cwd: string;
  /** Prefix HARDENED_GIT: for any command in a worktree an agent has written to. */
  harden?: boolean;
  /** Extra environment. Credentials belong here, never in the argv. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Ends the command like a timeout does, without `timedOut`. */
  signal?: AbortSignal;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
  /**
   * How long, once git has exited and what is left of its group is killed, to wait for its
   * output to close before failing (see `git()`). Default 10 s; a test shortens it.
   */
  pipesTimeoutMs?: number;
}

const DEFAULT_TIMEOUT = 120_000;

/** Subcommands that talk to a remote, and so can stall on a server that never answers. */
const REMOTE_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

/**
 * The longest to wait, after git has exited, for its output to close. Whatever
 * git started in its own group is killed when it exits, which closes the pipes
 * at once; this is only for something that left the group (`setsid`) and kept
 * them. Past it the call fails: returning the output read so far could be a
 * truncated `git diff --numstat` that a gate then judges.
 */
const PIPES_TIMEOUT_MS = 10_000;

/** The subcommand in `args`: the first word that is not an option or an option's value (`-c x=y`, `-C dir`). */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0] ?? '';
}

/** What git is started with: the hardening, the low-speed limit for a remote command, then `args`. */
export function gitArgv(args: string[], opts: Pick<GitOptions, 'harden' | 'timeoutMs'>): string[] {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  return [
    ...(opts.harden ? HARDENED_GIT : []),
    ...(REMOTE_COMMANDS.has(subcommand(args))
      ? [
          '-c',
          'http.lowSpeedLimit=1',
          '-c',
          `http.lowSpeedTime=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
        ]
      : []),
    ...args,
  ];
}

/**
 * Run git, to its end or to `timeoutMs`.
 *
 * git runs in a process group of its own. The timeout (or an abort) kills the
 * whole group: `git remote-http` and the other helpers git starts are not git's
 * own children to stop, and one left running holds the output open, which used
 * to keep a stalled check pending, and alive, for good. A killed command settles
 * as soon as git exits, with what it had printed and `timedOut` set.
 *
 * A command that ends by itself is different: its output must be whole. When git
 * exits, what is left of its group is killed (a helper that kept the pipes would
 * otherwise hold the call), and the call waits for the pipes to close, so every
 * byte is read however long the event loop was busy. Only a process that left
 * the group can keep them open past `pipesTimeoutMs`, and the call then fails
 * rather than return output that may be cut short.
 *
 * A command that talks to a remote also gets curl's low-speed limit for the
 * length of the timeout, so a server that goes silent ends the transfer itself.
 */
export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const pipesTimeoutMs = opts.pipesTimeoutMs ?? PIPES_TIMEOUT_MS;
    const argv = gitArgv(args, opts);
    const windows = process.platform === 'win32';
    const child = spawn('git', argv, {
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
      // Its own group (not on Windows, which has none), so the kill reaches the helpers.
      detached: !windows,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let exitCode: number | null = null;
    let held: NodeJS.Timeout | undefined;
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));

    /** Kill git and everything it started. */
    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        if (windows) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
            'error',
            () => undefined
          );
        } else {
          // A negative pid is the process group.
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    /** What git left running in its group, once git itself has gone (the group is not empty only then). */
    const killGroup = () => {
      if (windows || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* nothing left: the usual case */
      }
    };

    const stop = () => {
      stopped = true;
      killTree();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(held);
      opts.signal?.removeEventListener('abort', onAbort);
      // Whatever still holds the pipes no longer matters: this call is over.
      child.stdout.destroy();
      child.stderr.destroy();
      if (code !== 0 && !opts.allowFailure) {
        const why = timedOut
          ? `git ${subcommand(args)} timed out after ${Math.round(timeoutMs / 1000)} s`
          : stopped
            ? `git ${subcommand(args)} was stopped`
            : `git ${subcommand(args)} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`;
        reject(new GitError(why, code, stderr));
        return;
      }
      resolve({ stdout, stderr, code, ...(timedOut ? { timedOut: true } : {}) });
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(held);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new GitError(`Could not run git: ${e.message}`, null, ''));
    });

    child.on('exit', (code) => {
      exitCode = code;
      // A group that was stopped may still have members: stop them too, and do not wait on them.
      if (stopped) {
        killTree();
        finish(code);
        return;
      }
      // git has finished. Stop what it left in its group, then wait for 'close': that is when
      // every byte has been read, however busy the event loop was in between.
      killGroup();
      held = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        reject(
          new GitError(
            `git ${subcommand(args)} finished, but a process it started still holds its output open ` +
              `after ${Math.round(pipesTimeoutMs / 1000)} s, so the output may be incomplete`,
            code,
            stderr
          )
        );
      }, pipesTimeoutMs);
    });

    child.on('close', (code) => finish(code ?? exitCode));
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
