import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RunStep, ToolCallRecord } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { costWithChildren } from '../../app/stats';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import {
  childNode,
  decisionWords,
  inputSummary,
  OUTPUT_LINES,
  outputPreview,
  outputSummary,
  RunTree,
  ToolCalls,
} from './RunParts';
import { Runs } from './Runs';
import { describeStep, previousModel, stepLabel } from './steps';

const client = createFixtureClient({ now: FIXTURE_NOW });

/** A page drawn from what the store already holds, as it is once the gateway has answered. */
function page(node: ReactElement, held: Record<string, unknown> = {}): string {
  const store = new LiveStore();
  for (const [key, data] of Object.entries(held)) store.write(key, () => data);
  return renderToStaticMarkup(
    <EnvironmentContext.Provider
      value={{ client, host: { kind: 'web', version: '1.0.0', openUrl: () => {} } }}
    >
      <LiveProvider client={client} store={store}>
        <ToastProvider>{node}</ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}

const step = (over: Partial<RunStep>): RunStep => ({
  seq: 1,
  kind: 'tool',
  createdAt: '2026-11-11T10:00:00.000Z',
  ...over,
});
const tool = (name: string, input: object = {}, output: object = {}, status = 'ok') =>
  step({ kind: 'tool', input: { name, ...input }, output, status });

describe('step labels', () => {
  it('names a model fallback with where it went and why', () => {
    const w = describeStep(
      tool(
        'model.fallback',
        { from: 'a/one', to: 'b/two' },
        { reason: 'overloaded', skipped: [{ model: 'c/three', reason: 'no key' }] },
        'warning'
      )
    );
    expect(w.label).toBe('Switched to b/two: a/one was unavailable');
    expect(w.note).toContain('Reason: overloaded.');
    expect(w.note).toContain('Passed over: c/three (no key).');
    expect(w.note).toContain('provider may be a different one');
  });

  it('names an escalation after a failed gate', () => {
    const w = describeStep(
      tool('agent.escalate', { model: 'x/big' }, { from: 'x/small', after: 'Gate failed: t' })
    );
    expect(w.label).toBe('A gate failed: running the agent again with x/big');
    expect(w.note).toContain('same worktree');
    expect(w.note).toContain('x/small');
  });

  it('does not call an unnamed model "default" as if it were one', () => {
    const unnamed = describeStep(
      tool('agent.escalate', { model: 'x/big' }, { from: 'default', after: 'Gate failed: t' })
    );
    expect(unnamed.note).toContain(
      'Before this it used the agent program’s own default model, since none was named.'
    );
    expect(unnamed.note).not.toMatch(/used default/i);
    expect(
      describeStep(tool('agent.escalate', { model: 'x/big' }, { after: 'Gate failed: t' })).note
    ).not.toContain('Before this');
    expect(previousModel('x/small')).toBe('Before this it used x/small.');
    expect(previousModel(undefined)).toBeUndefined();
  });

  it('says what a sub-agent started with', () => {
    const named = describeStep(
      tool('subagent.start', {
        parentRunId: 'run_p',
        tools: ['risk:read'],
        model: 'x/m',
        strict: true,
      })
    );
    expect(named.label).toBe('Started as a sub-agent');
    expect(named.note).toContain('run_p');
    expect(named.note).toContain('risk:read');
    expect(named.note).toContain('does not fall back');
    const inherited = describeStep(tool('subagent.start', { parentRunId: 'run_p', model: null }));
    expect(inherited.note).toContain('Tools: read-only.');
    expect(inherited.note).toContain('the one its parent was using');
  });

  it('warns that native is not isolated, and says which profile otherwise', () => {
    const native = describeStep(
      tool('sandbox', { profile: 'native' }, { note: 'Unisolated: runs as you.' }, 'warning')
    );
    expect(native.label).toBe('Not isolated: runs with your account’s access');
    expect(native.note).toBe('Unisolated: runs as you.');
    expect(
      describeStep(tool('sandbox', { profile: 'seatbelt' }, { note: 'Isolated.' })).label
    ).toBe('Isolated: seatbelt');
  });

  it('flags a vault secret in the diff', () => {
    const w = describeStep(
      tool('diff.secrets', {}, { note: 'Pushing waits for approval.' }, 'warning')
    );
    expect(w.label).toBe('A vault secret is in the diff');
    expect(w.note).toBe('Pushing waits for approval.');
  });

  it('says the GitHub App, and who it acts as, on the steps that used it', () => {
    const source = 'github-app:openclerq-3fa91c/installation/4242';
    const clone = describeStep(
      step({
        kind: 'git',
        input: { action: 'clone', repo: 'github:a/b' },
        output: { path: '/c/x', credential: source },
      })
    );
    expect(clone.note).toContain('Reached with the GitHub App openclerq-3fa91c.');
    const push = describeStep(
      step({
        kind: 'git',
        input: { action: 'push', branch: 'auto/x' },
        output: { credential: source, pushedAs: 'openclerq-3fa91c[bot]' },
      })
    );
    expect(push.label).toBe('Pushed auto/x');
    expect(push.note).toBe(
      'Used the GitHub App openclerq-3fa91c. Done as openclerq-3fa91c[bot], the app’s own account, not as a person.'
    );
    const pr = describeStep(
      step({
        kind: 'git',
        input: { action: 'pull_request' },
        output: {
          url: 'https://github.com/a/b/pull/1',
          credential: source,
          openedBy: 'openclerq-3fa91c[bot]',
        },
      })
    );
    expect(pr.note).toContain('openclerq-3fa91c[bot]');
    // A vault secret reads as its name, as before.
    const vault = describeStep(
      step({
        kind: 'git',
        input: { action: 'push', branch: 'auto/x' },
        output: { credential: 'vault:GITHUB_TOKEN' },
      })
    );
    expect(vault.note).toBe('Used GITHUB_TOKEN.');
  });

  it('tells a clone from a cached clone', () => {
    const fresh = describeStep(
      step({
        kind: 'git',
        input: { action: 'clone', repo: 'github:a/b' },
        output: { path: '/c/x', credential: 'vault:GITHUB_TOKEN' },
      })
    );
    expect(fresh.label).toBe('Cloned github:a/b');
    expect(fresh.note).toContain('Reached with GITHUB_TOKEN.');
    const cached = describeStep(
      step({
        kind: 'git',
        input: { action: 'cached', repo: 'github:a/b' },
        output: { path: '/c/x' },
      })
    );
    expect(cached.label).toBe('Used the cached clone of github:a/b');
    expect(cached.note).toContain('No credential was used.');
  });

  it('lists the hosts a gate could not reach', () => {
    const w = describeStep(
      step({
        kind: 'gate',
        input: { run: 'pnpm test' },
        output: {
          egressDenied: [
            { host: 'registry.npmjs.org', port: 443 },
            { host: 'registry.npmjs.org', port: 443 },
            { host: 'cdn.example.com', port: 443 },
          ],
        },
        status: 'failed',
      })
    );
    expect(w.label).toBe('Gate: pnpm test: 2 hosts blocked');
    expect(w.note).toContain('registry.npmjs.org, cdn.example.com');
    expect(w.note).toContain('sandbox.network');
    expect(
      describeStep(step({ kind: 'gate', input: { run: 'pnpm test' }, status: 'passed' })).label
    ).toBe('Gate: pnpm test');
  });

  it('reads a retry, a requeue and a caught-up schedule', () => {
    const retry = describeStep(
      tool('run.retry', { attempt: 2 }, { after: 'Crashed', cause: 'driver_crash' }, 'warning')
    );
    expect(retry.label).toBe('Trying the run again (attempt 2)');
    expect(retry.note).toContain('the agent stopped without a result');
    const requeue = describeStep(
      tool('run.requeue', { relaunch: 1 }, { after: 'It stopped.', of: 3 })
    );
    expect(requeue.label).toBe('Put back in the queue (1 of 3)');
    const catchUp = describeStep(
      tool('schedule.catch_up', {}, { missedSlots: 3, countCapped: false, noticed: 'wake' })
    );
    expect(catchUp.label).toBe('Caught up a missed schedule');
    expect(catchUp.note).toContain('3 scheduled times');
    expect(catchUp.note).toContain('stands for all of them');
  });

  it('reads memory and context steps', () => {
    expect(
      describeStep(tool('memory.read', { types: ['preference'], includeAgent: true }, { notes: 2 }))
    ).toMatchObject({ label: 'Read 2 saved notes' });
    expect(describeStep(tool('memory.read', { types: ['fact'] }, { notes: 0 })).label).toBe(
      'Looked for saved notes: none matched'
    );
    const summary = describeStep(
      tool(
        'context.compact',
        { method: 'summary' },
        { compactedMessages: 1, tokensBefore: 900, tokensAfter: 200 }
      )
    );
    expect(summary.label).toBe('Summarised earlier context');
    expect(summary.note).toContain('1 older message were summarised');
    expect(describeStep(tool('context.compact', { method: 'dropped' }, {})).note).toContain(
      'no longer sees them'
    );
  });

  it('names the check of a model a person chose, and what it found', () => {
    const ok = describeStep(
      tool('driver.detect', { driver: 'builtin', model: 'x/m', for: 'chosen' }, { available: true })
    );
    expect(ok.label).toBe('Checked the model chosen for this run (x/m)');
    const down = describeStep(
      tool(
        'driver.detect',
        { model: 'x/m', for: 'fallback' },
        { available: false, reason: 'No key.' }
      )
    );
    expect(down.label).toBe('Checked fallback model x/m: not available');
    expect(down.note).toBe('No key.');
  });

  it('leaves a step it does not know as it was', () => {
    expect(stepLabel(tool('something.new'))).toBe('Tool: something.new');
    expect(stepLabel(step({ kind: 'git', input: { action: 'push', branch: 'b' } }))).toBe(
      'Pushed b'
    );
    expect(
      stepLabel(step({ kind: 'git', input: { action: 'commit' }, output: { sha: '1234567890' } }))
    ).toBe('Committed 1234567');
  });
});

describe('tool calls', () => {
  const call = (over: Partial<ToolCallRecord>): ToolCallRecord => ({
    id: 1,
    name: 'fs.read',
    status: 'ok',
    approvalState: 'not_required',
    createdAt: '2026-11-11T10:00:00.000Z',
    ...over,
  });

  it('says who allowed a call', () => {
    expect(decisionWords(call({ approvalState: 'approved' }))).toEqual({
      tone: 'ok',
      label: 'You approved it',
    });
    expect(decisionWords(call({ approvalState: 'denied', status: 'denied' })).label).toBe('Denied');
    expect(decisionWords(call({})).label).toBe('Allowed without asking');
    expect(decisionWords(call({ status: 'denied' })).label).toBe('Refused by policy');
    expect(decisionWords(call({ approvalState: null })).label).toBe('Not reported');
  });

  it('puts a call’s input on one line', () => {
    expect(inputSummary({ command: 'pnpm outdated', cwd: '/x' })).toBe('pnpm outdated');
    expect(inputSummary({ path: 'a.txt', content: 'long' })).toBe('a.txt');
    expect(inputSummary({ other: 1 })).toBe('{"other":1}');
    expect(inputSummary('a\n  b')).toBe('a b');
    expect(inputSummary(undefined)).toBe('');
    expect(inputSummary({ command: 'x'.repeat(300) }, 20)).toHaveLength(20);
  });

  it('shows the first line of the output beside the input', () => {
    expect(outputSummary('\n  first line  \nsecond')).toBe('first line');
    expect(outputSummary(undefined)).toBe('');
    expect(outputSummary('x'.repeat(300), 20)).toHaveLength(20);
    const markup = page(
      <ToolCalls
        calls={[call({ name: 'fs.read', input: { path: 'a.txt' }, output: 'hello world\nsecond' })]}
      />
    );
    expect(markup).toContain(
      '<span class="toolcall-result" title="hello world">hello world</span>'
    );
  });

  it('folds long output and keeps short output whole', () => {
    expect(outputPreview('one\ntwo')).toMatchObject({
      folded: false,
      preview: 'one\ntwo',
      lines: 2,
    });
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const view = outputPreview(many);
    expect(view.folded).toBe(true);
    expect(view.lines).toBe(30);
    expect(view.preview.split('\n')).toHaveLength(OUTPUT_LINES);
    expect(outputPreview('x'.repeat(2000))).toMatchObject({ folded: true });
  });

  it('lists each call with its tool, decision, input, duration and folded output', () => {
    const long = Array.from({ length: 24 }, (_, i) => `row ${i}`).join('\n');
    const markup = page(
      <ToolCalls
        calls={[
          call({
            id: 1,
            name: 'runtime.shell',
            input: { command: 'pnpm outdated' },
            output: long,
            approvalState: 'approved',
            durationMs: 4300,
          }),
          call({ id: 2, name: 'fs.write', status: 'denied', output: 'Outside the worktree.' }),
          call({ id: 3, name: 'Bash', approvalState: null, input: { command: 'ls' }, output: 'a' }),
        ]}
      />
    );
    expect(markup).toContain('Run a command');
    expect(markup).toContain('<code class="toolcall-raw">runtime.shell</code>');
    expect(markup).toContain('pnpm outdated');
    expect(markup).toContain('You approved it');
    expect(markup).toContain('4 s');
    expect(markup).toContain('Show all 24 lines');
    expect(markup).not.toContain('row 20');
    expect(markup).toContain('Refused by policy');
    expect(markup).toContain('Refused');
    expect(markup).toContain('Not reported');
    // A tool that has no plain name is shown as it is, once.
    expect(markup.match(/>Bash</g)).toHaveLength(1);
  });
});

describe('what a run cost with its sub-agents', () => {
  const run = (over: object) => ({
    costUsd: 0.5,
    costKnown: true,
    childCostUsd: 0.25,
    ...over,
  });

  it('adds them up, and is a lower bound only when a price was missing somewhere', () => {
    expect(costWithChildren(run({}))).toEqual({
      usd: 0.75,
      children: 0.25,
      atLeast: false,
      childrenAtLeast: false,
    });
    expect(costWithChildren(run({ childCostKnown: false }))).toMatchObject({
      usd: 0.75,
      atLeast: true,
      childrenAtLeast: true,
    });
    // The run's own unpriced call counts too, but is not the children's.
    expect(costWithChildren(run({ costKnown: false }))).toMatchObject({
      atLeast: true,
      childrenAtLeast: false,
    });
  });

  it('has no sub-agents to add, or nothing to bound', () => {
    expect(costWithChildren({ costUsd: 0.5, costKnown: true })).toEqual({
      usd: 0.5,
      children: 0,
      atLeast: false,
      childrenAtLeast: false,
    });
    // An unknown cost of nothing is not "at least $0".
    expect(
      costWithChildren({ costUsd: 0, costKnown: true, childCostUsd: 0, childCostKnown: false })
    ).toMatchObject({ usd: 0, atLeast: false });
  });
});

describe('the sub-agent tree', () => {
  const parent = {
    id: 'run_p',
    title: 'weekly-deps',
    status: 'done',
    costUsd: 0.84,
    costKnown: true,
  };
  const kids = [
    { id: 'run_a', title: 'Find zod uses', status: 'done', costUsd: 0.18, costKnown: true },
    { id: 'run_b', title: 'List tests', status: 'executing', costUsd: 0.07, costKnown: true },
  ];

  it('shows each child under the run with its status and cost, and the roll-up', () => {
    const markup = page(<RunTree parent={parent} children={kids} currentId="run_p" />);
    expect(markup).toContain('weekly-deps');
    expect(markup).toContain('Find zod uses');
    expect(markup).toContain('href="#/runs/run_a"');
    expect(markup).toContain('Done');
    expect(markup).toContain('Running');
    expect(markup).toContain('$0.18');
    expect(markup).toContain('+ $0.25 sub-agents');
    expect(markup).toContain(
      'The sub-agents cost $0.25 on top of the run’s own $0.84: $1.09 in all.'
    );
    // The run being looked at is marked, and is not a link to itself.
    expect(markup).toContain('This run');
    expect(markup).not.toContain('href="#/runs/run_p"');
  });

  it('says "at least" in the roll-up when a sub-agent’s cost is not fully known', () => {
    const unpriced = [
      kids[0],
      { id: 'run_c', title: 'Local model', status: 'done', costUsd: 0.07, costKnown: false },
    ];
    const markup = page(<RunTree parent={parent} children={unpriced} currentId="run_p" />);
    expect(markup).toContain('+ ≥ $0.25 sub-agents');
    expect(markup).toContain('≥ $0.07');
    expect(markup).toContain(
      'The sub-agents cost at least $0.25 on top of the run’s own $0.84: at least $1.09 in all.'
    );
    // Everything known: no qualifier.
    expect(page(<RunTree parent={parent} children={kids} currentId="run_p" />)).not.toContain(
      'at least'
    );
  });

  it('marks a child as the current run, with its parent linked', () => {
    const markup = page(<RunTree parent={parent} children={kids} currentId="run_b" />);
    expect(markup).toContain('href="#/runs/run_p"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('href="#/runs/run_b"');
  });

  it('names a child by its task, shortened', () => {
    const node = childNode({
      id: 'run_x',
      status: 'done',
      input: `${'word '.repeat(60)}`,
      costUsd: 0,
      costKnown: true,
      createdAt: 't',
    });
    expect(node.title.length).toBeLessThanOrEqual(90);
    expect(node.title.endsWith('…')).toBe(true);
    expect(
      childNode({ id: 'run_y', status: 'done', costUsd: 0, costKnown: true, createdAt: 't' }).title
    ).toBe('run_y');
  });
});

describe('a run’s page', () => {
  it('reads a rich run in words, with its tool calls and the model chosen for it', async () => {
    const run = await client.run('run_rich01');
    const markup = page(<Runs id="run_rich01" />, { 'run:run_rich01': run });
    for (const text of [
      'Caught up a missed schedule',
      'Put back in the queue (1 of 3)',
      'Cloned github:example/widgets',
      'Checked the model chosen for this run (anthropic/claude-haiku-5-5)',
      'Not isolated: runs with your account’s access',
      'Read 3 saved notes',
      'Switched to openai/gpt-5-mini: anthropic/claude-haiku-5-5 was unavailable',
      'Summarised earlier context',
      'Gate: pnpm test: 1 host blocked',
      'A gate failed: running the agent again with anthropic/claude-opus-5-5',
      'Trying the run again (attempt 2)',
      'A vault secret is in the diff',
      'Tool calls (6)',
      'You approved it',
      'Show all 24 lines',
      'anthropic/claude-haiku-5-5, chosen for this run: used as chosen, with no fallback',
    ]) {
      expect(markup, text).toContain(text);
    }
  });

  it('shows a run’s sub-agents as a tree and adds their cost', async () => {
    const run = await client.run('run_subs01');
    const markup = page(<Runs id="run_subs01" />, { 'run:run_subs01': run });
    expect(markup).toContain('Sub-agents (3)');
    expect(markup).toContain('Find every use of the deprecated zod API in src/');
    // One sub-agent ran a model with no price, so what they cost is a lower bound.
    expect(markup).toContain('+ ≥ $0.29 sub-agents');
    expect(markup).toContain(
      'The sub-agents cost at least $0.29 on top of the run’s own $0.62: at least $0.91 in all.'
    );
    expect(markup).toContain('With sub-agents');
    expect(markup).toContain('≥ $0.91');
    expect(markup).not.toContain('Started by');
    expect(markup).toContain('Start a sub-agent');
  });

  it('puts a sub-agent’s run under its parent, with the siblings', async () => {
    const child = await client.run('run_subs_a');
    const parent = await client.run('run_subs01');
    const markup = page(<Runs id="run_subs_a" />, {
      'run:run_subs_a': child,
      'run:run_subs01': parent,
    });
    expect(markup).toContain('Started by a sub-agent call');
    expect(markup).toContain('href="#/runs/run_subs01"');
    expect(markup).toContain('List the tests that touch the checkout flow');
    expect(markup).toContain('This run');
    expect(markup).toContain('Started as a sub-agent');
  });

  it('adds the roll-up to the Runs list', async () => {
    const { runs } = await client.runs(500);
    const markup = page(<Runs id={null} />, {
      'runs:list:': runs,
      automations: (await client.automations()).automations,
    });
    expect(markup).toContain('incl. ≥ $0.29 sub-agents');
    // The parent's own $0.62 and its children's $0.29 make $0.91, at least.
    expect(markup).toContain('≥ $0.91');
  });
});
