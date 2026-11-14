/**
 * A look at the text of a statement a plugin runs through `ctx.store.exec` or `ctx.store.prepare`.
 *
 * The reading itself is `@clerq/store`'s (`allNames`, `sqlWords`): every word that could be a table,
 * view, index or trigger name (bare, `"quoted"`, `` `backticked` ``, `[bracketed]`, and a `'string'` only
 * where SQLite reads a string as a name, such as `UPDATE 'settings' SET …`), lower-cased, comments
 * skipped. The caller checks them against the objects that are not the plugin's own.
 *
 * This is a check of statement text, not a database permission system. It is over-eager on purpose
 * (a column or a bare word that happens to equal a core table's name is refused too; an ordinary string
 * is not) and the plugin that wants to write SQL runs it in the gateway's own process, with the
 * gateway's own database handle: see docs/PLUGINS.md.
 */

import { allNames, sqlWords } from '@clerq/store';

export interface SqlScan {
  /** Candidate names, lower-case, in order. */
  names: string[];
  /** Bare keywords, lower-case. */
  words: Set<string>;
}

export const scanSql = (sql: string): SqlScan => ({ names: allNames(sql), words: sqlWords(sql) });

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
