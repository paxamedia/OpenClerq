import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { initStore, closeStore, getStore } from './store.js';
import { createRun, getRun, reapInterruptedRuns } from './runs.js';
import { listPending, requestApproval } from './approvals.js';
import {
  gatewayOwner,
  readProcessTable,
  runsOfLiveGateways,
  warmGatewayIdentity,
  type ProcessInfo,
} from './agent-processes.js';
import { recoverAfterRestart } from './automations/routes.js';

const isWindows = process.platform === 'win32';

const started: ChildProcess[] = [];

beforeAll(async () => {
  await initStore(':memory:');
  await warmGatewayIdentity();
});

afterAll(() => {
  closeStore();
});

afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** A process that leads its own group, as the sandbox starts every agent. */
function start(command: string, args: string[] = []): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  started.push(child);
  return child;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until the OS lists the process, and returns it. */
async function seen(pid: number): Promise<ProcessInfo> {
  for (const end = Date.now() + 4_000; Date.now() < end; ) {
    const found = (await readProcessTable())?.find((p) => p.pid === pid);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the OS never listed process ${pid}`);
}

/** A pid nobody holds: an owner that is gone. */
async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

describe.skipIf(isWindows)('which gateway started a run', () => {
  it('stamps every run with the gateway that started it', () => {
    const id = createRun({ trigger: 'manual', status: 'executing' });
    const mine = gatewayOwner();
    expect(mine.pid).toBe(process.pid);
    expect(mine.start).toBeTruthy();
    expect(getRun(id)).toBeTruthy();
    expect(
      getStore().prepare('SELECT owner_pid, owner_start FROM runs WHERE id = ?').get(id)
    ).toEqual({ owner_pid: process.pid, owner_start: mine.start });
  });
});

describe.skipIf(isWindows)('runs of a gateway that is still running', () => {
  /** An unfinished run owned by the given gateway process. */
  function runOwnedBy(owner: { pid: number; start: Date | null } | null): string {
    const id = createRun({ trigger: 'manual', status: 'executing' });
    getStore()
      .prepare('UPDATE runs SET owner_pid = ?, owner_start = ? WHERE id = ?')
      .run(owner?.pid ?? null, owner?.start ? owner.start.toISOString() : null, id);
    return id;
  }

  // A clean slate: only the runs a test makes are unfinished.
  beforeEach(() => {
    reapInterruptedRuns();
  });
  afterEach(() => {
    reapInterruptedRuns();
  });

  it('names the unfinished runs whose owner is running now, and only those', async () => {
    const other = start('sleep', ['30']); // another gateway, alive
    const { startMs } = await seen(other.pid as number);
    const table = (await readProcessTable()) as ProcessInfo[];

    const ours = runOwnedBy({ pid: process.pid, start: new Date(gatewayOwner().start as string) });
    const theirs = runOwnedBy({ pid: other.pid as number, start: new Date(startMs) });
    const dead = runOwnedBy({ pid: await deadPid(), start: new Date() });
    const reusedPid = runOwnedBy({
      pid: other.pid as number,
      start: new Date(startMs - 3_600_000),
    });
    const unknownOwner = runOwnedBy(null);
    const finished = runOwnedBy({ pid: process.pid, start: null });
    getStore().prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(finished);

    expect(runsOfLiveGateways(table)).toEqual(new Set([ours, theirs]));
    expect([dead, reusedPid, unknownOwner].some((id) => runsOfLiveGateways(table).has(id))).toBe(
      false
    );
  });

  it('does not fail them, deny their approvals or touch them at startup', async () => {
    const other = start('sleep', ['30']);
    const { startMs } = await seen(other.pid as number);

    const live = runOwnedBy({ pid: other.pid as number, start: new Date(startMs) });
    const orphan = runOwnedBy({ pid: await deadPid(), start: new Date(startMs) });
    const oldRun = runOwnedBy(null);
    for (const id of [live, orphan]) {
      requestApproval({
        runId: id,
        tool: 'git.push',
        tier: 'high',
        reason: 'Push',
        arguments: {},
      });
    }

    await recoverAfterRestart();

    expect(getRun(live)).toMatchObject({ status: 'executing' });
    expect(getRun(live)?.exitReason).toBeUndefined();
    expect(getRun(orphan)).toMatchObject({
      status: 'failed',
      exitReason: 'Interrupted: the gateway stopped while this run was in progress.',
    });
    expect(getRun(oldRun)?.status).toBe('failed');
    // Only the live gateway's approval is still waiting for an answer.
    expect(listPending().map((p) => p.runId)).toEqual([live]);
  });

  it('leaves its leftover processes alone along with its runs', async () => {
    const other = start('sleep', ['30']);
    const agent = start('sleep', ['30']);
    const ownerStart = (await seen(other.pid as number)).startMs;
    const agentStart = (await seen(agent.pid as number)).startMs;
    const live = runOwnedBy({ pid: other.pid as number, start: new Date(ownerStart) });
    getStore()
      .prepare(
        `INSERT INTO run_processes
           (run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start, started_at)
         VALUES (?, 'agent', ?, ?, 'sleep', ?, ?, ?, ?)`
      )
      .run(
        live,
        agent.pid as number,
        agent.pid as number,
        new Date(agentStart).toISOString(),
        other.pid as number,
        new Date(ownerStart).toISOString(),
        new Date().toISOString()
      );

    await recoverAfterRestart();

    expect(alive(agent.pid as number)).toBe(true);
    expect(getRun(live)?.status).toBe('executing');
  });
});
