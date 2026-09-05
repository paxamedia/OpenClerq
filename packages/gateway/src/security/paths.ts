/**
 * Canonical filesystem path containment.
 *
 * Replaces prefix comparison (`resolved.startsWith(root)`), which admitted two
 * distinct escapes:
 *   1. Sibling directories sharing a prefix — "/srv/repo-secrets" passes a check
 *      scoped to "/srv/repo".
 *   2. Symlinks — a link inside the root pointing anywhere on the filesystem.
 *
 * Containment here is decided by path.relative() against a realpath'd root, and
 * the target is realpath'd too (walking up to its nearest existing ancestor when
 * the target itself does not exist yet).
 */

import fs from 'node:fs';
import path from 'node:path';

export class PathContainmentError extends Error {
  readonly code = 'path_not_allowed';
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/** Resolve symlinks for the deepest existing portion of an absolute path. */
function realpathNearest(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // reached the filesystem root
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is the same as, or nested inside, `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true; // the root itself
  if (path.isAbsolute(rel)) return false; // different drive or unrelated root
  return !rel.split(path.sep).includes('..');
}

/**
 * Resolve `relativePath` inside `root`, or throw.
 *
 * Rejects: empty input, NUL bytes, absolute paths, traversal beyond the root,
 * and symlinks whose target escapes the root.
 *
 * @returns the canonical absolute path, safe to open.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathContainmentError('A non-empty relative path is required.');
  }
  if (relativePath.includes('\0')) {
    throw new PathContainmentError('Path contains a NUL byte.');
  }
  if (path.isAbsolute(relativePath)) {
    throw new PathContainmentError(
      'Absolute paths are not allowed; give a path relative to the configured root.'
    );
  }
  // Windows drive-relative ("C:foo") and UNC-ish inputs.
  if (/^[a-zA-Z]:/.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new PathContainmentError('Drive-qualified and UNC paths are not allowed.');
  }

  const realRoot = realpathNearest(path.resolve(root));
  const candidate = path.resolve(realRoot, relativePath);

  // First check on the lexical resolution, before touching the filesystem.
  if (!isInside(realRoot, candidate)) {
    throw new PathContainmentError('Access outside the configured root is not allowed.');
  }

  // Second check after resolving symlinks — this is the one that catches links.
  const realCandidate = realpathNearest(candidate);
  if (!isInside(realRoot, realCandidate)) {
    throw new PathContainmentError(
      'Path resolves outside the configured root via a symbolic link.'
    );
  }

  return realCandidate;
}

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
