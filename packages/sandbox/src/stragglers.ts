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
  /** It holds the run's tag file: started by one of the run's commands. */
  tagged: boolean;
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
async function byPath(dirs: string[], tagFile?: string): Promise<Straggler[] | null> {
  if (dirs.length === 0 && !tagFile) return [];
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
  const real = (d: string) => {
    try {
      return fs.realpathSync.native(d);
    } catch {
      return path.resolve(d);
    }
  };
  const roots = dirs.map(real);
  const tag = tagFile ? real(tagFile) : undefined;
  const under = (p: string) => roots.some((r) => p === r || p.startsWith(`${r}${path.sep}`));
  const found = new Map<number, Straggler>();
  let pid = 0;
  let command = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      command = '';
    } else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n')) {
      const name = line.slice(1);
      const tagged = name === tag;
      if (!tagged && !under(name)) continue;
      const seen = found.get(pid);
      if (seen) seen.tagged ||= tagged;
      else found.set(pid, { pid, command, tagged });
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
  const found = await byPath(options.dirs, options.tagFile);
  return found === null ? null : found.filter((s) => s.pid !== process.pid);
}

/**
 * How far apart two readings of one process's age can be: `ps` counts whole
 * seconds, and the process's start and the reading each lose their fraction.
 */
export const AGE_GRANULARITY_MS = 1_000;

/**
 * Seconds from `ps -o etime`: `[[dd-]hh:]mm:ss`. Null for anything else.
 *
 * This is how a process's age is read, not `lstart`. On Linux `lstart` is the
 * boot time plus the process's ticks since boot, and the boot time it assumes
 * moves with the wall clock: after an NTP step (common on a VM) a process
 * started a moment ago can be dated seconds before the run that started it.
 * The elapsed time is counted from uptime on both sides and does not move.
 */
export function parseElapsed(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * Rows of `ps -o pid=,ppid=,etime=` as start times in the caller's clock:
 * `now` minus the elapsed time. Rows it cannot read are skipped.
 */
export function parseProcessAges(
  text: string,
  now: number
): Map<number, { startMs: number; ppid: number }> {
  const out = new Map<number, { startMs: number; ppid: number }>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const elapsed = parseElapsed(m[3]);
    if (elapsed === null) continue;
    out.set(Number(m[1]), { startMs: now - elapsed * 1_000, ppid: Number(m[2]) });
  }
  return out;
}

/**
 * Whether a process that `ps` dates at `startMs` began with the run that began
 * at `since`. Both ends are whole seconds, so a process the run started can
 * be dated up to a second before it; a missing date is never "after".
 */
export function startedSince(startMs: number | undefined, since: number | undefined): boolean {
  if (since === undefined) return false;
  return (startMs ?? -Infinity) >= since - AGE_GRANULARITY_MS;
}

/** Start time (epoch ms, from the elapsed time) and parent of each pid, from `ps`. */
async function processInfo(
  pids: number[]
): Promise<Map<number, { startMs: number; ppid: number }>> {
  if (pids.length === 0) return new Map();
  const text = await run('ps', ['-ww', '-o', 'pid=,ppid=,etime=', '-p', pids.join(',')]);
  // After the call: the elapsed time was read while `ps` ran.
  return parseProcessAges(text ?? '', Date.now());
}

/** This process and its ancestors, which are never the run's. */
async function gatewayLine(): Promise<Set<number>> {
  const line = new Set<number>([process.pid]);
  let at = process.ppid;
  for (let i = 0; i < 64 && at > 1 && !line.has(at); i++) {
    line.add(at);
    at = (await processInfo([at])).get(at)?.ppid ?? 1;
  }
  return line;
}

/**
 * Kill the processes that are provably the run's, then look again:
 *
 *   - those holding the run's tag file, and
 *   - those with their cwd or a file under `dirs` that started at or after
 *     `since` (when the run began) and are neither this gateway nor one of
 *     its ancestors.
 *
 * Anything else under `dirs` (an editor or a terminal the user had open in the
 * worktree before the run) is returned in `ignored` and left alone. Returns
 * what was killed, what is still there (a failure for the caller), and what
 * was left alone; null when `lsof` could not be run.
 */
export async function stopStragglers(options: {
  tagFile?: string;
  dirs: string[];
  /** When the run began, epoch ms. Without it only tagged processes are killed. */
  since?: number;
}): Promise<{ stopped: Straggler[]; remaining: Straggler[]; ignored: Straggler[] } | null> {
  const found = await findStragglers(options);
  if (found === null) return null;
  const ours = async (list: Straggler[]) => {
    const info = await processInfo(list.map((s) => s.pid));
    const gateway = await gatewayLine();
    return list.filter(
      (s) =>
        s.tagged || (!gateway.has(s.pid) && startedSince(info.get(s.pid)?.startMs, options.since))
    );
  };
  const stopped = await ours(found);
  const ignored = found.filter((s) => !stopped.includes(s));
  for (const s of stopped) {
    try {
      process.kill(s.pid, 'SIGKILL');
    } catch {
      /* gone already */
    }
  }
  if (stopped.length === 0) return { stopped, remaining: [], ignored };
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A process that was killed may have started another in the meantime.
  return { stopped, remaining: await ours((await findStragglers(options)) ?? []), ignored };
}
