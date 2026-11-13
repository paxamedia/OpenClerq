/**
 * Gate assertions about a run's diff: `assert: diff.files_changed <= 5`.
 *
 * A small hand-written parser, never `eval`. The grammar is the whole of it:
 *
 *   diff.files_changed | diff.lines_added | diff.lines_removed   <op>   <whole number>
 *       <op> is one of  <=  <  >=  >  ==  !=
 *   diff.touches_none_of [glob, glob, …]
 *   diff.touches_only    [glob, glob, …]
 *
 * Globs are matched against paths from the repository root, with `/` between
 * directories: `*` is any run of characters within one directory, `?` one
 * character, `**` any number of whole directories, and a trailing `/` means
 * everything under that directory. `*.md` is a Markdown file at the root;
 * `**\/*.md` is one anywhere. A glob may be quoted, '…' or "…", to hold a
 * comma, a space or a bracket.
 *
 * The diff is the run's commit against the base it started from. A renamed
 * file counts once in `files_changed`, and both its old and new paths count as
 * touched.
 */

import { git, SAFE_DIFF } from '@clerq/workspaces';

export type DiffMetric = 'files_changed' | 'lines_added' | 'lines_removed';
export type Comparison = '<=' | '<' | '>=' | '>' | '==' | '!=';

export type DiffAssertion =
  | { kind: 'compare'; metric: DiffMetric; op: Comparison; value: number }
  | { kind: 'touches_none_of' | 'touches_only'; globs: string[] };

/** A problem with an assertion, at an offset into its text. */
export class AssertionSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message);
    this.name = 'AssertionSyntaxError';
  }
}

const METRICS: DiffMetric[] = ['files_changed', 'lines_added', 'lines_removed'];
const SETS = ['touches_none_of', 'touches_only'] as const;
const OPS: Comparison[] = ['<=', '>=', '==', '!=', '<', '>'];
const NAMES = [...METRICS, ...SETS].join(', ');

/** Parse an assertion. Throws AssertionSyntaxError pointing at the problem. */
export function parseAssertion(text: string): DiffAssertion {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  skip();
  if (!text.startsWith('diff.', i)) {
    throw new AssertionSyntaxError(
      `An assertion starts with diff.<name>, one of: ${NAMES}. For a command, use "run:".`,
      i
    );
  }
  i += 'diff.'.length;
  const nameAt = i;
  while (i < text.length && /[a-z_]/.test(text[i])) i++;
  const name = text.slice(nameAt, i);
  skip();

  if ((METRICS as string[]).includes(name)) {
    const op = OPS.find((o) => text.startsWith(o, i));
    if (!op) {
      throw new AssertionSyntaxError(
        `diff.${name} must be compared with <=, <, >=, >, == or != and a number.`,
        i
      );
    }
    i += op.length;
    skip();
    const numberAt = i;
    while (i < text.length && /[0-9]/.test(text[i])) i++;
    if (i === numberAt) {
      throw new AssertionSyntaxError(`diff.${name} ${op} needs a whole number.`, numberAt);
    }
    const value = Number(text.slice(numberAt, i));
    skip();
    if (i < text.length) {
      throw new AssertionSyntaxError(`Unexpected "${text.slice(i)}" after the number.`, i);
    }
    return { kind: 'compare', metric: name as DiffMetric, op, value };
  }

  if ((SETS as readonly string[]).includes(name)) {
    if (text[i] !== '[') {
      throw new AssertionSyntaxError(
        `diff.${name} takes a list of globs in brackets, e.g. diff.${name} [src/**, docs/]`,
        i
      );
    }
    i++;
    const globs: string[] = [];
    for (;;) {
      skip();
      if (text[i] === ']' && globs.length === 0) {
        throw new AssertionSyntaxError(`diff.${name} needs at least one glob.`, i);
      }
      const itemAt = i;
      let glob: string;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, i + 1);
        if (end < 0) throw new AssertionSyntaxError('This quote is never closed.', i);
        glob = text.slice(i + 1, end);
        i = end + 1;
      } else {
        while (i < text.length && !/[\s,\]]/.test(text[i])) i++;
        glob = text.slice(itemAt, i);
      }
      const problem = globProblem(glob);
      if (problem) throw new AssertionSyntaxError(problem, itemAt);
      globs.push(glob);
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        break;
      }
      throw new AssertionSyntaxError(
        i < text.length
          ? `Expected "," or "]" here.`
          : 'The list of globs is never closed with "]".',
        i
      );
    }
    skip();
    if (i < text.length) {
      throw new AssertionSyntaxError(`Unexpected "${text.slice(i)}" after the list.`, i);
    }
    return { kind: name as (typeof SETS)[number], globs };
  }

  throw new AssertionSyntaxError(
    name
      ? `Unknown diff.${name}; use one of: ${NAMES}.`
      : `diff. must be followed by one of: ${NAMES}.`,
    nameAt
  );
}

