import { describe, it, expect } from 'vitest';
import { evaluate } from '@clerq/policy';
import { githubProject, policyFor } from './runner.js';
import { parseSpec } from './spec.js';

const base = `
name: x
targets:
  repos: [local:/tmp/x]
agent:
  driver: claude-code
prompt: p
sandbox:
  profile: native
`;

describe('githubProject', () => {
  it('reads owner/repo from the URL forms git accepts', () => {
    expect(githubProject('https://github.com/acme/app.git')).toBe('acme/app');
    expect(githubProject('https://github.com/acme/app')).toBe('acme/app');
    expect(githubProject('https://token@github.com/acme/app.git')).toBe('acme/app');
    expect(githubProject('git@github.com:acme/app.git')).toBe('acme/app');
    expect(githubProject('ssh://git@github.com/acme/app.git')).toBe('acme/app');
  });

  it('refuses anything that is not GitHub', () => {
    expect(githubProject('https://gitlab.com/acme/app.git')).toBeNull();
    expect(githubProject('/srv/git/app.git')).toBeNull();
    expect(githubProject('https://github.com.evil.example/acme/app.git')).toBeNull();
    expect(githubProject(null)).toBeNull();
  });
});

describe('policyFor', () => {
  const push = { name: 'git.push', risk: 'external' as const };

  it('makes pushing wait for a human by default', () => {
    expect(evaluate(policyFor(parseSpec(base), false), push).decision).toBe('needs_approval');
  });

  it("holds an automation's first push for approval even when its spec says auto", () => {
    const spec = parseSpec(`${base}approvals:\n  push: auto\n`);
    expect(evaluate(policyFor(spec, true), push).decision).toBe('needs_approval');
    expect(evaluate(policyFor(spec, false), push).decision).toBe('allow');
  });

  it('denies pushing and pull requests when the spec does not publish', () => {
    const rules = policyFor(parseSpec(`${base}publish:\n  push: false\n`), false);
    expect(evaluate(rules, push).decision).toBe('deny');
    expect(evaluate(rules, { name: 'forge.pull_request', risk: 'external' }).decision).toBe('deny');
    expect(evaluate(rules, { name: 'runtime.agent', risk: 'execute' }).decision).toBe('allow');
  });
});
