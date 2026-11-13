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
 * be given to an unrelated one, and then to an unrelated group. So a group is
 * stopped only when its leader is still there and is what was recorded:
 *
 *   - the leader's start time must match the one recorded, and an agent's
 *     command line must still name the CLI that was started;
 *   - a group whose leader has gone is left alone, however old or young its
 *     members look: nothing says whose they are;
 *   - a record whose start time is unknown (the OS had not answered yet when
 *     the gateway died) is left alone;
 *   - the leader is read again just before the group is signalled, because
 *     stopping an earlier group can take seconds;
 *   - a gateway that is still running (another instance sharing the store)
 *     keeps its processes and its runs, and so does this one.
 *
 * What a process leaves in its group when it exits normally is not this
 * module's business: the sandbox stops it then (`reapGroup`).
 *
 * Needs `ps` with `lstart` (macOS, procps). Elsewhere nothing is stopped, and
 * the records are left for a gateway that can.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SpawnedProcess } from '@clerq/drivers';
import { removeContainer, resolveRuntime } from '@clerq/sandbox';
import { getStore } from './store.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

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

async function ps(args: string[]): Promise<ProcessInfo[] | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('ps', [...args, '-o', PS_COLUMNS], {
      // English month and day names, whatever the user's locale.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    });
    return parseProcessTable(stdout);
  } catch (e) {
    // `ps -p` exits 1 when the pid is gone: that is an empty answer, not a failure.
    const failure = e as { stdout?: unknown; killed?: boolean };
    if (!failure.killed && typeof failure.stdout === 'string') {
      return parseProcessTable(failure.stdout);
    }
    return null;
  }
}

/**
 * Every process on the machine, or null where `ps` cannot say. `-e` is the
 * POSIX spelling that lists them all on macOS and on procps alike; the UNIX
 * `-a` would leave out session leaders, which every agent is.
 */
export async function readProcessTable(): Promise<ProcessInfo[] | null> {
  const table = await ps(['-e', '-ww']);
  // A table with nobody in it, or without this process, is a `ps` we cannot read.
  return table && table.some((p) => p.pid === process.pid) ? table : null;
}

async function readProcess(pid: number): Promise<ProcessInfo | null> {
  return (await ps(['-ww', '-p', String(pid)]))?.find((p) => p.pid === pid) ?? null;
}

// ---------------------------------------------------------------------------
// Who started a run
// ---------------------------------------------------------------------------

let identity: { pid: number; startMs: number | null } | undefined;
let identifying: Promise<void> | undefined;

/**
 * Learn when this process started, so it can be recognised after it is gone.
 * Asks the OS without blocking; call it once at startup. Until it has answered,
 * what is recorded carries the pid only.
 */
export function warmGatewayIdentity(): Promise<void> {
  identifying ??= readProcess(process.pid).then((me) => {
    identity = { pid: process.pid, startMs: me?.startMs ?? null };
  });
  return identifying;
}

/** This gateway process, as it is recorded on the runs and processes it starts. */
export function gatewayOwner(): { pid: number; start: string | null } {
  return {
    pid: process.pid,
    start: identity?.startMs == null ? null : new Date(identity.startMs).toISOString(),
  };
}

