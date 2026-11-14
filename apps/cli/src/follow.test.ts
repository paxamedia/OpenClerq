import { describe, expect, it } from 'vitest';
import type { Approval, RunDetail, RunStep, ToolCallRecord } from '@clerq/gateway-client';
import {
  RunReader,
  decisionWords,
  inputSummary,
  itemLines,
  runHeader,
  toolLine,
} from './follow.js';

const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, s)).toISOString();

const step = (seq: number, over: Partial<RunStep> = {}): RunStep => ({
  seq,
  kind: 'git',
  input: { action: 'fetch' },
  output: {},
  status: 'ok',
  createdAt: at(seq),
  ...over,
});
const call = (id: number, over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id,
  name: 'fs.write',
  input: { path: 'a.txt' },
  output: 'wrote a.txt',
  status: 'ok',
  approvalState: 'not_required',
  durationMs: 12,
  createdAt: at(10 + id),
  ...over,
});
const run = (over: Partial<RunDetail> = {}): RunDetail => ({
  id: 'run_1',
  status: 'executing',
  trigger: 'manual',
  createdAt: at(0),
  costUsd: 0,
  costKnown: true,
  tokensIn: 0,
  tokensOut: 0,
  steps: [],
  toolCalls: [],
  artifacts: [],
  ...over,
});
const approval = (id: number, over: Partial<Approval> = {}): Approval => ({
  id,
  runId: 'run_1',
  tool: 'git.push',
  tier: 'high',
  reason: 'Push the branch.',
  requestedAt: at(20),
  ...over,
});

describe('RunReader', () => {
  it('shows each step once, in the words the desktop app uses', () => {
    const reader = new RunReader();
    const first = reader.news(
      run({
        steps: [step(1), step(2, { input: { action: 'worktree' }, output: { branch: 'auto/x' } })],
      }),
      []
    );
    expect(first.map((i) => i.type === 'step' && i.label)).toEqual([
      'Fetched the base branch',
      'Opened a worktree on auto/x',
    ]);
    const second = reader.news(
      run({
        steps: [
          step(1),
          step(2),
          step(3, { input: { action: 'commit' }, output: { sha: 'abcdef123' } }),
        ],
      }),
      []
    );
    expect(second.map((i) => i.type === 'step' && i.label)).toEqual(['Committed abcdef1']);
    expect(reader.news(run({ steps: [step(1), step(2), step(3)] }), [])).toEqual([]);
  });

  it('shows a tool call as one line, not also as the step that records it', () => {
    const reader = new RunReader();
    const items = reader.news(
      run({
        steps: [step(1), step(2, { kind: 'tool', input: { name: 'fs.write' }, output: {} })],
        toolCalls: [call(1, { stepSeq: 2 })],
      }),
      []
    );
    expect(items.map((i) => i.type)).toEqual(['step', 'tool']);
  });

  it('holds a tool call that is still going until the run is over', () => {
    const reader = new RunReader();
    const going = run({
      toolCalls: [call(1, { status: 'running', output: undefined, durationMs: undefined })],
    });
    expect(reader.news(going, [])).toEqual([]);
    const end = reader.news({ ...going, status: 'failed', exitReason: 'Stopped.' }, [], true);
    expect(end.map((i) => i.type)).toEqual(['tool', 'finished']);
    expect(end[0]).toMatchObject({ type: 'tool', status: 'running' });
  });

  it('says an approval once, and a sub-agent each time its state changes', () => {
    const reader = new RunReader();
    const base = run({ status: 'awaiting_approval' });
    expect(reader.news(base, [approval(7)]).map((i) => i.type)).toEqual(['approval']);
    expect(reader.news(base, [approval(7)])).toEqual([]);
    expect(
      reader
        .news(base, [approval(7), approval(8)])
        .map((i) => i.type === 'approval' && i.approval.id)
    ).toEqual([8]);

    const child = {
      id: 'run_2',
      status: 'executing',
      input: 'Check the docs\nand report',
      costUsd: 0,
      costKnown: true,
      createdAt: at(5),
    };
    expect(reader.news(run({ children: [child] }), [])).toMatchObject([
      { type: 'subagent', id: 'run_2', status: 'executing', task: 'Check the docs and report' },
    ]);
    expect(reader.news(run({ children: [child] }), [])).toEqual([]);
    expect(reader.news(run({ children: [{ ...child, status: 'done' }] }), [])).toMatchObject([
      { type: 'subagent', status: 'done' },
    ]);
  });

  it('ends with one finished item carrying the reason', () => {
    const reader = new RunReader();
    const items = reader.news(run({ status: 'failed', exitReason: 'A gate failed.' }), [], true);
    expect(items).toEqual([{ type: 'finished', status: 'failed', exitReason: 'A gate failed.' }]);
  });

  it('puts what happened first first, steps and tool calls together', () => {
    const reader = new RunReader();
    const items = reader.news(
      run({ steps: [step(1, { createdAt: at(30) })], toolCalls: [call(1, { createdAt: at(10) })] }),
      []
    );
    expect(items.map((i) => i.type)).toEqual(['tool', 'step']);
  });
});

