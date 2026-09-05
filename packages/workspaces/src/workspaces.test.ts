import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openWorkspace,
  ensureRepo,
  cacheKey,
  pruneWorktrees,
  WorkspaceError,
  git,
  isRepo,
  defaultBranch,
} from './index.js';
import { buildPullRequest, openPullRequest, renderBranchName, PublishError } from './publish.js';

let tmp: string;
let origin: string;
let local: string;
let cacheDir: string;

/** A bare repo standing in for a remote, plus a working clone with one commit. */
async function makeFixture(root: string): Promise<{ origin: string; local: string }> {
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  await git(['init', '--bare', '--initial-branch=main', bare], { cwd: root });
  await git(['init', '--initial-branch=main'], { cwd: work });
  await git(['config', 'user.email', 'test@example.com'], { cwd: work });
  await git(['config', 'user.name', 'Test'], { cwd: work });
  fs.writeFileSync(path.join(work, 'README.md'), '# fixture\n');
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'initial'], { cwd: work });
  await git(['remote', 'add', 'origin', bare], { cwd: work });
  await git(['push', '-u', 'origin', 'main'], { cwd: work });
  return { origin: bare, local: work };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-ws-'));
  cacheDir = path.join(tmp, 'cache');
  const f = await makeFixture(tmp);
  origin = f.origin;
  local = f.local;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cacheKey', () => {
  it('is stable and ignores .git, trailing slash and case', () => {
    const a = cacheKey('https://github.com/o/r.git');
    expect(cacheKey('https://github.com/o/r')).toBe(a);
    expect(cacheKey('https://github.com/o/r/')).toBe(a);
    expect(cacheKey('https://GitHub.com/O/R.git')).toBe(a);
  });

  it('separates different repositories', () => {
    expect(cacheKey('https://github.com/o/one')).not.toBe(cacheKey('https://github.com/o/two'));
  });

  it('produces a filesystem-safe name carrying the repo name', () => {
    const k = cacheKey('git@github.com:owner/my-repo.git');
    expect(k).toMatch(/^my-repo-[0-9a-f]{12}$/);
  });
});

describe('ensureRepo', () => {
  it('uses a local repository in place', async () => {
    expect(await ensureRepo({ kind: 'local', location: local })).toBe(path.resolve(local));
  });

  it('rejects a path that does not exist', async () => {
    await expect(ensureRepo({ kind: 'local', location: path.join(tmp, 'nope') })).rejects.toThrow(
      /does not exist/
    );
  });

  it('rejects a directory that is not a repository', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    await expect(ensureRepo({ kind: 'local', location: plain })).rejects.toThrow(
      /Not a git repository/
    );
  });

  it('clones a remote into the cache and reuses it', async () => {
    const first = await ensureRepo({ kind: 'remote', location: origin }, { cacheDir });
    expect(await isRepo(first)).toBe(true);
    expect(first.startsWith(cacheDir)).toBe(true);

    // Second call fetches rather than re-cloning, and lands in the same place.
    const second = await ensureRepo({ kind: 'remote', location: origin }, { cacheDir });
    expect(second).toBe(first);
  });
});

