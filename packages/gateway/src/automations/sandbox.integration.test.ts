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
 * The last describe runs the container profile against a real engine, and only
 * when CLERQ_TEST_CONTAINER_RUNTIME names one (`docker` or `podman`): the
 * `container-profile` job in ci.yml. It pulls two small public images, runs a
 * scripted builtin agent and its gate in containers, and sweeps real orphans.
 *
 * HOME is a temporary directory for this file, so the credential paths the
 * profile denies are fakes and no real one is touched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtin, claudeCode } from '@clerq/drivers';
import { parseRegistry } from '@clerq/providers';
import { listLabelled, removeContainer, resolveRuntime, runtimeCall } from '@clerq/sandbox';
import { cacheKey, type Fetcher } from '@clerq/workspaces';
import { killLeftoverProcesses, removeOrphanContainers } from '../agent-processes.js';
import { createGateway } from '../gateway.js';
import { createRun } from '../runs.js';
import { getStore } from '../store.js';

const TOKEN = 'sandbox-test-token-0123456789';
const FORGE_TOKEN = 'ghp_fake-forge-token-for-sandbox-tests';
const LAB_TOKEN = 'gitlab-fake-token-for-sandbox-tests';
const isMac = process.platform === 'darwin';

/** The model registry the builtin agent and the gateway check a spec against. */
const MODEL_REGISTRY_YAML = `
providers:
  - id: fake
    label: Fake
    adapter: anthropic
    baseUrl: https://fake.invalid/v1
    authEnv: FAKE_SANDBOX_MODEL_KEY
    models:
      - id: priced
        context: 200000
        inputPerM: 1
        outputPerM: 2
`;
/** The builtin agent is the real driver over a scripted model: each reply is the next API response. */
let modelReplies: Array<Array<Record<string, unknown>>> = [];
const modelRequests: Array<{ body: Record<string, unknown> }> = [];
const fakeModel = (async (_url: string, init: RequestInit) => {
  modelRequests.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
  const content = modelReplies.shift() ?? [{ type: 'text', text: 'Done.' }];
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 1_000, output_tokens: 100 },
      }),
  } as Response;
}) as unknown as typeof fetch;
const builtinDriver = builtin({
  registry: () => parseRegistry(MODEL_REGISTRY_YAML),
  fetch: fakeModel,
});

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
  branch?: string;
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

  for (const k of [
    'HOME',
    'GIT_CONFIG_GLOBAL',
    'CLERQ_KEYCHAIN',
    'CLERQ_CONTAINER_RUNTIME',
    'CLERQ_PROVIDERS_FILE',
  ]) {
    saved[k] = process.env[k];
  }
  fs.writeFileSync(path.join(root, 'providers.yaml'), MODEL_REGISTRY_YAML);
  process.env.CLERQ_PROVIDERS_FILE = path.join(root, 'providers.yaml');
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
      driverFor: (id) =>
        id === 'builtin'
          ? builtinDriver
          : claudeCode({ bin: path.join(bin, process.env.FAKE_AGENT ?? 'claude') }),
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

