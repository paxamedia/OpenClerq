/**
 * A database the gateway must not run on: one from a newer OpenClerq, or one
 * that could not be copied before an upgrade. The gateway stops serving and
 * says why, in plain words; it does not start half-working.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, StoreBackupError, StoreTooNewError, openDatabase } from '@clerq/store';
import { createGateway } from './gateway.js';
import { closeStore } from './store.js';

const NEWEST = MIGRATIONS[MIGRATIONS.length - 1].id;
const TOKEN = 'store-refusal-test-token-0123456789';

let root: string;
let savedKeychain: string | undefined;

beforeAll(() => {
  savedKeychain = process.env.CLERQ_KEYCHAIN;
  process.env.CLERQ_KEYCHAIN = 'off';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-refusal-'));
});

afterAll(() => {
  closeStore();
  fs.rmSync(root, { recursive: true, force: true });
  if (savedKeychain === undefined) delete process.env.CLERQ_KEYCHAIN;
  else process.env.CLERQ_KEYCHAIN = savedKeychain;
});

/** A store file at `upTo`, holding one session; `extra` adds migration ids on top. */
async function seed(file: string, upTo: number, extra: number[] = []): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = await openDatabase(file);
  db.exec(
    'CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
  );
  for (const m of MIGRATIONS.filter((x) => x.id <= upTo)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x');
  }
  for (const id of extra) {
    db.prepare("INSERT INTO schema_migrations VALUES (?, 'from_the_future', 'x')").run(id);
  }
  db.prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('ses_1', 'kept', 'a', 'a')"
  ).run();
  db.close();
}

const start = (dbPath: string) =>
  createGateway({ port: 0, authToken: TOKEN, dbPath, modulesDir: '/nonexistent-modules-dir-xyz' });

describe('the gateway on a database from a newer OpenClerq', () => {
  it('rejects `ready` with the reason and stops serving', async () => {
    const file = path.join(root, 'newer', 'clerq.db');
    await seed(file, NEWEST, [NEWEST + 2]);
    const { server, ready } = start(file);

    const error = await ready.then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(StoreTooNewError);
    expect((error as Error).message).toContain(
      `written by a newer OpenClerq (schema ${NEWEST + 2}); this build knows schema ${NEWEST}.`
    );
    // It is not listening any more.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.listening).toBe(false);
    // And it changed nothing: no copy, no migration.
    expect(fs.existsSync(path.join(root, 'newer', 'backups'))).toBe(false);
    const db = await openDatabase(file);
    expect(db.prepare('SELECT max(id) AS n FROM schema_migrations').get()).toEqual({
      n: NEWEST + 2,
    });
    db.close();
  });

  it('does the same when the copy before an upgrade cannot be made', async () => {
    const file = path.join(root, 'nocopy', 'clerq.db');
    await seed(file, 12);
    fs.writeFileSync(path.join(root, 'nocopy', 'backups'), 'in the way');
    const { server, ready } = start(file);
    const error = await ready.then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(StoreBackupError);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.listening).toBe(false);
    const db = await openDatabase(file);
    expect(db.prepare('SELECT max(id) AS n FROM schema_migrations').get()).toEqual({ n: 12 });
    db.close();
  });

  it('upgrades a database that is only behind, and serves', async () => {
    const file = path.join(root, 'behind', 'clerq.db');
    await seed(file, 12);
    const { server, ready } = start(file);
    await ready;
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/version`);
      expect(await res.json()).toMatchObject({ store: { schema: NEWEST } });
      expect(fs.readdirSync(path.join(root, 'behind', 'backups'))).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeStore();
    }
  });
});

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.skipIf(!fs.existsSync(CLI))(
  'the gateway program on a database from a newer OpenClerq',
  () => {
    it('prints the reason, and exits with a failure code instead of serving', async () => {
      const home = path.join(root, 'cli-home');
      await seed(path.join(home, '.clerq', 'clerq.db'), NEWEST, [NEWEST + 1]);
      const child = spawn(process.execPath, [CLI], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLERQ_PORT: '0',
          CLERQ_GATEWAY_TOKEN: TOKEN,
          CLERQ_KEYCHAIN: 'off',
        },
        cwd: home,
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(code).toBe(1);
      expect(stderr).toContain(
        '[Clerq] Not started: This database was written by a newer OpenClerq'
      );
      expect(stderr).toContain(`schema ${NEWEST + 1}`);
      expect(stderr).toContain('restore a backup from ~/.clerq/backups.');
    }, 30_000);
  }
);