describe('openWorkspace', () => {
  it('creates an isolated worktree at the default branch, detached', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir });
    try {
      expect(fs.existsSync(path.join(ws.path, 'README.md'))).toBe(true);
      expect(ws.path).not.toBe(path.resolve(local));
      expect(ws.baseSha).toMatch(/^[0-9a-f]{40}$/);
      // The source repo already has main checked out; git would refuse to
      // check it out again, so a branchless workspace detaches.
      expect(ws.detached).toBe(true);
    } finally {
      await ws.dispose();
    }
  });

  it('refuses to push from a detached workspace, with a clear reason', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir });
    try {
      await expect(ws.push()).rejects.toThrow(/detached and has no branch/);
    } finally {
      await ws.dispose();
    }
  });

  it('is not detached when a branch is requested', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'nd' });
    try {
      expect(ws.detached).toBe(false);
    } finally {
      await ws.dispose();
    }
  });

  it('creates a new branch when asked', async () => {
    const ws = await openWorkspace(
      { kind: 'local', location: local },
      { cacheDir, branch: 'auto/test-1' }
    );
    try {
      expect(ws.branch).toBe('auto/test-1');
      const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path });
      expect(r.stdout.trim()).toBe('auto/test-1');
    } finally {
      await ws.dispose();
    }
  });

  it('isolates concurrent runs from each other', async () => {
    const a = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'a' });
    const b = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'b' });
    try {
      fs.writeFileSync(path.join(a.path, 'only-in-a.txt'), 'a');
      expect(fs.existsSync(path.join(b.path, 'only-in-a.txt'))).toBe(false);
      expect(a.path).not.toBe(b.path);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it('leaves the source repository untouched', async () => {
    const before = fs.readdirSync(local).sort();
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'x' });
    fs.writeFileSync(path.join(ws.path, 'scratch.txt'), 'x');
    await ws.commitAll('scratch');
    await ws.dispose();
    expect(fs.readdirSync(local).sort()).toEqual(before);
  });

  it('dispose removes the worktree and is safe to repeat', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'y' });
    const p = ws.path;
    await ws.dispose();
    expect(fs.existsSync(p)).toBe(false);
    await ws.dispose();
  });
});

describe('changes and commits', () => {
  it('reports no changes on a fresh workspace', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'c1' });
    try {
      expect(await ws.hasChanges()).toBe(false);
      expect(await ws.commitAll('nothing')).toBeNull();
    } finally {
      await ws.dispose();
    }
  });

  it('sees untracked files as changes', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'c2' });
    try {
      fs.writeFileSync(path.join(ws.path, 'new.txt'), 'hi');
      expect(await ws.status()).toContain('new.txt');
      expect(await ws.hasChanges()).toBe(true);
    } finally {
      await ws.dispose();
    }
  });

  it('commits with a machine-identifiable trailer', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'c3' });
    try {
      fs.writeFileSync(path.join(ws.path, 'a.txt'), '1');
      const sha = await ws.commitAll('add a');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const msg = await git(['log', '-1', '--pretty=%B'], { cwd: ws.path });
      expect(msg.stdout).toContain('add a');
      expect(msg.stdout).toContain('Generated-by: OpenClerq');
    } finally {
      await ws.dispose();
    }
  });

  it('does not let a crafted commit message become a shell command', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'c4' });
    try {
      fs.writeFileSync(path.join(ws.path, 'b.txt'), '1');
      const evil = 'fix; touch /tmp/clerq-pwned-$(whoami); echo `id`';
      await ws.commitAll(evil);
      const msg = await git(['log', '-1', '--pretty=%B'], { cwd: ws.path });
      // Recorded verbatim, not executed.
      expect(msg.stdout).toContain(evil);
    } finally {
      await ws.dispose();
    }
  });

  it('computes a diff stat against the base commit', async () => {
    const ws = await openWorkspace({ kind: 'local', location: local }, { cacheDir, branch: 'c5' });
    try {
      fs.writeFileSync(path.join(ws.path, 'x.txt'), 'one\ntwo\n');
      await ws.commitAll('add x');
      const stat = await ws.diffStat();
      expect(stat.filesChanged).toBe(1);
      expect(stat.insertions).toBe(2);
      expect(stat.files).toEqual(['x.txt']);
      expect(await ws.diff()).toContain('+one');
    } finally {
      await ws.dispose();
    }
  });
});

describe('push', () => {
  it('pushes a branch to the origin', async () => {
    const ws = await openWorkspace(
      { kind: 'remote', location: origin },
      { cacheDir, branch: 'auto/pushed' }
    );
    try {
      fs.writeFileSync(path.join(ws.path, 'pushed.txt'), 'yes');
      await ws.commitAll('add pushed');
      await ws.push();
      const refs = await git(['branch', '--list'], { cwd: origin });
      expect(refs.stdout).toContain('auto/pushed');
    } finally {
      await ws.dispose();
    }
  });
});

