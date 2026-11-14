/**
 * The environment a spawned process gets.
 */

/** Variables a process needs to start and find its tools, and nothing else. */
export const BASE_ENV = [
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

export function baseEnv(inherit: boolean | undefined): Record<string, string> {
  if (inherit) return { ...(process.env as Record<string, string>) };
  const out: Record<string, string> = {};
  for (const name of BASE_ENV) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The variables that say which engine a Docker or Podman CLI talks to, and how.
 * Without them a CLI reaches the default engine of this machine; with
 * `DOCKER_HOST` or a context set for another one (a remote, a rootless or a
 * VM's engine), a call that lacked them would start a container on one engine
 * and try to stop it on another. Every call to the runtime CLI gets them, and
 * none of them is passed into a container.
 */
export const RUNTIME_ENV = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'CONTAINER_HOST',
  'CONTAINER_CONNECTION',
  'XDG_RUNTIME_DIR',
];

/** Only the engine's own variables, as they are in this process. */
export function engineEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RUNTIME_ENV) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** What a runtime CLI is started with, for any call: the base environment and the engine's own variables. */
export function runtimeEnv(): Record<string, string> {
  return { ...baseEnv(false), ...engineEnv() };
}
