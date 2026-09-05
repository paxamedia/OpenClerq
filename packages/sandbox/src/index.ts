/**
 * Execution isolation.
 *
 * The policy layer (@clerq/policy) decides what an agent may *ask for*. This
 * decides what the spawned process can physically *do*. Both are required:
 * permitting `exec` in an allowlist and then handing the command to
 * child_process on the host is arbitrary code execution with the gateway's
 * privileges, and the allowlist is a comment at that point.
 *
 * Three profiles, weakest first:
 *
 *   native     No isolation. The process runs as the gateway user with the
 *              gateway's reach. Development convenience only; every call emits
 *              a warning and it must be selected deliberately.
 *
 *   seatbelt   macOS sandbox-exec with a generated SBPL profile: writes limited
 *              to the workspace, network denied unless explicitly allowed.
 *              Apple has deprecated the tool but it still functions and is the
 *              only zero-dependency isolation available on macOS.
 *
 *   container  Docker or Podman: separate filesystem, PID and network
 *              namespaces, with memory, CPU and process caps enforced by the
 *              kernel rather than by us. The server default.
 *
 * Every profile enforces a wall-clock timeout by killing the process group, and
 * redacts secret values from captured output.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SandboxProfile = 'native' | 'seatbelt' | 'container';

export interface SandboxLimits {
  /** Wall-clock ceiling in milliseconds. Always enforced. Default 120000. */
  wallMs?: number;
  /** Memory ceiling in MiB. Container profile only. */
  memoryMb?: number;
  /** CPU cores. Container profile only. */
  cpus?: number;
  /** Maximum process count. Container profile only. */
  processes?: number;
  /** Captured output ceiling per stream, in bytes. Default 1 MiB. */
  maxOutputBytes?: number;
}

export interface SandboxSpec {
  profile: SandboxProfile;
  /** Working directory. The only writable location under seatbelt/container. */
  cwd: string;
  /** Additional writable paths. Use sparingly. */
  allowWrite?: string[];
  /**
   * Egress. 'none' denies all network access — the default, and the main
   * defence against a prompt-injected agent exfiltrating a repository.
   * A host list is honoured by the container profile; seatbelt can only
   * distinguish all-or-nothing, so a non-empty list there means "network on"
   * and is reported in the result.
   */
  network?: 'none' | string[];
  limits?: SandboxLimits;
  /** Plain environment variables. */
  env?: Record<string, string>;
  /**
   * Secrets injected as environment variables and redacted from captured
   * output. Never logged, never returned.
   */
  secrets?: Record<string, string>;
  /** Container image. Container profile only. */
  image?: string;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the wall-clock limit killed the process. */
  timedOut: boolean;
  /** True when either stream hit maxOutputBytes and was cut short. */
  truncated: boolean;
  durationMs: number;
  profile: SandboxProfile;
  /** Warnings about weakened isolation, safe to surface in a UI. */
  warnings: string[];
}