describe('pruneWorktrees', () => {
  it('runs without throwing on a healthy repo', async () => {
    await expect(pruneWorktrees(local)).resolves.toBeUndefined();
  });
});

describe('defaultBranch', () => {
  it('finds main in the fixture', async () => {
    expect(await defaultBranch(local)).toBe('main');
  });
});

describe('renderBranchName', () => {
  it('expands the documented placeholders', () => {
    const out = renderBranchName('auto/{{automation}}/{{date}}', {
      automation: 'dep-triage',
      now: new Date('2026-09-05T08:30:00Z'),
    });
    expect(out).toBe('auto/dep-triage/2026-09-05');
  });

  it('sanitises characters git refuses in a ref', () => {
    const out = renderBranchName('auto/{{automation}}', { automation: 'a b~c^d:e?f*g[h]' });
    expect(out).not.toMatch(/[\s~^:?*[\]\\]/);
  });

  it('refuses a template that renders to nothing', () => {
    expect(() => renderBranchName('///', {})).toThrow(PublishError);
  });

  it('avoids the .lock suffix git reserves', () => {
    expect(renderBranchName('branch.lock', {})).toBe('branch-lock');
  });
});

describe('pull requests', () => {
  const base = {
    project: 'owner/repo',
    title: 'Nightly dependency triage',
    body: 'Automated.',
    head: 'auto/deps',
    base: 'main',
    token: 'tok_secret_value',
  };

  it('builds a draft GitHub request by default', () => {
    const r = buildPullRequest({ ...base, forge: 'github' });
    expect(r.url).toBe('https://api.github.com/repos/owner/repo/pulls');
    expect(JSON.parse(r.body).draft).toBe(true);
    expect(r.headers.Authorization).toBe('Bearer tok_secret_value');
  });

  it('honours an explicit non-draft', () => {
    const r = buildPullRequest({ ...base, forge: 'github', draft: false });
    expect(JSON.parse(r.body).draft).toBe(false);
  });

  it('marks a GitLab draft in the title, as GitLab expects', () => {
    const r = buildPullRequest({ ...base, forge: 'gitlab' });
    expect(r.url).toContain('/projects/owner%2Frepo/merge_requests');
    expect(JSON.parse(r.body).title).toMatch(/^Draft: /);
    expect(r.headers['PRIVATE-TOKEN']).toBe('tok_secret_value');
  });

  it('supports a self-hosted API base', () => {
    const r = buildPullRequest({ ...base, forge: 'github', apiBase: 'https://ghe.example/api/v3' });
    expect(r.url).toBe('https://ghe.example/api/v3/repos/owner/repo/pulls');
  });

  it('refuses without a token, or when head equals base', () => {
    expect(() => buildPullRequest({ ...base, forge: 'github', token: '' })).toThrow(/token/);
    expect(() => buildPullRequest({ ...base, forge: 'github', head: 'main' })).toThrow(
      /nothing to open/
    );
  });

  it('returns the URL the forge reports', async () => {
    const res = await openPullRequest({ ...base, forge: 'github' }, async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ html_url: 'https://github.com/o/r/pull/7', number: 7 }),
    }));
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 });
  });

  it('reads a GitLab merge request response', async () => {
    const res = await openPullRequest({ ...base, forge: 'gitlab' }, async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({ web_url: 'https://gitlab.com/o/r/-/merge_requests/3', iid: 3 }),
    }));
    expect(res).toEqual({ url: 'https://gitlab.com/o/r/-/merge_requests/3', number: 3 });
  });

  it('surfaces a refusal without leaking the token', async () => {
    const err = await openPullRequest({ ...base, forge: 'github' }, async () => ({
      ok: false,
      status: 422,
      text: async () => '{"message":"Validation Failed"}',
    })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as Error).message).toContain('422');
    expect((err as Error).message).not.toContain('tok_secret_value');
  });

  it('rejects a non-JSON response', async () => {
    await expect(
      openPullRequest({ ...base, forge: 'github' }, async () => ({
        ok: true,
        status: 200,
        text: async () => '<html>nope</html>',
      }))
    ).rejects.toThrow(/not JSON/);
  });
});
