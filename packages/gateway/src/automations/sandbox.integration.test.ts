/**
 * Remote repositories and the seatbelt and container profiles, end to end
 * through the gateway's HTTP API.
 *
 * Remotes: `github:acme/remote-app` and `gitlab:group/lab-app` are rewritten by
 * git (url.insteadOf, in a global config this file points git at) to bare
 * repositories on disk, so the clone, fetch and push take the path they would
 * against the forge, with no network. The forge's API is a fake.
 *
 * Seatbelt runs for real on macOS (skipped elsewhere: `sandbox-exec` is macOS
 * only) with the real claude-code driver over a fake `claude` that tries what
 * an injected agent would: write outside its worktree, read a credential,
 * rewrite git's pointers and config. There is no container runtime here, so
 * the container case uses a fake `docker` that records its calls and runs the
 * command on the host: it checks what the gateway asks of the runtime, not
 * what a real engine does with it.
 *
 * HOME is a temporary directory for this file, so the credential paths the
 * profile denies are fakes and no real one is touched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCode } from '@clerq/drivers';
import { cacheKey, type Fetcher } from '@clerq/workspaces';
import { createGateway } from '../gateway.js';

const TOKEN = 'sandbox-test-token-0123456789';
const FORGE_TOKEN = 'ghp_fake-forge-token-for-sandbox-tests';
const LAB_TOKEN = 'gitlab-fake-token-for-sandbox-tests';
const isMac = process.platform === 'darwin';

let root: string;
let home: string;
let cacheDir: string;
let ghBare: string;
let labBare: string;
let bin: string;
let baseUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
let secrets: Record<string, string> = {};
const saved: Record<string, string | undefined> = {};

const requests: Array<{
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> = [];
const fakeForge: Fetcher = async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
  const n = requests.length;
  return {
    ok: true,
    status: 201,
    text: async () =>
      JSON.stringify(
        url.includes('gitlab')
          ? { web_url: `https://gitlab.com/group/lab-app/-/merge_requests/${n}`, iid: n }
          : { html_url: `https://github.com/acme/remote-app/pull/${n}`, number: n }
      ),
  };
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** A bare repository with one commit on main, standing in for a forge's copy. */
function forgeRepo(name: string): string {
  const bare = path.join(root, `${name}.git`);
  const seed = path.join(root, `${name}-seed`);
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'push', '-q', bare, 'main');
  return bare;
}

/** Another commit on the forge's main, as a teammate would push it. */
function pushUpstream(bare: string, file: string): string {
  const clone = fs.mkdtempSync(path.join(root, 'up-'));
  sh(root, 'clone', '-q', bare, clone);
  fs.writeFileSync(path.join(clone, file), 'upstream\n');
  sh(clone, 'add', '.');
  sh(clone, 'commit', '-q', '-m', `add ${file}`);
  sh(clone, 'push', '-q', 'origin', 'main');
  return sh(clone, 'rev-parse', 'HEAD');
}

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  });

async function json<T = Record<string, unknown>>(
  p: string,
  init?: RequestInit
): Promise<{ status: number; body: T }> {
  const res = await api(p, init);
  return { status: res.status, body: (await res.json()) as T };
}

