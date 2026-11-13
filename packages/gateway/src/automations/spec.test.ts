import { describe, it, expect } from 'vitest';
import { parseRegistry } from '@clerq/providers';
import { parseSpec, parseDuration, SpecError } from './spec.js';
import { nextRunOf } from './scheduler.js';

/** MINIMAL with a vault key for the agent, which a CLI needs under a sandbox profile. */
const keyed = (source: string) =>
  source.replace('driver: claude-code', 'driver: claude-code\n  api_key_secret: ANTHROPIC_KEY');

const MINIMAL = `
name: deps
targets:
  repos: [local:~/code/app]
agent:
  driver: claude-code
prompt: Update the lockfile.
sandbox:
  profile: native
`;

function errorOf(source: string): SpecError {
  try {
    parseSpec(source);
  } catch (e) {
    if (e instanceof SpecError) return e;
    throw e;
  }
  throw new Error('expected a SpecError');
}

describe('parseSpec', () => {
  it('fills safe defaults around the required fields', () => {
    const spec = parseSpec(MINIMAL);
    expect(spec).toMatchObject({
      name: 'deps',
      repo: { kind: 'local', path: '~/code/app' },
      agent: { driver: 'claude-code', permissionMode: 'acceptEdits', allowedTools: [] },
      prompt: 'Update the lockfile.',
      sandbox: { profile: 'native', timeoutMs: 20 * 60_000 },
      gates: [],
      publish: {
        push: true,
        pullRequest: 'draft',
        onNoChanges: 'skip',
        tokenSecret: 'GITHUB_TOKEN',
        branch: 'auto/{{automation}}/{{date}}-{{run}}',
      },
      // Pushing waits for a human unless the spec says otherwise.
      approvals: { push: 'manual', timeoutMs: 24 * 3_600_000 },
    });
    expect(spec.schedule).toBeUndefined();
  });

  it('reads the documented format', () => {
    const spec = parseSpec(`
name: nightly-dependency-triage
description: Patch safe bumps
on:
  schedule: '0 3 * * 1-5'
targets:
  repos: [local:~/code/openclerq#develop]
agent:
  driver: claude-code
  model:
    primary: sonnet
  allowed_tools: ['Bash(pnpm test:*)']
  api_key_secret: ANTHROPIC_API_KEY
prompt: |
  Review dependency updates.
sandbox:
  profile: native
  timeout: 15m
gates:
  - run: pnpm install --frozen-lockfile
  - run: pnpm test
    timeout: 5m
publish:
  branch: 'auto/{{automation}}/{{date}}'
  pull_request: draft
  on_no_changes: skip
budget:
  max_usd_per_run: 2.00
  max_usd_per_month: 60
  on_exceed: pause_automation
approvals:
  push: auto
  merge: manual
`);
    expect(spec).toMatchObject({
      schedule: '0 3 * * 1-5',
      repo: { path: '~/code/openclerq', ref: 'develop' },
      agent: {
        model: 'sonnet',
        allowedTools: ['Bash(pnpm test:*)'],
        apiKeySecret: 'ANTHROPIC_API_KEY',
      },
      sandbox: { timeoutMs: 15 * 60_000 },
      gates: [
        { run: 'pnpm install --frozen-lockfile', timeoutMs: 10 * 60_000 },
        { run: 'pnpm test', timeoutMs: 5 * 60_000 },
      ],
      budget: { maxUsdPerRun: 2, maxUsdPerMonth: 60 },
      approvals: { push: 'auto' },
    });
  });

  it('reports the line and column of a problem', () => {
    const e = errorOf(`name: deps
targets:
  repos: [local:~/code/app]
agent:
  driver: claude-code
prompt: x
on:
  schedule: 'every tuesday'
`);
    expect(e.line).toBe(8);
    expect(e.column).toBe(13);
    expect(e.message).toMatch(/not a valid cron expression/);
  });

  it('refuses unknown keys, which are usually typos', () => {
    const e = errorOf(`${MINIMAL}gate:\n  - run: x\n`);
    expect(e.message).toMatch(/Unknown key "gate"/);
    expect(e.line).toBe(10);
  });

  it('refuses documented keys this release does not run, by name', () => {
    expect(errorOf(`${MINIMAL}on:\n  events: [pr_opened]\n`).message).toMatch(
      /"on.events" \(event triggers\) is not supported/
    );
    expect(errorOf(`${MINIMAL}targets:\n  repos: [local:/a]\n  max_parallel: 4\n`).message).toMatch(
      /Map keys must be unique|"targets.max_parallel" \(fleet runs/
    );
    expect(
      errorOf(MINIMAL.replace('[local:~/code/app]', '[local:~/code/app]\n  max_parallel: 2'))
        .message
    ).toMatch(/"targets.max_parallel" \(fleet runs across several repositories\) is not supported/);
    // Routing strategies are planned for after 1.0, and the refusal says what to use instead.
    const strategy = errorOf(
      MINIMAL.replace(
        'driver: claude-code',
        'driver: claude-code\n  model:\n    primary: sonnet\n    strategy: cost_aware'
      )
    );
    expect(strategy.message).toMatch(
      /"agent.model.strategy" \(routing strategies such as cost_aware, quality_first, race and consensus\) is not supported in this release\. They are planned after 1\.0\..*"agent.model.fallback".*"agent.model.escalate"/
    );
    expect([strategy.line, strategy.column]).toEqual([9, 5]);
    // The native profile cannot limit the network or the filesystem, and says so.
    expect(errorOf(`${MINIMAL}  network: [registry.npmjs.org]\n`).message).toMatch(
      /"sandbox.network" needs the seatbelt or container profile/
    );
    expect(errorOf(`${MINIMAL}  filesystem: repo_only\n`).message).toMatch(
      /"sandbox.filesystem" needs the seatbelt or container profile/
    );
  });

  it('reads on.catch_up, and refuses it without a schedule', () => {
    expect(parseSpec(MINIMAL).catchUp).toBe(false);
    const spec = parseSpec(`${MINIMAL}on:\n  schedule: '0 3 * * *'\n  catch_up: true\n`);
    expect(spec).toMatchObject({ schedule: '0 3 * * *', catchUp: true });
    const alone = errorOf(`${MINIMAL}on:\n  catch_up: true\n`);
    expect(alone.message).toMatch(/needs "on.schedule"/);
    expect(alone.line).toBe(11);
    expect(
      errorOf(`${MINIMAL}on:\n  schedule: '0 3 * * *'\n  catch_up: yes please\n`).message
    ).toMatch(/"on.catch_up" must be true or false/);
  });

  it('reads retry, with no retries by default', () => {
    expect(parseSpec(MINIMAL).retry).toEqual({ maxRetries: 0, backoffMs: 60_000 });
    expect(parseSpec(`${MINIMAL}retry:\n  max_retries: 3\n  backoff: 30s\n`).retry).toEqual({
      maxRetries: 3,
      backoffMs: 30_000,
    });
    const many = errorOf(`${MINIMAL}retry:\n  max_retries: 11\n`);
    expect(many.message).toMatch(/"retry.max_retries" must be a whole number from 0 to 10/);
    expect([many.line, many.column]).toEqual([11, 16]);
    expect(errorOf(`${MINIMAL}retry:\n  max_retries: 1.5\n`).message).toMatch(/whole number/);
    expect(errorOf(`${MINIMAL}retry:\n  backoff: 2h\n`).message).toMatch(/at most 1h/);
    expect(errorOf(`${MINIMAL}retry:\n  on: [gate]\n`).message).toMatch(/Unknown key "retry.on"/);
  });

  it('reads agent.model.escalate, and checks each model by line', () => {
    const spec = parseSpec(
      MINIMAL.replace(
        'driver: claude-code',
        'driver: claude-code\n  model:\n    primary: sonnet\n    escalate: [opus]'
      )
    );
    expect(spec.agent).toMatchObject({ model: 'sonnet', escalate: ['opus'] });
    expect(parseSpec(MINIMAL).agent.escalate).toEqual([]);

    const builtin = (escalate: string) =>
      MINIMAL.replace(
        'driver: claude-code',
        `driver: builtin\n  model:\n    primary: fake/small\n    escalate: ${escalate}`
      );
    expect(parseSpec(builtin('[fake/large, other/huge]')).agent.escalate).toEqual([
      'fake/large',
      'other/huge',
    ]);
    const bare = errorOf(builtin('[fake/large, huge]'));
    expect(bare.message).toMatch(/"huge" must name the provider too/);
    expect([bare.line, bare.column]).toEqual([9, 28]);
    expect(errorOf(builtin('[fake/small]')).message).toMatch(/already the primary model/);
    expect(errorOf(builtin('[fake/a, fake/a]')).message).toMatch(/already listed/);
    expect(errorOf(builtin('[]')).message).toMatch(/one or more models/);
    expect(errorOf(builtin('[a/1, a/2, a/3, a/4, a/5, a/6]')).message).toMatch(/at most 5/);
  });

  it('reads agent.model.fallback, and checks each model by line', () => {
    const spec = parseSpec(
      MINIMAL.replace(
        'driver: claude-code',
        'driver: claude-code\n  model:\n    primary: sonnet\n    fallback: [haiku, opus]'
      )
    );
    expect(spec.agent).toMatchObject({
      model: 'sonnet',
      fallback: ['haiku', 'opus'],
      escalate: [],
    });
    expect(parseSpec(MINIMAL).agent.fallback).toEqual([]);
    // Alongside escalation: they are different keys with different jobs.
    const both = parseSpec(
      MINIMAL.replace(
        'driver: claude-code',
        'driver: claude-code\n  model:\n    primary: sonnet\n    escalate: [opus]\n    fallback: [haiku]'
      )
    );
    expect(both.agent).toMatchObject({ escalate: ['opus'], fallback: ['haiku'] });

    const builtin = (fallback: string) =>
      MINIMAL.replace(
        'driver: claude-code',
        `driver: builtin\n  model:\n    primary: fake/small\n    fallback: ${fallback}`
      );
    expect(parseSpec(builtin('[other/m, fake/large]')).agent.fallback).toEqual([
      'other/m',
      'fake/large',
    ]);
    const bare = errorOf(builtin('[fake/large, huge]'));
    expect(bare.message).toMatch(/"huge" must name the provider too/);
    expect([bare.line, bare.column]).toEqual([9, 28]);
    expect(errorOf(builtin('[fake/small]')).message).toMatch(/already the primary model/);
    expect(errorOf(builtin('[fake/a, fake/a]')).message).toMatch(/already listed/);
    expect(errorOf(builtin('[]')).message).toMatch(/one or more models/);
    expect(errorOf(builtin('[a/1, a/2, a/3, a/4, a/5, a/6]')).message).toMatch(/at most 5/);
    expect(errorOf(builtin('fake/large')).message).toMatch(/one or more models/);
    // A CLI that cannot be told a model cannot be told another.
    expect(
      errorOf(
        MINIMAL.replace('driver: claude-code', 'driver: claude-code\n  model:\n    fallback: [7]')
      ).message
    ).toMatch(/Each fallback model must be a model name/);
  });

  describe('against a registry', () => {
    const registry = parseRegistry(
      'providers:\n  - id: fake\n    label: Fake\n    adapter: anthropic\n    baseUrl: https://f.invalid\n    models:\n      - id: small\n  - id: other\n    label: Other\n    adapter: openai-compat\n    baseUrl: https://o.invalid\n    models: []\n'
    );
    const builtin = (model: string) =>
      MINIMAL.replace('driver: claude-code', `driver: builtin\n  model:\n${model}`);

    it('refuses a provider it does not know, in the primary, an escalation and a fallback, by line', () => {
      const primary = (() => {
        try {
          parseSpec(builtin('    primary: fakee/small'), { registry });
        } catch (e) {
          return e as SpecError;
        }
        throw new Error('expected a SpecError');
      })();
      expect(primary.message).toMatch(
        /Unknown provider "fakee" in "fakee\/small"\. Known: fake, other\./
      );
      expect([primary.line, primary.column]).toEqual([8, 14]);

      for (const key of ['escalate', 'fallback']) {
        let err: SpecError | undefined;
        try {
          parseSpec(builtin(`    primary: fake/small\n    ${key}: [other/x, nope/y]`), {
            registry,
          });
        } catch (e) {
          err = e as SpecError;
        }
        expect(err?.message, key).toMatch(/Unknown provider "nope" in "nope\/y"/);
        expect([err?.line, err?.column], key).toEqual([9, 25]);
      }
    });

    it('allows a model id the registry does not list, and a provider with no models listed', () => {
      expect(
        parseSpec(builtin('    primary: fake/brand-new-model'), { registry }).agent.model
      ).toBe('fake/brand-new-model');
      expect(parseSpec(builtin('    primary: other/anything'), { registry }).agent.model).toBe(
        'other/anything'
      );
    });

    it('checks nothing without a registry, and nothing for a CLI, whose model is the CLI’s own', () => {
      expect(parseSpec(builtin('    primary: nobody/x')).agent.model).toBe('nobody/x');
      const cli = MINIMAL.replace('driver: claude-code', 'driver: claude-code\n  model: nobody/x');
      expect(parseSpec(cli, { registry }).agent.model).toBe('nobody/x');
    });
  });

  it('reads memory.read, and checks each type by line', () => {
    expect(parseSpec(MINIMAL).memory).toEqual({ read: [] });
    expect(parseSpec(`${MINIMAL}memory:\n  read: [preference, procedure]\n`).memory).toEqual({
      read: ['preference', 'procedure'],
    });
    const bad = errorOf(`${MINIMAL}memory:\n  read: [fact, gossip]\n`);
    expect(bad.message).toMatch(/"gossip" is not a kind of memory\. Use fact, preference/);
    expect([bad.line, bad.column]).toEqual([11, 16]);
    expect(errorOf(`${MINIMAL}memory:\n  read: [fact, fact]\n`).message).toMatch(/listed twice/);
    expect(errorOf(`${MINIMAL}memory:\n  read: []\n`).message).toMatch(/one or more of fact/);
    expect(errorOf(`${MINIMAL}memory:\n  write: [fact]\n`).message).toMatch(
      /Unknown key "memory.write"/
    );
  });

  it('reads diff assertions as gates, and points at the mistake in a bad one', () => {
    const spec = parseSpec(
      `${MINIMAL}gates:\n  - run: pnpm test\n  - assert: diff.files_changed <= 5\n  - assert: diff.touches_none_of [src/**, .github/**]\n`
    );
    expect(spec.gates).toEqual([
      { run: 'pnpm test', timeoutMs: 600_000 },
      {
        assert: 'diff.files_changed <= 5',
        check: { kind: 'compare', metric: 'files_changed', op: '<=', value: 5 },
      },
      {
        assert: 'diff.touches_none_of [src/**, .github/**]',
        check: { kind: 'touches_none_of', globs: ['src/**', '.github/**'] },
      },
    ]);

    // Line 11, the value starts at column 13; the column points into it.
    const name = errorOf(`${MINIMAL}gates:\n  - assert: diff.files_changd <= 5\n`);
    expect(name.message).toMatch(/Unknown diff.files_changd/);
    expect([name.line, name.column]).toEqual([11, 18]);
    const op = errorOf(`${MINIMAL}gates:\n  - assert: diff.lines_added =< 5\n`);
    expect(op.message).toMatch(/must be compared with/);
    expect([op.line, op.column]).toEqual([11, 30]);
    const quoted = errorOf(`${MINIMAL}gates:\n  - assert: 'diff.lines_removed < many'\n`);
    expect(quoted.message).toMatch(/needs a whole number/);
    expect([quoted.line, quoted.column]).toEqual([11, 35]);
    const list = errorOf(`${MINIMAL}gates:\n  - assert: diff.touches_only [docs/** src/**]\n`);
    expect(list.message).toMatch(/Expected "," or "\]"/);
    expect([list.line, list.column]).toEqual([11, 40]);
    expect(errorOf(`${MINIMAL}gates:\n  - assert: pnpm test\n`).message).toMatch(/use "run:"/);
    expect(
      errorOf(`${MINIMAL}gates:\n  - assert: diff.files_changed <= 5\n    timeout: 1m\n`).message
    ).toMatch(/Unknown key "gates.0.timeout"/);
    expect(errorOf(`${MINIMAL}gates:\n  - check: x\n`).message).toMatch(
      /"run: <command>" or "assert:/
    );
  });

  it('reads remote repositories: github:, gitlab: and https URLs on either', () => {
    const gh = parseSpec(MINIMAL.replace('[local:~/code/app]', '[github:paxamedia/OpenClerq#dev]'));
    expect(gh.repo).toEqual({
      kind: 'github',
      project: 'paxamedia/OpenClerq',
      url: 'https://github.com/paxamedia/OpenClerq.git',
      ref: 'dev',
      target: 'github:paxamedia/OpenClerq#dev',
    });
    expect(gh.publish.tokenSecret).toBe('GITHUB_TOKEN');
    const gl = parseSpec(MINIMAL.replace('[local:~/code/app]', '[gitlab:group/sub/app]'));
    expect(gl.repo).toMatchObject({ kind: 'gitlab', project: 'group/sub/app' });
    // A GitLab token by default, for a GitLab repository.
    expect(gl.publish.tokenSecret).toBe('GITLAB_TOKEN');
    const https = parseSpec(
      MINIMAL.replace('[local:~/code/app]', '["https://github.com/acme/app.git"]')
    );
    expect(https.repo).toMatchObject({ kind: 'github', project: 'acme/app' });
  });

  it('refuses a repository it cannot work on, and more than one', () => {
    const other = errorOf(
      MINIMAL.replace('[local:~/code/app]', '["https://git.example.com/acme/app.git"]')
    );
    expect(other.message).toMatch(/local:<path>, github:owner\/name, gitlab:group\/name/);
    expect(other.line).toBe(4);
    expect(errorOf(MINIMAL.replace('[local:~/code/app]', '[github:acme]')).message).toMatch(
      /not a repository/
    );
    expect(
      errorOf(MINIMAL.replace('[local:~/code/app]', "['github:acme/app#--upload-pack=x']")).message
    ).toMatch(/not a branch name/);
    expect(
      errorOf(MINIMAL.replace('[local:~/code/app]', "['github:acme/app#main#evil']")).message
    ).toMatch(/at most one #branch/);
    const two = errorOf(MINIMAL.replace('[local:~/code/app]', '[local:/a, github:acme/app]'));
    expect(two.message).toMatch(/one repository/);
  });

  it('checks names, drivers, amounts and durations', () => {
    expect(errorOf(MINIMAL.replace('name: deps', 'name: Deps Bot')).message).toMatch(/lowercase/);
    expect(errorOf(MINIMAL.replace('driver: claude-code', 'driver: aider')).message).toMatch(
      /one of: claude-code, codex, cursor-agent/
    );
    expect(errorOf(`${MINIMAL}budget:\n  max_usd_per_run: -1\n`).message).toMatch(/positive/);
    expect(errorOf(`${MINIMAL}  timeout: soon\n`).message).toMatch(/duration/);
    expect(errorOf(`${MINIMAL}publish:\n  push: false\n  pull_request: draft\n`).message).toMatch(
      /needs "publish.push: true"/
    );
  });

  it('accepts the codex and cursor-agent drivers', () => {
    for (const driver of ['codex', 'cursor-agent']) {
      const spec = parseSpec(
        MINIMAL.replace('driver: claude-code', `driver: ${driver}\n  model: some-model`)
      );
      expect(spec.agent).toMatchObject({
        driver,
        model: 'some-model',
        permissionMode: 'acceptEdits',
        allowedTools: [],
      });
    }
  });

  it("refuses what the driver's CLI cannot do, naming the key and the driver", () => {
    for (const [driver, label] of [
      ['codex', 'Codex'],
      ['cursor-agent', 'Cursor'],
    ]) {
      const base = MINIMAL.replace('driver: claude-code', `driver: ${driver}`);
      const tools = errorOf(
        base.replace(`driver: ${driver}`, `driver: ${driver}\n  allowed_tools: [Edit]`)
      );
      expect(tools.message).toMatch(
        new RegExp(`"agent.allowed_tools" is not supported by the ${driver} driver`)
      );
      expect(tools.message).toContain(label);
      expect(tools.line).toBe(7);

      const perRun = errorOf(`${base}budget:\n  max_usd_per_run: 2\n`);
      expect(perRun.message).toMatch(/"budget.max_usd_per_run" is not supported.*no spend limit/);
      expect(perRun.line).toBe(11);

      const perMonth = errorOf(`${base}budget:\n  max_usd_per_month: 50\n`);
      expect(perMonth.message).toMatch(
        /"budget.max_usd_per_month" is not supported.*does not report/
      );
    }
  });

  it('still allows claude-code a tool list and both budgets', () => {
    const spec = parseSpec(
      MINIMAL.replace('driver: claude-code', 'driver: claude-code\n  allowed_tools: [Edit]') +
        'budget:\n  max_usd_per_run: 2\n  max_usd_per_month: 50\n'
    );
    expect(spec.budget).toEqual({ maxUsdPerRun: 2, maxUsdPerMonth: 50 });
  });

  it('reports YAML syntax errors with their position', () => {
    const e = errorOf('name: deps\n  bad: [\n');
    expect(e.line).toBeGreaterThan(0);
  });

  it('refuses a duplicate key', () => {
    expect(() => parseSpec(`${MINIMAL}prompt: again\n`)).toThrow(SpecError);
  });

  it('runs native when the spec has no sandbox block, and remembers that it was assumed', () => {
    const assumed = parseSpec(MINIMAL.replace('sandbox:\n  profile: native\n', ''));
    expect(assumed.sandbox).toEqual({ profile: 'native', timeoutMs: 20 * 60_000, explicit: false });
    expect(parseSpec(MINIMAL).sandbox.explicit).toBe(true);
  });

  it('reads the seatbelt profile with its hosts, and limits the filesystem to the repo', () => {
    const spec = parseSpec(
      keyed(MINIMAL).replace(
        'profile: native',
        'profile: seatbelt\n  network: [Registry.npmjs.org, "*.github.com", "api.example.com:8443"]\n  timeout: 5m'
      )
    );
    expect(spec.sandbox).toEqual({
      profile: 'seatbelt',
      timeoutMs: 5 * 60_000,
      network: ['registry.npmjs.org', '*.github.com', 'api.example.com:8443'],
      filesystem: 'repo_only',
      explicit: true,
    });
    expect(
      parseSpec(keyed(MINIMAL).replace('profile: native', 'profile: seatbelt\n  network: all'))
        .sandbox.network
    ).toBe('all');
  });

  it('refuses hosts it cannot enforce, with the line', () => {
    const bad = errorOf(
      MINIMAL.replace(
        'profile: native',
        'profile: seatbelt\n  network: [ok.example, "http://x.example/"]'
      )
    );
    expect(bad.message).toMatch(/Each host is a name/);
    expect(bad.line).toBe(10);
    expect(
      errorOf(
        MINIMAL.replace('profile: native', 'profile: seatbelt\n  network: ["x.example:99999"]')
      ).message
    ).toMatch(/invalid port/);
    expect(
      errorOf(MINIMAL.replace('profile: native', 'profile: seatbelt\n  filesystem: everything'))
        .message
    ).toMatch(/"sandbox.filesystem" must be one of: repo_only/);
  });

  it('needs an image, and a key for a CLI, in a container', () => {
    expect(errorOf(MINIMAL.replace('profile: native', 'profile: container')).message).toMatch(
      /needs "sandbox.image".*Claude Code's CLI \(`claude`\)/
    );
    expect(
      errorOf(MINIMAL.replace('profile: native', 'profile: container\n  image: agents:1')).message
    ).toMatch(
      /container profile, Claude Code does not use this machine's sign-in.*"agent.api_key_secret"/
    );
    // The same under seatbelt: the run never uses the user's own CLI state.
    expect(errorOf(MINIMAL.replace('profile: native', 'profile: seatbelt')).message).toMatch(
      /seatbelt profile, Claude Code does not use this machine's sign-in/
    );
    expect(
      parseSpec(keyed(MINIMAL).replace('profile: native', 'profile: seatbelt')).sandbox.profile
    ).toBe('seatbelt');
    const ok = parseSpec(
      MINIMAL.replace(
        'driver: claude-code',
        'driver: claude-code\n  api_key_secret: ANTHROPIC_KEY'
      ).replace('profile: native', 'profile: container\n  image: ghcr.io/acme/agents:1')
    );
    expect(ok.sandbox).toMatchObject({ profile: 'container', image: 'ghcr.io/acme/agents:1' });
    expect(
      errorOf(keyed(MINIMAL).replace('profile: native', 'profile: seatbelt\n  image: x')).message
    ).toMatch(/container profile only/);
  });

  it('refuses an empty spec', () => {
    expect(() => parseSpec('   ')).toThrow(/empty/);
  });
});

describe('parseDuration', () => {
  it('reads units and bare seconds', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('20m')).toBe(1_200_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration(30)).toBe(30_000);
    expect(parseDuration('20 minutes')).toBeNull();
    expect(parseDuration(0)).toBeNull();
  });
});

describe('nextRunOf', () => {
  it('finds the coming Monday for a weekday schedule', () => {
    const next = nextRunOf('0 8 * * 1') as Date;
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(8);
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 3_600_000);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('answers null for an invalid expression', () => {
    expect(nextRunOf('not cron')).toBeNull();
  });
});
