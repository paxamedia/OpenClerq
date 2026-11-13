import { describe, it, expect } from 'vitest';
import {
  Conversation,
  DEFAULT_CONTEXT_WINDOW,
  contextBudget,
  estimateMessageTokens,
  estimateTokens,
  renderTranscript,
  truncateOutput,
  type ConversationMessage,
} from './index.js';

/** One tool round: an assistant call and the user turn carrying its result. */
function round(n: number, resultChars = 400): ConversationMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', adapter: 'anthropic', data: { type: 'thinking', signature: `s${n}` } },
        { type: 'text', text: `Step ${n}.` },
        { type: 'tool_use', id: `t${n}`, name: 'read_file', input: { path: `f${n}.ts` } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `t${n}`, content: 'x'.repeat(resultChars) }],
    },
  ];
}

describe('estimateTokens', () => {
  it('counts four ASCII characters a token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });

  it('counts a character outside ASCII as a token, so CJK text is not undercounted', () => {
    expect(estimateTokens('日本語')).toBe(3);
    expect(estimateTokens('ab日本')).toBe(1 + 2);
  });

  it('adds framing per message and counts tool calls and results', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'abcd' })).toBe(1 + 4);
    const [call, result] = round(1, 400);
    expect(estimateMessageTokens(result)).toBe(100 + 8 + 4);
    expect(estimateMessageTokens(call)).toBeGreaterThan(estimateTokens('Step 1.'));
  });
});

describe('contextBudget', () => {
  it('takes the window from the registry and reserves the answer and a margin', () => {
    expect(contextBudget({ context: 200_000 }, { maxOutputTokens: 8_000 })).toEqual({
      window: 200_000,
      known: true,
      budget: Math.floor(192_000 * 0.9),
    });
  });

  it('assumes a small window when the registry does not give one', () => {
    const b = contextBudget({}, { maxOutputTokens: 4_000, margin: 0 });
    expect(b).toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      known: false,
      budget: DEFAULT_CONTEXT_WINDOW - 4_000,
    });
  });
});

describe('truncateOutput', () => {
  it('leaves short output alone', () => {
    expect(truncateOutput('short', { maxChars: 10 })).toEqual({
      text: 'short',
      truncated: false,
      omitted: 0,
    });
  });

  it('keeps the start and the end, and says what was cut and how to get more', () => {
    const text = `${'a'.repeat(700)}${'m'.repeat(1_000)}${'z'.repeat(300)}`;
    const r = truncateOutput(text, { maxChars: 1_000, hint: 'Read with offset 40 to see more.' });
    expect(r.truncated).toBe(true);
    expect(r.omitted).toBe(1_000);
    expect(r.text.startsWith('a'.repeat(700))).toBe(true);
    expect(r.text.endsWith('z'.repeat(300))).toBe(true);
    expect(r.text).toContain(
      '[… output truncated: 1000 of 2000 characters cut here. Read with offset 40 to see more.]'
    );
    expect(r.text).not.toContain('mm');
  });
});

