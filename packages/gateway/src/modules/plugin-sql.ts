/**
 * A look at the text of a statement a plugin runs through `ctx.store.exec` or `ctx.store.prepare`.
 *
 * It finds every word that could be a table name: bare words, `"quoted"`, `` `backticked` ``,
 * `[bracketed]` and (because SQLite reads a quoted string as a name in some places, such as
 * `UPDATE 'settings' SET …`) the contents of string literals, each lower-cased. Comments are
 * skipped. The caller checks them against the core tables.
 *
 * This is a check of statement text, not a database permission system. It is over-eager on purpose
 * (a column or a string that happens to equal a core table's name is refused too) and the plugin
 * that wants to write SQL runs it in the gateway's own process, with the gateway's own database
 * handle: see docs/PLUGINS.md.
 */

export interface SqlScan {
  /** Candidate names, lower-case, in order. */
  names: string[];
  /** Bare keywords, lower-case. */
  words: Set<string>;
}

const WORD_START = /[\p{L}_]/u;
const WORD = /[\p{L}\p{N}_$]/u;

export function scanSql(sql: string): SqlScan {
  const names: string[] = [];
  const words = new Set<string>();
  let i = 0;
  const quoted = (open: string, close: string) => {
    let j = i + 1;
    let out = '';
    for (;;) {
      if (j >= sql.length) break;
      if (sql[j] === close && sql[j + 1] === close && open === close) {
        out += close;
        j += 2;
      } else if (sql[j] === close) {
        break;
      } else {
        out += sql[j];
        j += 1;
      }
    }
    names.push(out.toLowerCase());
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
    } else if (c === "'" || c === '"' || c === '`') {
      quoted(c, c);
    } else if (c === '[') {
      quoted('[', ']');
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < sql.length && WORD.test(sql[j])) j += 1;
      const w = sql.slice(i, j).toLowerCase();
      names.push(w);
      words.add(w);
      i = j;
    } else {
      i += 1;
    }
  }
  return { names, words };
}

/** Keywords a plugin may not use through the context at all, as in a module's migrations. */
export const BANNED_SQL = ['attach', 'detach', 'pragma', 'vacuum'] as const;

/** Words that make a statement a change, not a read. */
const WRITES = new Set([
  'insert',
  'update',
  'delete',
  'replace',
  'drop',
  'alter',
  'create',
  'reindex',
]);

export const changesData = (scan: SqlScan): boolean => [...scan.words].some((w) => WRITES.has(w));
