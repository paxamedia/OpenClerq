/**
 * Where a managed chat's commands run, and what of the gateway they must not
 * reach by way of the folder.
 *
 *  - A folder that is, holds or lies inside OpenClerq's own state (~/.clerq, the
 *    store's directory) cannot be attached: the file tools are confined to the
 *    folder, so this keeps the gateway token, the vault and the store out of
 *    their reach, at every access level.
 *  - Commands get a home directory of the conversation's own, not the user's,
 *    so `~/.clerq/gateway-token` and other dotfiles are not where `~` points.
 *    The commit name and email are passed through. Under Full access a command
 *    can still name any path the user's account can read: see SECURITY.md.
 *  - The Sandboxed level (macOS) runs commands and file tools under seatbelt.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clerqHome } from '@clerq/store';

let extraStateDirs: string[] = [];

/** The store's directory and any other place the gateway keeps state, besides ~/.clerq. */
export function setGatewayStateDirs(dirs: string[]): void {
  extraStateDirs = dirs.filter(Boolean);
}

/** Where the gateway keeps its own state: ~/.clerq, the store's directory. */
export function gatewayStateDirs(): string[] {
  return [...new Set([clerqHome(), ...extraStateDirs].map(real))];
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why `dir` cannot be a chat's folder, or undefined when it can: it is, holds
 * or lies inside the gateway's own state.
 */
export function stateDirProblem(dir: string): string | undefined {
  const d = real(dir);
  for (const state of gatewayStateDirs()) {
    if (within(d, state) || within(state, d)) {
      return `${d} holds or lies inside OpenClerq's own data (${state}); attach a project folder instead.`;
    }
  }
  return undefined;
}

/** True when the Sandboxed access level can run here (macOS sandbox-exec). */
export function seatbeltAvailable(): boolean {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}

/**
 * The home directory a conversation's commands get: one of its own under the
 * system temporary directory, created on first use, readable only by this account.
 */
export function chatHome(sessionId: string): string {
  const id = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `clerq-chat-${id}`, 'home');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(dir);
}

/** Remove a conversation's home directory, when the conversation goes. */
export function removeChatHome(sessionId: string): void {
  const id = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  fs.rmSync(path.join(os.tmpdir(), `clerq-chat-${id}`), { recursive: true, force: true });
}

let identity: Record<string, string> | undefined;

/**
 * The user's commit name and email from their global git config, as git's
 * environment variables, so commits in a chat's folder are theirs although
 * the commands do not see their home directory. Read once.
 */
export function gitIdentityEnv(): Record<string, string> {
  if (identity) return identity;
  const read = (key: string): string | undefined => {
    try {
      return (
        execFileSync('git', ['config', '--global', '--get', key], {
          encoding: 'utf8',
          timeout: 3_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  identity = {
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
  };
  return identity;
}

/** The environment a chat's commands run with: PATH, the chat's own HOME, the commit identity. */
export function chatCommandEnv(sessionId: string, pathVar: string): Record<string, string> {
  const home = chatHome(sessionId);
  return { PATH: pathVar, HOME: home, USERPROFILE: home, ...gitIdentityEnv() };
}
