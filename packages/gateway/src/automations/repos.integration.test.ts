/**
 * GET /repos and GET /repos/:id through the gateway's HTTP API: behind the
 * token, a local and a remote repository, a folder that has gone, and no
 * secret value anywhere in an answer. (POST /repos is in repos-add.integration.test.ts.)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway.js';
import { createRun } from '../runs.js';
import { issueToken } from '../security/scoped-tokens.js';
import { getStore } from '../store.js';
import { pauseAutomationQueue } from './queue.js';
import { parseSpec } from './spec.js';
import { createAutomation, ensureRepoRow } from './store.js';

const TOKEN = 'repos-test-token-0123456789';
/** What the vault holds: a value that must never appear in an answer. */
const SECRET_VALUE = 'ghp_vault-value-that-must-stay-in-the-vault';

let root: string;
let baseUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
const secrets: Record<string, string> = { ACME_TOKEN: SECRET_VALUE };
/** Every time something asked the vault to open a secret. The Repos routes should never. */
let opened: string[] = [];

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });

interface Repo {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  path: { value: string; exists: boolean; role: string } | null;
  credential: { secret: string; present: boolean } | null;
  reachedWith: { via: string } | null;
  automations: Array<{
    id: string;
    name: string;
    enabled: boolean;
    credential: {
      secret: string;
      present: boolean;
      auth: string;
      reachedWith: { via: string } | null;
    } | null;
  }>;
  runs: { queued: number; running: number };
  lastRun: { id: string; status: string; createdAt: string; finishedAt?: string } | null;
  recentRuns?: Array<{ id: string; childCostUsd?: number }>;
}

async function list(): Promise<Repo[]> {
  const res = await api('/repos');
  expect(res.status).toBe(200);
  return ((await res.json()) as { repos: Repo[] }).repos;
}

const specOf = (name: string, target: string, extra = '') =>
  [
    `name: ${name}`,
    'targets:',
    `  repos: [${target}]`,
    'agent:',
    '  driver: claude-code',
    'prompt: Keep it tidy.',
    extra,
  ].join('\n');

