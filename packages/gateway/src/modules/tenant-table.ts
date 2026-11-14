/**
 * ctx.store.rows(name): a module table seen through the current tenant. The
 * SQL is plain and portable: equality filters, one ORDER BY, a LIMIT.
 */

import type { SqlParam, TenantTable } from '@clerq/plugin-sdk';
import { getStore } from '../store.js';
import { currentTenant } from '../tenant.js';

const COLUMN = /^[a-z_][a-z0-9_]*$/;

function column(name: string): string {
  if (!COLUMN.test(name)) throw new Error(`Invalid column name "${name}".`);
  if (name === 'tenant_id') throw new Error('tenant_id is set by the gateway.');
  return name;
}

/** `tenant_id = ? AND a = ? AND b IS NULL`, with its parameters. */
function where(filter: Record<string, SqlParam> = {}): { sql: string; params: SqlParam[] } {
  const parts = ['tenant_id = ?'];
  const params: SqlParam[] = [currentTenant()];
  for (const [k, v] of Object.entries(filter)) {
    if (v === null) parts.push(`${column(k)} IS NULL`);
    else {
      parts.push(`${column(k)} = ?`);
      params.push(v);
    }
  }
  return { sql: parts.join(' AND '), params };
}

export function tenantTable(table: string): TenantTable {
  const t = `"${table}"`;
  return {
    name: table,
    insert(row) {
      const cols = Object.keys(row).map(column);
      const out = getStore()
        .prepare(
          `INSERT INTO ${t} (tenant_id${cols.map((c) => `, ${c}`).join('')})
           VALUES (?${cols.map(() => ', ?').join('')})`
        )
        .run(currentTenant(), ...cols.map((c) => row[c]));
      return { id: out.lastInsertRowid, changes: out.changes };
    },
    find(filter, opts = {}) {
      const w = where(filter);
      const order = opts.orderBy
        ? ` ORDER BY ${column(opts.orderBy)}${opts.desc ? ' DESC' : ''}`
        : '';
      const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.trunc(opts.limit))}` : '';
      return getStore()
        .prepare(`SELECT * FROM ${t} WHERE ${w.sql}${order}${limit}`)
        .all(...w.params);
    },
    get(filter) {
      const w = where(filter);
      return getStore()
        .prepare(`SELECT * FROM ${t} WHERE ${w.sql} LIMIT 1`)
        .get(...w.params);
    },
    update(filter, set) {
      const cols = Object.keys(set).map(column);
      if (cols.length === 0) return 0;
      const w = where(filter);
      return getStore()
        .prepare(`UPDATE ${t} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${w.sql}`)
        .run(...cols.map((c) => set[c]), ...w.params).changes;
    },
    delete(filter) {
      const w = where(filter);
      return getStore()
        .prepare(`DELETE FROM ${t} WHERE ${w.sql}`)
        .run(...w.params).changes;
    },
    count(filter) {
      const w = where(filter);
      const row = getStore()
        .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w.sql}`)
        .get(...w.params);
      return Number(row?.n ?? 0);
    },
  };
}
