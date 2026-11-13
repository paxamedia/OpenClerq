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
 *              to the workspace, network denied unless explicitly allowed, and
 *              an egress allowlist enforced by forcing traffic through a local
 *              proxy. Apple has deprecated the tool but it still functions and
 *              is the only zero-dependency isolation available on macOS.
 *
 *   container  Docker or Podman: separate filesystem, PID and network
 *              namespaces, with memory, CPU and process caps enforced by the
 *              kernel rather than by us. An egress allowlist is enforced per
 *              host by a proxy container on an internal network.
 *
 * Every profile enforces a wall-clock timeout by killing the process group, and
 * redacts secret values from captured output.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAllowlist,
  startEgressProxy,
  type DeniedAttempt,
  type EgressProxy,
} from './egress.js';
import {
  buildContainerArgs,
  containerName,
  removeContainer,
  resolveRuntime,
  runtimeCall,
  startEgressSidecar,
  type EgressSidecar,
} from './container.js';
import { SandboxError } from './errors.js';
export { resolveWithinRoot, PathContainmentError } from './paths.js';
export { SandboxError } from './errors.js';
export {
  buildContainerArgs,
  containerName,
  removeContainer,
  resolveRuntime,
  parseEgressLog,
  EGRESS_SIDECAR_SCRIPT,
  DEFAULT_EGRESS_IMAGE,
  EGRESS_PORT,
} from './container.js';

export {
  startEgressProxy,
  parseAllowlist,
  isAllowed,
  EgressError,
  type EgressProxy,
  type EgressRule,
  type DeniedAttempt,
} from './egress.js';

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
  /** The working directory is read-only as well (seatbelt, container). */
  readOnlyCwd?: boolean;
  /** Additional writable paths. Use sparingly. */
  allowWrite?: string[];
  /**
   * Seatbelt: files the command may create or write whose path starts with one
   * of these, such as a config file an agent CLI rewrites through a temporary
   * sibling (`~/.claude.json`, `~/.claude.json.tmp.123`). Ignored elsewhere.
   */
  allowWritePrefix?: string[];
  /**
   * Paths the command may read. Under container, the only host paths it sees
   * besides the working directory and `allowWrite`, mounted read-only at the
   * same path. Under seatbelt they are readable even inside `denyRead`.
   */
  readOnly?: string[];
  /**
   * Paths inside a writable one that must stay read-only: a file or a
   * directory. Seatbelt denies writing them; container mounts each that
   * exists read-only over the writable mount.
   */
  protect?: string[];
  /**
   * Seatbelt: paths the command may neither read nor write (credential
   * stores, the gateway's own state), except what `cwd`, `allowWrite` and
   * `readOnly` name below them. The container profile sees nothing it is not
   * given, so it ignores this.
   */
  denyRead?: string[];
  /**
   * Egress.
   *
   *   'none'   No network at all. The default, and the main defence against a
   *            prompt-injected agent exfiltrating a repository.
   *   'all'    Unrestricted. Deliberate, and warned about in the result.
   *   string[] Host allowlist, enforced by an egress proxy the sandbox starts.
   *            Entries are "example.com", "example.com:443" or "*.example.com".
   *
   * An allowlist is refused by any profile that cannot enforce it, rather than
   * quietly granting full network access. See `startEgressProxy` and
   * SECURITY.md for what seatbelt can and cannot guarantee.
   */
  network?: 'none' | 'all' | string[];
  limits?: SandboxLimits;
  /**
   * Plain environment variables, on top of a minimal base: PATH, HOME, the
   * user and locale, and the variables Windows needs to start a process.
   */
  env?: Record<string, string>;
  /**
   * Pass the caller's whole environment through. Off by default: the gateway's
   * environment holds provider keys and its own token, and a sandboxed command
   * should receive only what it is given.
   */
  inheritEnv?: boolean;
  /**
   * Secrets injected as environment variables and redacted from captured
   * output. Never logged, never returned.
   */
  secrets?: Record<string, string>;
  /** Container image. Container profile only. */
  image?: string;
  /** Container: a prefix for the container's name; a random suffix is added. */
  containerName?: string;
  /** Container: labels on the container, its egress proxy and network. */
  labels?: Record<string, string>;
  /**
   * Container: `docker`, `podman`, or a path to one. Default: the
   * CLERQ_CONTAINER_RUNTIME variable, then docker, then podman on PATH.
   */
  runtime?: string;
  /** Container: the egress proxy's image, which needs `node`. Default node:24-alpine. */
  egressImage?: string;
}