interface RunView {
  id: string;
  status: string;
  exitReason?: string;
  prUrl?: string;
  steps: Array<{
    kind: string;
    status?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
  artifacts: Array<{ id: number; kind: string }>;
}

const finished = (r: RunView) => ['done', 'failed', 'cancelled'].includes(r.status);

async function waitForRun(runId: string, until: (r: RunView) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const { body } = await json<RunView>(`/runs/${runId}`);
    if (until(body)) return body;
    if (Date.now() > end)
      throw new Error(`run ${runId} stuck in ${body.status}: ${body.exitReason ?? ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function create(source: string): Promise<string> {
  const { status, body } = await json<{ id: string; message?: string }>('/automations', {
    method: 'POST',
    body: JSON.stringify({ spec: source }),
  });
  if (status !== 201) throw new Error(`create failed: ${body.message}`);
  return body.id;
}

async function start(id: string): Promise<string> {
  const { status, body } = await json<{ runId: string }>(`/automations/${id}/run`, {
    method: 'POST',
  });
  expect(status).toBe(202);
  return body.runId;
}

/** Approve the push the run waits for, and wait for the run to end. */
async function approveAndFinish(runId: string): Promise<RunView> {
  const waiting = await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
  if (finished(waiting)) return waiting;
  const { body } = await json<{ approvals: Array<{ id: number; runId: string }> }>('/approvals');
  const approval = body.approvals.find((a) => a.runId === runId);
  await api(`/approvals/${approval?.id}/approve`, { method: 'POST' });
  return waitForRun(runId, finished);
}

const stepsNamed = (run: RunView, action: string) =>
  run.steps.filter((s) => s.input?.action === action || s.input?.name === action);

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-sbx-int-')));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  // The user's own Claude Code state, which no run under a profile may touch.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"user":"own"}\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'PRIVATE KEY');
  // The default workspace cache: inside ~/.clerq, which seatbelt denies.
  cacheDir = path.join(home, '.clerq', 'workspaces');
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);

  ghBare = forgeRepo('remote-app');
  labBare = forgeRepo('lab-app');
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(
    gitconfig,
    `[url "${ghBare}"]\n\tinsteadOf = https://github.com/acme/remote-app.git\n` +
      `[url "${labBare}"]\n\tinsteadOf = https://gitlab.com/group/lab-app.git\n` +
      // Never the network: a repository that does not exist is a path that does not.
      `[url "${path.join(root, 'missing.git')}"]\n\tinsteadOf = https://github.com/acme/does-not-exist.git\n` +
      `[protocol "file"]\n\tallow = always\n`
  );

  for (const k of ['HOME', 'GIT_CONFIG_GLOBAL', 'CLERQ_KEYCHAIN', 'CLERQ_CONTAINER_RUNTIME']) {
    saved[k] = process.env[k];
  }
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.CLERQ_KEYCHAIN = 'off';

  // A plain fake agent: writes CHANGED.md and reports a result.
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "changed by the agent" > CHANGED.md
env > "${root}/claude.env"
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CHANGED.md","total_cost_usd":0.01,"usage":{}}'
`,
    { mode: 0o755 }
  );

  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    automations: {
      driverFor: () => claudeCode({ bin: path.join(bin, process.env.FAKE_AGENT ?? 'claude') }),
      fetcher: fakeForge,
      getSecret: (name) => secrets[name],
      workspaceCacheDir: cacheDir,
      path: () => `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      maxConcurrent: 2,
    },
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 0; i < 50; i++) {
    if ((await api('/automations')).status === 200) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  secrets = {
    GITHUB_TOKEN: FORGE_TOKEN,
    GITLAB_TOKEN: LAB_TOKEN,
    ANTHROPIC_KEY: 'sk-ant-fake-key-for-sandbox-tests',
  };
  delete process.env.FAKE_AGENT;
  delete process.env.CLERQ_CONTAINER_RUNTIME;
});

function spec(name: string, repo: string, extra = ''): string {
  return [
    `name: ${name}`,
    'targets:',
    `  repos: [${repo}]`,
    'agent:',
    '  driver: claude-code',
    // A vault key: under a profile the CLI never uses this machine's sign-in.
    '  api_key_secret: ANTHROPIC_KEY',
    'prompt: Add a CHANGED.md file.',
    'gates:',
    '  - run: test -f CHANGED.md',
    extra,
  ].join('\n');
}

