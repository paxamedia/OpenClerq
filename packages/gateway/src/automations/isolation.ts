/**
 * What a run's agent and gates are allowed to touch, from the spec's
 * `sandbox` block: the sandbox settings `exec` gets for each.
 *
 * `native` (the default) is no isolation at all. Under `seatbelt` and
 * `container` the profile is the same for the agent, the builtin agent's
 * commands and the gates, except that only an agent CLI also reaches its
 * model provider and writes where it keeps its sign-in:
 *
 *   writes      the run's worktree; the worktree's own index in the git
 *               directory; (agent CLI, seatbelt) its sign-in and state
 *   read-only   the repository's git directory (history, config, hooks), and
 *               the pointer files that tell git where that directory is
 *   reads       seatbelt: the whole disk except known credential stores and
 *               OpenClerq's own state; container: only what is mounted
 *   network     the spec's hosts (agent CLI: plus its provider's), through
 *               an egress proxy; `all` turns the limit off
 *
 * The git directory is read-only because the gateway's own git commands run
 * outside the sandbox after the agent: a hook, a config entry (core.fsmonitor,
 * a filter) or a rewritten `.git` pointer written by the agent would run code
 * there with the user's full access. So inside a profile the agent can read
 * history, diff and stage, but not commit; the gateway commits its changes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DRIVER_CAPABILITIES,
  agentStatePaths,
  type DriverId,
  type SandboxOptions,
} from '@clerq/drivers';
import { resolveRuntime } from '@clerq/sandbox';
import type { GitDirs } from '@clerq/workspaces';
import type { AutomationSpec } from './spec.js';

/**
 * Places in a home directory that hold credentials, or OpenClerq's own state,
 * which no profile lets a run read. Every agent CLI's sign-in is among them;
 * the run's own driver gets its own back (`agentStatePaths`).
 */
export function credentialPaths(home = os.homedir()): string[] {
  const at = (...p: string[]) => path.join(home, ...p);
  return [
    at('.clerq'),
    at('.ssh'),
    at('.gnupg'),
    at('.aws'),
    at('.azure'),
    at('.config', 'gcloud'),
    at('.kube'),
    at('.docker'),
    at('.config', 'gh'),
    at('.config', 'glab-cli'),
    at('.git-credentials'),
    at('.netrc'),
    at('.npmrc'),
    at('.yarnrc.yml'),
    at('.pypirc'),
    at('.cargo', 'credentials.toml'),
    at('.gem', 'credentials'),
    at('.terraform.d', 'credentials.tfrc.json'),
    at('.password-store'),
    at('Library', 'Keychains'),
    at('Library', 'Cookies'),
    at('Library', 'Application Support', 'Google', 'Chrome'),
    at('Library', 'Application Support', 'Firefox'),
    at('Library', 'Safari'),
    at('.claude'),
    at('.claude.json'),
    at('.codex'),
    at('.cursor'),
    at('.config', 'cursor'),
    at('Library', 'Caches', 'claude-cli-nodejs'),
  ];
}

export interface RunIsolation {
  /** For the agent process (a CLI), or the builtin agent's commands. */
  agent(driver: DriverId): SandboxOptions;
  /** For the gates. */
  gates: SandboxOptions;
  /** One line for the run's record: what the profile does. */
  note: string;
  /**
   * Make what the profile needs to exist before anything runs: the agent CLI's
   * writable state directories (seatbelt pins each writable directory, so it
   * cannot be created from inside), and an empty `config.worktree` in the
   * worktree's git entry (container: mounted read-only only if it exists).
   */
  prepare(): void;
}

/** The network a command gets: the spec's hosts, plus `extra`, or none. */
function networkFor(spec: AutomationSpec, extra: string[]): SandboxOptions['network'] {
  if (spec.sandbox.network === 'all') return 'all';
  const hosts = [...new Set([...(spec.sandbox.network ?? []), ...extra])];
  return hosts.length > 0 ? hosts : 'none';
}

