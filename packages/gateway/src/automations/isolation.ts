/**
 * What a run's agent and gates are allowed to touch, from the spec's
 * `sandbox` block: the sandbox settings `exec` gets for each.
 *
 * `native` (the default) is no isolation at all. Under `seatbelt` and
 * `container` the profile is the same for the agent, the builtin agent's
 * commands and file tools, and the gates, except that only an agent CLI also
 * reaches its model provider:
 *
 *   writes      the run's worktree; the worktree's own index in the git
 *               directory; (agent CLI) a state home of the run's own, never
 *               the user's ~/.claude, ~/.codex or ~/.cursor
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
import { DRIVER_CAPABILITIES, type DriverId, type SandboxOptions } from '@clerq/drivers';
import { resolveRuntime, stopStragglers, type Straggler } from '@clerq/sandbox';
import type { GitDirs } from '@clerq/workspaces';
import type { AutomationSpec } from './spec.js';

/**
 * Places in a home directory that hold credentials, or OpenClerq's own state,
 * which no profile lets a run read. Every agent CLI's state is among them: a
 * run's CLI works on a state home of the run's own (`RunIsolation.stateHome`).
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
   * Under seatbelt: the directory an agent CLI keeps its state in for this
   * run (`DriverRunInput.stateHome`), in place of the user's. Under container
   * the CLI's HOME is the container's own /tmp. Native: undefined.
   */
  stateHome?: string;
  /**
   * Stop what the run's commands left running: processes holding the run's
   * tag file, or anything under `dirs` or the state home. `problem` says what
   * could not be stopped (the run must end), `warning` what could not be
   * checked.
   */
  quiesce(dirs: string[]): Promise<{ stopped: Straggler[]; problem?: string; warning?: string }>;
  /** Remove the run's state home and tag file. */
  cleanup(): void;
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
      // Native promises nothing: the agent can run anything as the user anyway.
      quiesce: async () => ({ stopped: [] }),
      cleanup: () => undefined,
    };
  }

  const home = options.home ?? os.homedir();
  // The run's own area, outside anything a sandbox may write: the tag file
  // every command holds open, and (seatbelt) the CLI's state home, which is
  // the one writable part of it.
  const area = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-run-area-'));
  fs.chmodSync(area, 0o700);
  const tagFile = path.join(area, 'run.tag');
  fs.writeFileSync(tagFile, '', { mode: 0o600 });
  const stateHome = profile === 'seatbelt' ? path.join(area, 'home') : undefined;
  if (stateHome) fs.mkdirSync(stateHome, { mode: 0o700 });
  if (profile === 'container') {
    // An empty one changes nothing (git reads it only with
    // extensions.worktreeConfig), and existing, it is mounted read-only.
    const file = path.join(dirs.adminDir, 'config.worktree');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
  }
  const shared: SandboxOptions = {
    profile,
    tagFile,
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
  const agent = (driver: DriverId): SandboxOptions => ({
    ...shared,
    // The CLI's state home of the run's (seatbelt; in a container, /tmp).
    allowWrite: [...(shared.allowWrite ?? []), ...(stateHome ? [stateHome] : [])],
    network: networkFor(spec, DRIVER_CAPABILITIES[driver].providerHosts),
  });
  const quiesce = async (watched: string[]) => {
    const r = await stopStragglers({
      tagFile,
      dirs: [...watched, ...(stateHome ? [stateHome] : [])],
    });
    if (r === null) {
      return {
        stopped: [],
        warning:
          'Could not run lsof to look for processes the run left behind; the commit does not depend on it.',
      };
    }
    return {
      stopped: r.stopped,
      ...(r.remaining.length > 0
        ? {
            problem: `Processes the run started would not stop: ${r.remaining
              .map((p) => `${p.pid} (${p.command || 'unknown'})`)
              .join(', ')
              .slice(0, 500)}.`,
          }
        : {}),
    };
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
    ...(stateHome ? { stateHome } : {}),
    quiesce,
    cleanup: () => fs.rmSync(area, { recursive: true, force: true }),
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