describe('remote repositories', () => {
  it('clones a GitHub repository into the cache, works from origin, pushes and opens a draft PR', async () => {
    const id = await create(spec('remote-gh', 'github:acme/remote-app'));
    const runId = await start(id);
    const run = await approveAndFinish(runId);
    expect(run.status).toBe('done');
    expect(run.prUrl).toBe('https://github.com/acme/remote-app/pull/1');

    // Unisolated, and the run says so: no sandbox block means native.
    const note = stepsNamed(run, 'sandbox')[0];
    expect(note.status).toBe('warning');
    expect(String(note.output?.note)).toMatch(/^Unisolated/);

    const clone = stepsNamed(run, 'clone')[0];
    expect(clone.output).toMatchObject({
      url: 'https://github.com/acme/remote-app.git',
      credential: 'vault:GITHUB_TOKEN',
    });
    const clonePath = path.join(cacheDir, cacheKey('https://github.com/acme/remote-app.git'));
    expect(clone.output?.path).toBe(clonePath);
    // The token is never written into the clone's configuration.
    expect(fs.readFileSync(path.join(clonePath, '.git', 'config'), 'utf8')).not.toContain(
      FORGE_TOKEN
    );
    expect(stepsNamed(run, 'fetch')[0].output).toMatchObject({ startRef: 'origin/main' });

    // The branch reached the forge's copy, and the PR was asked of GitHub with the token.
    const branches = sh(ghBare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    expect(branches.split('\n')).toContain(String(requests.at(-1)?.body.head));
    expect(requests.at(-1)?.url).toBe('https://api.github.com/repos/acme/remote-app/pulls');
    expect(requests.at(-1)?.headers.Authorization).toBe(`Bearer ${FORGE_TOKEN}`);
    // The agent never saw it.
    const agentEnv = fs.readFileSync(path.join(root, 'claude.env'), 'utf8');
    expect(agentEnv).not.toContain(FORGE_TOKEN);
    // The run's branch is gone from the cache once pushed; the worktree too.
    expect(sh(clonePath, 'branch', '--list', String(requests.at(-1)?.body.head))).toBe('');
  }, 60_000);

  it('fetches before each run, and starts from what origin has now', async () => {
    const id = await create(spec('remote-again', 'github:acme/remote-app'));
    await approveAndFinish(await start(id));
    const upstream = pushUpstream(ghBare, 'TEAMMATE.md');
    const run = await approveAndFinish(await start(id));
    expect(run.status).toBe('done');
    expect(stepsNamed(run, 'cached')).toHaveLength(1);
    expect(stepsNamed(run, 'clone')).toHaveLength(0);
    const worktree = run.steps.find((s) => s.input?.action === 'worktree');
    expect(worktree?.output?.baseSha).toBe(upstream);
  }, 60_000);

  it('opens a merge request on GitLab with the GitLab token', async () => {
    const id = await create(spec('remote-lab', 'gitlab:group/lab-app'));
    const run = await approveAndFinish(await start(id));
    expect(run.status).toBe('done');
    expect(run.prUrl).toMatch(/gitlab\.com\/group\/lab-app\/-\/merge_requests\/\d+/);
    const req = requests.at(-1);
    expect(req?.url).toBe('https://gitlab.com/api/v4/projects/group%2Flab-app/merge_requests');
    expect(req?.headers['PRIVATE-TOKEN']).toBe(LAB_TOKEN);
    expect(stepsNamed(run, 'clone')[0]?.output?.credential).toBe('vault:GITLAB_TOKEN');
  }, 60_000);

  it('says why a clone failed, without the token', async () => {
    const id = await create(spec('remote-missing', 'github:acme/does-not-exist'));
    const run = await waitForRun(await start(id), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/^Could not clone github:acme\/does-not-exist/);
    expect(JSON.stringify(run)).not.toContain(FORGE_TOKEN);
  }, 60_000);

  it('previews a remote without fetching it', async () => {
    const { body } = await json<{
      repo: Record<string, unknown>;
      checks: Array<{ message: string }>;
    }>('/automations/preview', {
      method: 'POST',
      body: JSON.stringify({ spec: spec('remote-preview', 'gitlab:group/never-cloned') }),
    });
    expect(body.repo).toMatchObject({ forge: 'gitlab', project: 'group/never-cloned' });
    expect(body.repo.cache).toBeUndefined();
    expect(body.checks.map((c) => c.message).join('\n')).toMatch(
      /cloned into the workspace cache on its first run.*with GITLAB_TOKEN/
    );
  });
});

describe('vault values in the stored diff', () => {
  it('redacts the run’s secrets from the diff, and holds the push for a person', async () => {
    fs.writeFileSync(
      path.join(bin, 'claude-leaky'),
      `#!/bin/sh
echo "token=${FORGE_TOKEN}" > LEAK.md
echo "changed" > CHANGED.md
echo '{"type":"result","subtype":"success","is_error":false,"result":"Wrote files","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-leaky';
    const id = await create(spec('leaky', 'github:acme/remote-app'));
    const runId = await start(id);
    const waiting = await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
    expect(waiting.status).toBe('awaiting_approval');
    const { body } = await json<{ approvals: Array<{ runId: string; reason: string }> }>(
      '/approvals'
    );
    expect(body.approvals.find((a) => a.runId === runId)?.reason).toMatch(
      /contains a value from the vault/
    );
    expect(stepsNamed(waiting, 'diff.secrets')).toHaveLength(1);
    const diffArtifact = waiting.artifacts.find((a) => a.kind === 'diff');
    const { body: diff } = await json<{ content: string }>(
      `/runs/${runId}/artifacts/${diffArtifact?.id}`
    );
    expect(diff.content).toContain('token=«redacted»');
    expect(diff.content).not.toContain(FORGE_TOKEN);
    await api(`/runs/${runId}/cancel`, { method: 'POST' });
    await waitForRun(runId, finished);
  }, 60_000);
});

describe.skipIf(!isMac)('the seatbelt profile, end to end (macOS)', () => {
  it('holds the agent and the gates to the worktree, and keeps git’s own files out of reach', async () => {
    const escape = path.join(root, 'escaped.txt');
    fs.writeFileSync(
      path.join(bin, 'claude-probe'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
try() { if sh -c "$1" >/dev/null 2>&1; then echo yes; else echo no; fi; }
echo "changed" > CHANGED.md
outside=$(try 'echo x > "${escape}"')
ssh=$(try 'cat "${home}/.ssh/id_test"')
gitfile=$(try 'echo "gitdir: /tmp/evil" > .git')
common=$(git rev-parse --git-common-dir)
config=$(try "echo '[core]' >> '$common/config'")
hook=$(try "echo evil > '$common/hooks/pre-push'")
status=$(try 'git status --porcelain')
commit=$(try 'git add -A && git -c user.name=a -c user.email=a@a commit -qm x')
state=$(try 'mkdir -p "$HOME/.claude" && echo s > "$HOME/.claude/state"')
runhome=$([ "$HOME" != "${home}" ] && [ "$CLAUDE_CONFIG_DIR" = "$HOME/.claude" ] && echo yes || echo no)
settings=$(try 'echo {} > "${home}/.claude/settings.json"')
skill=$(try 'mkdir -p "${home}/.claude/skills/x"')
wt=$(pwd)
swap=$(try "mv '$wt' '$wt.moved'")
statedir=$(try 'mv "${home}/.claude" "${home}/.claude-old"')
open=$(lsappinfo front 2>/dev/null | grep -q ASN && echo yes || echo no)
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"outside=$outside ssh=$ssh gitfile=$gitfile config=$config hook=$hook status=$status commit=$commit state=$state runhome=$runhome settings=$settings skill=$skill swap=$swap statedir=$statedir launchservices=$open proxy=\${HTTPS_PROXY:+set}\\",\\"total_cost_usd\\":0,\\"usage\\":{}}"
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-probe';
    const id = await create(
      spec(
        'seatbelted',
        'github:acme/remote-app',
        [
          '  - run: "! touch ' + path.join(root, 'gate-escaped.txt') + '"',
          'sandbox:',
          '  profile: seatbelt',
          '  network: [registry.npmjs.org]',
          'publish:',
          '  push: false',
        ].join('\n')
      )
    );
    const run = await waitForRun(await start(id), finished);
    expect(run.status, run.exitReason).toBe('done');
    const summary = run.steps
      .filter((s) => s.kind === 'llm')
      .map((s) => JSON.stringify(s.output))
      .join(' ');
    expect(summary).toContain(
      'outside=no ssh=no gitfile=no config=no hook=no status=yes commit=no state=yes runhome=yes settings=no skill=no swap=no statedir=no launchservices=no proxy=set'
    );
    expect(fs.existsSync(escape)).toBe(false);
    expect(fs.existsSync(path.join(root, 'gate-escaped.txt'))).toBe(false);
    // The user's own Claude Code state is as it was.
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(
      '{"user":"own"}\n'
    );

    const note = stepsNamed(run, 'sandbox')[0];
    expect(note.status).toBe('ok');
    expect(String(note.output?.note)).toMatch(/Isolated \(profile seatbelt\)/);
    const agent = note.output?.agent as { network: string[]; denyRead: string[] };
    const gates = note.output?.gates as { network: string[] };
    // The agent reaches its provider too; the gates only the spec's hosts.
    expect(agent.network).toEqual(
      expect.arrayContaining(['registry.npmjs.org', 'api.anthropic.com'])
    );
    expect(gates.network).toEqual(['registry.npmjs.org']);
    expect(agent.denyRead).toContain(path.join(home, '.ssh'));
    // The agent's own change was committed by the gateway, after the agent.
    expect(run.exitReason).toMatch(/not pushed/);
  }, 60_000);
});

describe('what the gateway does after the agent', () => {
  /** A fake agent that plants a nested repository whose config runs a command. */
  function nestedRepoAgent(marker: string): void {
    fs.writeFileSync(
      path.join(bin, 'claude-nested'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "changed" > CHANGED.md
mkdir sub && cd sub && git init -q && git -c user.name=a -c user.email=a@a commit -q --allow-empty -m x
printf '#!/bin/sh\\ntouch ${marker}\\n' > ../fsm.sh && chmod +x ../fsm.sh
git config core.fsmonitor "$(cd .. && pwd)/fsm.sh"
cd .. && git add sub
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-nested';
  }

  const profiles = isMac ? ['native', 'seatbelt'] : ['native'];
  for (const profile of profiles) {
    it(`runs no code from a nested repository the agent staged, and refuses to commit it (${profile})`, async () => {
      const marker = path.join(root, `fsmonitor-ran-${profile}`);
      nestedRepoAgent(marker);
      const id = await create(
        spec(
          `nested-${profile}`,
          'github:acme/remote-app',
          `sandbox:\n  profile: ${profile}\npublish:\n  push: false`
        )
      );
      const run = await waitForRun(await start(id), finished);
      expect(run.status).toBe('failed');
      expect(run.exitReason).toMatch(/nested git repository \(a submodule entry\) at sub/);
      // The gateway ran status, add and the diff in that worktree: none ran the command.
      expect(fs.existsSync(marker)).toBe(false);
    }, 60_000);
  }

  it('fails a run whose worktree was swapped for a link, without running git in it', async () => {
    const marker = path.join(root, 'swapped-git-ran');
    fs.writeFileSync(
      path.join(bin, 'claude-swap'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
wt=$(pwd)
evil="${root}/evil-$$"
mkdir -p "$evil" && git init -q "$evil"
printf '#!/bin/sh\\ntouch ${marker}\\n' > "$evil/fsm.sh" && chmod +x "$evil/fsm.sh"
git -C "$evil" config core.fsmonitor "$evil/fsm.sh"
echo x > "$evil/CHANGED.md"
mv "$wt" "$wt.moved" && ln -s "$evil" "$wt"
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-swap';
    // Native: nothing stops the agent; the gateway's own check must.
    const id = await create(spec('swapped', 'github:acme/remote-app', 'publish:\n  push: false'));
    const run = await waitForRun(await start(id), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/worktree was tampered with.*no git command was run in it/);
    expect(fs.existsSync(marker)).toBe(false);
    // The link put in its place is removed, not followed.
    const worktree = String(run.steps.find((s) => s.input?.action === 'worktree')?.output?.path);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(fs.existsSync(`${worktree}.moved`)).toBe(true);
  }, 60_000);

  it('finds a vault value hidden from the diff as binary or -diff, and redacts the PR', async () => {
    fs.writeFileSync(
      path.join(bin, 'claude-hide'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "hidden.txt -diff" > .gitattributes
echo "${FORGE_TOKEN}" > hidden.txt
echo "changed" > CHANGED.md
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-hide';
    const id = await create(spec('hidden-secret', 'github:acme/remote-app'));
    const runId = await start(id);
    const waiting = await waitForRun(runId, (r) => r.status === 'awaiting_approval' || finished(r));
    // Not pushed on its own: the scan read hidden.txt as text.
    expect(waiting.status).toBe('awaiting_approval');
    expect(stepsNamed(waiting, 'diff.secrets')).toHaveLength(1);
    await api(`/runs/${runId}/cancel`, { method: 'POST' });
    await waitForRun(runId, finished);
  }, 60_000);
});

describe.skipIf(!isMac)('what a run leaves running (macOS, seatbelt)', () => {
  it('stops a process that left the group with setsid before the gateway commits', async () => {
    fs.writeFileSync(
      path.join(bin, 'claude-straggler'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "changed" > CHANGED.md
# Out of the process group, quiet, and writing into the worktree later.
/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); close STDOUT; close STDERR; close STDIN; sleep 3; open F, ">", "LATE.md"; print F "late\\n"; close F' &
sleep 1
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-straggler';
    const id = await create(
      spec(
        'straggler',
        'github:acme/remote-app',
        'sandbox:\n  profile: seatbelt\npublish:\n  push: false'
      )
    );
    const run = await waitForRun(await start(id), finished);
    expect(run.status, run.exitReason).toBe('done');
    const step = stepsNamed(run, 'process.stragglers')[0];
    expect(step?.output?.stopped).toEqual([
      expect.objectContaining({ command: expect.stringContaining('perl') }),
    ]);
    await new Promise((r) => setTimeout(r, 3_500));
    const diff = run.artifacts.find((a) => a.kind === 'diff');
    const { body } = await json<{ content: string }>(`/runs/${run.id}/artifacts/${diff?.id}`);
    expect(body.content).toContain('CHANGED.md');
    expect(body.content).not.toContain('LATE.md');
  }, 60_000);
});

describe('the run commit', () => {
  it('pushes only the base plus the run commit, whatever merge the agent set up', async () => {
    fs.writeFileSync(
      path.join(bin, 'claude-merge'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
# A private commit the diff never shows, then planted as a merge parent.
gd=$(git rev-parse --git-dir)
echo "history nobody reviews" > hidden.txt
git add hidden.txt
tree=$(git write-tree)
hidden=$(git -c user.name=a -c user.email=a@a commit-tree "$tree" -p HEAD -m private)
git rm -q --cached hidden.txt && rm hidden.txt
echo "$hidden" > "$gd/MERGE_HEAD"
echo "$hidden" > "${root}/hidden-commit"
echo "changed" > CHANGED.md
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-merge';
    const id = await create(spec('merge-planted', 'github:acme/remote-app'));
    const run = await approveAndFinish(await start(id));
    expect(run.status, run.exitReason).toBe('done');
    const branch = String(requests.at(-1)?.body.head);
    const parents = sh(ghBare, 'rev-list', '--parents', '-n', '1', branch).split(' ');
    expect(parents).toHaveLength(2);
    const hidden = fs.readFileSync(path.join(root, 'hidden-commit'), 'utf8').trim();
    expect(parents[1]).not.toBe(hidden);
    expect(() => sh(ghBare, 'cat-file', '-e', hidden)).toThrow();
  }, 60_000);
});

describe('the container profile, against a fake runtime', () => {
  it('runs the agent and the gates in named containers with the git directory read-only, and removes them', async () => {
    const calls = path.join(root, 'docker.calls');
    const docker = path.join(bin, 'docker-fake');
    fs.writeFileSync(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
# The egress proxy container: started, and listening at once.
if [ "$1" = "run" ] && [ "$2" = "-d" ]; then exit 0; fi
if [ "$1" = "logs" ]; then echo '{"event":"listening","port":3128}'; exit 0; fi
if [ "$1" = "run" ]; then
  # Run what follows the image on the host, in the working directory.
  while [ "$1" != "fake-image" ]; do
    if [ "$1" = "-w" ]; then shift; cd "$1"; fi
    shift
  done
  shift
  exec "$@"
fi
exit 0
`,
      { mode: 0o755 }
    );
    process.env.CLERQ_CONTAINER_RUNTIME = docker;
    secrets.ANTHROPIC_KEY = 'sk-ant-fake-key-for-container-test';
    const id = await create(
      spec(
        'containered',
        'github:acme/remote-app',
        [
          'sandbox:',
          '  profile: container',
          '  image: fake-image',
          'publish:',
          '  push: false',
        ].join('\n')
      )
    );
    const run = await waitForRun(await start(id), finished);
    expect(run.status, run.exitReason).toBe('done');

    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    const runs = lines.filter((l) => l.startsWith('run ') && !l.startsWith('run -d'));
    // The agent, then the gate: each in a container of its own, named for the run.
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatch(/ fake-image claude -p /);
    expect(runs[1]).toMatch(/ fake-image \/bin\/sh -c test -f CHANGED.md$/);
    const worktree = String(run.steps.find((s) => s.input?.action === 'worktree')?.output?.path);
    const common = path.join(cacheDir, cacheKey('https://github.com/acme/remote-app.git'), '.git');
    for (const r of runs) {
      expect(r).toContain(`--name clerq-${run.id}-`);
      expect(r).toContain(`--mount type=bind,source=${worktree},target=${worktree} `);
      expect(r).toContain(`--mount type=bind,source=${common},target=${common},readonly`);
      expect(r).toContain(
        `--mount type=bind,source=${worktree}/.git,target=${worktree}/.git,readonly`
      );
    }
    // The agent reaches its model provider through an egress proxy container on
    // an internal network; the gate, with no hosts in the spec, has no network.
    const agentName = /--name (\S+)/.exec(runs[0])?.[1] as string;
    expect(lines).toContain(
      `network create --internal --label clerq.run=${run.id} ${agentName}-net`
    );
    expect(lines.some((l) => l.startsWith(`run -d --name ${agentName}-egress `))).toBe(true);
    // The proxy's script spans lines in the log; its configuration is the last argument.
    const config = /\{"rules":.*"port":3128\}/.exec(fs.readFileSync(calls, 'utf8'))?.[0] as string;
    expect(JSON.parse(config)).toEqual({
      rules: [
        { host: 'api.anthropic.com' },
        { host: 'console.anthropic.com' },
        { host: 'claude.ai' },
      ],
      port: 3128,
    });
    expect(runs[0]).toContain(`--network ${agentName}-net`);
    expect(runs[0]).toContain('-e HTTPS_PROXY');
    expect(runs[1]).toContain('--network none');
    expect(lines).toContain(`network rm ${agentName}-net`);
    // The key goes by name, never by value.
    expect(runs[0]).toContain('-e ANTHROPIC_API_KEY');
    expect(lines.join('\n')).not.toContain('sk-ant-fake-key-for-container-test');
    // Every container is removed by name once its command has ended.
    for (const r of runs) {
      const name = /--name (\S+)/.exec(r)?.[1];
      expect(lines).toContain(`rm -f ${name} ${name}-egress`);
    }
  }, 60_000);

  it('refuses to start when there is no runtime, before doing any work', async () => {
    process.env.CLERQ_CONTAINER_RUNTIME = path.join(root, 'no-such-docker');
    secrets.ANTHROPIC_KEY = 'sk-ant-fake-key-for-container-test';
    const id = await create(
      spec(
        'no-runtime',
        'github:acme/remote-app',
        'sandbox:\n  profile: container\n  image: fake-image'
      )
    );
    const run = await waitForRun(await start(id), finished);
    expect(run.status).toBe('failed');
    expect(run.exitReason).toMatch(/CLERQ_CONTAINER_RUNTIME.*was not found/);
    expect(run.steps.some((s) => s.input?.action === 'worktree')).toBe(false);
  }, 60_000);
});
