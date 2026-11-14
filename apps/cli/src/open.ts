/**
 * Opening a file or an address in the person's default application (the
 * browser), by the system's own opener. Never through a shell: the target is
 * one argument.
 */

import { spawn } from 'node:child_process';

/** The command and arguments that open `target` on this system. */
export function openerFor(
  target: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
  }
  return { command: 'xdg-open', args: [target] };
}

/** True when the opener started; false when there is none (a server with no desktop). */
export function systemOpen(target: string): Promise<boolean> {
  const { command, args } = openerFor(target);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