describe.skipIf(!isMac)('gates test the commit (macOS, seatbelt)', () => {
  it('runs the gates on the run commit, not on a worktree a hidden process rewrites', async () => {
    const marker = `clerq-test-straggler-${Date.now()}`;
    fs.writeFileSync(
      path.join(bin, 'claude-rewriter'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo good > OUT.md
wt=$(pwd)
common=$(git rev-parse --path-format=absolute --git-common-dir)
branch=$(git symbolic-ref --short HEAD)
base=$(git rev-parse HEAD)
# As a shell started by a Node CLI would be: no tag descriptor, out of the
# group, out of the run's directories. Once the commit exists, it rewrites
# the worktree.
/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); close STDIN; close STDOUT; close STDERR; POSIX::close(3); chdir "/"; exec "/bin/sh", "-c", $ARGV[0], "${marker}"' "while [ \\"\\$(cat '$common/refs/heads/$branch')\\" = '$base' ]; do sleep 0.1; done; echo bad > '$wt/OUT.md'; sleep 30" &
# Long enough for it to leave the group before the agent ends.
sleep 1
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-rewriter';
    const id = await create(
      spec(
        'gates-on-commit',
        'github:acme/remote-app',
        '  - run: sleep 3 && grep -q good OUT.md\nsandbox:\n  profile: seatbelt\npublish:\n  push: false'
      ).replace('  - run: test -f CHANGED.md\n', '')
    );
    const runId = await start(id);
    let sawRewrite = false;
    try {
      for (const end = Date.now() + 30_000; Date.now() < end; ) {
        const { body } = await json<RunView>(`/runs/${runId}`);
        const wt = body.steps.find((s) => s.input?.action === 'worktree')?.output?.path;
        if (body.status === 'verifying' && wt) {
          try {
            sawRewrite ||= fs.readFileSync(path.join(String(wt), 'OUT.md'), 'utf8') === 'bad\n';
          } catch {
            /* not yet */
          }
        }
        if (finished(body)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const run = await waitForRun(runId, finished);
      // The hidden process did rewrite the worktree while the gates ran...
      expect(sawRewrite).toBe(true);
      // ...and the gates saw the commit, which is what the run keeps.
      expect(run.status, run.exitReason).toBe('done');
      const diff = run.artifacts.find((a) => a.kind === 'diff');
      const { body } = await json<{ content: string }>(`/runs/${runId}/artifacts/${diff?.id}`);
      expect(body.content).toContain('+good');
    } finally {
      // Whatever is left of it (nothing, once the run stopped it).
      spawnSync('pkill', ['-f', marker], { stdio: 'ignore' });
    }
  }, 60_000);

  it("does not kill the user's own process that sits in the worktree", async () => {
    // The user's shell: started before the run, it moves into the worktree once there is one,
    // as a person cd-ing into it would. Two files order it with the run, so the test does not
    // depend on how fast either side is: `where` names the worktree (written whole, then
    // renamed into place, so the shell never reads half of it) and `ack` is written by the
    // shell once it is in. The fake agent waits for `ack` before it finishes, so the scan
    // that follows the agent always finds the shell under the worktree.
    const where = path.join(root, `user-shell-${Date.now()}`);
    const ack = `${where}.ack`;
    fs.writeFileSync(
      path.join(bin, 'claude-plain'),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo changed > CHANGED.md
# Up to 30 s for the user's shell to say it is in the worktree.
n=0
while [ ! -e "${ack}" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0,"usage":{}}'
`,
      { mode: 0o755 }
    );
    process.env.FAKE_AGENT = 'claude-plain';
    const own = spawn(
      '/usr/bin/perl',
      [
        '-e',
        `until (-e "${where}") { select(undef,undef,undef,0.05) } open F, "${where}" or die; chomp($p = <F>); chdir $p or die "cannot enter [$p]"; open A, ">${ack}" or die; close A; sleep 30`,
      ],
      { stdio: 'ignore', detached: true }
    );
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      const id = await create(
        spec(
          'user-process',
          'github:acme/remote-app',
          'sandbox:\n  profile: seatbelt\npublish:\n  push: false'
        )
      );
      const runId = await start(id);
      for (;;) {
        const { body } = await json<RunView>(`/runs/${runId}`);
        const p = body.steps.find((s) => s.input?.action === 'worktree')?.output?.path;
        if (p) {
          fs.writeFileSync(`${where}.tmp`, `${p}\n`);
          fs.renameSync(`${where}.tmp`, where);
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const run = await waitForRun(runId, finished);
      expect(run.status, run.exitReason).toBe('done');
      // The shell got into the worktree before the agent finished.
      expect(fs.existsSync(ack)).toBe(true);
      // Found under the worktree, reported, and left running.
      const left = stepsNamed(run, 'process.stragglers').flatMap(
        (s) => (s.output?.leftRunning as Array<{ pid: number }> | undefined) ?? []
      );
      expect(left.map((p) => p.pid)).toContain(own.pid);
      expect(() => process.kill(own.pid as number, 0)).not.toThrow();
    } finally {
      own.kill('SIGKILL');
    }
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
    // The agent works in the run's worktree; the gate in a fresh checkout of the commit.
    const gateDir = /-w (\S+)/.exec(runs[1])?.[1] as string;
    expect(path.basename(gateDir)).toMatch(/^gate-/);
    for (const [r, dir] of [
      [runs[0], worktree],
      [runs[1], gateDir],
    ]) {
      expect(r).toContain(`--name clerq-${run.id}-`);
      expect(r).toContain(`--mount type=bind,source=${dir},target=${dir} `);
      expect(r).toContain(`--mount type=bind,source=${common},target=${common},readonly`);
      expect(r).toContain(`--mount type=bind,source=${dir}/.git,target=${dir}/.git,readonly`);
    }
    expect(runs[1]).toMatch(/config\.worktree,readonly/);
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

// ---------------------------------------------------------------------------
// The container profile on a real engine
// ---------------------------------------------------------------------------

const REAL_RUNTIME = process.env.CLERQ_TEST_CONTAINER_RUNTIME;
const ALPINE = 'docker.io/library/alpine:3.20';
const testDir = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_SCRIPT = path.resolve(testDir, '../../../../scripts/container-debug.sh');
const DEBUG_DIR =
  process.env.CLERQ_TEST_DEBUG_DIR || path.join(os.tmpdir(), 'clerq-container-debug');
const CALLS_LOG = path.join(DEBUG_DIR, 'docker-calls.log');

describe.skipIf(!REAL_RUNTIME || process.platform === 'win32')(
  REAL_RUNTIME
    ? 'the container profile, on a real container engine'
    : 'the container profile, on a real container engine ' +
        '(skipped: set CLERQ_TEST_CONTAINER_RUNTIME=docker or podman to run it)',
  () => {
    let runtime = '';
    /** The runtime as the gateway sees it: a wrapper that records each call's arguments. */
    let shim = '';
    let repoDir = '';
    const uid = process.getuid?.();
    const gid = process.getgid?.();

    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

    function dump(why: string, callsFrom = 0): string {
      let text = `\n##### Engine state after a failure: ${why}\n`;
      try {
        const r = spawnSync('sh', [DEBUG_SCRIPT, runtime, CALLS_LOG, String(callsFrom)], {
          encoding: 'utf8',
          timeout: 60_000,
        });
        text += `${r.stdout ?? ''}${r.stderr ?? ''}`;
      } catch (e) {
        text += `(could not run ${DEBUG_SCRIPT}: ${e instanceof Error ? e.message : e})\n`;
      }
      try {
        fs.appendFileSync(path.join(DEBUG_DIR, 'failures.txt'), text);
      } catch {
        /* only a copy for the artifact */
      }
      return text;
    }

    /** A test that prints the engine's state when it fails. */
    function realIt(name: string, fn: () => Promise<void>, ms = 240_000): void {
      it(
        name,
        async () => {
          // The log is shared by every test: a failure shows only what its own test asked of the engine.
          const callsFrom = fs.existsSync(CALLS_LOG) ? fs.statSync(CALLS_LOG).size : 0;
          try {
            await fn();
          } catch (e) {
            console.error(
              dump(
                `${name}: ${e instanceof Error ? e.message.slice(0, 600) : String(e)}`,
                callsFrom
              )
            );
            throw e;
          }
        },
        ms
      );
    }

    async function ensureImage(image: string): Promise<void> {
      if ((await runtimeCall(runtime, ['image', 'inspect', image])).code === 0) return;
      let last = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await runtimeCall(runtime, ['pull', image], 300_000);
        if (r.code === 0) return;
        last = (r.stderr || r.stdout).trim().slice(-400);
        await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
      }
      throw new Error(`Could not pull ${image}: ${last}`);
    }

    /** What a gateway that died leaves: a network, an egress proxy and a command container, labelled. */
    async function orphans(forRun: string, tag: string): Promise<string> {
      const name = `clerq-${forRun}-${tag}`;
      const label = ['--label', `clerq.run=${forRun}`];
      const net = await runtimeCall(runtime, [
        'network',
        'create',
        '--internal',
        ...label,
        `${name}-net`,
      ]);
      expect(net.code, net.stderr).toBe(0);
      for (const n of [name, `${name}-egress`]) {
        const r = await runtimeCall(runtime, [
          'run',
          '-d',
          '--name',
          n,
          ...label,
          ALPINE,
          'sleep',
          '300',
        ]);
        expect(r.code, r.stderr).toBe(0);
      }
      return name;
    }

    const running = async (name: string): Promise<boolean> =>
      (
        await runtimeCall(runtime, ['container', 'inspect', '--format', '{{.State.Running}}', name])
      ).stdout.trim() === 'true';

    const labelled = async (value: string) => {
      const all = await listLabelled(runtime, 'clerq.run');
      return {
        containers: all.containers
          .filter((c) => c.value === value)
          .map((c) => c.name)
          .sort(),
        networks: all.networks
          .filter((n) => n.value === value)
          .map((n) => n.name)
          .sort(),
      };
    };

    async function deadPid(): Promise<number> {
      const child = spawn('true', [], { stdio: 'ignore' });
      const pid = child.pid as number;
      await new Promise((resolve) => child.once('exit', resolve));
      return pid;
    }

    beforeAll(async () => {
      const found = resolveRuntime(REAL_RUNTIME);
      if (!found) {
        throw new Error(
          `CLERQ_TEST_CONTAINER_RUNTIME=${REAL_RUNTIME} is set, but no such runtime was found on PATH.`
        );
      }
      runtime = found;
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      shim = path.join(DEBUG_DIR, 'runtime-shim-gateway');
      fs.writeFileSync(
        shim,
        [
          '#!/bin/bash',
          '# Appends the arguments of each call, never its environment, then runs the real runtime.',
          `{ printf '%s %s' "$(date -u +%H:%M:%S)" "$$"; for a in "$@"; do a=\${a//$'\\n'/ }; [ \${#a} -gt 400 ] && a="\${a:0:400}...[+$((\${#a} - 400))]"; printf ' %s' "$a"; done; printf '\\n'; } >> ${quote(CALLS_LOG)} 2>/dev/null`,
          `exec ${quote(runtime)} "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      const version = await runtimeCall(runtime, ['version']);
      expect(version.code, version.stderr).toBe(0);
      await ensureImage(ALPINE);

      // The repository the run works in: a local one, so nothing needs a forge.
      repoDir = path.join(root, 'real-app');
      fs.mkdirSync(repoDir);
      sh(repoDir, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# real-app\n');
      sh(repoDir, 'add', '.');
      sh(repoDir, 'commit', '-q', '-m', 'init');
    }, 15 * 60_000);

    beforeEach(() => {
      // The file's own beforeEach clears it.
      process.env.CLERQ_CONTAINER_RUNTIME = shim;
    });

    afterAll(async () => {
      delete process.env.CLERQ_CONTAINER_RUNTIME;
      const left = await listLabelled(runtime, 'clerq.run');
      for (const c of left.containers) await removeContainer(runtime, c.name);
      for (const n of left.networks) await removeContainer(runtime, n.name.replace(/-net$/, ''));
    }, 120_000);

    realIt(
      'runs a scripted builtin agent and its gate in containers, and commits what they did',
      async () => {
        secrets.MODEL_KEY = 'vault-model-key-for-the-real-engine-test';
        modelRequests.length = 0;
        modelReplies = [
          [
            {
              type: 'tool_use',
              id: 'w1',
              name: 'write_file',
              input: { path: 'CHANGED.md', content: 'by builtin\n' },
            },
          ],
          [
            {
              type: 'tool_use',
              id: 's1',
              name: 'run_shell',
              input: {
                command:
                  "printf 'ignored.log\\n' > .gitignore && echo scratch > ignored.log && " +
                  'echo "uid=$(id -u) gid=$(id -g) home=$HOME" && ' +
                  '(touch /etc/clerq-probe 2>/dev/null && echo rootfs=writable || echo rootfs=readonly) && ' +
                  "grep '^ID=' /etc/os-release",
              },
            },
          ],
          [{ type: 'text', text: 'Added CHANGED.md.' }],
        ];
        // True only inside the container, and only on a fresh checkout of the commit: the agent's
        // ignored.log is not in it.
        const gate =
          'test ! -e ignored.log && test -f CHANGED.md && ' +
          `test "$(id -u)" = "${uid}" && grep -q '^ID=alpine' /etc/os-release`;
        const id = await create(
          [
            'name: real-container',
            'targets:',
            `  repos: [local:${repoDir}]`,
            'agent:',
            '  driver: builtin',
            '  model: fake/priced',
            '  api_key_secret: MODEL_KEY',
            'prompt: Add CHANGED.md.',
            'sandbox:',
            '  profile: container',
            `  image: ${ALPINE}`,
            'gates:',
            `  - run: ${JSON.stringify(gate)}`,
            'publish:',
            '  push: false',
          ].join('\n')
        );
        const run = await waitForRun(await start(id), finished, 200_000);
        expect(run.status, run.exitReason).toBe('done');
        expect(run.exitReason).toMatch(/not pushed/);

        // What the model was told the commands found: a container, not this machine.
        const told = JSON.stringify(modelRequests[2]?.body.messages);
        expect(told).toContain(`uid=${uid} gid=${gid} home=/tmp`);
        expect(told).toContain('rootfs=readonly');
        expect(told).toContain('ID=alpine');

        // The gateway committed what they did, and left out what git ignores.
        expect(sh(repoDir, 'show', `${run.branch}:CHANGED.md`)).toBe('by builtin');
        const files = sh(repoDir, 'ls-tree', '--name-only', String(run.branch)).split('\n');
        expect(files).toEqual(expect.arrayContaining(['CHANGED.md', '.gitignore', 'README.md']));
        expect(files).not.toContain('ignored.log');

        // Every command was recorded with its container, and each is over.
        const rows = getStore()
          .prepare(
            'SELECT kind, container, container_runtime, ended_at FROM run_processes WHERE run_id = ? ORDER BY id'
          )
          .all(run.id) as Array<{
          kind: string;
          container: string | null;
          container_runtime: string | null;
          ended_at: string | null;
        }>;
        // The file tool, the shell command and the gate, at least.
        expect(rows.length).toBeGreaterThanOrEqual(3);
        for (const r of rows) {
          expect(r.container).toMatch(new RegExp(`^clerq-${run.id}-[0-9a-f]{8}$`));
          expect(r.container_runtime).toBe(shim);
          expect(r.ended_at).not.toBeNull();
        }
        expect(rows[rows.length - 1].kind).toBe('gate');

        // What was asked of the engine: each command in a container held down, the gate in a fresh checkout.
        const lines = fs
          .readFileSync(CALLS_LOG, 'utf8')
          .split('\n')
          .filter((l) => l.includes(' run --rm ') && l.includes(`clerq-${run.id}-`));
        expect(lines.length).toBe(rows.length);
        for (const l of lines) {
          expect(l).toContain('--init');
          expect(l).toContain('--read-only');
          expect(l).toContain('--cap-drop ALL');
          expect(l).toContain(`--user ${uid}:${gid}`);
          expect(l).toContain('--network none');
          expect(l).toContain(ALPINE);
        }
        const dirs = lines.map((l) => path.basename(/ -w (\S+)/.exec(l)?.[1] ?? ''));
        expect(dirs[dirs.length - 1]).toMatch(/^gate-/);
        expect(dirs.slice(0, -1).every((d) => !d.startsWith('gate-'))).toBe(true);
        expect(lines[lines.length - 1]).toContain('test ! -e ignored.log');

        // Nothing of the run is left in the engine.
        expect(await labelled(run.id)).toEqual({ containers: [], networks: [] });
      }
    );

    realIt('sweeps what runs that are over left behind, and nothing else', async () => {
      const over = createRun({ trigger: 'manual', status: 'failed' });
      const live = createRun({ trigger: 'manual', status: 'executing' });
      const overName = await orphans(over, 'aaaa');
      const liveName = await orphans(live, 'bbbb');
      // Another OpenClerq install on the same engine: a run this store has never heard of.
      const strangerRun = `run_not-in-this-store-${process.pid}`;
      const strangerName = await orphans(strangerRun, 'cccc');
      // A container of someone else's, with no label at all.
      const plain = `clerq-plain-${process.pid}`;
      const started = await runtimeCall(runtime, [
        'run',
        '-d',
        '--name',
        plain,
        ALPINE,
        'sleep',
        '300',
      ]);
      expect(started.code, started.stderr).toBe(0);
      try {
        const removed = await removeOrphanContainers(new Set([live]), shim);
        expect([...removed].sort()).toEqual(
          [overName, `${overName}-egress`, `${overName}-net`].sort()
        );
        expect(await labelled(over)).toEqual({ containers: [], networks: [] });
        // The run another gateway is working on, the stranger's and the unlabelled one are as they were.
        expect(await labelled(live)).toEqual({
          containers: [liveName, `${liveName}-egress`].sort(),
          networks: [`${liveName}-net`],
        });
        expect(await labelled(strangerRun)).toEqual({
          containers: [strangerName, `${strangerName}-egress`].sort(),
          networks: [`${strangerName}-net`],
        });
        expect(await running(liveName)).toBe(true);
        expect(await running(plain)).toBe(true);
      } finally {
        await removeContainer(runtime, liveName);
        await removeContainer(runtime, strangerName);
        await runtimeCall(runtime, ['rm', '-f', plain]);
      }
    });

    realIt('removes the container of a gateway that is gone, by the name it recorded', async () => {
      const lost = createRun({ trigger: 'manual', status: 'executing' });
      const name = await orphans(lost, 'dddd');
      const pid = await deadPid();
      // As the dead gateway left it: the runtime CLI's pid is gone, and so is the owner's.
      getStore()
        .prepare(
          `INSERT INTO run_processes
             (run_id, kind, pid, pgid, command, proc_start, owner_pid, owner_start, started_at,
              container, container_runtime)
           VALUES (?, 'agent', ?, ?, 'docker', ?, ?, NULL, ?, ?, ?)`
        )
        .run(
          lost,
          pid,
          pid,
          new Date(Date.now() - 60_000).toISOString(),
          await deadPid(),
          new Date().toISOString(),
          name,
          shim
        );
      const found = (await killLeftoverProcesses()).find((p) => p.runId === lost);
      expect(found).toMatchObject({ outcome: 'gone', container: name });
      expect(await labelled(lost)).toEqual({ containers: [], networks: [] });
    });
  }
);
