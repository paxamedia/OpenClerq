/**
 * Agent processes a crashed gateway left behind.
 *
 * Every agent and gate process a run starts leads its own process group, so it
 * survives the gateway that started it. The gateway records each one, beside
 * the run, with what is needed to recognise it later: its pid and process
 * group, the operating system's start time for it, and the command. On the
 * next start, anything recorded and still alive is stopped before the runs it
 * belonged to are marked failed and their worktrees removed, so nothing keeps
 * writing into a directory that is about to disappear.
 *
 * A pid proves nothing on its own: once the process has exited the number can
 * be given to an unrelated one. So a process is stopped only when what is
 * running now is what was recorded.
 *
 *   - If the group's leader still exists, its start time must match the one
 *     recorded, and an agent's command line must still name the CLI that was
 *     started.
 *   - If the leader has gone but other members of the group remain (a server
 *     the agent started, say), they are the leader's descendants: a pid cannot
 *     be reused while it is still a group id. They are stopped too, provided
 *     none of them started before the leader did.
 *   - If the recorded start time is unknown, nothing is stopped.
 *   - A gateway that is still running (another instance sharing the store)
 *     keeps its processes, and so does this one.
 *
 * Needs `ps` with `lstart` (macOS, procps). Elsewhere nothing is stopped, and
 * the records are left for a gateway that can.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { SpawnedProcess } from '@clerq/drivers';
import { getStore } from './store.js';
import { logger } from './logger.js';

export type ProcessKind = 'agent' | 'gate';

export interface ProcessInfo {
  pid: number;
  pgid: number;
  /** When the OS says it started, in epoch milliseconds. */
  startMs: number;
  command: string;
}

/** The OS reports start times to the second; the two readings can straddle one. */
const START_TOLERANCE_MS = 2_000;

const PS_COLUMNS = 'pid=,pgid=,lstart=,command=';
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** Rows of `ps -o pid=,pgid=,lstart=,command=`. Rows it cannot read are skipped. */
export function parseProcessTable(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const m = PS_ROW.exec(line);
    if (!m) continue;
    // `lstart` is printed in the current time zone and read back in it, so a
    // change of zone between two readings does not move the instant.
    const startMs = new Date(m[3]).getTime();
    if (!Number.isFinite(startMs)) continue;
    out.push({ pid: Number(m[1]), pgid: Number(m[2]), startMs, command: m[4].trim() });
  }
  return out;
}

