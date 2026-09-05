/**
 * Runtime-adaptive SQLite driver.
 *
 * The gateway runs under two runtimes and must work identically in both:
 *   - Node (development, `pnpm gateway`)  -> node:sqlite
 *   - Bun  (the desktop sidecar, compiled with `bun build --compile`) -> bun:sqlite
 *
 * Both are built into their runtime, so the store needs no native addon. That
 * matters: better-sqlite3 is a native module and `bun build --compile` cannot
 * embed it, which would break the desktop installer build.
 *
 * The module specifier is computed rather than literal so Bun's bundler cannot
 * statically resolve `node:sqlite` (which it does not implement) at build time.
 * A literal import would fail the sidecar compile even on a branch never taken.
 */

/** One row, as returned by a query. */
export type Row = Record<string, unknown>;

/** Values SQLite can bind. */
export type Param = string | number | bigint | boolean | null | Uint8Array;

export interface Statement {
  run(...params: Param[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: Param[]): Row | undefined;
  all(...params: Param[]): Row[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Which runtime backend is in use — surfaced for diagnostics. */
  readonly backend: 'node:sqlite' | 'bun:sqlite';
}

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/** Normalise `undefined` to `null`, and booleans to ints — SQLite has neither. */
function normalise(params: Param[]): Param[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

function wrapStatement(raw: {
  run: (...p: Param[]) => unknown;
  get: (...p: Param[]) => unknown;
  all: (...p: Param[]) => unknown;
}): Statement {
  return {
    run(...params) {
      const r = raw.run(...normalise(params)) as
        | { changes?: number | bigint; lastInsertRowid?: number | bigint }
        | undefined;
      return {
        changes: Number(r?.changes ?? 0),
        lastInsertRowid: r?.lastInsertRowid ?? 0,
      };
    },
    get(...params) {
      return (raw.get(...normalise(params)) as Row | null | undefined) ?? undefined;
    },
    all(...params) {
      return (raw.all(...normalise(params)) as Row[] | undefined) ?? [];
    },
  };
}

/**
 * Open (or create) a database at `path`, with the pragmas this project relies on:
 * WAL so readers never block the writer, and foreign keys enforced.
 *
 * Pass ':memory:' for tests.
 */
export async function openDatabase(path: string): Promise<Database> {
  const bun = isBun();
  // Computed specifier: see the note at the top of this file.
  const specifier = bun ? 'bun:sqlite' : 'node:sqlite';
  const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;

  let handle: {
    exec: (sql: string) => void;
    prepare: (sql: string) => never;
    close: () => void;
  };

  if (bun) {
    const Ctor = mod.Database as new (p: string) => typeof handle;
    handle = new Ctor(path);
  } else {
    const Ctor = mod.DatabaseSync as new (p: string) => typeof handle;
    handle = new Ctor(path);
  }

  // WAL is what makes concurrent readers safe alongside a writer; the JSON
  // config files this store replaces were read-modify-write with no locking.
  // :memory: databases do not support WAL, and do not need it.
  if (path !== ':memory:') {
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA synchronous = NORMAL');
    // Wait rather than fail immediately when another writer holds the lock.
    handle.exec('PRAGMA busy_timeout = 5000');
  }
  handle.exec('PRAGMA foreign_keys = ON');

  const db: Database = {
    backend: bun ? 'bun:sqlite' : 'node:sqlite',
    exec(sql) {
      handle.exec(sql);
    },
    prepare(sql) {
      return wrapStatement(handle.prepare(sql) as never);
    },
    transaction<T>(fn: () => T): T {
      handle.exec('BEGIN');
      try {
        const out = fn();
        handle.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          /* the transaction was already rolled back by SQLite */
        }
        throw e;
      }
    },
    close() {
      handle.close();
    },
  };

  return db;
}
