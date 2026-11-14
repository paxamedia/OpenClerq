/**
 * Path scope: which paths of a folder a holder may touch.
 *
 * A scope is a list of globs relative to a folder, in the syntax the diff gates use:
 *
 *   `*`       any run of characters within one folder or file name
 *   `?`       one character
 *   `**`      any number of whole folders (`src/**` is everything under `src`)
 *   `docs/`   a trailing `/` means the folder and everything under it
 *   `docs`    with no wildcard, the path itself and anything under it
 *
 * `*.md` is a Markdown file at the top of the folder; `**\/*.md` is one anywhere. An entry that
 * starts with `~` names the user's home, which is not inside the folder, so it never matches a
 * path in it. Paths are given as the folder-relative paths the file tools use: no leading `/`,
 * no `..`; the caller has already made them contain.
 *
 * This only decides on text. The file tools check that a path stays inside the folder first.
 */

const cache = new Map<string, RegExp>();

/** A scope entry as an anchored regular expression over folder-relative paths. */
export function scopeToRegExp(entry: string): RegExp {
  const hit = cache.get(entry);
  if (hit) return hit;
  let g = entry.trim();
  while (g.startsWith('./')) g = g.slice(2);
  // A name with no wildcard is itself, or anything below it.
  let andBelow = false;
  if (g === '' || g === '.' || g === '/') g = '**';
  else if (g.endsWith('/')) g += '**';
  else if (!/[*?]/.test(g)) andBelow = true;
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const before = i === 0 || g[i - 1] === '/';
        const after = g[i + 2] === undefined || g[i + 2] === '/';
        i++;
        if (before && after) {
          if (g[i + 1] === '/') {
            out += '(?:[^/]*/)*';
            i++;
          } else {
            out += '.*';
          }
          continue;
        }
        out += '[^/]*';
        continue;
      }
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${out}${andBelow ? '(?:/.*)?' : ''}$`);
  if (cache.size > 500) cache.clear();
  cache.set(entry, re);
  return re;
}

/** A folder-relative path as written: no `./` in front, no trailing `/`, `.` as the empty path. */
export function scopePath(rel: string): string {
  let p = rel
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/$/, '');
  return p === '.' ? '' : p;
}

const inFolder = (entry: string) => !entry.trim().startsWith('~');

/** Whether `rel` is inside the scope: a path some entry covers. */
export function pathInScope(scope: readonly string[], rel: string): boolean {
  const p = scopePath(rel);
  return scope.filter(inFolder).some((entry) => scopeToRegExp(entry).test(p));
}

/**
 * Whether a folder is on the way to something in scope, or inside it: a folder worth looking
 * into, though not every name in it is. The top of the folder (`''` or `.`) is on the way to
 * any entry that has a name or a pattern for something in it. `**` is on the way to anything
 * below it; a pattern with no `**` only reaches as deep as it is long.
 */
export function scopeReaches(scope: readonly string[], dir: string): boolean {
  const d = scopePath(dir);
  if (pathInScope(scope, d)) return true;
  const want = d === '' ? [] : d.split('/');
  return scope.filter(inFolder).some((entry) => {
    let e = entry.trim();
    while (e.startsWith('./')) e = e.slice(2);
    if (e === '' || e === '.' || e === '/') return true;
    if (e.endsWith('/')) e += '**';
    const segs = e.split('/').filter(Boolean);
    for (let i = 0; i < want.length; i++) {
      if (i >= segs.length) return false;
      if (segs[i] === '**') return true;
      if (!scopeToRegExp(segs[i]).test(want[i])) return false;
    }
    return want.length < segs.length;
  });
}

/** The entries that can match a path in the folder (those not starting with `~`), tidied. */
export function folderScope(scope: readonly string[]): string[] {
  return scope.filter(inFolder).map((e) => e.trim());
}