describe('what a line says', () => {
  it('writes a tool call with its label, input, outcome and decision', () => {
    const [item] = new RunReader().news(
      run({ toolCalls: [call(1, { approvalState: 'approved', durationMs: 3200 })] }),
      []
    );
    if (item.type !== 'tool') throw new Error('expected a tool call');
    expect(toolLine(item)).toBe('Write a file (fs.write)  a.txt  [done, you approved it, 3 s]');
    expect(itemLines(item)[1].trim()).toBe('wrote a.txt');
    // A tool with no friendlier name shows its own, once; a quick call shows no time.
    const [other] = new RunReader().news(
      run({ toolCalls: [call(2, { name: 'Write', approvalState: null, durationMs: 4 })] }),
      []
    );
    if (other.type !== 'tool') throw new Error('expected a tool call');
    expect(toolLine(other)).toBe('Write  a.txt  [done]');
  });

  it('says who decided in words, and that a CLI agent does not say', () => {
    expect(decisionWords(call(1, { approvalState: 'not_required' }))).toBe(
      'allowed without asking'
    );
    expect(decisionWords(call(1, { approvalState: 'approved' }))).toBe('you approved it');
    expect(decisionWords(call(1, { approvalState: 'denied', status: 'denied' }))).toBe(
      'you denied it'
    );
    expect(decisionWords(call(1, { approvalState: 'not_required', status: 'denied' }))).toBe(
      'refused by policy'
    );
    expect(decisionWords(call(1, { approvalState: null }))).toBe('');
  });

  it('cuts an input to one short line', () => {
    expect(inputSummary({ command: 'git status\n  --short' })).toBe('git status --short');
    expect(inputSummary({ other: 1 })).toBe('{"other":1}');
    expect(inputSummary('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(inputSummary(undefined)).toBe('');
  });

  it('prints the way to answer an approval beside it', () => {
    const [a] = new RunReader().news(run({ status: 'awaiting_approval' }), [approval(7)]);
    expect(itemLines(a)).toEqual([
      '          Waiting for approval 7: Push (git.push). Push the branch.',
      '            Approve: clerq approve 7    Deny: clerq deny 7',
    ]);
  });

  it('gives a run a header with its facts, and no cost row for a free run', () => {
    const head = runHeader(
      run({
        status: 'done',
        automationName: 'nightly-tidy',
        startedAt: at(0),
        finishedAt: at(75),
        branch: 'auto/x',
        prUrl: 'https://github.com/acme/app/pull/3',
        costUsd: 0.5,
        tokensIn: 100,
        tokensOut: 20,
        modelOverride: 'openai/gpt-5-mini',
      })
    );
    expect(head[0]).toBe('Run run_1 of nightly-tidy: succeeded');
    const text = head.join('\n');
    expect(text).toContain('Took          1 min 15 s');
    expect(text).toContain('Pull request  https://github.com/acme/app/pull/3');
    expect(text).toContain('Cost          $0.50 (100 tokens in, 20 out)');
    expect(text).toContain(
      'openai/gpt-5-mini, chosen for this run: used as chosen, with no fallback'
    );
    expect(runHeader(run()).join('\n')).not.toContain('Cost');
  });
});