function globProblem(glob: string): string | undefined {
  if (!glob) return 'An empty glob matches nothing.';
  if (/(^|\/)\.\.(\/|$)/.test(glob))
    return `"${glob}" leaves the repository; globs are paths inside it.`;
  return undefined;
}

/** A glob as an anchored regular expression over repository paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.?\//, '');
  if (g.endsWith('/')) g += '**';
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
            // `**/`: any number of whole directories, none included.
            out += '(?:[^/]*/)*';
            i++;
          } else {
            // A trailing `**`: everything below.
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
  return new RegExp(`^${out}$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** One file in a run's diff. */
export interface DiffFile {
  path: string;
  /** For a rename, where it came from. */
  oldPath?: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

/** What an assertion found. */
export interface AssertionResult {
  passed: boolean;
  /** The measured value, for a comparison. */
  actual?: number;
  /** For a set assertion: the paths that broke it. */
  offending?: string[];
  /** One line saying what was found, for the run's step. */
  detail: string;
}

export function evaluateAssertion(a: DiffAssertion, files: DiffFile[]): AssertionResult {
  if (a.kind === 'compare') {
    const actual =
      a.metric === 'files_changed'
        ? files.length
        : files.reduce((n, f) => n + ((a.metric === 'lines_added' ? f.added : f.removed) ?? 0), 0);
    const passed = compare(actual, a.op, a.value);
    return {
      passed,
      actual,
      detail: `diff.${a.metric} is ${actual}${passed ? '' : `, not ${a.op} ${a.value}`}.`,
    };
  }
  const touched = [...new Set(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])))];
  const offending =
    a.kind === 'touches_none_of'
      ? touched.filter((p) => matchesAny(p, a.globs))
      : touched.filter((p) => !matchesAny(p, a.globs));
  const shown = offending.slice(0, 20).join(', ') + (offending.length > 20 ? ', …' : '');
  return {
    passed: offending.length === 0,
    offending,
    detail:
      offending.length === 0
        ? `${touched.length} paths touched, none outside the rule.`
        : a.kind === 'touches_none_of'
          ? `${offending.length} touched paths match [${a.globs.join(', ')}]: ${shown}`
          : `${offending.length} touched paths are outside [${a.globs.join(', ')}]: ${shown}`,
  };
}

function compare(actual: number, op: Comparison, value: number): boolean {
  switch (op) {
    case '<=':
      return actual <= value;
    case '<':
      return actual < value;
    case '>=':
      return actual >= value;
    case '>':
      return actual > value;
    case '==':
      return actual === value;
    case '!=':
      return actual !== value;
  }
}

/**
 * `git diff --numstat -z -M` output: `added\tremoved\tpath\0` per file, or for
 * a rename `added\tremoved\t\0old\0new\0`. Binary files count `-` lines.
 */
export function parseNumstat(out: string): DiffFile[] {
  const parts = out.split('\0');
  const files: DiffFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    if (m[3]) {
      files.push({ path: m[3], added, removed });
    } else {
      const oldPath = parts[++i];
      const path = parts[++i];
      if (path) files.push({ path, oldPath, added, removed });
    }
  }
  return files;
}

/** The files a workspace's commits changed since `baseSha`. */
export async function diffFiles(cwd: string, baseSha: string): Promise<DiffFile[]> {
  // Hardened: the agent has written to this worktree (see HARDENED_GIT).
  const r = await git(['diff', '--numstat', '-z', '-M', ...SAFE_DIFF, `${baseSha}..HEAD`], {
    cwd,
    harden: true,
  });
  return parseNumstat(r.stdout);
}