/** A saved automation and the repos row its spec points at, as a first run would make it. */
function repoFor(name: string, target: string, extra = '', clonePath?: string) {
  const source = specOf(name, target, extra);
  const automation = createAutomation(source);
  const repoId = ensureRepoRow(parseSpec(source), clonePath);
  return { automationId: automation.id, repoId };
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-repos-')));
  process.env.CLERQ_KEYCHAIN = 'off';
  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    automations: {
      getSecret: (name) => {
        opened.push(name);
        return secrets[name];
      },
      // Names only, as the real vault lists them: no secret is opened to say it exists.
      secretNames: () => Object.keys(secrets),
      workspaceCacheDir: path.join(root, 'cache'),
      path: () => process.env.PATH ?? '',
    },
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 50; i++) {
    if ((await api('/automations')).status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // Rows made below stand in for runs; nothing here should start an agent.
  pauseAutomationQueue();
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('who may read the repositories', () => {
  it('refuses a request without a token', async () => {
    expect((await fetch(`${baseUrl}/repos`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/repos/repo_x`)).status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await fetch(`${baseUrl}/repos`, { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('refuses a scoped token whose scopes do not name it', async () => {
    const { token } = issueToken({
      kind: 'device',
      subject: 'dev_1',
      scopes: ['GET /runs', 'GET /automations'],
      ttlMs: 60_000,
    });
    for (const p of ['/repos', '/repos/repo_x']) {
      const res = await fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, p).toBe(403);
    }
  });

  it('has no route to change or remove a repository', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const res = await api('/repos', { method, body: '{}' });
      expect(res.status, method).toBe(404);
    }
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await api('/repos/repo_x', { method, body: '{}' });
      expect(res.status, method).toBe(404);
    }
  });
});

describe('the list', () => {
  it('is empty before any automation has been queued', async () => {
    expect(await list()).toEqual([]);
  });

  it('lists a local repository by its folder, with the automations that target it', async () => {
    const dir = path.join(root, 'shop');
    fs.mkdirSync(dir);
    const { automationId } = repoFor('shop-deps', `local:${dir}`);
    const repo = (await list()).find((r) => r.path?.value === dir) as Repo;
    expect(repo).toMatchObject({
      kind: 'local',
      name: 'shop',
      url: null,
      path: { value: dir, exists: true, role: 'repository' },
      credential: null,
      automations: [{ id: automationId, name: 'shop-deps', enabled: false }],
      runs: { queued: 0, running: 0 },
      lastRun: null,
    });
  });

  it('lists a remote repository that has not been cloned, naming its secret and whether it is there', async () => {
    const { repoId } = repoFor(
      'acme-widgets',
      'github:acme/widgets',
      'publish:\n  token_secret: ACME_TOKEN'
    );
    const repo = (await list()).find((r) => r.id === repoId) as Repo;
    expect(repo).toMatchObject({
      kind: 'github',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets.git',
      path: null,
      credential: { secret: 'ACME_TOKEN', present: true },
      automations: [{ name: 'acme-widgets' }],
    });
  });

  it('reports a secret the vault does not hold as missing, still by name', async () => {
    const { repoId } = repoFor('lab-tools', 'gitlab:lab/tools');
    const repo = (await list()).find((r) => r.id === repoId) as Repo;
    expect(repo.kind).toBe('gitlab');
    expect(repo.credential).toEqual({ secret: 'GITLAB_TOKEN', present: false });
  });

  it('shows a remote’s clone, and keeps listing it after the clone is gone', async () => {
    const clone = path.join(root, 'cache', 'widgets-clone');
    fs.mkdirSync(clone, { recursive: true });
    const { repoId } = repoFor(
      'acme-widgets-2',
      'github:acme/widgets',
      'publish:\n  token_secret: ACME_TOKEN',
      clone
    );
    let repo = (await list()).find((r) => r.id === repoId) as Repo;
    expect(repo.path).toEqual({ value: clone, exists: true, role: 'clone' });
    // Two automations target the one remote.
    expect(repo.automations.map((a) => a.name).sort()).toEqual(['acme-widgets', 'acme-widgets-2']);

    fs.rmSync(clone, { recursive: true });
    repo = (await list()).find((r) => r.id === repoId) as Repo;
    expect(repo.path).toEqual({ value: clone, exists: false, role: 'clone' });
  });

  it('keeps a local repository whose folder has gone, and says so', async () => {
    const dir = path.join(root, 'gone-app');
    fs.mkdirSync(dir);
    const { repoId } = repoFor('gone-app-bumps', `local:${dir}`);
    fs.rmSync(dir, { recursive: true });
    const repo = (await list()).find((r) => r.id === repoId) as Repo;
    expect(repo.path).toEqual({ value: dir, exists: false, role: 'repository' });
    expect(repo.automations).toHaveLength(1);
  });

  it('never carries a secret value', async () => {
    const res = await api('/repos');
    expect(await res.text()).not.toContain(SECRET_VALUE);
  });

  it('says whether a secret exists from the vault’s names, without opening one', async () => {
    opened = [];
    const repos = await list();
    const [first] = repos;
    await api(`/repos/${first.id}`);
    expect(repos.some((r) => r.credential?.present)).toBe(true);
    expect(opened).toEqual([]);
  });
});

describe('the secret each automation reaches a repository with', () => {
  it('reads it from each automation’s own spec, so two on one remote can differ', async () => {
    repoFor('pair-a', 'github:acme/pair', 'publish:\n  token_secret: ACME_TOKEN');
    const { repoId } = repoFor(
      'pair-b',
      'github:acme/pair',
      'publish:\n  token_secret: OTHER_TOKEN'
    );
    const repo = (await list()).find((r) => r.id === repoId) as Repo;
    const byName = Object.fromEntries(repo.automations.map((a) => [a.name, a.credential]));
    // No GitHub App is connected here: each reaches it with its own secret, or with nothing.
    expect(byName).toEqual({
      'pair-a': {
        secret: 'ACME_TOKEN',
        present: true,
        auth: 'auto',
        reachedWith: { via: 'secret', secret: 'ACME_TOKEN' },
      },
      'pair-b': {
        secret: 'OTHER_TOKEN',
        present: false,
        auth: 'auto',
        reachedWith: {
          via: 'none',
          secret: 'OTHER_TOKEN',
          note: 'OTHER_TOKEN is not in the vault.',
        },
      },
    });
    // The detail gives the same, and neither answer holds a value.
    const detail = await api(`/repos/${repoId}`);
    const text = await detail.text();
    expect(text).not.toContain(SECRET_VALUE);
    expect((JSON.parse(text) as Repo).automations).toEqual(repo.automations);
  });

  it('uses the forge’s default secret name when the spec names none', async () => {
    const { repoId } = repoFor('default-name', 'gitlab:lab/default-name');
    const repo = (await list()).find((r) => r.id === repoId) as Repo;
    // GitLab has no app: nothing is said of one.
    expect(repo.automations[0].credential).toEqual({
      secret: 'GITLAB_TOKEN',
      present: false,
      auth: 'auto',
      reachedWith: null,
    });
  });

  it('gives a local repository a secret only when the automation pushes or opens a pull request', async () => {
    const dir = path.join(root, 'local-token');
    fs.mkdirSync(dir);
    repoFor('local-quiet', `local:${dir}`, 'publish:\n  push: false\n  pull_request: none');
    let repo = (await list()).find((r) => r.path?.value === dir) as Repo;
    expect(repo.automations.find((a) => a.name === 'local-quiet')?.credential).toBeNull();
    repoFor('local-pushes', `local:${dir}`, 'publish:\n  push: true\n  token_secret: ACME_TOKEN');
    repo = (await list()).find((r) => r.path?.value === dir) as Repo;
    // A local repository's forge is not known here, so nothing is said of an app.
    expect(repo.automations.find((a) => a.name === 'local-pushes')?.credential).toEqual({
      secret: 'ACME_TOKEN',
      present: true,
      auth: 'auto',
      reachedWith: null,
    });
  });
});

describe('what a request costs', () => {
  it('reads the runs table once for the whole list, however many repositories there are', async () => {
    for (let i = 0; i < 6; i++) {
      const dir = path.join(root, `scan-${i}`);
      fs.mkdirSync(dir);
      repoFor(`scan-${i}`, `local:${dir}`);
    }
    const store = getStore();
    const seen: string[] = [];
    const prepare = store.prepare.bind(store);
    const spy = vi.spyOn(store, 'prepare').mockImplementation(((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof store.prepare);
    try {
      const repos = await list();
      expect(repos.length).toBeGreaterThan(6);
      const scans = seen.filter((q) => /\bFROM\s+runs\b/i.test(q));
      expect(scans).toHaveLength(1);
      // And the automations are read once, not once per repository.
      expect(seen.filter((q) => /\bFROM\s+automations\b/i.test(q))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runs against a repository', () => {
  it('counts the queued and the running, and finds the last', async () => {
    const dir = path.join(root, 'api');
    fs.mkdirSync(dir);
    const { automationId, repoId } = repoFor('api-flaky', `local:${dir}`);
    const run = (status: string, finishedAt?: string) => {
      const id = createRun({ trigger: 'manual', automationId, repoId, status: 'queued' });
      getStore()
        .prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?')
        .run(status, finishedAt ?? null, id);
      return id;
    };
    run('done', '2026-11-01T10:00:00.000Z');
    run('queued');
    run('leased');
    run('executing');
    run('awaiting_approval');
    const last = run('failed', '2026-11-12T10:00:00.000Z');

    const repo = (await list()).find((r) => r.id === repoId) as Repo;
    expect(repo.runs).toEqual({ queued: 2, running: 2 });
    expect(repo.lastRun).toMatchObject({
      id: last,
      status: 'failed',
      finishedAt: '2026-11-12T10:00:00.000Z',
    });
  });

  it('gives the detail the latest 20 runs, newest first, and leaves sub-agents under their parent', async () => {
    const dir = path.join(root, 'many');
    fs.mkdirSync(dir);
    const { automationId, repoId } = repoFor('many-runs', `local:${dir}`);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(createRun({ trigger: 'manual', automationId, repoId, status: 'executing' }));
    }
    const parent = ids[24];
    const child = createRun({ trigger: 'subagent', parentRunId: parent, repoId });
    getStore().prepare('UPDATE runs SET cost_usd = 0.25 WHERE id = ?').run(child);

    const res = await api(`/repos/${repoId}`);
    expect(res.status).toBe(200);
    const repo = (await res.json()) as Repo;
    expect(repo.recentRuns).toHaveLength(20);
    expect(repo.recentRuns?.map((r) => r.id)).toEqual(ids.slice(5).reverse());
    expect(repo.recentRuns?.[0].childCostUsd).toBe(0.25);
    expect(repo.recentRuns?.map((r) => r.id)).not.toContain(child);
    expect(repo.runs.running).toBe(25);

    // The roll-up is on the runs list too, so the Runs screen can show it.
    const all = (await (await api('/runs?limit=500')).json()) as {
      runs: Array<{ id: string; childCostUsd?: number }>;
    };
    expect(all.runs.find((r) => r.id === parent)?.childCostUsd).toBe(0.25);
    expect(all.runs.find((r) => r.id === ids[0])?.childCostUsd).toBeUndefined();
  });
});

describe('one repository', () => {
  it('answers the same facts as the list, plus its runs', async () => {
    const [first] = await list();
    const res = await api(`/repos/${first.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Repo;
    const { recentRuns, ...rest } = detail;
    expect(Array.isArray(recentRuns)).toBe(true);
    expect(rest).toEqual(first);
  });

  it('answers 404 for one it does not know', async () => {
    const res = await api('/repos/repo_nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'repo_not_found' });
  });

  it('never carries a secret value', async () => {
    const remote = (await list()).find((r) => r.credential?.secret === 'ACME_TOKEN') as Repo;
    const res = await api(`/repos/${remote.id}`);
    expect(await res.text()).not.toContain(SECRET_VALUE);
  });
});