/** The sandbox settings for one run's agent and gates. */
export function isolationFor(
  spec: AutomationSpec,
  dirs: GitDirs,
  options: { runId: string; home?: string; env?: NodeJS.ProcessEnv } = { runId: 'run' }
): RunIsolation {
  const profile = spec.sandbox.profile;
  if (profile === 'native') {
    return {
      agent: () => ({ profile: 'native' }),
      gates: { profile: 'native' },
      note:
        'Unisolated: the agent and the gates run with your account’s access to files and the ' +
        'network (profile native, the default). Set sandbox.profile to seatbelt or container to limit them.',
      prepare: () => undefined,
    };
  }

  const home = options.home ?? os.homedir();
  const shared: SandboxOptions = {
    profile,
    // The history is readable, the worktree's own index writable, and nothing
    // the gateway's git later trusts can be changed from inside.
    readOnly: [dirs.commonDir],
    allowWrite: [dirs.adminDir],
    protect: [
      dirs.gitFile,
      path.join(dirs.adminDir, 'commondir'),
      path.join(dirs.adminDir, 'gitdir'),
      path.join(dirs.adminDir, 'HEAD'),
      path.join(dirs.adminDir, 'config.worktree'),
    ],
    ...(profile === 'seatbelt' ? { denyRead: credentialPaths(home) } : {}),
    ...(profile === 'container'
      ? {
          image: spec.sandbox.image,
          containerName: `clerq-${options.runId}`,
          labels: { 'clerq.run': options.runId },
        }
      : {}),
  };

  const gates: SandboxOptions = { ...shared, network: networkFor(spec, []) };
  const agent = (driver: DriverId): SandboxOptions => {
    const caps = DRIVER_CAPABILITIES[driver];
    // In a container the CLI keeps its state in the container's own /tmp.
    const state =
      profile === 'seatbelt'
        ? agentStatePaths(driver, home, options.env)
        : { readDirs: [], writeDirs: [], writeFiles: [] };
    return {
      ...shared,
      // Its state directories readable; only the listed parts writable.
      readOnly: [...(shared.readOnly ?? []), ...state.readDirs],
      allowWrite: [...(shared.allowWrite ?? []), ...state.writeDirs],
      ...(state.writeFiles.length > 0 ? { allowWritePrefix: state.writeFiles } : {}),
      network: networkFor(spec, caps.providerHosts),
    };
  };
  const prepare = () => {
    if (profile === 'seatbelt') {
      for (const dir of agentStatePaths(spec.agent.driver, home, options.env).writeDirs) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
    if (profile === 'container') {
      // An empty one changes nothing: git reads it only with extensions.worktreeConfig.
      const file = path.join(dirs.adminDir, 'config.worktree');
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    }
  };

  const hosts =
    spec.sandbox.network === 'all'
      ? 'any host'
      : spec.sandbox.network?.length
        ? spec.sandbox.network.join(', ')
        : 'no host';
  return {
    agent,
    gates,
    prepare,
    note:
      `Isolated (profile ${profile}): writes only in the worktree, ` +
      `network to ${hosts}${spec.sandbox.network === 'all' ? '' : ' (and the agent CLI’s model provider)'}` +
      (profile === 'container' ? `, in image ${spec.sandbox.image}.` : '.'),
  };
}

/**
 * Why the spec's profile cannot run on this machine, or undefined. Checked
 * before a run does any work, and by the spec preview.
 */
export function profileProblem(spec: AutomationSpec): string | undefined {
  if (spec.sandbox.profile === 'seatbelt' && process.platform !== 'darwin') {
    return 'The seatbelt profile needs macOS (sandbox-exec). Use the container profile on this machine.';
  }
  if (spec.sandbox.profile === 'container' && !resolveRuntime()) {
    return process.env.CLERQ_CONTAINER_RUNTIME
      ? `The container profile was told to use ${process.env.CLERQ_CONTAINER_RUNTIME} (CLERQ_CONTAINER_RUNTIME), which was not found.`
      : 'The container profile needs docker or podman on PATH, and neither was found.';
  }
  return undefined;
}
