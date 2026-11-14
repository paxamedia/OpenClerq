/**
 * What a plugin did through its context, checked against what it declared.
 *
 * The person decides whether this is enforced (`plugins.enforce`, off by
 * default). With enforcement off nothing is blocked: a use outside the
 * declaration is audited and goes ahead. With it on, the same use throws a
 * `PluginPermissionError` and is audited as refused.
 *
 * This checks what goes *through the context*: `ctx.secrets`, `ctx.services`,
 * `ctx.exec`, `ctx.fetch` and `ctx.fs`. A plugin runs inside the gateway
 * process, so its own `child_process`, `fs` or `fetch` are not touched. It makes
 * a plugin's declarations true for a well-behaved plugin and catches mistakes. It
 * is not a sandbox.
 */

import os from 'node:os';
import path from 'node:path';
import { audit } from '@clerq/store';
import { PluginPermissionError, tablePrefix, type PluginPermissions } from '@clerq/plugin-sdk';
import { isAllowed, parseAllowlist, resolveWithinRoot, type EgressRule } from '@clerq/sandbox';
import { getStore } from '../store.js';
import { BANNED_SQL, changesData, scanSql } from './plugin-sql.js';
import { logger } from '../logger.js';

/** The same refusal or undeclared use is written to the audit log once a minute, with a count of the repeats. */
export const AUDIT_REPEAT_MS = 60_000;

/** Variables that decide which program or library a command runs, matched whatever their case. */
const BLOCKED_ENV =
  /^(PATH|DYLD_.*|LD_.*|NODE_OPTIONS|NODE_PATH|GIT_EXEC_PATH|GIT_CONFIG.*|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB)$/i;

export type Permission = 'secrets' | 'services' | 'exec' | 'net' | 'fs.read' | 'fs.write' | 'store';

export interface GuardDeps {
  id: string;
  /** The plugin's own directory: a relative root in `permissions.fs` is read against it. */
  dir: string;
  declared: () => Readonly<PluginPermissions>;
  /** Asked at every check, so turning enforcement on or off applies to a plugin that is running. */
  enforcing: () => boolean;
  now?: () => number;
}

/** `~` and `~/…` as the user's home. */
export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** The real path of an absolute path: links resolved as far as it exists, the rest as written. */
function canonical(abs: string): string {
  const top = path.parse(abs).root;
  return resolveWithinRoot(top, path.relative(top, abs) || '.');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.split(path.sep).includes('..') && !path.isAbsolute(rel));
}

/**
 * `target` (absolute) in `root` (absolute), after symbolic links on both sides are
 * resolved: the real path to use, or null. A `..` that climbs out and a link that
 * leads out are both outside.
 */
export function containedIn(root: string, target: string): string | null {
  try {
    const realRoot = canonical(root);
    const realTarget = canonical(target);
    if (!isInside(realRoot, realTarget)) return null;
    const rel = path.relative(realRoot, realTarget);
    return resolveWithinRoot(realRoot, rel === '' ? '.' : rel);
  } catch {
    return null;
  }
}

export class PluginGuard {
  private readonly last = new Map<string, { at: number; repeated: number }>();

  constructor(private readonly deps: GuardDeps) {}

  get enforcing(): boolean {
    return this.deps.enforcing();
  }

  private get declared(): Readonly<PluginPermissions> {
    return this.deps.declared();
  }

  /** A secret name, short form. `op` is only for the wording. */
  secret(name: string, op: 'read' | 'write' | 'delete'): void {
    if (this.declared.secrets.includes(name)) return;
    this.outside(
      'secrets',
      name,
      `The plugin "${this.deps.id}" may not ${op === 'read' ? 'read' : op === 'write' ? 'write' : 'delete'} the secret "${name}": it is not in permissions.secrets.`
    );
  }

  /** The names `ctx.secrets.list()` may show. */
  visibleSecrets(names: string[]): string[] {
    return this.enforcing ? names.filter((n) => this.declared.secrets.includes(n)) : names;
  }

  service(label: string): void {
    if (this.declared.services.includes(label)) return;
    this.outside(
      'services',
      label,
      `The plugin "${this.deps.id}" may not control the service "${label}": it is not in permissions.services.`
    );
  }

  visibleServices<T extends { label: string }>(items: T[]): T[] {
    return this.enforcing ? items.filter((s) => this.declared.services.includes(s.label)) : items;
  }

  /**
   * A statement about to run through `ctx.store.exec` or `.prepare`. A plugin's SQL may name only
   * its own tables (`mod_<id>__*`): any other table is a core table (or another module's), and
   * `ATTACH`, `DETACH`, `PRAGMA` and `VACUUM` are not for a plugin. With enforcement on that is
   * refused; with it off a statement that changes a core table is audited and goes ahead. It reads
   * the text of the statement, nothing more.
   */
  sql(sql: string): void {
    const scan = scanSql(sql);
    const banned = BANNED_SQL.find((k) => scan.words.has(k));
    if (banned) {
      this.outside(
        'store',
        banned.toUpperCase(),
        `The plugin "${this.deps.id}" may not run ${banned.toUpperCase()} through ctx.store.`
      );
      return;
    }
    const core = this.coreTable(scan.names);
    if (!core) return;
    // Off, only a write is worth a row; on, a read of the gateway's own tables is refused too.
    if (!this.enforcing && !changesData(scan)) return;
    this.outside(
      'store',
      core,
      `The plugin "${this.deps.id}" may not use the table "${core}" in SQL: its SQL may name only its own tables (${tablePrefix(this.deps.id)}*).`
    );
  }