/** The container a command ran in, by name: what stops it is the runtime, not a signal. */
export interface ContainerRef {
  /** The runtime CLI, as a path. */
  runtime: string;
  name: string;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the wall-clock limit killed the process. */
  timedOut: boolean;
  /** True when the caller's signal killed the process. */
  cancelled: boolean;
  /** True when either stream hit maxOutputBytes and was cut short. */
  truncated: boolean;
  durationMs: number;
  profile: SandboxProfile;
  /** Warnings about weakened isolation, safe to surface in a UI. */
  warnings: string[];
  /** Present when an allowlist was in force: what the run reached, and what it tried to. */
  egress?: { allowed: number; denied: DeniedAttempt[] };
}

export interface ExecOptions {
  /** Kills the process group when it aborts. The result then has `cancelled: true`. */
  signal?: AbortSignal;
  /**
   * Each complete output line as it arrives, redacted. Lines are delivered even
   * after the captured output reaches maxOutputBytes, so a long-running agent
   * can be followed to the end; a single line is cut at maxLineBytes.
   */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Called once, as soon as the process exists. `pid` leads its own process
   * group, so `pgid` is the same number; a caller that records them can find
   * and stop the group later, even if this process has died. Errors thrown
   * here are swallowed: bookkeeping must not stop the command it describes.
   *
   * Under the container profile the process is the runtime CLI, and
   * `container` names the container: stopping the CLI does not stop it, so a
   * caller that cleans up later removes it by name (`removeContainer`).
   */
  onSpawn?: (process: { pid: number; pgid: number; container?: ContainerRef }) => void;
  /**
   * When the process exits, stop whatever it left running in its process
   * group: a dev server an agent started, a daemon a gate forked. They are
   * asked to stop, then killed after a short grace. Off by default, because a
   * command run on a user's behalf may be meant to leave something running.
   * Under the container profile the container is removed whatever this says.
   */
  reapGroup?: boolean;
}

/** Variables a process needs to start and find its tools, and nothing else. */
const BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  // Windows
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'ProgramData',
  'ProgramFiles',
];

function baseEnv(inherit: boolean | undefined): Record<string, string> {
  if (inherit) return { ...(process.env as Record<string, string>) };
  const out: Record<string, string> = {};
  for (const name of BASE_ENV) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const DEFAULTS = {
  wallMs: 120_000,
  maxOutputBytes: 1_048_576,
  maxLineBytes: 4_194_304,
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

/**
 * Resolve symlinks where possible. A path that does not exist yet is resolved
 * through its nearest existing ancestor, so a rule for `~/.aws` written before
 * that directory exists still matches it once it does.
 */
function canonical(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...rest);
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return abs;
      rest.unshift(path.basename(at));
      at = parent;
    }
  }
}

/** A path as an SBPL string. Quotes and line breaks have no place in one. */
function sbplPath(p: string): string {
  if (/["\n\r\\]/.test(p)) {
    throw new SandboxError(
      `Cannot write a sandbox rule for a path with a quote or line break: ${p}`
    );
  }
  return JSON.stringify(p);
}

/** A path prefix as an SBPL regular expression, matching it and anything longer. */
function sbplPrefix(p: string): string {
  sbplPath(p);
  return `#"^${p.replace(/[.*+?^${}()|[\]]/g, '\\$&')}"`;
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
 * interpreters and libraries) except `denyRead`, writing only inside the
 * workspace and `allowWrite`, and process execution. Network is denied
 * unless explicitly requested. Rules are matched last to first, so a later
 * rule carves an exception out of an earlier one.
 */
export function buildSeatbeltProfile(
  spec: SandboxSpec,
  opts: { egressProxyPort?: number } = {}
): string {
  // Canonical paths only. On macOS os.tmpdir() is /var/folders/..., a symlink
  // to /private/var/folders/..., and a subpath rule built from the unresolved
  // path silently fails to match the write it was meant to permit.
  //
  // The shared temp directory is deliberately NOT writable: granting it would
  // let a sandboxed command write into every other process's temp files. exec()
  // instead creates a private temp directory per run and passes it in
  // allowWrite, with TMPDIR pointed at it.
  const writable = [...(spec.readOnlyCwd ? [] : [spec.cwd]), ...(spec.allowWrite ?? [])].map(
    canonical
  );
  const readable = [spec.cwd, ...(spec.allowWrite ?? []), ...(spec.readOnly ?? [])].map(canonical);
  const denied = (spec.denyRead ?? []).map(canonical);
  const protectedPaths = (spec.protect ?? []).map(canonical);

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
    // Except what must stay unread: credentials, the gateway's own state.
    ...denied.map((d) => `(deny file-read* file-write* (subpath ${sbplPath(d)}))`),
    // What the command is given stays readable, wherever it lives.
    ...(denied.length > 0
      ? readable.map((r) => `(allow file-read* (subpath ${sbplPath(r)}))`)
      : []),
    // Writes: workspace and temp only.
    ...writable.map((w) => `(allow file-write* (subpath ${sbplPath(w)}))`),
    ...(spec.allowWritePrefix ?? [])
      .map(canonical)
      .map((p) => `(allow file-write* (regex ${sbplPrefix(p)}))`),
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
    // Last, so nothing above re-opens them.
    ...protectedPaths.map((p) => `(deny file-write* (subpath ${sbplPath(p)}))`),
  ];

  if (spec.network === 'all') {
    lines.push('(allow network*)');
  } else if (opts.egressProxyPort !== undefined) {
    // Everything stays denied except the proxy's port, so the only way out is
    // through the allowlist. Note the limit of the tool: SBPL accepts only "*"
    // or "localhost" as the host in a network address — a numeric address is a
    // parse error — and the rule is in practice scoped by port, not by address.
    // So this closes every port but one; a process that deliberately connects
    // to an outside host on *that* port is not stopped. Per-host enforcement
    // needs the container profile. SECURITY.md records this.
    lines.push(`(allow network-outbound (remote ip "localhost:${opts.egressProxyPort}"))`);
  } else {
    lines.push('(deny network*)');
  }

  return lines.join('\n');
}

