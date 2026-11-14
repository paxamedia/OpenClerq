/**
 * The container profile: the command runs in a Docker or Podman container.
 *
 * What the container sees of the host is what is mounted into it, each at the
 * same absolute path it has on the host (a git worktree's `.git` file names
 * its git directory by absolute path, so the paths must agree):
 *
 *   - the working directory, read-write (read-only when asked);
 *   - `allowWrite` paths read-write, `readOnly` paths read-only;
 *   - `protect` paths read-only, mounted over a writable one.
 *
 * The root filesystem is read-only, /tmp is a private tmpfs, every capability
 * is dropped, and the process runs as the host user so that what it writes in
 * the worktree belongs to that user.
 *
 * Every container gets a name, so it can be stopped by name: the pid the
 * caller sees is the runtime CLI's, and killing that does not stop the
 * container. `exec` removes the container when the command ends for any reason
 * (exit, timeout, cancel, a failure to start), and `removeContainer` lets a
 * gateway that restarts remove what a crashed one left.
 *
 * An egress allowlist is enforced by a second container, the egress proxy,
 * which sits on two networks: an internal one (no route out) shared with the
 * command, and the default one. The command's only way out is the proxy,
 * which allows the listed hosts and records the rest.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeniedAttempt, EgressRule } from './egress.js';
import { SandboxError } from './errors.js';

/** Default egress proxy image. It needs `node` and nothing else. */
export const DEFAULT_EGRESS_IMAGE = 'docker.io/library/node:24-alpine';
/** The port the egress proxy listens on inside its container. */
export const EGRESS_PORT = 3128;
/** How long starting the egress proxy may take, a first pull of its image included. */
const START_MS = 300_000;

/** Environment variables of the host that mean nothing inside a container. */
const HOST_ONLY_ENV = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
]);

/** What the container needs that the profile-neutral spec does not say. */
export interface ContainerPlan {
  /** Container name. */
  name: string;
  /** The network to join instead of none: the egress proxy's internal network. */
  network?: string;
  /** Proxy variables, passed by name. */
  proxyEnv?: Record<string, string>;
  /** `uid:gid` to run as. */
  user?: string;
}

export interface ContainerSpecLike {
  cwd: string;
  allowWrite?: string[];
  readOnly?: string[];
  protect?: string[];
  readOnlyCwd?: boolean;
  network?: 'none' | 'all' | string[];
  limits?: { memoryMb?: number; cpus?: number; processes?: number };
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  image?: string;
  labels?: Record<string, string>;
}

/** A container name: the prefix, made safe, and a random suffix. */
export function containerName(prefix = 'clerq'): string {
  const safe =
    prefix
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^[^a-zA-Z0-9]+/, '')
      .slice(0, 48) || 'clerq';
  return `${safe}-${crypto.randomBytes(4).toString('hex')}`;
}

function mount(source: string, readonly: boolean): string[] {
  const p = path.resolve(source);
  // `--mount` splits on commas, and there is no escape for one in a path.
  if (p.includes(',')) {
    throw new SandboxError(`Cannot mount ${p} into a container: the path contains a comma.`);
  }
  return ['--mount', `type=bind,source=${p},target=${p}${readonly ? ',readonly' : ''}`];
}

