/**
 * `clerq skill …` against a real gateway in this process: real HTTP, a real store, a real skills
 * folder, a temporary HOME. No model is called. `checksum` needs no gateway at all.
 *
 * Needs the gateway built (`pnpm build`); without it the tests are skipped locally and fail under
 * CI.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillChecksum } from '@clerq/plugin-sdk/node';
import { FakeStdin, capture, cli, type CliResult } from './test-harness.js';
import { runCli } from './cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIST = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'gateway',
  'dist',
  'index.js'
);
const runnable = fs.existsSync(GATEWAY_DIST) || Boolean(process.env.CI);

const TOKEN = 'cli-skills-gateway-token-0123456789';

let root: string;
let skills: string;
let gatewayUrl: string;
let server: {
  close(cb: () => void): void;
  once(e: string, cb: () => void): void;
  address(): unknown;
};
const saved: Record<string, string | undefined> = {};

let homes = 0;
const newHome = () => {
  const dir = path.join(root, `cli-home-${homes++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

async function signedIn(): Promise<string> {
  const home = newHome();
  const r = await cli(['login', gatewayUrl, '--token-stdin'], { home, stdin: `${TOKEN}\n` });
  expect(r.code, r.stderr).toBe(0);
  return home;
}

const json = <T = Record<string, any>>(r: CliResult): T => JSON.parse(r.stdout) as T;

function write(slug: string, front: string[], body: string) {
  fs.mkdirSync(path.join(skills, slug), { recursive: true });
  fs.writeFileSync(
    path.join(skills, slug, 'SKILL.md'),
    ['---', `name: '${slug}'`, `slug: '${slug}'`, ...front, '---', '', body, ''].join('\n')
  );
}

/** Answer yes or no to the one question a command asks on a terminal. */
async function asking(argv: string[], home: string, answer: string): Promise<CliResult> {
  const stdin = new FakeStdin('', true);
  const c = capture(stdin, true);
  const pending = runCli(argv, {
    env: { HOME: home },
    io: c.io,
    home,
    cwd: home,
    pollMs: 500,
    retryMs: 10,
    githubPollMs: 20,
    openUrl: async () => false,
  });
  const end = Date.now() + 10_000;
  while (!/\[y\/N\]/.test(c.stderr()) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
  stdin.type(answer);
  const code = await pending;
  return { code, stdout: c.stdout(), stderr: c.stderr() };
}

beforeAll(async () => {
  if (!runnable) return;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-skill-e2e-')));
  for (const name of ['HOME', 'CLERQ_KEYCHAIN']) saved[name] = process.env[name];
  const gatewayHome = path.join(root, 'gateway-home');
  fs.mkdirSync(gatewayHome);
  process.env.HOME = gatewayHome;
  process.env.CLERQ_KEYCHAIN = 'off';
  skills = path.join(root, 'skills');
  fs.mkdirSync(skills);
  const { createGateway } = await import('@clerq/gateway');
  const { server: s } = createGateway({
    port: 0,
    authToken: TOKEN,
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
    skillsDir: skills,
  });
  server = s as typeof server;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${gatewayUrl}/v1/skills`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status === 200) break;
    await new Promise((r) => setTimeout(r, 30));
  }
}, 30_000);

afterAll(async () => {
  if (!runnable) return;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!runnable) return;
  fs.rmSync(skills, { recursive: true, force: true });
  fs.mkdirSync(skills);
  write(
    'report',
    [
      "triggers: ['report']",
      'tools_required: [fs.read, shell.exec]',
      'network_domains: [api.example.com]',
      'filesystem_scope: [docs/]',
    ],
    'Quote the figures.'
  );
  write('plain', ["triggers: ['plain']"], 'Be plain.');
  // Each test starts with nothing decided.
  for (const slug of ['report', 'plain']) {
    await fetch(`${gatewayUrl}/v1/skills/${slug}/untrust`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  }
});

describe.skipIf(!runnable)('clerq skill list and show', () => {
  it('lists each skill with its state and what it declares, and says whether enforcement is on', async () => {
    const home = await signedIn();
    const r = await cli(['skill', 'list'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/SKILL\s+STATE\s+DECLARES\s+FROM/);
    expect(r.stdout).toMatch(/plain\s+not trusted\s+nothing\s+skills folder/);
    expect(r.stdout).toMatch(/report\s+not trusted\s+2 tools, 1 host, 1 path\s+skills folder/);
    expect(r.stdout).toContain('Enforcement is off');
    expect(r.stdout).toContain('`clerq skill trust <skill>`');
  });

  it('is data under --json', async () => {
    const home = await signedIn();
    const r = await cli(['skill', 'list', '--json'], { home });
    const data = json<{
      skills: Array<{ slug: string; trust: string; computedChecksum: string }>;
      enforce: boolean;
    }>(r);
    expect(data.enforce).toBe(false);
    expect(data.skills.map((s) => [s.slug, s.trust])).toEqual([
      ['plain', 'untrusted'],
      ['report', 'untrusted'],
    ]);
    expect(data.skills[0].computedChecksum).toBe(await skillChecksum(path.join(skills, 'plain')));
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('shows one skill: state, checksums, declarations in words, warnings and the instructions', async () => {
    const home = await signedIn();
    const r = await cli(['skill', 'show', 'report'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('report (report)');
    expect(r.stdout).toContain('not trusted. You have not decided on this skill.');
    expect(r.stdout).toContain(await skillChecksum(path.join(skills, 'report')));
    expect(r.stdout).toContain('SKILL.md declares no checksum');
    expect(r.stdout).toContain('use tools: fs.read, shell.exec');
    expect(r.stdout).toContain('reach websites: api.example.com');
    expect(r.stdout).toContain('use files: docs/');
    expect(r.stdout).toContain(
      'tools_required: "shell.exec" is not a tool OpenClerq has. Did you mean runtime.shell?'
    );
    expect(r.stdout).toContain('Instructions\nQuote the figures.');
    const j = json<{ skill: { slug: string }; body: string }>(
      await cli(['skill', 'show', 'report', '--json'], { home })
    );
    expect(j).toMatchObject({ skill: { slug: 'report' }, body: 'Quote the figures.' });
  });

  it('says there is no such skill, and exits 1', async () => {
    const home = await signedIn();
    const r = await cli(['skill', 'show', 'nope'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('There is no skill "nope". `clerq skill list` shows them.');
  });
});

describe.skipIf(!runnable)('clerq skill trust, block and untrust', () => {
  it('shows what is being trusted and asks; yes trusts exactly those files', async () => {
    const home = await signedIn();
    const r = await asking(['skill', 'trust', 'report'], home, 'y\n');
    expect(r.code, r.stderr).toBe(0);
    const sum = await skillChecksum(path.join(skills, 'report'));
    // Before the question: the declarations and the checksum.
    expect(r.stdout).toContain('use tools: fs.read, shell.exec');
    expect(r.stdout).toContain(`Trusting records exactly these files (${sum})`);
    expect(r.stdout).toContain('Enforcement is off: a skill is used whether or not you trust it');
    expect(r.stderr).toContain('Trust report? [y/N]');
    expect(r.stdout).toContain('Trusted report.');
    const list = json<{ skills: Array<{ slug: string; trust: string }> }>(
      await cli(['skill', 'list', '--json'], { home })
    );
    expect(list.skills.find((s) => s.slug === 'report')?.trust).toBe('trusted');
  });

  it('an answer that is not yes changes nothing', async () => {
    const home = await signedIn();
    const r = await asking(['skill', 'trust', 'plain'], home, '\n');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Nothing was changed.');
    const list = json<{ skills: Array<{ slug: string; trust: string }> }>(
      await cli(['skill', 'list', '--json'], { home })
    );
    expect(list.skills.find((s) => s.slug === 'plain')?.trust).toBe('untrusted');
  });

  it('without a terminal it does not guess: --yes is needed', async () => {
    const home = await signedIn();
    const no = await cli(['skill', 'trust', 'plain'], { home });
    expect(no.code).toBe(64);
    expect(no.stderr).toContain('Pass --yes');
    const yes = await cli(['skill', 'trust', 'plain', '--yes', '--json'], { home });
    expect(yes.code, yes.stderr).toBe(0);
    expect(json(yes)).toMatchObject({
      changed: true,
      skill: { slug: 'plain', trust: 'trusted', trustedBy: 'user' },
    });
    // Again: nothing to do.
    const again = await cli(['skill', 'trust', 'plain', '--yes'], { home });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('"plain" is already trusted');
  });

  it('a skill that was edited is changed, and trusting it again records the new files', async () => {
    const home = await signedIn();
    await cli(['skill', 'trust', 'plain', '--yes'], { home });
    fs.appendFileSync(path.join(skills, 'plain', 'SKILL.md'), 'More.\n');
    const show = await cli(['skill', 'show', 'plain'], { home });
    expect(show.stdout).toContain('changed. Its files have changed since you trusted it.');
    expect(show.stdout).toContain('SKILL.md changed');
    const again = await cli(['skill', 'trust', 'plain', '--yes'], { home });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('Trusted plain.');
  });

  it('blocks and unblocks', async () => {
    const home = await signedIn();
    const b = await cli(['skill', 'block', 'plain'], { home });
    expect(b.code, b.stderr).toBe(0);
    expect(b.stdout).toContain(
      'Blocked plain. It is not used, with enforcement on or off, until you untrust it.'
    );
    const list = await cli(['skill', 'list'], { home });
    expect(list.stdout).toMatch(/plain\s+blocked/);
    const u = await cli(['skill', 'untrust', 'plain', '--json'], { home });
    expect(json(u)).toMatchObject({ skill: { slug: 'plain', trust: 'untrusted' } });
    const text = await cli(['skill', 'untrust', 'plain'], { home });
    expect(text.stdout).toContain('plain is not trusted: your decision about it was forgotten.');
  });

  it('says there is no such skill for each decision', async () => {
    const home = await signedIn();
    for (const verb of ['trust', 'block', 'untrust']) {
      const r = await cli(['skill', verb, 'nope', ...(verb === 'trust' ? ['--yes'] : [])], {
        home,
      });
      expect([verb, r.code]).toEqual([verb, 1]);
      expect(r.stderr).toContain('There is no skill "nope"');
    }
  });
});

describe.skipIf(!runnable)('clerq skill checksum', () => {
  const offline = async () => ({ home: newHome(), gateway: 'http://127.0.0.1:1' });

  it('prints only the value, with no gateway needed, and it is the one the gateway computes', async () => {
    const { home, gateway } = await offline();
    const r = await cli(['skill', 'checksum', path.join(skills, 'report'), '--gateway', gateway], {
      home,
    });
    expect(r.code, r.stderr).toBe(0);
    const sum = await skillChecksum(path.join(skills, 'report'));
    expect(r.stdout).toBe(`${sum}\n`);
    expect(r.stderr).toContain('SKILL.md does not declare a checksum');
    const signed = await signedIn();
    const list = json<{ skills: Array<{ slug: string; computedChecksum: string }> }>(
      await cli(['skill', 'list', '--json'], { home: signed })
    );
    expect(list.skills.find((s) => s.slug === 'report')?.computedChecksum).toBe(sum);
  });

  it('is relative to where the command is run, and gives the files under --json', async () => {
    const home = newHome();
    const r = await cli(['skill', 'checksum', './report', '--json'], { home, cwd: skills });
    const data = json<{
      checksum: string;
      written: boolean;
      declared: null;
      files: Array<{ path: string }>;
    }>(r);
    expect(data).toMatchObject({ written: false, declared: null, matches: null });
    expect(data.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('--write puts the line in SKILL.md, and the gateway then sees a checksum that matches', async () => {
    const home = await signedIn();
    const dir = path.join(skills, 'report');
    const before = await skillChecksum(dir);
    const r = await cli(['skill', 'checksum', dir, '--write'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${before}\n`);
    expect(r.stderr).toContain('Written to');
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain(`checksum: ${before}\n`);
    expect(await skillChecksum(dir)).toBe(before);
    const show = json<{ skill: { checksum: string; checksumMatches: boolean; trust: string } }>(
      await cli(['skill', 'show', 'report', '--json'], { home })
    );
    expect(show.skill).toMatchObject({
      checksum: before,
      checksumMatches: true,
      trust: 'untrusted',
    });
    const text = await cli(['skill', 'show', 'report'], { home });
    expect(text.stdout).toContain(`${before}, which matches`);
  });

  it('says when SKILL.md declares a checksum these files do not have, and a later edit is changed', async () => {
    const home = await signedIn();
    const dir = path.join(skills, 'plain');
    await cli(['skill', 'checksum', dir, '--write'], { home });
    fs.appendFileSync(path.join(dir, 'SKILL.md'), 'Edited after.\n');
    const r = await cli(['skill', 'checksum', dir], { home });
    expect(r.stderr).toContain('SKILL.md declares sha256:');
    expect(r.stderr).toContain('which does not match these files');
    const show = await cli(['skill', 'show', 'plain'], { home });
    expect(show.stdout).toContain('changed. The files do not match the checksum in SKILL.md.');
    expect(show.stdout).toContain('which does NOT match');
  });

  it('refuses a folder with no SKILL.md, one that is not a folder, and one with a link in it', async () => {
    const home = newHome();
    fs.mkdirSync(path.join(root, 'empty'));
    const none = await cli(['skill', 'checksum', path.join(root, 'empty')], { home });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('There is no SKILL.md');
    const file = await cli(['skill', 'checksum', path.join(skills, 'plain', 'SKILL.md')], { home });
    expect(file.code).toBe(1);
    expect(file.stderr).toContain('is not a folder');
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(root, 'empty'), path.join(skills, 'plain', 'link'));
      const link = await cli(['skill', 'checksum', path.join(skills, 'plain'), '--write'], {
        home,
      });
      expect(link.code).toBe(1);
      expect(link.stderr).toContain('"link" is a link');
      expect(fs.readFileSync(path.join(skills, 'plain', 'SKILL.md'), 'utf8')).not.toContain(
        'checksum:'
      );
    }
  });

  it('needs a folder', async () => {
    const r = await cli(['skill', 'checksum'], { home: newHome() });
    expect(r.code).toBe(64);
  });
});
