import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePrivateDir,
  restrictFile,
  writePrivateFile,
  appendPrivateFile,
  secureClerqHome,
} from './local-files.js';
import { openStore } from './index.js';

const posix = process.platform !== 'win32';
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { HOME: process.env.HOME, CLERQ_KEEP_PERMISSIONS: process.env.CLERQ_KEEP_PERMISSIONS };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-perm-'));
  process.env.HOME = root;
  delete process.env.CLERQ_KEEP_PERMISSIONS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!posix)('private local files', () => {
  it('creates the directory readable only by this account', () => {
    const dir = path.join(root, '.clerq');
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it('tightens a directory an earlier build left world-traversable', () => {
    const dir = path.join(root, '.clerq');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    expect(ensurePrivateDir(dir)).toBe(true);
    expect(modeOf(dir)).toBe(0o700);
  });

  it('leaves an existing directory alone when told to', () => {
    process.env.CLERQ_KEEP_PERMISSIONS = '1';
    const dir = path.join(root, 'shared');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o750);
    expect(ensurePrivateDir(dir)).toBe(false);
    expect(modeOf(dir)).toBe(0o750);
  });

  it('writes a file private, and tightens one that existed wider', () => {
    const file = path.join(root, '.clerq', 'secret.txt');
    writePrivateFile(file, 'one');
    expect(modeOf(file)).toBe(0o600);

    fs.chmodSync(file, 0o644);
    writePrivateFile(file, 'two');
    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
  });

  it('makes a rewritten file private even under the opt-out, since it is ours', () => {
    process.env.CLERQ_KEEP_PERMISSIONS = '1';
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o644);
    writePrivateFile(file, 'y');
    expect(modeOf(file)).toBe(0o600);
  });

  it('appends privately, but respects the opt-out for a file it did not create', () => {
    const fresh = path.join(root, 'fresh.log');
    appendPrivateFile(fresh, 'a\n');
    expect(modeOf(fresh)).toBe(0o600);

    process.env.CLERQ_KEEP_PERMISSIONS = '1';
    const shared = path.join(root, 'shared.log');
    fs.writeFileSync(shared, 'old\n');
    fs.chmodSync(shared, 0o640);
    appendPrivateFile(shared, 'new\n');
    expect(modeOf(shared)).toBe(0o640);
    expect(fs.readFileSync(shared, 'utf8')).toBe('old\nnew\n');
  });

  it('reports a file it left alone', () => {
    expect(restrictFile(path.join(root, 'absent'))).toBe(false);
  });

  it('repairs an existing install: the directory, the API key and the database', () => {
    // The scenario the audit found: ~/.clerq created 0755 by one code path, with
    // the API key and every conversation readable by other accounts.
    const home = path.join(root, '.clerq');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    for (const name of ['.env', 'clerq.db', 'secrets.vault', 'system-prompt.txt']) {
      fs.writeFileSync(path.join(home, name), 'x');
      fs.chmodSync(path.join(home, name), 0o644);
    }

    const changed = secureClerqHome();

    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(path.join(home, '.env'))).toBe(0o600);
    expect(modeOf(path.join(home, 'clerq.db'))).toBe(0o600);
    expect(modeOf(path.join(home, 'secrets.vault'))).toBe(0o600);
    // Not sensitive, and unreachable anyway now that the directory is private.
    expect(modeOf(path.join(home, 'system-prompt.txt'))).toBe(0o644);
    expect(changed).toContain(home);
    expect(changed).toContain(path.join(home, '.env'));
  });

  it('does nothing before there is anything to secure', () => {
    expect(secureClerqHome()).toEqual([]);
    expect(fs.existsSync(path.join(root, '.clerq'))).toBe(false);
  });

  it('opens the default store privately even when the directory pre-existed wide', async () => {
    const home = path.join(root, '.clerq');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);

    const db = await openStore();
    db.close();

    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(path.join(home, 'clerq.db'))).toBe(0o600);
  });

  it('creates a custom location privately but leaves an existing directory as it is', async () => {
    const shared = path.join(root, 'srv');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o750);

    const db = await openStore(path.join(shared, 'clerq.db'));
    db.close();

    expect(modeOf(shared)).toBe(0o750);
    // The database it created is still this account's alone.
    expect(modeOf(path.join(shared, 'clerq.db'))).toBe(0o600);
  });
});