/** Build the docker/podman argument list for one command. */
export function buildContainerArgs(
  spec: ContainerSpecLike,
  command: string,
  args: string[],
  plan: Partial<ContainerPlan> = {}
): string[] {
  const limits = spec.limits ?? {};
  const image = spec.image ?? 'docker.io/library/alpine:3.20';
  const cwd = path.resolve(spec.cwd);

  const out = [
    'run',
    '--rm',
    '-i',
    // An init process forwards signals and reaps what the command leaves behind.
    '--init',
    // No new privileges, and drop every capability we are not using.
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    // Root filesystem read-only; the mounts and /tmp are the exceptions.
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=512m',
  ];
  if (plan.name) out.push('--name', plan.name);
  for (const [k, v] of Object.entries(spec.labels ?? {})) out.push('--label', `${k}=${v}`);
  if (plan.user) out.push('--user', plan.user);

  out.push(...mount(cwd, spec.readOnlyCwd === true));
  for (const w of spec.allowWrite ?? []) out.push(...mount(w, false));
  for (const r of spec.readOnly ?? []) out.push(...mount(r, true));
  // Mounted read-only over a writable mount, so they cannot be changed from
  // inside. Only what exists can be mounted; see SECURITY.md.
  for (const p of spec.protect ?? []) {
    if (fs.existsSync(p)) out.push(...mount(p, true));
  }
  out.push('-w', cwd);

  if (plan.network) out.push('--network', plan.network);
  else if (spec.network !== 'all') out.push('--network', 'none');

  if (limits.memoryMb) out.push('--memory', `${limits.memoryMb}m`);
  if (limits.cpus) out.push('--cpus', String(limits.cpus));
  if (limits.processes) out.push('--pids-limit', String(limits.processes));

  // HOME is the private /tmp: an agent CLI keeps its state there for the run.
  out.push('-e', 'HOME=/tmp');
  const names = [
    ...Object.keys(spec.env ?? {}).filter((k) => !HOST_ONLY_ENV.has(k)),
    ...Object.keys(plan.proxyEnv ?? {}),
    ...Object.keys(spec.secrets ?? {}),
  ];
  for (const k of new Set(names)) {
    // Passed by name; the value comes from the environment of the runtime CLI,
    // so it never appears in the host's process listing.
    out.push('-e', k);
  }

  out.push(image, command, ...args);
  return out;
}

/** Resolve the container runtime: a path, a name on PATH, or docker then podman. */
export function resolveRuntime(configured?: string): string | null {
  const wanted = configured ?? process.env.CLERQ_CONTAINER_RUNTIME;
  const candidates = wanted ? [wanted] : ['docker', 'podman'];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (isExecutable(candidate)) return candidate;
      continue;
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, candidate);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run the runtime CLI for a management call (create, remove, logs). Never rejects. */
export function runtimeCall(
  runtime: string,
  args: string[],
  timeoutMs = 30_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      runtime,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : null;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

/**
 * Remove a container by name, with the egress proxy and the network that may
 * belong to it. Safe to call for a container that is already gone, and twice.
 */
export async function removeContainer(runtime: string, name: string): Promise<void> {
  await runtimeCall(runtime, ['rm', '-f', name, `${name}-egress`]);
  await runtimeCall(runtime, ['network', 'rm', `${name}-net`]);
}

/** The egress proxy that runs in its own container; plain JavaScript run by `node -e`. */
export const EGRESS_SIDECAR_SCRIPT = String.raw`
const http = require('node:http');
const net = require('node:net');
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const rules = cfg.rules;
const log = (o) => process.stdout.write(JSON.stringify(o) + '\n');
function allowed(host, port) {
  const target = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return rules.some((r) => {
    if (r.port !== undefined && r.port !== port) return false;
    if (r.host.startsWith('*.')) return target.endsWith(r.host.slice(1)) && target.length > r.host.length - 1;
    return r.host === target;
  });
}
function split(authority, fallback) {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : fallback };
  const i = authority.lastIndexOf(':');
  if (i === -1) return { host: authority, port: fallback };
  const port = Number(authority.slice(i + 1));
  return Number.isInteger(port) ? { host: authority.slice(0, i), port } : { host: authority, port: fallback };
}
const refuse = (host, port) => log({ event: 'denied', host, port, at: new Date().toISOString() });
const server = http.createServer();
server.on('request', (req, res) => {
  let target;
  try { target = new URL(req.url || ''); } catch { res.writeHead(400); res.end(); return; }
  const port = target.port ? Number(target.port) : 80;
  if (target.protocol !== 'http:' || !allowed(target.hostname, port)) {
    refuse(target.hostname, port);
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Egress to ' + target.hostname + ':' + port + ' is not on the allowlist.\n');
    return;
  }
  log({ event: 'allowed', host: target.hostname, port });
  const up = http.request({ host: target.hostname, port, method: req.method, path: target.pathname + target.search, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502); res.end('Upstream error: ' + e.message + '\n'); });
  req.pipe(up);
});
server.on('connect', (req, client, head) => {
  const { host, port } = split(req.url || '', 443);
  if (!allowed(host, port)) {
    refuse(host, port);
    client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n', () => client.destroy());
    return;
  }
  log({ event: 'allowed', host, port });
  const up = net.connect(port, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  const drop = () => { up.destroy(); client.destroy(); };
  up.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n', drop));
  client.on('error', drop);
});
server.listen(cfg.port, cfg.host || '0.0.0.0', () => log({ event: 'listening', port: server.address().port }));
`;

/** What the egress proxy said it did, read from its log. */
export function parseEgressLog(text: string): { allowed: number; denied: DeniedAttempt[] } {
  let allowed = 0;
  const denied: DeniedAttempt[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.event === 'allowed') allowed += 1;
      else if (e.event === 'denied') {
        denied.push({ host: String(e.host), port: Number(e.port), at: String(e.at) });
      }
    } catch {
      /* not one of its lines */
    }
  }
  return { allowed, denied };
}

