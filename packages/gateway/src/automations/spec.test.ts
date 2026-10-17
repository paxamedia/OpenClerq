import { describe, it, expect } from 'vitest';
import { parseSpec, parseDuration, SpecError } from './spec.js';
import { nextRunOf } from './scheduler.js';

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
    expect(errorOf(`${MINIMAL}gates:\n  - assert: diff.files_changed <= 5\n`).message).toMatch(
      /diff assertions/
    );
    expect(errorOf(MINIMAL.replace('profile: native', 'profile: container')).message).toMatch(
      /"native" profile only/
    );
    expect(errorOf(`${MINIMAL}  network: [registry.npmjs.org]\n`).message).toMatch(
      /network restriction/
    );
  });

  it('refuses remote and multiple repositories', () => {
    expect(
      errorOf(MINIMAL.replace('[local:~/code/app]', '[github:paxamedia/OpenClerq]')).message
    ).toMatch(/local:<path>/);
    const two = errorOf(MINIMAL.replace('[local:~/code/app]', '[local:/a, local:/b]'));
    expect(two.message).toMatch(/one repository/);
  });

  it('checks names, drivers, amounts and durations', () => {
    expect(errorOf(MINIMAL.replace('name: deps', 'name: Deps Bot')).message).toMatch(/lowercase/);
    expect(errorOf(MINIMAL.replace('driver: claude-code', 'driver: codex')).message).toMatch(
      /one of: claude-code/
    );
    expect(errorOf(`${MINIMAL}budget:\n  max_usd_per_run: -1\n`).message).toMatch(/positive/);
    expect(errorOf(`${MINIMAL}  timeout: soon\n`).message).toMatch(/duration/);
    expect(errorOf(`${MINIMAL}publish:\n  push: false\n  pull_request: draft\n`).message).toMatch(
      /needs "publish.push: true"/
    );
  });

  it('reports YAML syntax errors with their position', () => {
    const e = errorOf('name: deps\n  bad: [\n');
    expect(e.line).toBeGreaterThan(0);
  });

  it('refuses a duplicate key', () => {
    expect(() => parseSpec(`${MINIMAL}prompt: again\n`)).toThrow(SpecError);
  });

  it('makes running without isolation an explicit choice', () => {
    const e = errorOf(MINIMAL.replace('sandbox:\n  profile: native\n', ''));
    expect(e.message).toMatch(/Add `sandbox: \{ profile: native \}` to accept that/);
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
