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

/** Links followed before giving up, as the operating system does (ELOOP). */
const MAX_LINKS = 40;

/**
 * Resolve symlinks for the deepest existing portion of an absolute path.
 *
 * A link whose target does not exist cannot be realpath'd, but writing through
 * it creates its target: `root/link -> ../outside/new` would create
 * `outside/new`. So a dangling link met on the way is followed by hand, with
 * readlink, and the path is resolved again from where it points.
 */
function realpathNearest(target: string, links = 0): string {
  if (links > MAX_LINKS) {
    throw new PathContainmentError('Path passes through too many symbolic links.');
  }
  let current = path.resolve(target);
  const trailing: string[] = [];
  const rest = () => [...trailing].reverse();

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return trailing.length > 0 ? path.join(real, ...rest()) : real;
    } catch {
      let link: string | undefined;
      try {
        if (fs.lstatSync(current).isSymbolicLink()) link = fs.readlinkSync(current);
      } catch {
        // Not there at all: keep walking up.
      }
      if (link !== undefined) {
        const pointsAt = path.resolve(path.dirname(current), link);
        return realpathNearest(path.join(pointsAt, ...rest()), links + 1);
      }
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
