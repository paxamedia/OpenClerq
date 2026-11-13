/**
 * The CLI drivers under the seatbelt and container profiles. Seatbelt runs for
 * real on macOS (skipped elsewhere: `sandbox-exec` is macOS only). There is no
 * container runtime where these tests run, so `docker` is a script that
 * records what it was asked; what a real engine and a real CLI in an image do
 * is not exercised here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_TOOLS,
  buildCodexArgs,
  claudeCode,
  codex,
  cursorAgent,
  DRIVER_CAPABILITIES,
  type DriverEvent,
  type DriverRunInput,
} from './index.js';

const isMac = process.platform === 'darwin';
// sandbox-exec starts slower on a loaded machine than the 5s default allows.
vi.setConfig({ testTimeout: 20_000 });
let dir: string;
let fakeCodex: string;
let fakeClaude: string;
let fakeDocker: string;
/** Where the fakes write what they saw: writable under seatbelt, unlike the worktree's neighbours. */
let logs: string;

const FAKE_CODEX = String.raw`#!/bin/sh
printf '%s\n' "$@" > "$FAKE_LOG.args"
echo '{"type":"thread.started","thread_id":"t-1"}'
if echo hi > hello.txt 2>/dev/null; then wrote=yes; else wrote=no; fi
echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"i\",\"type\":\"agent_message\",\"text\":\"wrote=$wrote\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`;

const FAKE_CLAUDE = String.raw`#!/bin/sh
env > "$FAKE_LOG.env"
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`;

const FAKE_DOCKER = String.raw`#!/bin/sh
here=$(dirname "$0")
printf '%s\n' "$*" >> "$here/docker.calls"
exit 0
`;