describe('Conversation', () => {
  const pinned: ConversationMessage[] = [{ role: 'user', content: 'TASK: fix the build' }];

  it('sends pinned turns first, then the history', () => {
    const c = new Conversation({ system: 'sys', pinned, budget: 10_000 });
    c.append({ role: 'assistant', content: 'ok' });
    expect(c.forRequest()).toEqual([pinned[0], { role: 'assistant', content: 'ok' }]);
  });

  it("uses the provider's count once reported, adding the heuristic only for later turns", () => {
    const c = new Conversation({ system: 'sys', pinned, budget: 100_000 });
    for (const m of round(1)) c.append(m);
    const heuristic = c.estimate();
    expect(heuristic).toBe(c.heuristicTokens());
    c.forRequest();
    c.recordUsage(5_000);
    expect(c.estimate()).toBe(5_000);
    const [call, result] = round(2);
    c.append(call);
    c.append(result);
    expect(c.estimate()).toBe(5_000 + estimateMessageTokens(call) + estimateMessageTokens(result));
  });

  it('says when the next request would pass the budget', () => {
    const c = new Conversation({ system: '', pinned, budget: 1_000 });
    expect(c.overBudget()).toBe(false);
    for (const m of round(1, 4_000)) c.append(m);
    expect(c.overBudget()).toBe(true);
  });

  it('summarises the older rounds, keeps the latest whole, and never touches the pinned turns', async () => {
    const c = new Conversation({ system: 'sys', pinned, budget: 2_000 });
    for (let n = 1; n <= 6; n++) for (const m of round(n, 1_000)) c.append(m);
    let transcript = '';
    const record = await c.compact(
      async (t) => {
        transcript = t;
        return 'Read f1..f4; nothing changed yet.';
      },
      { keepTokens: 700 }
    );
    expect(record).toMatchObject({
      method: 'summary',
      summary: 'Read f1..f4; nothing changed yet.',
    });
    expect(record!.compactedMessages + record!.keptMessages).toBe(12);
    expect(record!.tokensAfter).toBeLessThan(record!.tokensBefore);
    expect(transcript).toContain('TOOL CALL read_file: {"path":"f1.ts"}');

    const sent = c.forRequest();
    expect(sent[0]).toEqual(pinned[0]);
    expect(sent[1].role).toBe('user');
    expect(String(sent[1].content)).toContain('Read f1..f4; nothing changed yet.');
    // What is kept starts at an assistant turn: no result is separated from its call.
    expect(sent[2].role).toBe('assistant');
    const kept = sent.slice(2);
    const calls = kept.flatMap((m) =>
      typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_use')
    );
    const results = kept.flatMap((m) =>
      typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result')
    );
    expect(calls.length).toBe(results.length);
    expect(calls.length).toBeGreaterThan(0);
    // Opaque reasoning is not replayed after the history before it changed.
    expect(JSON.stringify(kept)).not.toContain('"reasoning"');
  });

  it('keeps at least the latest round, even when it alone is over the keep share', async () => {
    const c = new Conversation({ system: '', pinned, budget: 1_000 });
    for (let n = 1; n <= 3; n++) for (const m of round(n, 8_000)) c.append(m);
    const record = await c.compact(async () => 'summary', { keepTokens: 10 });
    expect(record?.keptMessages).toBe(2);
  });

  it('drops the older rounds with a note when summarising fails', async () => {
    const c = new Conversation({ system: '', pinned, budget: 2_000 });
    for (let n = 1; n <= 4; n++) for (const m of round(n, 1_000)) c.append(m);
    const record = await c.compact(
      async () => {
        throw new Error('rate limited');
      },
      { keepTokens: 400 }
    );
    expect(record).toMatchObject({ method: 'dropped', error: 'rate limited' });
    expect(String(c.messages()[1].content)).toContain('earlier messages were removed');
  });

  it('never drops a summary that was paid for: a later drop keeps it, a later summary builds on it', async () => {
    const c = new Conversation({ system: '', pinned, budget: 2_000 });
    for (let n = 1; n <= 4; n++) for (const m of round(n, 1_000)) c.append(m);
    await c.compact(async () => 'SUMMARY-ONE', { keepTokens: 400 });
    for (let n = 5; n <= 8; n++) for (const m of round(n, 1_000)) c.append(m);
    const dropped = await c.trim({ keepTokens: 400 });
    expect(dropped?.method).toBe('dropped');
    const note = String(c.messages()[1].content);
    expect(note).toContain('SUMMARY-ONE');
    expect(note).toContain('earlier messages were removed');

    for (let n = 9; n <= 12; n++) for (const m of round(n, 1_000)) c.append(m);
    let transcript = '';
    await c.compact(
      async (t) => {
        transcript = t;
        return 'SUMMARY-TWO';
      },
      { keepTokens: 400 }
    );
    expect(transcript.startsWith('EARLIER SUMMARY:\nSUMMARY-ONE')).toBe(true);
    expect(String(c.messages()[1].content)).toContain('SUMMARY-TWO');
    expect(
      c.messages().filter((m) => m.role === 'user' && String(m.content).includes('[Context note'))
    ).toHaveLength(1);
  });

  it('skips compaction that would free too little, so a near-budget task is not summarised every turn', async () => {
    // The pinned task alone is most of the budget; each round is small.
    const big: ConversationMessage[] = [{ role: 'user', content: 'x'.repeat(4 * 1_800) }];
    const c = new Conversation({ system: '', pinned: big, budget: 2_000 });
    for (let n = 1; n <= 3; n++) for (const m of round(n, 40)) c.append(m);
    expect(c.overBudget(0.8)).toBe(true);
    let calls = 0;
    const record = await c.compact(async () => {
      calls += 1;
      return 'summary';
    });
    expect(record).toBeNull();
    expect(calls).toBe(0);
    expect(c.turns).toHaveLength(6);
  });

  it('trims without a model call, as a rolling window', async () => {
    const c = new Conversation({ system: '', pinned, budget: 2_000 });
    for (let n = 1; n <= 4; n++) for (const m of round(n, 1_000)) c.append(m);
    const record = await c.trim({ keepTokens: 400 });
    expect(record?.method).toBe('dropped');
    expect(record?.error).toBeUndefined();
  });

  it('has nothing to compact while only one round exists', async () => {
    const c = new Conversation({ system: '', pinned, budget: 100 });
    for (const m of round(1, 4_000)) c.append(m);
    expect(await c.compact(async () => 'x')).toBeNull();
  });
});

describe('renderTranscript', () => {
  it('shows text, calls and shortened results', () => {
    const text = renderTranscript([{ role: 'user', content: 'hello' }, ...round(1, 5_000)]);
    expect(text).toContain('USER: hello');
    expect(text).toContain('ASSISTANT: Step 1.');
    expect(text).toContain('TOOL RESULT: ');
    expect(text).toContain('output truncated');
  });
});
