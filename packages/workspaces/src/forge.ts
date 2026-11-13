/**
 * Where a repository lives on a forge, and how git authenticates to it.
 *
 * A repository is named one of three ways in a spec: `github:owner/name`,
 * `gitlab:group/name` (groups may nest), or an https URL on github.com or
 * gitlab.com. All three come down to a forge, a project path and the https
 * URL git clones, fetches and pushes over.
 *
 * Credentials reach git only through the environment, as an HTTP header for
 * that one host (`http.<url>.extraheader`), never in the argv, the remote URL
 * or a config file: nothing that outlives the git process holds the token.
 */

import type { Forge } from './publish.js';

export interface RemoteTarget {
  forge: Forge;
  /** "owner/name" on GitHub, "group/sub/name" on GitLab. */
  project: string;
  /** The https URL git uses. */
  url: string;
  /** The forge's host, which the credential header is scoped to. */
  host: string;
}

const HOSTS: Record<Forge, string> = { github: 'github.com', gitlab: 'gitlab.com' };

/** One path segment of a project: letters, digits, `.`, `_`, `-`, not `.` or `..` alone. */
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

function project(forge: Forge, path: string): string | null {
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (parts.some((p) => !SEGMENT.test(p))) return null;
  // GitHub has owner/name and nothing deeper; GitLab nests groups.
  if (forge === 'github' ? parts.length !== 2 : parts.length < 2) return null;
  return parts.join('/');
}

/** The target for a forge and project. */
export function remoteTarget(forge: Forge, projectPath: string): RemoteTarget {
  const host = HOSTS[forge];
  return { forge, project: projectPath, url: `https://${host}/${projectPath}.git`, host };
}

/**
 * Read a remote repository as a spec names it: `github:owner/name`,
 * `gitlab:group/name`, or `https://github.com/owner/name(.git)` /
 * `https://gitlab.com/group/name(.git)`. Null when it is none of these.
 */
export function parseRemote(text: string): RemoteTarget | null {
  const value = text.trim();
  const short = /^(github|gitlab):(.+)$/.exec(value);
  if (short) {
    const forge = short[1] as Forge;
    const p = project(forge, short[2]);
    return p ? remoteTarget(forge, p) : null;
  }
  const https = /^https:\/\/(github\.com|gitlab\.com)\/(.+)$/i.exec(value);
  if (https) {
    const forge: Forge = https[1].toLowerCase() === 'github.com' ? 'github' : 'gitlab';
    const p = project(forge, https[2]);
    return p ? remoteTarget(forge, p) : null;
  }
  return null;
}

/**
 * The forge and project of a local repository's origin URL (https or ssh), or
 * null when it is on neither github.com nor gitlab.com.
 */
export function forgeOf(url: string | null): { forge: Forge; project: string } | null {
  if (!url) return null;
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[/:](.+?)\/?$/i.exec(
      url.trim()
    );
  if (!m) return null;
  const forge: Forge = m[1].toLowerCase() === 'github.com' ? 'github' : 'gitlab';
  const p = project(forge, m[2]);
  return p ? { forge, project: p } : null;
}

/**
 * git configuration, through the environment, that sends `token` to `forge`'s
 * host and nowhere else. GitHub takes it as `x-access-token`, GitLab as
 * `oauth2`, both as HTTP basic credentials, which works for a personal access
 * token and for an app's installation token alike.
 */
export function forgeAuthEnv(forge: Forge, token: string): Record<string, string> {
  const user = forge === 'github' ? 'x-access-token' : 'oauth2';
  const basic = Buffer.from(`${user}:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${HOSTS[forge]}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