  private coreSet: { version: number; names: Set<string> } | null = null;

  /** The first name in `names` that is a table or view of the gateway or of another module. */
  private coreTable(names: string[]): string | undefined {
    const db = getStore();
    const version = Number(db.prepare('PRAGMA schema_version').get()?.schema_version ?? -1);
    if (!this.coreSet || this.coreSet.version !== version) {
      const own = tablePrefix(this.deps.id);
      this.coreSet = {
        version,
        names: new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
            .all()
            .map((r) => String(r.name).toLowerCase())
            .filter((n) => !n.startsWith(own))
        ),
      };
    }
    const set = this.coreSet.names;
    return names.find((n) => set.has(n) || n.startsWith('sqlite_'));
  }

  /**
   * Environment variables a command may not be given: they change which program or library runs
   * (`PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `GIT_EXEC_PATH`, `GIT_CONFIG_*`, `BASH_ENV`, …).
   */
  env(keys: string[]): void {
    for (const key of keys) {
      if (!BLOCKED_ENV.test(key)) continue;
      this.outside(
        'exec',
        `env:${key}`,
        `The plugin "${this.deps.id}" may not set ${key} for a command: it changes which program or library runs.`
      );
    }
  }

  /** `cmd` exactly as declared. */
  command(cmd: string): void {
    if (this.declared.exec.includes(cmd)) return;
    this.outside(
      'exec',
      cmd,
      `The plugin "${this.deps.id}" may not run "${cmd}": it is not in permissions.exec, written exactly like this.`
    );
  }

  /** The host (and port) of a URL about to be fetched. */
  host(url: URL): void {
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    let rules: EgressRule[] = [];
    try {
      rules = parseAllowlist(this.declared.net);
    } catch {
      // An entry that is not a host; the ones before it still count.
      rules = this.declared.net.flatMap((n) => {
        try {
          return parseAllowlist([n]);
        } catch {
          return [];
        }
      });
    }
    if (isAllowed(rules, url.hostname, port)) return;
    this.outside(
      'net',
      `${url.hostname}:${port}`,
      `The plugin "${this.deps.id}" may not connect to ${url.hostname}: it is not in permissions.net.`
    );
  }

  /**
   * The path a read or write should use: `raw` (absolute or `~/…`) when it is inside a
   * declared folder, as its real path with links resolved. Outside every declared folder
   * it throws when enforcement is on, and otherwise goes ahead with the path as written.
   */
  path(raw: string, mode: 'read' | 'write'): string {
    if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) {
      throw new Error('ctx.fs needs a path.');
    }
    const expanded = expandHome(raw);
    if (!path.isAbsolute(expanded)) {
      throw new Error('ctx.fs needs an absolute path, or one that starts with "~/".');
    }
    const target = path.resolve(expanded);
    const roots = (mode === 'read' ? this.declared.fs.read : this.declared.fs.write).map((r) =>
      path.resolve(this.deps.dir, expandHome(r))
    );
    for (const root of roots) {
      const inside = containedIn(root, target);
      if (inside) return inside;
    }
    const key = mode === 'read' ? 'permissions.fs.read' : 'permissions.fs.write';
    this.outside(
      mode === 'read' ? 'fs.read' : 'fs.write',
      target,
      `The plugin "${this.deps.id}" may not ${mode === 'read' ? 'read' : 'write'} ${target}: it is not inside a folder in ${key}.`
    );
    return target;
  }

  /** Called by a check that failed. Throws when enforcement is on; otherwise records it and returns. */
  private outside(permission: Permission, subject: string, message: string): void {
    const enforced = this.enforcing;
    this.record(enforced ? 'denied' : 'undeclared', permission, subject);
    if (enforced) {
      throw new PluginPermissionError(
        `${message} Plugin permission enforcement is on.`,
        permission,
        subject
      );
    }
  }

  private record(kind: 'denied' | 'undeclared', permission: Permission, subject: string): void {
    const now = (this.deps.now ?? Date.now)();
    const key = `${kind}|${permission}|${subject}`;
    const seen = this.last.get(key);
    if (seen && now - seen.at < AUDIT_REPEAT_MS) {
      seen.repeated += 1;
      return;
    }
    this.last.set(key, { at: now, repeated: 0 });
    // Keep the map small: a plugin that tries a new name every time must not grow it for ever.
    if (this.last.size > 500) {
      for (const [k, v] of this.last) if (now - v.at >= AUDIT_REPEAT_MS) this.last.delete(k);
    }
    try {
      audit(getStore(), {
        actor: `plugin:${this.deps.id}`,
        action: kind === 'denied' ? 'plugin.permission.denied' : 'plugin.permission.undeclared',
        subject: this.deps.id,
        detail: {
          permission,
          subject,
          enforced: kind === 'denied',
          repeatedBefore: seen?.repeated ?? 0,
        },
      });
    } catch (e) {
      logger.warn('Could not audit a plugin permission check', {
        pluginId: this.deps.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
