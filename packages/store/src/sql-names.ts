/**
 * Reading the names in the text of a SQL statement.
 *
 * Two readers, for two jobs, both over the text and neither a SQL parser:
 *
 * - `allNames`: every word that could be a table, view, index or trigger name: bare words,
 *   `"quoted"`, `` `backticked` `` and `[bracketed]` names, and a `'string'` only where SQLite
 *   reads a string as a name (right after FROM, JOIN, INTO, UPDATE, TABLE, … or a `.`). It is
 *   over-eager on purpose: it is what `ctx.store` uses, where a miss is a hole and a false
 *   alarm costs a rename.
 * - `referencedNames`: only the names in the places a statement *reads or writes an object*
 *   (after FROM, JOIN, INTO, UPDATE, REFERENCES, TABLE, in a FROM list, after `main.` or
 *   `temp.`). It is what a module migration is checked with, where a column called `memory` is
 *   not a reference to the core table of that name.
 *
 * Comments are skipped. Each name is lower-cased. This is a check of statement text, not a
 * database permission system: SQLite's own authorizer is not reachable from here.
 */

type Kind = 'word' | 'quoted' | 'string' | 'sym';

interface Token {
  kind: Kind;
  /** Lower-cased for a word, a quoted name and a string; the character for a symbol. */
  text: string;
}

const WORD_START = /[\p{L}_]/u;
const WORD = /[\p{L}\p{N}_$]/u;
const SPACE = /\s/;

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const quoted = (open: string, close: string, kind: Kind) => {
    let j = i + 1;
    let text = '';
    for (;;) {
      if (j >= sql.length) break;
      if (sql[j] === close && sql[j + 1] === close && open === close) {
        text += close;
        j += 2;
      } else if (sql[j] === close) {
        break;
      } else {
        text += sql[j];
        j += 1;
      }
    }
    out.push({ kind, text: text.toLowerCase() });
    i = j + 1;
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'") {
      quoted("'", "'", 'string');
    } else if (c === '"' || c === '`') {
      quoted(c, c, 'quoted');
    } else if (c === '[') {
      quoted('[', ']', 'quoted');
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && WORD.test(sql[j])) j += 1;
      out.push({ kind: 'word', text: sql.slice(i, j).toLowerCase() });
      i = j;
    } else if (SPACE.test(c)) {
      i += 1;
    } else {
      out.push({ kind: 'sym', text: c });
      i += 1;
    }
  }
  return out;
}

const is = (t: Token | undefined, kind: Kind, ...texts: string[]): boolean =>
  !!t && t.kind === kind && (texts.length === 0 || texts.includes(t.text));
const word = (t: Token | undefined, ...texts: string[]) => is(t, 'word', ...texts);
const sym = (t: Token | undefined, ...texts: string[]) => is(t, 'sym', ...texts);

/** Keywords that start a clause, for telling a FROM list from a VALUES list. */
const CLAUSES = new Set([
  'select',
  'from',
  'join',
  'where',
  'values',
  'set',
  'group',
  'order',
  'having',
  'limit',
  'into',
  'update',
  'using',
  'returning',
  'on',
  'union',
]);

/** The clause the token at `i` is in: the nearest clause keyword before it, parenthesised groups skipped. */
function clauseAt(tokens: Token[], i: number): string | undefined {
  let depth = 0;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = tokens[j];
    if (sym(t, ')')) depth += 1;
    else if (sym(t, '(')) depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.kind === 'word' && CLAUSES.has(t.text)) return t.text;
  }
  return undefined;
}

/** What introduces a table, view, index or trigger name. */
const NAME_AFTER = new Set([
  'from',
  'join',
  'into',
  'update',
  'table',
  'view',
  'index',
  'trigger',
  'references',
  'exists',
  'reindex',
  'analyze',
]);

const CONFLICT = new Set(['abort', 'fail', 'ignore', 'replace', 'rollback']);

/**
 * Whether the token at `i` stands where a statement names an object: after one of the words above
 * (also `UPDATE OR REPLACE name`), after `.`, as an item of a FROM list, or as `ON name (` of an index
 * or trigger. `all` also counts a name after `.` whatever came before it; the narrow reader counts one
 * only after `main.` or `temp.`.
 */
function inNamePosition(tokens: Token[], i: number, all: boolean): boolean {
  const prev = tokens[i - 1];
  const before = tokens[i - 2];
  if (word(prev) && NAME_AFTER.has(prev.text)) return true;
  if (word(prev) && CONFLICT.has(prev.text) && word(before, 'or')) return true;
  if (word(prev, 'on'))
    return sym(tokens[i + 1], '(') || word(tokens[i + 1], 'begin', 'for', 'when');
  if (sym(prev, '.')) {
    return all || ['main', 'temp'].includes(String(before?.text));
  }
  const clause = clauseAt(tokens, i);
  const inFrom = clause === 'from' || clause === 'join';
  if (sym(prev, ',')) return inFrom;
  if (sym(prev, '(')) {
    return word(before, 'from', 'join') || (sym(before, ',') && inFrom);
  }
  return false;
}

/**
 * Every word that could be an object name, lower-cased, in order: bare words and quoted names
 * wherever they are, and a string literal only where SQLite reads a string as a name. So
 * `UPDATE 'settings' SET …` names `settings`, and `VALUES ('settings')` does not.
 */
export function allNames(sql: string): string[] {
  const tokens = tokenize(sql);
  const names: string[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === 'word' || t.kind === 'quoted') names.push(t.text);
    else if (t.kind === 'string' && inNamePosition(tokens, i, true)) names.push(t.text);
  });
  return names;
}

/** The bare keywords of a statement, lower-cased. */
export function sqlWords(sql: string): Set<string> {
  return new Set(
    tokenize(sql)
      .filter((t) => t.kind === 'word')
      .map((t) => t.text)
  );
}

/** The names a statement reads or writes, by where they stand (see the top of this file). */
export function referencedNames(sql: string): string[] {
  const tokens = tokenize(sql);
  const names: string[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === 'sym') return;
    if (inNamePosition(tokens, i, false)) names.push(t.text);
  });
  return names;
}