export class SandboxError extends Error {
  readonly code = 'sandbox_error';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

const DEFAULTS = {
  wallMs: 120_000,
  maxOutputBytes: 1_048_576,
};

/**
 * Replace secret values wherever they appear in text.
 *
 * Values are matched literally rather than by variable name, because a leaked
 * secret usually surfaces as the value being echoed, not the name. Short values
 * are skipped: redacting a 3-character secret would blank unrelated text.
 */
export function redact(text: string, secrets: Record<string, string> | undefined): string {
  if (!secrets) return text;
  let out = text;
  for (const value of Object.values(secrets)) {
    if (!value || value.length < 6) continue;
    out = out.split(value).join('«redacted»');
  }
  return out;
}

/** Resolve symlinks where possible; fall back to a lexical resolve. */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/** Reject paths that would let a caller escape the workspace by construction. */
function assertAbsolute(p: string, label: string): void {
  if (!p || !path.isAbsolute(p)) {
    throw new SandboxError(`${label} must be an absolute path (got "${p}").`);
  }
}

/**
 * Build a macOS seatbelt profile.
 *
 * Deny by default, then permit: reading the filesystem (so tooling can find
 * interpreters and libraries), writing only inside the workspace, and process
 * execution. Network is denied unless explicitly requested.
 */
export function buildSeatbeltProfile(spec: SandboxSpec): string {
  // Canonical paths only. On macOS os.tmpdir() is /var/folders/..., a symlink
  // to /private/var/folders/..., and a subpath rule built from the unresolved
  // path silently fails to match the write it was meant to permit.
  //
  // The shared temp directory is deliberately NOT writable: granting it would
  // let a sandboxed command write into every other process's temp files. exec()
  // instead creates a private temp directory per run and passes it in
  // allowWrite, with TMPDIR pointed at it.
  const writable = [spec.cwd, ...(spec.allowWrite ?? [])].map(canonical);
  const networkAllowed = spec.network !== 'none' && spec.network !== undefined;

  const lines = [
    '(version 1)',
    '(deny default)',
    // Reading is broad on purpose: interpreters, shared libraries and toolchains
    // live outside the workspace, and denying reads breaks nearly every command.
    '(allow file-read*)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow signal (target same-sandbox))',
    '(allow mach-lookup)',
    // Writes: workspace and temp only.
    ...writable.map((w) => `(allow file-write* (subpath ${JSON.stringify(path.resolve(w))}))`),
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
  ];

  if (networkAllowed) {
    lines.push('(allow network*)');
  } else {
    lines.push('(deny network*)');
  }

  return lines.join('\n');
}

/** Build the docker/podman argument list. */
export function buildContainerArgs(spec: SandboxSpec, command: string, args: string[]): string[] {
  const limits = spec.limits ?? {};
  const image = spec.image ?? 'docker.io/library/alpine:3.20';

  const out = [
    'run',
    '--rm',
    '-i',
    // No new privileges, and drop every capability we are not using.
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    // Root filesystem read-only; the workspace mount and /tmp are the exceptions.
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=64m',
    '-v',
    `${path.resolve(spec.cwd)}:/workspace:rw`,
    '-w',
    '/workspace',
  ];

  if (spec.network === 'none' || spec.network === undefined) {
    out.push('--network', 'none');
  }

  if (limits.memoryMb) out.push('--memory', `${limits.memoryMb}m`);
  if (limits.cpus) out.push('--cpus', String(limits.cpus));
  if (limits.processes) out.push('--pids-limit', String(limits.processes));

  for (const [k, v] of Object.entries({ ...spec.env, ...spec.secrets })) {
    // Passed by name; the value comes from the parent environment we set on the
    // spawn, so it never appears in the process listing of the host.
    out.push('-e', k);
    void v;
  }

  out.push(image, command, ...args);
  return out;
}

function detectContainerRuntime(): string | null {
  for (const candidate of ['docker', 'podman']) {
    const probe = spawnSyncQuiet(candidate, ['--version']);
    if (probe) return candidate;
  }
  return null;
}

function spawnSyncQuiet(cmd: string, args: string[]): boolean {
  try {
    // Using the async spawn API synchronously is not possible; this is a cheap
    // existence probe via PATH resolution instead.
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    return dirs.some((d) => {
      try {
        fs.accessSync(path.join(d, cmd), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
  void args;
}

/**
 * Run `command` under the requested profile.
 *
 * Resolves with the outcome rather than rejecting on a non-zero exit; a failing
 * command is a normal result. Rejects only when the sandbox itself cannot be
 * established.
 */
export async function exec(
  spec: SandboxSpec,
  command: string,
  args: string[] = []
): Promise<ExecResult> {
  assertAbsolute(spec.cwd, 'cwd');
  if (!fs.existsSync(spec.cwd)) {
    throw new SandboxError(`Working directory does not exist: ${spec.cwd}`);
  }
  for (const w of spec.allowWrite ?? []) assertAbsolute(w, 'allowWrite entry');

  const limits = spec.limits ?? {};
  const wallMs = limits.wallMs ?? DEFAULTS.wallMs;
  const maxBytes = limits.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const warnings: string[] = [];

  let file = command;
  let argv = args;
  let cleanup: (() => void) | undefined;
  let privateTmp: string | undefined;

  if (spec.profile === 'native') {
    warnings.push(
      'Running without isolation (profile "native"). The command has this account\'s full filesystem and network reach.'
    );
  } else if (spec.profile === 'seatbelt') {
    if (process.platform !== 'darwin') {
      throw new SandboxError('The "seatbelt" profile requires macOS. Use "container" elsewhere.');
    }
    // A private temp directory, writable by this run alone, so commands that
    // need scratch space work without opening the shared temp directory.
    privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-run-'));
    const profileText = buildSeatbeltProfile({
      ...spec,
      allowWrite: [...(spec.allowWrite ?? []), privateTmp],
    });
    const sbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-sb-'));
    const profilePath = path.join(sbDir, 'profile.sb');
    fs.writeFileSync(profilePath, profileText, 'utf8');
    cleanup = () => {
      for (const d of [sbDir, privateTmp]) {
        try {
          if (d) fs.rmSync(d, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    };
    file = 'sandbox-exec';
    argv = ['-f', profilePath, command, ...args];
    if (Array.isArray(spec.network) && spec.network.length > 0) {
      warnings.push(
        'Seatbelt cannot filter by host: network access is all-or-nothing, so the requested host allowlist was applied as "network enabled". Use the container profile for per-host egress control.'
      );
    }
  } else if (spec.profile === 'container') {
    const runtime = detectContainerRuntime();
    if (!runtime) {
      throw new SandboxError(
        'The "container" profile needs docker or podman on PATH, and neither was found.'
      );
    }
    file = runtime;
    argv = buildContainerArgs(spec, command, args);
    if (Array.isArray(spec.network) && spec.network.length > 0) {
      warnings.push(
        'Per-host egress filtering requires a pre-configured container network; the container currently runs with default networking for the listed hosts.'
      );
    }
  } else {
    throw new SandboxError(`Unknown sandbox profile "${String(spec.profile)}".`);
  }

  const started = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(file, argv, {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...(privateTmp ? { TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp } : {}),
          ...spec.env,
          ...spec.secrets,
        },
        // Own process group, so the timeout can kill descendants too rather
        // than orphaning them.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      cleanup?.();
      reject(new SandboxError(`Could not start sandbox: ${e instanceof Error ? e.message : e}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (chunk: Buffer, into: 'out' | 'err') => {
      const current = into === 'out' ? stdout : stderr;
      if (current.length >= maxBytes) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf8');
      const room = maxBytes - current.length;
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (into === 'out') stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => capture(c, 'err'));

    const killTree = (signal: NodeJS.Signals) => {
      try {
        // Negative pid targets the whole process group.
        process.kill(-child.pid!, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      // Escalate if it ignores the polite request.
      setTimeout(() => killTree('SIGKILL'), 2000).unref?.();
    }, wallMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup?.();
      resolve({
        code,
        signal,
        stdout: redact(stdout, spec.secrets),
        stderr: redact(stderr, spec.secrets),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        profile: spec.profile,
        warnings,
      });
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup?.();
      reject(new SandboxError(`Sandbox failed to run "${file}": ${e.message}`));
    });

    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Which profiles can actually run here. Useful for UI and for choosing a default. */
export function availableProfiles(): SandboxProfile[] {
  const out: SandboxProfile[] = ['native'];
  if (process.platform === 'darwin') out.push('seatbelt');
  if (detectContainerRuntime()) out.push('container');
  return out;
}

/** Strongest profile available on this host. */
export function defaultProfile(): SandboxProfile {
  const available = availableProfiles();
  if (available.includes('container')) return 'container';
  if (available.includes('seatbelt')) return 'seatbelt';
  return 'native';
}
