/**
 * Canonical filesystem path containment, for the gateway's own tools.
 *
 * The containment check itself lives in @clerq/sandbox, where the agent
 * drivers use it too; this adds the size-checked read the `fs.read` tool needs.
 */

import fs from 'node:fs';
import { PathContainmentError, resolveWithinRoot } from '@clerq/sandbox';

export { PathContainmentError, resolveWithinRoot };

/**
 * Read a UTF-8 file inside `root`, refusing anything that is not a regular file
 * or that exceeds `maxBytes`. Size is checked by stat before the read, so an
 * oversized file is never loaded into memory.
 */
export async function readTextFileWithin(
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<{ path: string; content: string; bytes: number }> {
  const resolved = resolveWithinRoot(root, relativePath);

  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) {
    throw new PathContainmentError('Path is not a regular file.');
  }
  if (stat.size > maxBytes) {
    throw new PathContainmentError(
      `File is ${stat.size} bytes, over the ${maxBytes}-byte limit. Raise capabilities.fsMaxReadBytes to read it.`
    );
  }

  const content = await fs.promises.readFile(resolved, 'utf8');
  return { path: resolved, content, bytes: stat.size };
}