export interface EgressSidecar {
  network: string;
  proxyEnv: Record<string, string>;
  /** What it allowed and refused, then remove it. */
  finish(): Promise<{ allowed: number; denied: DeniedAttempt[] }>;
}

/**
 * Start the egress proxy for container `name`: an internal network, and the
 * proxy on it and on the default network. Throws when it cannot be set up;
 * whatever was created by then is removed.
 */
export async function startEgressSidecar(
  runtime: string,
  name: string,
  rules: EgressRule[],
  options: { image?: string; labels?: Record<string, string>; readyMs?: number } = {}
): Promise<EgressSidecar> {
  const network = `${name}-net`;
  const proxy = `${name}-egress`;
  const labels = Object.entries(options.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const fail = async (what: string, r: { stderr: string; stdout: string }): Promise<never> => {
    await removeContainer(runtime, name);
    throw new SandboxError(
      `Could not ${what}, which the egress allowlist needs: ${(r.stderr || r.stdout).trim().slice(0, 300)}`
    );
  };

  const created = await runtimeCall(runtime, [
    'network',
    'create',
    '--internal',
    ...labels,
    network,
  ]);
  if (created.code !== 0) await fail('create the internal network', created);

  const started = await runtimeCall(
    runtime,
    [
      'run',
      '-d',
      '--name',
      proxy,
      ...labels,
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '--read-only',
      '--user',
      '65534:65534',
      options.image ?? process.env.CLERQ_EGRESS_IMAGE ?? DEFAULT_EGRESS_IMAGE,
      'node',
      '-e',
      EGRESS_SIDECAR_SCRIPT,
      JSON.stringify({ rules, port: EGRESS_PORT }),
    ],
    // `run` pulls the image first when the engine does not have it, and 30 seconds is not enough
    // for a first pull over a slow connection.
    START_MS
  );
  if (started.code !== 0) await fail('start the egress proxy', started);

  const joined = await runtimeCall(runtime, ['network', 'connect', network, proxy]);
  if (joined.code !== 0) await fail('connect the egress proxy', joined);

  // The command must not start before the proxy listens, or its first
  // connection is refused for no reason it could tell.
  const until = Date.now() + (options.readyMs ?? 15_000);
  for (;;) {
    const logs = await runtimeCall(runtime, ['logs', proxy]);
    if (/"event":"listening"/.test(logs.stdout)) break;
    if (Date.now() > until) await fail('see the egress proxy start', logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const url = `http://${proxy}:${EGRESS_PORT}`;
  return {
    network,
    proxyEnv: {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ALL_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      all_proxy: url,
      NO_PROXY: '',
      no_proxy: '',
    },
    async finish() {
      const logs = await runtimeCall(runtime, ['logs', proxy]);
      return parseEgressLog(logs.stdout);
    },
  };
}

/** Containers and networks carrying `label`, with the label's value. */
export async function listLabelled(
  runtime: string,
  label: string
): Promise<{
  containers: Array<{ name: string; value: string }>;
  networks: Array<{ name: string; value: string }>;
}> {
  const read = (text: string) =>
    text
      .split('\n')
      .map((l) => l.trim().split('\t'))
      .filter((p) => p.length === 2 && p[0] && p[1])
      .map(([name, value]) => ({ name, value }));
  const containers = await runtimeCall(runtime, [
    'ps',
    '-a',
    '--filter',
    `label=${label}`,
    '--format',
    `{{.Names}}\t{{.Label "${label}"}}`,
  ]);
  const networks = await runtimeCall(runtime, [
    'network',
    'ls',
    '--filter',
    `label=${label}`,
    '--format',
    `{{.Name}}\t{{.Label "${label}"}}`,
  ]);
  return {
    containers: containers.code === 0 ? read(containers.stdout) : [],
    networks: networks.code === 0 ? read(networks.stdout) : [],
  };
}