function ps(args: string[]): ProcessInfo[] | null {
  if (process.platform === 'win32') return null;
  try {
    const text = execFileSync('ps', [...args, '-o', PS_COLUMNS], {
      // English month and day names, whatever the user's locale.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseProcessTable(text);
  } catch (e) {
    // `ps -p` exits 1 when the pid is gone: that is an empty answer, not a failure.
    const stdout = (e as { stdout?: string }).stdout;
    if (typeof stdout === 'string') return parseProcessTable(stdout);
    return null;
  }
}

/** Every process on the machine, or null where `ps` cannot say. */
export function readProcessTable(): ProcessInfo[] | null {
  const table = ps(['-axww']);
  // A table with nobody in it, or without this process, is a `ps` we cannot read.
  return table && table.some((p) => p.pid === process.pid) ? table : null;
}

function readProcess(pid: number): ProcessInfo | null {
  return ps(['-ww', '-p', String(pid)])?.find((p) => p.pid === pid) ?? null;
}

let self: { pid: number; startMs: number | null } | undefined;

/** This gateway process, as it will be recognised after it is gone. */
function gatewayIdentity(): { pid: number; startMs: number | null } {
  self ??= { pid: process.pid, startMs: readProcess(process.pid)?.startMs ?? null };
  return self;
}

/**
 * Record a process a run started. Returns the record's id, or null when it
 * could not be written: bookkeeping must not stop the run it describes.
 */
export function recordProcess(
  runId: string,
  kind: ProcessKind,
  spawned: SpawnedProcess
): number | null {
  try {
    const me = gatewayIdentity();
    const startMs = readProcess(spawned.pid)?.startMs;
    const res = getStore()
      .prepare(
        `INSERT INTO run_processes
           (run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        kind,
        spawned.pid,
        spawned.pgid,
        spawned.command,
        startMs === undefined ? null : new Date(startMs).toISOString(),
        me.pid,
        me.startMs === null ? null : new Date(me.startMs).toISOString(),
        new Date().toISOString()
      );
    return Number(res.lastInsertRowid);
  } catch (e) {
    logger.warn('Could not record an agent process', {
      runId,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export function markProcessEnded(id: number | null, outcome = 'exited'): void {
  if (id === null) return;
  try {
    getStore()
      .prepare('UPDATE run_processes SET ended_at = ?, outcome = ? WHERE id = ?')
      .run(new Date().toISOString(), outcome, id);
  } catch (e) {
    logger.warn('Could not close an agent process record', {
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Records the process a run starts, and closes the record when it exits.
 * `onSpawn` goes to the driver or the sandbox; call `done` when the work ends.
 */
export function watchProcess(
  runId: string,
  kind: ProcessKind
): { onSpawn: (spawned: SpawnedProcess) => void; done: () => void } {
  let id: number | null = null;
  return {
    onSpawn: (spawned) => {
      id = recordProcess(runId, kind, spawned);
    },
    done: () => markProcessEnded(id),
  };
}

export type LeftoverOutcome =
  /** Still running, and it was the recorded process: its group was stopped. */
  | 'killed'
  /** Nothing of it remained. */
  | 'gone'
  /** The pid now belongs to something else, or the recording does not fit. Left alone. */
  | 'reused'
  /** Could not be told apart from a stranger, so left alone. */
  | 'unverified'
  /** Started by a gateway that is still running. Left alone and still recorded. */
  | 'owner_alive'
  /** Started by this very process. Left alone and still recorded. */
  | 'own'
  /** This machine cannot say what is running. */
  | 'unsupported';

export interface LeftoverProcess {
  runId: string;
  kind: ProcessKind;
  pid: number;
  pgid: number;
  command: string;
  outcome: LeftoverOutcome;
  /** For a process that was stopped: whether it had to be killed outright. */
  forced?: boolean;
}

interface Row {
  id: number;
  runId: string;
  kind: ProcessKind;
  pid: number;
  pgid: number;
  command: string;
  procStart: number | null;
  ownerPid: number;
  ownerStart: number | null;
}

function rows(): Row[] {
  return getStore()
    .prepare(
      `SELECT id, run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start
       FROM run_processes WHERE ended_at IS NULL ORDER BY id`
    )
    .all()
    .map((r) => ({
      id: Number(r.id),
      runId: String(r.run_id),
      kind: r.kind as ProcessKind,
      pid: Number(r.pid),
      pgid: Number(r.pgid),
      command: String(r.command),
      procStart: r.proc_start ? Date.parse(String(r.proc_start)) : null,
      ownerPid: Number(r.owner_pid),
      ownerStart: r.owner_start ? Date.parse(String(r.owner_start)) : null,
    }));
}

const sameInstant = (a: number, b: number) => Math.abs(a - b) <= START_TOLERANCE_MS;

/**
 * Whether the process now at `pid` is the one that was recorded. "killed"
 * means it should be stopped; the other answers say why it should not.
 */
function judge(row: Row, table: ProcessInfo[]): Exclude<LeftoverOutcome, 'unsupported'> {
  const owner = table.find((p) => p.pid === row.ownerPid);
  // The gateway that started it is still there, so it is not a leftover. The
  // pid alone is not enough (a restarted container's gateway is pid 1 every
  // time), so its start time must match too. When that was never recorded, a
  // live pid is given the benefit of the doubt.
  if (owner && (row.ownerStart === null || sameInstant(owner.startMs, row.ownerStart))) {
    return row.ownerPid === process.pid ? 'own' : 'owner_alive';
  }

  const group = table.filter((p) => p.pgid === row.pgid);
  if (group.length === 0) return 'gone';

  // Never this gateway's own group, and never init's.
  if (row.pgid <= 1 || table.find((p) => p.pid === process.pid)?.pgid === row.pgid) {
    return 'unverified';
  }
  // Without the recorded start there is nothing to tell it from a stranger.
  if (row.procStart === null) return 'unverified';

  const leader = group.find((p) => p.pid === row.pid);
  if (leader) {
    if (!sameInstant(leader.startMs, row.procStart)) return 'reused';
    // Start time says it is ours; for an agent the command line must still
    // agree. The CLI may be a script run by an interpreter, so its name is
    // looked for, not its place in the line. A gate is run by a shell, which
    // may have replaced itself with the one command it was given, so there is
    // nothing fixed to look for.
    if (row.kind === 'agent') {
      const name = path.basename(row.command).toLowerCase();
      if (name && !leader.command.toLowerCase().includes(name)) return 'reused';
    }
    return 'killed';
  }

  // The leader has exited. A process group id cannot be handed out again while
  // the group has members, so what is left are its descendants, which cannot
  // be older than the leader.
  return group.every((p) => p.startMs >= row.procStart! - START_TOLERANCE_MS) ? 'killed' : 'reused';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and is not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stop a process group: ask, wait, then insist. Returns whether it had to be insisted. */
async function stopGroup(pgid: number, graceMs: number): Promise<boolean> {
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch (e) {
    // Already gone is fine; anything else (not ours to signal) is for the caller.
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
  for (const end = Date.now() + graceMs; Date.now() < end; ) {
    await sleep(50);
    if (!groupAlive(pgid)) return false;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    return false;
  }
  for (const end = Date.now() + 2_000; Date.now() < end && groupAlive(pgid); ) await sleep(50);
  return true;
}

/**
 * Stop the agent and gate processes a previous gateway left running, after
 * checking each is still the process that was recorded. Run it at startup,
 * before the runs they belonged to are marked failed.
 */
export async function killLeftoverProcesses(
  options: { graceMs?: number } = {}
): Promise<LeftoverProcess[]> {
  const live = rows();
  if (live.length === 0) return [];

  const table = readProcessTable();
  const out: LeftoverProcess[] = [];
  const close = (row: Row, outcome: string) => markProcessEnded(row.id, outcome);
  const report = (row: Row, outcome: LeftoverOutcome, forced?: boolean) =>
    out.push({
      runId: row.runId,
      kind: row.kind,
      pid: row.pid,
      pgid: row.pgid,
      command: row.command,
      outcome,
      ...(forced === undefined ? {} : { forced }),
    });

  if (!table) {
    if (process.platform === 'win32') {
      // Nothing here can ever be checked, so do not keep the records.
      for (const row of live) {
        close(row, 'unsupported');
        report(row, 'unsupported');
      }
    } else {
      logger.warn(
        'Could not list processes with `ps`; agent processes left by an earlier gateway were not checked',
        { recorded: live.length }
      );
    }
    return out;
  }

  for (const row of live) {
    const verdict = judge(row, table);
    if (verdict === 'own' || verdict === 'owner_alive') {
      report(row, verdict);
      continue;
    }
    if (verdict !== 'killed') {
      close(row, verdict);
      report(row, verdict);
      continue;
    }
    try {
      const forced = await stopGroup(row.pgid, options.graceMs ?? 3_000);
      close(row, forced ? 'killed (forced)' : 'killed');
      report(row, 'killed', forced);
    } catch (e) {
      // Not ours to signal, or it would not die: leave the record for the next start.
      logger.warn('Could not stop an agent process left by an earlier gateway', {
        pid: row.pid,
        err: e instanceof Error ? e.message : String(e),
      });
      report(row, 'unverified');
    }
  }
  return out;
}
