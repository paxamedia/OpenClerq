import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStore, closeStore, getStore } from './store.js';
import { createRun, getRun } from './runs.js';
import {
  killLeftoverProcesses,
  markProcessEnded,
  parseProcessTable,
  readProcessTable,
  recordProcess,
  settleRecords,
  warmGatewayIdentity,
  watchProcess,
  type ProcessInfo,
} from './agent-processes.js';
import { recoverAfterRestart } from './automations/routes.js';

const isWindows = process.platform === 'win32';

let dir: string;
let agentScript: string;
let runId: string;
const started: ChildProcess[] = [];

beforeAll(async () => {
  await initStore(':memory:');
  await warmGatewayIdentity();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-proc-'));
  // A stand-in agent: starts a helper in its group, then waits on it.
  agentScript = path.join(dir, 'fake-agent.sh');
  fs.writeFileSync(agentScript, '#!/bin/sh\nsleep 60 &\nwait\n', { mode: 0o755 });
  runId = createRun({ trigger: 'manual', status: 'executing' });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  closeStore();
});

afterEach(async () => {
  await settleRecords();
  // Whatever a test left running.
  for (const child of started.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  getStore().prepare('DELETE FROM run_processes').run();
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

async function until(condition: () => boolean | Promise<boolean>, ms = 4_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return condition();
}

async function listed(pid: number): Promise<ProcessInfo | undefined> {
  return (await readProcessTable())?.find((p) => p.pid === pid);
}

/** Waits until the OS lists the process, and returns it. */
async function seen(pid: number): Promise<ProcessInfo> {
  expect(await until(async () => Boolean(await listed(pid)))).toBe(true);
  return (await listed(pid)) as ProcessInfo;
}

/** A pid nobody holds: an owner that is gone. */
async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

interface RowFields {
  pid: number;
  pgid?: number;
  kind?: 'agent' | 'gate';
  command: string;
  procStart: Date | null;
  ownerPid: number;
  ownerStart?: Date | null;
}

/** A record as an earlier gateway would have left it. */
function insert(f: RowFields): number {
  const res = getStore()
    .prepare(
      `INSERT INTO run_processes
         (run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      f.kind ?? 'agent',
      f.pid,
      f.pgid ?? f.pid,
      f.command,
      f.procStart ? f.procStart.toISOString() : null,
      f.ownerPid,
      f.ownerStart ? f.ownerStart.toISOString() : null,
      new Date().toISOString()
    );
  return Number(res.lastInsertRowid);
}

function row(id: number) {
  return getStore().prepare('SELECT ended_at, outcome FROM run_processes WHERE id = ?').get(id) as {
    ended_at: string | null;
    outcome: string | null;
  };
}

describe('parseProcessTable', () => {
  it('reads pid, group, start time and command, however the date is padded', () => {
    const table = parseProcessTable(
      [
        '    1     1 Wed Oct 14 00:49:38 2026     /sbin/launchd',
        '  835   830 Thu Nov  5 09:01:02 2026     /usr/bin/node /srv/app.js --flag "two words"',
        'not a row at all',
        '  900   900 Xyz Foo 99 99:99:99 2026     /bad/date',
      ].join('\n')
    );
    expect(table).toHaveLength(2);
    expect(table[0]).toMatchObject({ pid: 1, pgid: 1, command: '/sbin/launchd' });
    expect(table[1]).toMatchObject({
      pid: 835,
      pgid: 830,
      command: '/usr/bin/node /srv/app.js --flag "two words"',
    });
    expect(new Date(table[1].startMs).getMonth()).toBe(10);
    expect(new Date(table[1].startMs).getDate()).toBe(5);
  });
});

describe.skipIf(isWindows)('the process table on this machine', () => {
  it('lists this process with its own group and a plausible start time', async () => {
    const table = await readProcessTable();
    expect(table).not.toBeNull();
    const me = table?.find((p) => p.pid === process.pid);
    expect(me).toBeDefined();
    expect(Math.abs((me?.startMs ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(
      5_000
    );
  });

  it('lists session leaders, which is what every agent is', async () => {
    // Started detached, the child calls setsid(): its pid is its group and its session.
    const child = start('sleep', ['30']);
    const pid = child.pid as number;
    const found = await seen(pid);
    expect(found.pgid).toBe(pid);
  });

  it('does not block the event loop while it asks the OS', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    try {
      await readProcessTable();
      await readProcessTable();
    } finally {
      clearInterval(timer);
    }
    // A synchronous ps would let no timer fire between the start and the answer.
    expect(ticks).toBeGreaterThan(0);
  });
});

describe.skipIf(isWindows)('recording a run’s processes', () => {
  it('writes the record at once and fills in the start time when the OS answers', async () => {
    const child = start('sleep', ['30']);
    const pid = child.pid as number;
    const watch = watchProcess(runId, 'agent');
    watch.onSpawn({ pid, pgid: pid, command: 'sleep' });

    // Immediately: the row exists, with no start time yet.
    const [first] = getStore().prepare('SELECT * FROM run_processes WHERE run_id = ?').all(runId);
    expect(first).toMatchObject({
      kind: 'agent',
      pid,
      pgid: pid,
      command: 'sleep',
      owner_pid: process.pid,
      proc_start: null,
      ended_at: null,
    });
    expect(first.owner_start).toBeTruthy();

    await settleRecords();
    const [filled] = getStore().prepare('SELECT * FROM run_processes WHERE run_id = ?').all(runId);
    const startMs = (await seen(pid)).startMs;
    expect(Math.abs(Date.parse(String(filled.proc_start)) - startMs)).toBeLessThan(2_000);

    watch.done();
    expect(row(Number(filled.id)).ended_at).toBeTruthy();
    expect(row(Number(filled.id)).outcome).toBe('exited');
  });

  it('leaves a record alone that never got its start time, and does not stop the process', async () => {
    // The gateway died before the OS answered: proc_start is still empty.
    const child = start('sleep', ['30']);
    const pid = child.pid as number;
    await seen(pid);
    const id = recordProcess(runId, 'agent', { pid, pgid: pid, command: 'sleep' }) as number;
    await settleRecords();
    getStore()
      .prepare('UPDATE run_processes SET proc_start = NULL, owner_pid = ? WHERE id = ?')
      .run(await deadPid(), id);

    const [found] = await killLeftoverProcesses();
    expect(found.outcome).toBe('unverified');
    expect(alive(pid)).toBe(true);
  });

  it('does not fail the run when the record cannot be written', () => {
    expect(recordProcess('run_missing', 'agent', { pid: 1, pgid: 1, command: 'x' })).toBeNull();
    expect(() => markProcessEnded(null)).not.toThrow();
  });
});

describe.skipIf(isWindows)('processes a crashed gateway left behind', () => {
  it('stops a leftover agent and the processes it started', async () => {
    const child = start(agentScript);
    const pid = child.pid as number;
    // Let it start its helper, then record it as the earlier gateway did.
    await until(
      async () => (await readProcessTable())?.some((p) => p.pgid === pid && p.pid !== pid) ?? false
    );
    const id = recordProcess(runId, 'agent', { pid, pgid: pid, command: agentScript }) as number;
    await settleRecords();
    getStore()
      .prepare('UPDATE run_processes SET owner_pid = ?, owner_start = NULL WHERE id = ?')
      .run(await deadPid(), id);

    const [found] = await killLeftoverProcesses({ graceMs: 2_000 });
    expect(found).toMatchObject({ runId, kind: 'agent', pid, outcome: 'killed' });

    expect(await until(() => !alive(pid))).toBe(true);
    // Nothing of the group remains, helper included.
    expect((await readProcessTable())?.filter((p) => p.pgid === pid)).toEqual([]);
    expect(row(id).outcome).toMatch(/^killed/);
    expect(row(id).ended_at).toBeTruthy();
  });

  it('kills a leftover that ignores the polite request', async () => {
    const stubborn = path.join(dir, 'stubborn.sh');
    const ready = path.join(dir, 'stubborn.ready');
    fs.rmSync(ready, { force: true });
    fs.writeFileSync(
      stubborn,
      `#!/bin/sh\ntrap "" TERM\ntouch '${ready}'\nwhile true; do sleep 1; done\n`,
      { mode: 0o755 }
    );
    const child = start(stubborn);
    const pid = child.pid as number;
    // Only once it has installed its trap does ignoring the request mean anything.
    expect(await until(() => fs.existsSync(ready))).toBe(true);
    const id = recordProcess(runId, 'agent', { pid, pgid: pid, command: stubborn }) as number;
    await settleRecords();
    getStore()
      .prepare('UPDATE run_processes SET owner_pid = ? WHERE id = ?')
      .run(await deadPid(), id);

    const [found] = await killLeftoverProcesses({ graceMs: 300 });
    expect(found).toMatchObject({ outcome: 'killed', forced: true });
    expect(await until(() => !alive(pid))).toBe(true);
    expect(row(id).outcome).toBe('killed (forced)');
  });

  it('never stops a group whose leader has gone, however young its members look', async () => {
    // The recorded group died long ago. Its number now belongs to another
    // group whose leader has since exited, leaving a member that started well
    // after the recording: nothing about it says whose it is.
    const lonely = path.join(dir, 'lonely.sh');
    fs.writeFileSync(lonely, '#!/bin/sh\nsleep 60 &\nexit 0\n', { mode: 0o755 });
    const child = start(lonely);
    const pid = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    const member = (await readProcessTable())?.find((p) => p.pgid === pid && p.pid !== pid);
    expect(member).toBeDefined();

    const id = insert({
      pid,
      command: lonely,
      procStart: new Date(Date.now() - 3_600_000),
      ownerPid: await deadPid(),
    });
    const [found] = await killLeftoverProcesses({ graceMs: 500 });
    expect(found.outcome).toBe('unverified');
    expect(alive((member as ProcessInfo).pid)).toBe(true);
    expect(row(id).outcome).toBe('unverified');
  });

  it('never kills a process that has taken over the recorded pid', async () => {
    const stranger = start('sleep', ['30']);
    const pid = stranger.pid as number;
    await seen(pid);
    // Recorded as having started an hour before this process did: so the pid
    // was reused after the recorded process died.
    const id = insert({
      pid,
      command: 'sleep',
      procStart: new Date(Date.now() - 3_600_000),
      ownerPid: await deadPid(),
    });

    const [found] = await killLeftoverProcesses();
    expect(found.outcome).toBe('reused');
    expect(alive(pid)).toBe(true);
    expect(row(id).outcome).toBe('reused');
  });

  it('never kills a process whose command is no longer the recorded agent', async () => {
    const other = start('sleep', ['30']);
    const pid = other.pid as number;
    const { startMs } = await seen(pid);
    insert({
      pid,
      command: '/usr/local/bin/codex',
      procStart: new Date(startMs),
      ownerPid: await deadPid(),
    });

    const [found] = await killLeftoverProcesses();
    expect(found.outcome).toBe('reused');
    expect(alive(pid)).toBe(true);
  });

  it('does not hold a gate to its command, which a shell may have replaced', async () => {
    const gate = start('sleep', ['30']);
    const pid = gate.pid as number;
    const { startMs } = await seen(pid);
    insert({
      pid,
      kind: 'gate',
      command: '/bin/sh',
      procStart: new Date(startMs),
      ownerPid: await deadPid(),
    });
    const [found] = await killLeftoverProcesses({ graceMs: 2_000 });
    expect(found.outcome).toBe('killed');
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('leaves a process alone when its start time was never recorded', async () => {
    const child = start('sleep', ['30']);
    const pid = child.pid as number;
    await seen(pid);
    insert({ pid, command: 'sleep', procStart: null, ownerPid: await deadPid() });

    const [found] = await killLeftoverProcesses();
    expect(found.outcome).toBe('unverified');
    expect(alive(pid)).toBe(true);
  });

  it('looks at the leader again just before it stops a group', async () => {
    const child = start('sleep', ['30']);
    const pid = child.pid as number;
    const { startMs } = await seen(pid);
    insert({
      pid,
      command: 'sleep',
      procStart: new Date(startMs),
      ownerPid: await deadPid(),
    });

    // By the second look the pid belongs to a process that started later: the
    // first reading, taken before earlier groups were stopped, is out of date.
    const real = (await readProcessTable()) as ProcessInfo[];
    let reads = 0;
    const readTable = async () => {
      reads += 1;
      return reads === 1
        ? real
        : real.map((p) => (p.pid === pid ? { ...p, startMs: p.startMs + 3_600_000 } : p));
    };

    const [found] = await killLeftoverProcesses({ readTable });
    expect(reads).toBe(2);
    expect(found.outcome).toBe('reused');
    expect(alive(pid)).toBe(true);
  });

  it('reads the table again for every group it is about to stop', async () => {
    const a = start('sleep', ['30']);
    const b = start('sleep', ['30']);
    const infoA = await seen(a.pid as number);
    const infoB = await seen(b.pid as number);
    for (const info of [infoA, infoB]) {
      insert({
        pid: info.pid,
        command: 'sleep',
        procStart: new Date(info.startMs),
        ownerPid: await deadPid(),
      });
    }
    let reads = 0;
    const readTable = async () => {
      reads += 1;
      return readProcessTable();
    };
    const found = await killLeftoverProcesses({ readTable, graceMs: 2_000 });
    expect(found.map((f) => f.outcome)).toEqual(['killed', 'killed']);
    // One reading to find them, then one before each group.
    expect(reads).toBe(3);
    expect(await until(() => !alive(a.pid as number) && !alive(b.pid as number))).toBe(true);
  });

  it('closes the record of a process that is already gone', async () => {
    const id = insert({
      pid: await deadPid(),
      command: 'sleep',
      procStart: new Date(),
      ownerPid: await deadPid(),
    });
    const [found] = await killLeftoverProcesses();
    expect(found.outcome).toBe('gone');
    expect(row(id).outcome).toBe('gone');
  });

  it('leaves processes alone while the gateway that started them is still running', async () => {
    const other = start('sleep', ['30']); // stands in for another gateway
    const agent = start('sleep', ['30']);
    const ownerStart = (await seen(other.pid as number)).startMs;
    const agentStart = (await seen(agent.pid as number)).startMs;

    const theirs = insert({
      pid: agent.pid as number,
      command: 'sleep',
      procStart: new Date(agentStart),
      ownerPid: other.pid as number,
      ownerStart: new Date(ownerStart),
    });
    // And one this very process started.
    const mine = recordProcess(runId, 'agent', {
      pid: agent.pid as number,
      pgid: agent.pid as number,
      command: 'sleep',
    }) as number;

    const found = await killLeftoverProcesses();
    expect(found.map((f) => f.outcome).sort()).toEqual(['own', 'owner_alive']);
    expect(alive(agent.pid as number)).toBe(true);
    // Both stay recorded: they are not leftovers.
    expect(row(theirs).ended_at).toBeNull();
    expect(row(mine).ended_at).toBeNull();
  });

  it('treats a gateway with the recorded pid but a different start as a dead one', async () => {
    // A restarted container's gateway is pid 1 every time.
    const child = start('sleep', ['30']);
    const pid = child.pid as number;
    const { startMs } = await seen(pid);
    insert({
      pid,
      command: 'sleep',
      procStart: new Date(startMs),
      ownerPid: process.pid,
      ownerStart: new Date(Date.now() - 86_400_000),
    });
    const [found] = await killLeftoverProcesses({ graceMs: 2_000 });
    expect(found.outcome).toBe('killed');
  });

  it('does nothing when nothing was recorded', async () => {
    expect(await killLeftoverProcesses()).toEqual([]);
  });

  describe('containers (container profile)', () => {
    /** A stand-in runtime that only records what it is asked. */
    function fakeRuntime(): { bin: string; calls: () => string[] } {
      const bin = path.join(dir, `docker-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${bin}.calls"\n`, { mode: 0o755 });
      return {
        bin,
        calls: () =>
          fs.existsSync(`${bin}.calls`)
            ? fs.readFileSync(`${bin}.calls`, 'utf8').trim().split('\n')
            : [],
      };
    }

    it('records the container a process runs its work in', () => {
      const id = recordProcess(runId, 'agent', {
        pid: 999_999,
        pgid: 999_999,
        command: 'claude',
        container: { runtime: '/usr/local/bin/docker', name: 'clerq-run_1-abcd' },
      }) as number;
      expect(
        getStore()
          .prepare('SELECT container, container_runtime FROM run_processes WHERE id = ?')
          .get(id)
      ).toEqual({ container: 'clerq-run_1-abcd', container_runtime: '/usr/local/bin/docker' });
    });

    it("removes a dead gateway's container by name, whatever became of the runtime CLI's pid", async () => {
      const runtime = fakeRuntime();
      // The runtime CLI is long gone; its container would still be running.
      const id = insert({
        pid: await deadPid(),
        command: 'claude',
        procStart: new Date(Date.now() - 60_000),
        ownerPid: await deadPid(),
      });
      getStore()
        .prepare('UPDATE run_processes SET container = ?, container_runtime = ? WHERE id = ?')
        .run('clerq-run_9-0001', runtime.bin, id);
      const [found] = await killLeftoverProcesses();
      expect(found).toMatchObject({ outcome: 'gone', container: 'clerq-run_9-0001' });
      expect(runtime.calls()).toEqual([
        'rm -f clerq-run_9-0001 clerq-run_9-0001-egress',
        'network rm clerq-run_9-0001-net',
      ]);
      expect(row(id).ended_at).not.toBeNull();
    });

    it("leaves a live gateway's container alone", async () => {
      const runtime = fakeRuntime();
      const id = recordProcess(runId, 'agent', {
        pid: process.pid,
        pgid: process.pid,
        command: 'claude',
        container: { runtime: runtime.bin, name: 'clerq-run_8-0002' },
      }) as number;
      await settleRecords();
      const [found] = await killLeftoverProcesses();
      expect(found.outcome).toBe('own');
      expect(found.container).toBeUndefined();
      expect(runtime.calls()).toEqual([]);
      expect(row(id).ended_at).toBeNull();
    });
  });
});

describe.skipIf(isWindows)('recovering after a restart', () => {
  it('stops the leftover agent before it fails the run, and says so on the run', async () => {
    const id = createRun({ trigger: 'manual', status: 'executing' });
    // The earlier gateway: gone.
    getStore()
      .prepare('UPDATE runs SET owner_pid = ?, owner_start = NULL WHERE id = ?')
      .run(await deadPid(), id);
    const child = start(agentScript);
    const pid = child.pid as number;
    await until(
      async () => (await readProcessTable())?.some((p) => p.pgid === pid && p.pid !== pid) ?? false
    );
    const recorded = recordProcess(id, 'agent', {
      pid,
      pgid: pid,
      command: agentScript,
    }) as number;
    await settleRecords();
    getStore()
      .prepare('UPDATE run_processes SET owner_pid = ?, owner_start = NULL WHERE id = ?')
      .run(await deadPid(), recorded);

    await recoverAfterRestart();

    expect(await until(() => !alive(pid))).toBe(true);
    expect((await readProcessTable())?.filter((p) => p.pgid === pid)).toEqual([]);
    const run = getRun(id);
    expect(run).toMatchObject({
      status: 'failed',
      exitReason: 'Interrupted: the gateway stopped while this run was in progress.',
    });
    const step = (
      run?.steps as Array<{ input?: { name?: string; pid?: number }; output?: { note?: string } }>
    ).find((s) => s.input?.name === 'process.cleanup');
    expect(step?.input?.pid).toBe(pid);
    expect(step?.output?.note).toMatch(/Stopped the agent process/);
  });

  it('marks interrupted runs failed when nothing was left running', async () => {
    const id = createRun({ trigger: 'manual', status: 'preparing' });
    getStore()
      .prepare('UPDATE runs SET owner_pid = ?, owner_start = NULL WHERE id = ?')
      .run(await deadPid(), id);
    await recoverAfterRestart();
    expect(getRun(id)?.status).toBe('failed');
  });
});
