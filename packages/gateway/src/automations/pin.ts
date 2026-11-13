/**
 * The worktree as it was before the agent ran, to check against afterwards.
 *
 * Everything the gateway does after the agent (status, commit, diff, push,
 * removing the worktree) runs git in the worktree outside any sandbox. If the
 * worktree, or its entry in the git directory, had been moved away and
 * replaced (by a link to another tree with a `.git` of the agent's choosing),
 * that git would read the agent's configuration and run its commands. The
 * sandbox profiles stop this; this check is the gateway's own: a worktree that
 * is not the directory it was, or whose pointers changed, ends the run before
 * any git runs in it.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GitDirs } from '@clerq/workspaces';

export class WorktreeTampered extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeTampered';
  }
}

interface Dir {
  path: string;
  real: string;
  dev: number;
  ino: number;
}

export interface Pin {
  /** Why the worktree is not as it was, or undefined. */
  problem(): string | undefined;
  /** Throws WorktreeTampered when it is not as it was. */
  assert(): void;
}

function dirOf(p: string): Dir {
  const st = fs.lstatSync(p);
  return { path: p, real: fs.realpathSync.native(p), dev: st.dev, ino: st.ino };
}

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Record the worktree and its git entry as they are now. */
export function pinWorktree(dirs: GitDirs, worktree: string): Pin {
  const watched = [dirOf(worktree), dirOf(dirs.adminDir)];
  const files = [
    dirs.gitFile,
    path.join(dirs.adminDir, 'commondir'),
    path.join(dirs.adminDir, 'gitdir'),
  ].map((p) => ({ path: p, content: read(p) }));

  const problem = (): string | undefined => {
    for (const d of watched) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(d.path);
      } catch {
        return `${d.path} is gone.`;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return `${d.path} was replaced.`;
      if (st.dev !== d.dev || st.ino !== d.ino) return `${d.path} is not the directory it was.`;
      let real: string;
      try {
        real = fs.realpathSync.native(d.path);
      } catch {
        return `${d.path} cannot be resolved.`;
      }
      if (real !== d.real) return `${d.path} now resolves elsewhere (${real}).`;
    }
    for (const f of files) {
      if (read(f.path) !== f.content) return `${f.path} was changed.`;
    }
    return undefined;
  };

  return {
    problem,
    assert() {
      const found = problem();
      if (found) {
        throw new WorktreeTampered(
          `The run's worktree was tampered with while the agent or a gate ran: ${found} ` +
            'Nothing was committed or pushed, and no git command was run in it.'
        );
      }
    },
  };
}