/** Writes that wait on the OS, so a test can wait for them. */
const pending = new Set<Promise<void>>();
function later(work: Promise<void>): void {
  const tracked = work.catch((e: unknown) => {
    logger.warn('Could not complete an agent process record', {
      err: e instanceof Error ? e.message : String(e),
    });
  });
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Resolves once the start times being looked up have been written. */
export async function settleRecords(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Record a process a run started. The row is written at once, without a start
 * time; the OS is asked for that without blocking and it is filled in when it
 * answers. A gateway that dies in between leaves a record that is never acted
 * on. Returns the record's id, or null when it could not be written:
 * bookkeeping must not stop the run it describes.
 */
export function recordProcess(
  runId: string,
  kind: ProcessKind,
  spawned: SpawnedProcess
): number | null {
  try {
    const owner = gatewayOwner();
    const res = getStore()
      .prepare(
        `INSERT INTO run_processes
           (run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start, started_at,
            container, container_runtime)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        kind,
        spawned.pid,
        spawned.pgid,
        spawned.command,
        owner.pid,
        owner.start,
        new Date().toISOString(),
        spawned.container?.name ?? null,
        spawned.container?.runtime ?? null
      );
    const id = Number(res.lastInsertRowid);

    later(
      readProcess(spawned.pid).then((info) => {
        if (!info) return;
        getStore()
          .prepare('UPDATE run_processes SET proc_start = ? WHERE id = ? AND proc_start IS NULL')
          .run(new Date(info.startMs).toISOString(), id);
      })
    );
    if (owner.start === null) {
      later(
        warmGatewayIdentity().then(() => {
          const { start } = gatewayOwner();
          if (start === null) return;
          getStore()
            .prepare(
              'UPDATE run_processes SET owner_start = ? WHERE id = ? AND owner_start IS NULL'
            )
            .run(start, id);
        })
      );
    }
    return id;
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
  /**
   * The container the process ran its work in (container profile), removed by
   * name: the process is only the runtime CLI, and stopping it does not stop
   * the container.
   */
  container?: string;
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
  container: string | null;
  containerRuntime: string | null;
}

function rows(): Row[] {
  return getStore()
    .prepare(
      `SELECT id, run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start,
              container, container_runtime
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
      container: r.container ? String(r.container) : null,
      containerRuntime: r.container_runtime ? String(r.container_runtime) : null,
    }));
}

const sameInstant = (a: number, b: number) => Math.abs(a - b) <= START_TOLERANCE_MS;

/**
 * Whether the gateway recorded as `pid` and `startMs` is running now. The pid
 * alone is not enough (a restarted container's gateway is pid 1 every time),
 * so its start time must match too. When that was never recorded, a live pid
 * is given the benefit of the doubt.
 */
function gatewayAlive(table: ProcessInfo[], pid: number, startMs: number | null): boolean {
  const found = table.find((p) => p.pid === pid);
  return found !== undefined && (startMs === null || sameInstant(found.startMs, startMs));
}

/**
 * The unfinished runs started by a gateway that is running now, this one
 * included. Their processes, their approvals and their worktrees are theirs.
 */
export function runsOfLiveGateways(table: ProcessInfo[]): Set<string> {
  const owned = getStore()
    .prepare(
      `SELECT id, owner_pid, owner_start FROM runs
       WHERE status NOT IN ('done', 'failed', 'cancelled') AND owner_pid IS NOT NULL`
    )
    .all();
  const live = new Set<string>();
  for (const r of owned) {
    const start = r.owner_start ? Date.parse(String(r.owner_start)) : null;
    if (gatewayAlive(table, Number(r.owner_pid), start)) live.add(String(r.id));
  }
  return live;
}

/**
 * Whether the process now at `pid` is the one that was recorded. "killed"
 * means its group should be stopped; the other answers say why it should not.
 */
function judge(row: Row, table: ProcessInfo[]): Exclude<LeftoverOutcome, 'unsupported'> {
  if (gatewayAlive(table, row.ownerPid, row.ownerStart)) {
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

  // The leader is the only member that can be told from a stranger's: after
  // the recorded group has died its number can be given to another group, and
  // that group's leader may have exited too, leaving members that all look
  // younger than the recording. Nothing about them says whose they are.
  const leader = group.find((p) => p.pid === row.pid);
  if (!leader) return 'unverified';

  if (!sameInstant(leader.startMs, row.procStart)) return 'reused';
  // Start time says it is ours; for an agent the command line must still
  // agree. The CLI may be a script run by an interpreter, so its name is
  // looked for, not its place in the line. A gate is run by a shell, which may
  // have replaced itself with the one command it was given, so there is
  // nothing fixed to look for.
  if (row.kind === 'agent') {
    const name = path.basename(row.command).toLowerCase();
    if (name && !leader.command.toLowerCase().includes(name)) return 'reused';
  }
  return 'killed';
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
  options: {
    graceMs?: number;
    /** For tests: how the process table is read. */
    readTable?: () => Promise<ProcessInfo[] | null>;
  } = {}
): Promise<LeftoverProcess[]> {
  const live = rows();
  if (live.length === 0) return [];

  const readTable = options.readTable ?? readProcessTable;
  const table = await readTable();
  const out: LeftoverProcess[] = [];
  const close = (row: Row, outcome: string) => markProcessEnded(row.id, outcome);
  /** Containers removed so far, by name: a run's processes may share none, but never twice. */
  const removed = new Set<string>();
  const report = async (row: Row, outcome: LeftoverOutcome, forced?: boolean) => {
    // The container is named for this run alone, so whatever the verdict on
    // the pid (which may since have been reused), a container of a gateway
    // that is gone is removed by its name.
    let container: string | undefined;
    if (row.container && outcome !== 'own' && outcome !== 'owner_alive') {
      const runtime =
        row.containerRuntime && fs.existsSync(row.containerRuntime)
          ? row.containerRuntime
          : resolveRuntime();
      if (runtime && !removed.has(row.container)) {
        removed.add(row.container);
        await removeContainer(runtime, row.container);
        container = row.container;
      }
    }
    out.push({
      runId: row.runId,
      kind: row.kind,
      pid: row.pid,
      pgid: row.pgid,
      command: row.command,
      outcome,
      ...(forced === undefined ? {} : { forced }),
      ...(container ? { container } : {}),
    });
  };

  if (!table) {
    if (process.platform === 'win32') {
      // Nothing here can ever be checked, so do not keep the records.
      for (const row of live) {
        close(row, 'unsupported');
        await report(row, 'unsupported');
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
    let verdict = judge(row, table);
    if (verdict === 'killed') {
      // The reading above may be seconds old: stopping an earlier group can
      // take that long. Look again, at the leader, just before signalling.
      const fresh = await readTable();
      verdict = fresh ? judge(row, fresh) : 'unverified';
    }
    if (verdict === 'own' || verdict === 'owner_alive') {
      await report(row, verdict);
      continue;
    }
    if (verdict !== 'killed') {
      close(row, verdict);
      await report(row, verdict);
      continue;
    }
    try {
      const forced = await stopGroup(row.pgid, options.graceMs ?? 3_000);
      close(row, forced ? 'killed (forced)' : 'killed');
      await report(row, 'killed', forced);
    } catch (e) {
      // Not ours to signal, or it would not die: leave the record for the next start.
      logger.warn('Could not stop an agent process left by an earlier gateway', {
        pid: row.pid,
        err: e instanceof Error ? e.message : String(e),
      });
      await report(row, 'unverified');
    }
  }
  return out;
}