beforeAll(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-drv-prof-')));
  fakeCodex = path.join(dir, 'codex');
  fakeClaude = path.join(dir, 'claude');
  fakeDocker = path.join(dir, 'docker');
  logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(fakeCodex, FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(fakeDocker, FAKE_DOCKER, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const out: DriverEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function summaryOf(events: DriverEvent[]): string {
  const last = events[events.length - 1];
  return last?.type === 'finished' ? last.result.summary : '';
}

function workdir(): string {
  return fs.mkdtempSync(path.join(dir, 'work-'));
}

describe('codex under an outer profile', () => {
  it("turns Codex's own sandbox off under seatbelt and container, whatever the mode", () => {
    for (const profile of ['seatbelt', 'container'] as const) {
      for (const permissionMode of ['acceptEdits', 'default', 'dontAsk', 'plan'] as const) {
        const args = buildCodexArgs({
          prompt: 'x',
          cwd: '/x',
          permissionMode,
          sandbox: { profile, network: ['api.openai.com'] },
        });
        expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access');
        // The network setting belongs to Codex's own sandbox, which is off.
        expect(args).not.toContain('--config');
      }
    }
    // Native keeps Codex's own sandbox, as before.
    const native = buildCodexArgs({ prompt: 'x', cwd: '/x', sandbox: { profile: 'native' } });
    expect(native[native.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it.skipIf(!isMac)('edits the worktree under seatbelt in acceptEdits (macOS)', async () => {
    const work = workdir();
    const log = path.join(logs, `log-${Math.random().toString(36).slice(2)}`);
    const events = await collect(
      codex({ bin: fakeCodex }).run({
        prompt: 'x',
        cwd: work,
        sandbox: { profile: 'seatbelt', network: 'none', allowWrite: [logs] },
        env: { FAKE_LOG: log },
      })
    );
    expect(summaryOf(events)).toBe('wrote=yes');
    expect(fs.existsSync(path.join(work, 'hello.txt'))).toBe(true);
    const args = fs.readFileSync(`${log}.args`, 'utf8').split('\n');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'danger-full-access']));
  });

  it.skipIf(!isMac)(
    'keeps a read-only mode read-only through the outer profile (macOS)',
    async () => {
      const work = workdir();
      const log = path.join(logs, `log-${Math.random().toString(36).slice(2)}`);
      const events = await collect(
        codex({ bin: fakeCodex }).run({
          prompt: 'x',
          cwd: work,
          permissionMode: 'plan',
          sandbox: { profile: 'seatbelt', network: 'none', allowWrite: [logs] },
          env: { FAKE_LOG: log },
        })
      );
      expect(summaryOf(events)).toBe('wrote=no');
      expect(fs.existsSync(path.join(work, 'hello.txt'))).toBe(false);
    }
  );
});

describe('the CLI drivers in a container', () => {
  const run = async (driver: ReturnType<typeof codex>, extra: Partial<DriverRunInput> = {}) => {
    fs.rmSync(path.join(dir, 'docker.calls'), { force: true });
    await collect(
      driver.run({
        prompt: 'do it',
        cwd: workdir(),
        sandbox: { profile: 'container', image: 'agent-image', runtime: fakeDocker },
        ...extra,
      })
    );
    return fs.readFileSync(path.join(dir, 'docker.calls'), 'utf8').trim().split('\n');
  };

  it("runs the image's own CLI by name, not the host's path", async () => {
    // A host path that does not exist: in a container it is not looked for.
    const missing = '/nonexistent/bin/claude';
    const [runCall] = await run(claudeCode({ bin: missing }));
    expect(runCall).toMatch(/ agent-image claude -p /);
    expect(runCall).not.toContain(missing);
    const [codexRun] = await run(codex({ bin: '/nonexistent/codex' }));
    expect(codexRun).toMatch(/ agent-image codex exec --json --sandbox danger-full-access /);
    const [cursorRun] = await run(cursorAgent({ bin: '/nonexistent/cursor-agent' }));
    expect(cursorRun).toMatch(/ agent-image cursor-agent --print /);
  });

  it('removes the container by name after the CLI ends', async () => {
    const calls = await run(codex({ bin: '/nonexistent/codex' }));
    const name = /--name (\S+)/.exec(calls[0])?.[1];
    expect(name).toBeTruthy();
    expect(calls).toContain(`rm -f ${name} ${name}-egress`);
  });

  it("does not check the host's CLI or sign-in for a run in a container", async () => {
    for (const driver of [
      claudeCode({ bin: '/nonexistent/claude' }),
      codex({ bin: '/nonexistent/codex' }),
      cursorAgent({ bin: '/nonexistent/cursor-agent' }),
    ]) {
      const found = await driver.detect({ inContainer: true });
      expect(found.available).toBe(true);
      expect(found.path).toBe(DRIVER_CAPABILITIES[driver.id as 'codex'].cliName);
    }
  });
});

describe('claude-code under an egress allowlist', () => {
  it.skipIf(!isMac)(
    'asks the CLI not to send telemetry the proxy would only refuse (macOS)',
    async () => {
      const log = path.join(logs, `log-${Math.random().toString(36).slice(2)}`);
      await collect(
        claudeCode({ bin: fakeClaude }).run({
          prompt: 'x',
          cwd: workdir(),
          sandbox: { profile: 'seatbelt', network: ['api.anthropic.com'], allowWrite: [logs] },
          env: { FAKE_LOG: log },
        })
      );
      const env = fs.readFileSync(`${log}.env`, 'utf8');
      expect(env).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
      expect(env).toMatch(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/);
    }
  );
});

describe('what each driver declares', () => {
  it('names the hosts its CLI must reach, and none for builtin', () => {
    expect(DRIVER_CAPABILITIES['claude-code'].providerHosts).toContain('api.anthropic.com');
    expect(DRIVER_CAPABILITIES.codex.providerHosts).toContain('api.openai.com');
    expect(DRIVER_CAPABILITIES['cursor-agent'].providerHosts.length).toBeGreaterThan(0);
    expect(DRIVER_CAPABILITIES.builtin.providerHosts).toEqual([]);
  });

  it("points a CLI at the run's own state directory, never the user's, when given one", async () => {
    const stateHome = fs.mkdtempSync(path.join(dir, 'state-'));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/the/users/own/claude';
    try {
      const log = path.join(logs, `log-${Math.random().toString(36).slice(2)}`);
      await collect(
        claudeCode({ bin: fakeClaude }).run({
          prompt: 'x',
          cwd: workdir(),
          stateHome,
          env: { FAKE_LOG: log },
        })
      );
      const env = fs.readFileSync(`${log}.env`, 'utf8');
      expect(env).toContain(`HOME=${stateHome}\n`);
      expect(env).toContain(`CLAUDE_CONFIG_DIR=${path.join(stateHome, '.claude')}\n`);
      expect(env).not.toContain('/the/users/own/claude');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

describe.skipIf(!isMac)("the builtin agent's file tools under seatbelt (macOS)", () => {
  const ctxFor = (cwd: string) => ({
    cwd,
    signal: new AbortController().signal,
    deadline: Date.now() + 120_000,
    sandbox: { profile: 'seatbelt' as const, network: 'none' as const },
    env: { PATH: process.env.PATH ?? '' },
  });
  const tool = (name: string) => BUILTIN_TOOLS.find((t) => t.definition.name === name)!;

  it('reads, lists, writes and edits through the sandbox', async () => {
    const cwd = fs.realpathSync.native(workdir());
    const ctx = ctxFor(cwd);
    expect(
      await tool('write_file').run({ path: 'src/a.ts', content: 'export const a = 1;\n' }, ctx)
    ).toMatchObject({
      isError: false,
    });
    expect(
      await tool('edit_file').run({ path: 'src/a.ts', old_text: '= 1', new_text: '= 2' }, ctx)
    ).toMatchObject({ isError: false });
    expect((await tool('read_file').run({ path: 'src/a.ts' }, ctx)).output).toContain(
      'export const a = 2;'
    );
    expect((await tool('list_files').run({ depth: 2 }, ctx)).output).toBe('src/\nsrc/a.ts');
    await expect(tool('read_file').run({ path: '../x' }, ctx)).rejects.toThrow(/outside/);
  });

  it('cannot write outside the worktree through a link, whatever the gateway checked', async () => {
    const cwd = fs.realpathSync.native(workdir());
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-out-')));
    fs.symlinkSync(outside, path.join(cwd, 'd'));
    const r = await tool('write_file')
      .run({ path: 'd/planted.txt', content: 'x' }, ctxFor(cwd))
      .catch((e: Error) => ({ output: e.message, isError: true }));
    expect(r.isError).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('lands no write outside while another process swaps a directory on the path for a link', async () => {
    const cwd = fs.realpathSync.native(workdir());
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-out-')));
    fs.mkdirSync(path.join(cwd, 'd'));
    // The reviewer's race: d is renamed away and a link to outside put in its place, over and over.
    const racer = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');process.chdir(${JSON.stringify(cwd)});const end=Date.now()+20000;
         while(Date.now()<end){try{fs.renameSync('d','dold');fs.symlinkSync(${JSON.stringify(outside)},'d');fs.unlinkSync('d');fs.renameSync('dold','d')}catch{}}`,
      ],
      { stdio: 'ignore' }
    );
    try {
      const ctx = ctxFor(cwd);
      for (let i = 0; i < 60; i++) {
        await tool('write_file')
          .run({ path: `d/f${i}`, content: 'x' }, ctx)
          .catch(() => undefined);
      }
    } finally {
      racer.kill('SIGKILL');
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 60_000);
});
