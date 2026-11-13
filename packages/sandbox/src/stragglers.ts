/**
 * Processes a sandboxed command left running after it, outside its process
 * group: a child that called setsid() is no longer in the group `reapGroup`
 * signals, and keeps running after `exec` returns. Before a caller acts on
 * what the command left (commits a worktree), it looks for them, with `lsof`,
 * as any process of this user that has its working directory or an open file
 * under one of the given directories, or the run's tag file open: `exec`
 * hands every command of a spec with a `tagFile` that file as descriptor 3,
 * and descendants inherit it unless they close it.
 *
 * A process that closed its descriptors, left those directories and holds
 * nothing open in them is not found (macOS does not show another process's
 * environment, so there is no other mark to look for). That is why a caller
 * must not depend on this alone; see the gateway's commit, which never reads
 * the worktree's own index or HEAD.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Straggler {
  pid: number;
  command: string;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 60_000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (error, stdout) => {
        // lsof exits 1 when it found nothing.
        if (error && !stdout) resolve(error.code === 1 ? '' : null);
        else resolve(String(stdout));
      }
    );
  });
}

/** Processes of this user with their cwd or an open file under one of `dirs`. */
async function byPath(dirs: string[]): Promise<Straggler[] | null> {
  if (dirs.length === 0) return [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const text = await run('lsof', [
    '-n',
    '-P',
    '-w',
    '-F',
    'pcn',
    ...(uid === undefined ? [] : ['-u', String(uid)]),
  ]);
  if (text === null) return null;
  const roots = dirs.map((d) => {
    try {
      return fs.realpathSync.native(d);
    } catch {
      return path.resolve(d);
    }
  });
  const under = (p: string) => roots.some((r) => p === r || p.startsWith(`${r}${path.sep}`));
  const found = new Map<number, Straggler>();
  let pid = 0;
  let command = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      command = '';
    } else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && under(line.slice(1)) && !found.has(pid)) {
      found.set(pid, { pid, command });
    }
  }
  return [...found.values()];
}

/** Processes holding the tag file, or something under `dirs`. Null: `lsof` could not say. */
export async function findStragglers(options: {
  tagFile?: string;
  dirs: string[];
}): Promise<Straggler[] | null> {
  if (process.platform === 'win32') return [];
  const found = await byPath([...options.dirs, ...(options.tagFile ? [options.tagFile] : [])]);
  return found === null ? null : found.filter((s) => s.pid !== process.pid);
}

/**
 * Kill what `findStragglers` finds, then look again. Returns what was killed,
 * and what is still there, which the caller must treat as a failure; null
 * when `lsof` could not be run.
 */
export async function stopStragglers(options: {
  tagFile?: string;
  dirs: string[];
}): Promise<{ stopped: Straggler[]; remaining: Straggler[] } | null> {
  const stopped = await findStragglers(options);
  if (stopped === null) return null;
  for (const s of stopped) {
    try {
      process.kill(s.pid, 'SIGKILL');
    } catch {
      /* gone already */
    }
  }
  if (stopped.length === 0) return { stopped, remaining: [] };
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A process that was killed may have started another in the meantime.
  return { stopped, remaining: (await findStragglers(options)) ?? [] };
}