/** Whether any process is left in the group. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, and is not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The grace a group gets between being asked to stop and being killed. */
const REAP_GRACE_MS = 1_000;

/**
 * Stop what is left of a process group whose leader has exited: ask, wait a
 * short while, then kill. Does nothing when the group is empty, which is the
 * usual case.
 */
async function reapGroup(pgid: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return;
  }
  for (const end = Date.now() + REAP_GRACE_MS; Date.now() < end; ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!groupAlive(pgid)) return;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* gone in the meantime */
  }
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
  args: string[] = [],
  options: ExecOptions = {}
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

  if (options.signal?.aborted) {
    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: true,
      truncated: false,
      durationMs: 0,
      profile: spec.profile,
      warnings,
    };
  }

  let file = command;
  let argv = args;
  let cleanup: (() => void) | undefined;
  let privateTmp: string | undefined;
  /** The container, when the profile runs one: removed by name when the command ends. */
  let container: ContainerRef | undefined;
  let sidecar: EgressSidecar | undefined;

  // An empty allowlist allows nothing, which is what 'none' already means.
  const allowlist =
    Array.isArray(spec.network) && spec.network.length > 0 ? spec.network : undefined;
  let proxy: EgressProxy | undefined;
  let proxyEnv: Record<string, string> = {};

  if (allowlist && spec.profile === 'native') {
    throw new SandboxError(
      'The "native" profile cannot enforce an egress allowlist. ' +
        "Use network: 'none', or network: 'all' if unrestricted access is intended, " +
        'or the seatbelt or container profile, which enforce one.'
    );
  }

  try {
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

      if (allowlist) {
        proxy = await startEgressProxy(allowlist);
        const url = proxy.url;
        // Set both cases: tooling is split on which it reads.
        proxyEnv = {
          HTTP_PROXY: url,
          HTTPS_PROXY: url,
          ALL_PROXY: url,
          http_proxy: url,
          https_proxy: url,
          all_proxy: url,
          NO_PROXY: '',
          no_proxy: '',
        };
        warnings.push(
          'Egress is restricted to the allowlist through a local proxy. macOS can only filter by ' +
            'port, so a command that connects to an outside host on the proxy port is not stopped; ' +
            'and a client that ignores the proxy variables reaches nothing at all.'
        );
      }

      const profileText = buildSeatbeltProfile(
        {
          ...spec,
          allowWrite: [...(spec.allowWrite ?? []), privateTmp],
        },
        { egressProxyPort: proxy?.port }
      );
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
    } else if (spec.profile === 'container') {
      const runtime = resolveRuntime(spec.runtime);
      if (!runtime) {
        throw new SandboxError(
          spec.runtime || process.env.CLERQ_CONTAINER_RUNTIME
            ? `The "container" profile was told to use ${spec.runtime ?? process.env.CLERQ_CONTAINER_RUNTIME}, which was not found.`
            : 'The "container" profile needs docker or podman on PATH, and neither was found.'
        );
      }
      container = { runtime, name: containerName(spec.containerName) };
      if (allowlist) {
        sidecar = await startEgressSidecar(runtime, container.name, parseAllowlist(allowlist), {
          image: spec.egressImage,
          labels: spec.labels,
        });
        proxyEnv = sidecar.proxyEnv;
        warnings.push(
          'Egress is restricted to the allowlist by a proxy container: the command is on an ' +
            'internal network whose only way out is the proxy. A client that ignores the proxy ' +
            'variables reaches nothing at all.'
        );
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
      file = runtime;
      argv = buildContainerArgs(spec, command, args, {
        name: container.name,
        network: sidecar?.network,
        proxyEnv,
        ...(uid !== undefined && gid !== undefined ? { user: `${uid}:${gid}` } : {}),
      });
    } else {
      throw new SandboxError(`Unknown sandbox profile "${String(spec.profile)}".`);
    }
  } catch (e) {
    // Nothing of a sandbox that could not be set up is left behind.
    if (privateTmp) fs.rmSync(privateTmp, { recursive: true, force: true });
    cleanup?.();
    await proxy?.close();
    if (container) await removeContainer(container.runtime, container.name);
    throw e;
  }

  const started = Date.now();

  /**
   * Remove what the profile created for this command: the container (which
   * outlives a killed runtime CLI), its egress proxy and network, the
   * seatbelt profile and private temp directory. Resolves with what the
   * container's egress proxy recorded. Never rejects.
   */
  let egressSeen: ExecResult['egress'];
  const teardown = async (): Promise<void> => {
    cleanup?.();
    if (sidecar) {
      try {
        egressSeen = await sidecar.finish();
      } catch {
        /* nothing recorded */
      }
    }
    if (container) await removeContainer(container.runtime, container.name);
  };

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(file, argv, {
        cwd: spec.cwd,
        env: {
          ...baseEnv(spec.inheritEnv),
          ...(privateTmp ? { TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp } : {}),
          ...proxyEnv,
          ...spec.env,
          ...spec.secrets,
        },
        // Own process group, so the timeout can kill descendants too rather
        // than orphaning them.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      void teardown().then(() =>
        reject(new SandboxError(`Could not start sandbox: ${e instanceof Error ? e.message : e}`))
      );
      return;
    }

    if (child.pid !== undefined) {
      try {
        options.onSpawn?.({
          pid: child.pid,
          pgid: child.pid,
          ...(container ? { container } : {}),
        });
      } catch {
        /* bookkeeping must not stop the command */
      }
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    // Partial lines held until their newline arrives, per stream.
    const pending = { out: '', err: '' };
    const onLine = options.onLine;
    const emitLines = (into: 'out' | 'err', text: string, flush: boolean) => {
      if (!onLine) return;
      let buffer = pending[into] + text;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        onLine(redact(line, spec.secrets), into === 'out' ? 'stdout' : 'stderr');
      }
      if (buffer.length > DEFAULTS.maxLineBytes) {
        // One line this long is not something a caller can use whole.
        onLine(
          redact(buffer.slice(0, DEFAULTS.maxLineBytes), spec.secrets),
          into === 'out' ? 'stdout' : 'stderr'
        );
        buffer = '';
        truncated = true;
      }
      if (flush && buffer) {
        onLine(redact(buffer, spec.secrets), into === 'out' ? 'stdout' : 'stderr');
        buffer = '';
      }
      pending[into] = buffer;
    };

    const capture = (chunk: Buffer, into: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      emitLines(into, text, false);
      const current = into === 'out' ? stdout : stderr;
      if (current.length >= maxBytes) {
        truncated = true;
        return;
      }
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

    const stop = () => {
      // The container is not in the process group: the runtime stops it.
      if (container) void runtimeCall(container.runtime, ['kill', container.name]);
      killTree('SIGTERM');
      // Escalate if it ignores the polite request.
      setTimeout(() => killTree('SIGKILL'), 2000).unref?.();
    };

    // Children that outlive their parent keep its output pipes open, and the
    // process is not "closed" until they are shut, so this runs on exit.
    if (options.reapGroup) {
      child.once('exit', () => {
        void reapGroup(child.pid as number);
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, wallMs);

    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      emitLines('out', '', true);
      emitLines('err', '', true);
      // Before resolving, so nothing of the command is left when the caller
      // goes on to remove its worktree.
      await teardown();
      const egress = proxy
        ? { allowed: proxy.allowed, denied: [...proxy.denied] }
        : (egressSeen ?? undefined);
      // The proxy outlives nothing: the run is over, so its only route out closes.
      void proxy?.close();
      resolve({
        code,
        signal,
        stdout: redact(stdout, spec.secrets),
        stderr: redact(stderr, spec.secrets),
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
        profile: spec.profile,
        warnings,
        egress,
      });
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void proxy?.close();
      void teardown().then(() =>
        reject(new SandboxError(`Sandbox failed to run "${file}": ${e.message}`))
      );
    });

    child.on('close', (code, signal) => void finish(code, signal));
  });
}

/** Which profiles can actually run here. Useful for UI and for choosing a default. */
export function availableProfiles(): SandboxProfile[] {
  const out: SandboxProfile[] = ['native'];
  if (process.platform === 'darwin') out.push('seatbelt');
  if (resolveRuntime()) out.push('container');
  return out;
}

/** Strongest profile available on this host. */
export function defaultProfile(): SandboxProfile {
  const available = availableProfiles();
  if (available.includes('container')) return 'container';
  if (available.includes('seatbelt')) return 'seatbelt';
  return 'native';
}
