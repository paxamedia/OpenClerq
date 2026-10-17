/**
 * The PATH a user's own terminal would have.
 *
 * The desktop app starts the gateway from the Finder or the Start menu, which
 * hands it a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin on macOS). A gate such as
 * `pnpm test` would then fail to find pnpm. Asking the login shell once gives
 * the PATH the user set up for themselves.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MARK = '__CLERQ_PATH__';
let cached: string | null = null;

function fromLoginShell(): string | null {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  try {
    const r = spawnSync(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = new RegExp(`${MARK}(.*)${MARK}`).exec(r.stdout ?? '');
    return m?.[1] || null;
  } catch {
    return null;
  }
}

/** The login shell's PATH merged with ours, without duplicates. Cached. */
export function userShellPath(): string {
  if (cached !== null) return cached;
  const home = os.homedir();
  const extra =
    process.platform === 'win32'
      ? []
      : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin')];
  const parts = [
    ...(fromLoginShell() ?? '').split(path.delimiter),
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...extra,
  ].filter(Boolean);
  cached = [...new Set(parts)].join(path.delimiter);
  return cached;
}
