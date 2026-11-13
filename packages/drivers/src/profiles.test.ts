/**
 * The CLI drivers under the seatbelt and container profiles. Seatbelt runs for
 * real on macOS (skipped elsewhere: `sandbox-exec` is macOS only). There is no
 * container runtime where these tests run, so `docker` is a script that
 * records what it was asked; what a real engine and a real CLI in an image do
 * is not exercised here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentStatePaths,
  buildCodexArgs,
  claudeCode,
  codex,
  cursorAgent,
  DRIVER_CAPABILITIES,
  DRIVER_IDS,
  type DriverEvent,
  type DriverRunInput,
} from './index.js';

const isMac = process.platform === 'darwin';
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

  it('lists only what each CLI may write; the rest of its state stays read-only', () => {
    const home = '/home/u';
    const claude = agentStatePaths('claude-code', home, {});
    expect(claude.readDirs).toEqual(['/home/u/.claude']);
    expect(claude.writeDirs).toEqual(
      expect.arrayContaining(['/home/u/.claude/todos', '/home/u/Library/Caches/claude-cli-nodejs'])
    );
    expect(claude.writeFiles).toEqual([
      '/home/u/.claude/.credentials.json',
      '/home/u/.claude.json',
    ]);
    // Nothing that carries code or instructions is writable.
    const writable = [...claude.writeDirs, ...claude.writeFiles].join(' ');
    for (const carrier of [
      'settings',
      'hooks',
      'commands',
      'agents',
      'plugins',
      'skills',
      'projects',
      'CLAUDE.md',
      'local',
    ]) {
      expect(writable).not.toContain(`/.claude/${carrier}`);
    }
    expect(agentStatePaths('claude-code', home, { CLAUDE_CONFIG_DIR: '/cfg' }).writeFiles).toEqual([
      '/cfg/.credentials.json',
      '/cfg/.claude.json',
    ]);
    const codex = agentStatePaths('codex', home, { CODEX_HOME: '/c' });
    expect(codex.readDirs).toEqual(['/c']);
    expect([...codex.writeDirs, ...codex.writeFiles].join(' ')).not.toMatch(
      /config\.toml|rules|skills|AGENTS/
    );
    const cursor = agentStatePaths('cursor-agent', home, {});
    expect([...cursor.writeDirs, ...cursor.writeFiles].join(' ')).not.toMatch(
      /extensions|hooks\.json|cli-config\.json|mcp\.json|rules/
    );
    for (const id of DRIVER_IDS) expect(agentStatePaths(id, home, {})).toBeTruthy();
    expect(agentStatePaths('builtin', home, {})).toEqual({
      readDirs: [],
      writeDirs: [],
      writeFiles: [],
    });
  });
});
