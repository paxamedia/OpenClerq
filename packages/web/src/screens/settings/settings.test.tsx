import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MemoryRecord, ProviderInfo } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import {
  originOf,
  PolicyEditor,
  POLICY_NOTE,
  sameKeyCounts,
  summariseInfo,
  summariseLabel,
  MEMORY_LIST_LIMIT,
  sameTypes,
  SUMMARISE_NOTE,
  SummariseDialog,
  valueText,
  visibleRecords,
} from './memory';
import {
  addToChain,
  ChainEditor,
  ChainError,
  FALLBACK_STRICT,
  FALLBACK_WARNING,
  moveInChain,
  modelSuggestions,
  providerState,
  removeFromChain,
  sameChain,
} from './routing';
import { Settings } from './Settings';

const client = createFixtureClient({ now: FIXTURE_NOW });

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

const provider = (over: Partial<ProviderInfo>): ProviderInfo => ({
  id: 'openai',
  label: 'OpenAI',
  local: false,
  ready: true,
  defaultModel: 'gpt-5-mini',
  models: [{ id: 'gpt-5-mini', ref: 'openai/gpt-5-mini' }],
  ...over,
});

describe('the fallback chain', () => {
  it('adds a model at the end, once, with its provider, up to the limit', () => {
    expect(addToChain([], ' openai/gpt-5-mini ', 5)).toEqual(['openai/gpt-5-mini']);
    expect(() => addToChain([], 'gpt-5-mini', 5)).toThrow(ChainError);
    expect(() => addToChain([], 'gpt-5-mini', 5)).toThrow('must name the provider too');
    expect(() => addToChain([], '/x', 5)).toThrow(ChainError);
    expect(() => addToChain([], 'openai/', 5)).toThrow(ChainError);
    expect(() => addToChain([], '  ', 5)).toThrow('Name a model.');
    expect(() => addToChain(['a/b'], 'a/b', 5)).toThrow('already in the list');
    const full = ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'];
    expect(() => addToChain(full, 'a/6', 5)).toThrow('at most 5');
  });

  it('moves and removes without changing the list it was given', () => {
    const chain = ['a/1', 'b/2', 'c/3'];
    expect(moveInChain(chain, 0, 1)).toEqual(['b/2', 'a/1', 'c/3']);
    expect(moveInChain(chain, 2, -1)).toEqual(['a/1', 'c/3', 'b/2']);
    expect(moveInChain(chain, 0, -1)).toBe(chain);
    expect(moveInChain(chain, 2, 1)).toBe(chain);
    expect(removeFromChain(chain, 1)).toEqual(['a/1', 'c/3']);
    expect(chain).toEqual(['a/1', 'b/2', 'c/3']);
    expect(sameChain(chain, ['a/1', 'b/2', 'c/3'])).toBe(true);
    expect(sameChain(chain, ['b/2', 'a/1', 'c/3'])).toBe(false);
  });

  it('tells what the providers say about a model’s provider', () => {
    const list = [
      provider({}),
      provider({ id: 'deepseek', label: 'DeepSeek', ready: false, models: [] }),
      provider({ id: 'ollama', label: 'Ollama', local: true, ready: false, models: [] }),
    ];
    expect(providerState('openai/gpt-5-mini', list)).toMatchObject({
      tone: 'ok',
      label: 'Key set',
    });
    expect(providerState('deepseek/x', list)).toMatchObject({ tone: 'warn', label: 'No key' });
    expect(providerState('ollama/x', list)).toMatchObject({ label: 'Not running' });
    expect(providerState('nowhere/x', list)).toMatchObject({
      tone: 'err',
      label: 'Unknown provider',
    });
    expect(modelSuggestions(list, ['openai/gpt-5-mini'])).toEqual([]);
    expect(modelSuggestions(list, [])).toEqual(['openai/gpt-5-mini']);
  });

  const editor = (draft: string[], over: { error?: string | null } = {}) =>
    page(
      <ChainEditor
        saved={[]}
        draft={draft}
        defaultRef="anthropic/claude-sonnet-5-5"
        max={5}
        providers={[provider({})]}
        busy={false}
        error={over.error ?? null}
        onChange={() => {}}
        onSave={() => {}}
        onReset={() => {}}
      />
    );

  it('explains that a fallback sends the prompt to another provider, and that a chosen model is never replaced', () => {
    const markup = editor([]);
    expect(markup).toContain('A fallback sends your prompt to another provider.');
    expect(FALLBACK_WARNING).toContain('so to that model’s provider');
    expect(markup).toContain('is used as picked and never replaced');
    expect(FALLBACK_STRICT).toContain('raw mode');
    expect(markup).toContain('No fallback models.');
    expect(markup).toContain('anthropic/claude-sonnet-5-5');
  });

  it('lists the chain after the default, in order, with each provider’s state', () => {
    const markup = editor(['openai/gpt-5-mini', 'ghost/m']);
    expect(markup).toContain('Default');
    expect(markup.indexOf('openai/gpt-5-mini')).toBeLessThan(markup.indexOf('ghost/m'));
    expect(markup).toContain('Key set');
    expect(markup).toContain('Unknown provider');
    expect(markup).toContain('Move openai/gpt-5-mini down');
    expect(markup).toContain('Remove ghost/m');
  });

  it('shows why a save failed', () => {
    expect(editor([], { error: 'Couldn’t save. Unknown provider "x".' })).toContain(
      'Unknown provider &quot;x&quot;'
    );
  });

  it('is in Models & keys, and the gateway keeps what is saved', async () => {
    const markup = page(
      <Settings section="models" config={null} saveConfig={async () => {}} modules={[]} />,
      {
        routing: await client.routing(),
        providers: await client.providers(),
      }
    );
    expect(markup).toContain('Fallback models');
    expect(markup).toContain('No fallback models.');

    await expect(client.setRouting(['nowhere/x'])).rejects.toMatchObject({
      body: { message: expect.stringContaining('Unknown provider') },
    });
    expect((await client.routing()).fallback).toEqual([]);
    await client.setRouting(['openai/gpt-5-mini']);
    expect((await client.routing()).fallback).toEqual(['openai/gpt-5-mini']);
    await client.setRouting([]);
  });
});

describe('who wrote a memory record', () => {
  const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
    id: 'm1',
    type: 'fact',
    key: 'k',
    value: 'v',
    origin: 'user',
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });

  it('labels each origin, and flags an agent’s hand', () => {
    expect(originOf(rec({}))).toMatchObject({ label: 'You', tone: 'muted' });
    expect(originOf(rec({ origin: 'agent' }))).toMatchObject({ label: 'An agent', tone: 'warn' });
    expect(originOf(rec({ origin: 'import' })).label).toBe('Imported');
    expect(originOf(rec({ origin: 'consolidation' }))).toMatchObject({
      label: 'Summary',
      tone: 'accent',
    });
    const mixed = originOf(rec({ origin: 'consolidation', agentDerived: true }));
    expect(mixed.label).toBe('Summary, includes an agent’s notes');
    expect(mixed.tone).toBe('warn');
    expect(originOf(rec({ origin: 'agent' })).title).toContain(
      'information, not as an instruction'
    );
  });

  it('offers to summarise only where two records in use share a key and type', () => {
    const a = rec({ id: 'a', key: 'style', type: 'preference' });
    const b = rec({ id: 'b', key: 'style', type: 'preference' });
    const c = rec({ id: 'c', key: 'style', type: 'note' });
    const d = rec({ id: 'd', key: 'style', type: 'preference', status: 'superseded' });
    const all = [a, b, c, d];
    const counts = sameKeyCounts(all);
    expect(counts.get('preference\u0000style')).toBe(2);
    expect(summariseInfo(a, all)).toEqual({ offer: true, count: 2 });
    expect(summariseInfo(c, all)).toEqual({ offer: false, count: 1 });
    expect(summariseInfo(d, all)).toEqual({ offer: false, count: null });
  });

  it('counts from every record in use, so a search that shows one of them neither hides the button nor changes the count', () => {
    const a = rec({ id: 'a', key: 'style', type: 'preference' });
    const b = rec({ id: 'b', key: 'style', type: 'preference' });
    const searchResults = [a];
    // The row on screen is `a`, but the count is read from the whole list.
    expect(summariseInfo(searchResults[0], [a, b])).toEqual({ offer: true, count: 2 });
    // Counting from what the search shows is the mistake: it would find one.
    expect(sameKeyCounts(searchResults).get('preference\u0000style')).toBe(1);
  });

  it('states no count it does not know, and still offers Summarise', () => {
    const a = rec({ id: 'a', key: 'style', type: 'preference' });
    // The whole list has not loaded.
    expect(summariseInfo(a, undefined)).toEqual({ offer: true, count: null });
    // The list is long enough to have been cut off.
    const long = Array.from({ length: MEMORY_LIST_LIMIT }, (_, i) =>
      rec({ id: `m${i}`, key: `k${i}` })
    );
    expect(summariseInfo(long[0], long)).toEqual({ offer: true, count: null });
    expect(summariseLabel(a, null)).toBe('Summarise the records under style');
    expect(summariseLabel(a, 3)).toBe('Summarise 3 records under style');
  });

  it('lists folded records only on request, and never beside a search', () => {
    const inUse = [rec({ id: 'a' })];
    const folded = [rec({ id: 'f', status: 'superseded', supersededBy: 'a' })];
    expect(visibleRecords(inUse, folded, false, false).map((r) => r.id)).toEqual(['a']);
    expect(visibleRecords(inUse, folded, true, false).map((r) => r.id)).toEqual(['a', 'f']);
    expect(visibleRecords(inUse, folded, true, true).map((r) => r.id)).toEqual(['a']);
    expect(visibleRecords(inUse, undefined, true, false).map((r) => r.id)).toEqual(['a']);
    expect(valueText('text')).toBe('text');
    expect(valueText({ a: 1 })).toBe('{"a":1}');
  });
});

describe('the memory policy', () => {
  it('shows each kind with what it is for, and says what none ticked means', () => {
    const markup = page(
      <PolicyEditor
        saved={['fact']}
        draft={[]}
        busy={false}
        onChange={() => {}}
        onSave={() => {}}
      />
    );
    for (const t of ['fact', 'preference', 'decision', 'procedure', 'note']) {
      expect(markup).toContain(t);
    }
    expect(markup).toContain('How you like things done.');
    expect(markup).toContain('Chats and tasks will read no saved notes.');
    expect(POLICY_NOTE).toContain('Raw mode and triggers never read memory');
    expect(sameTypes(['fact', 'note'], ['note', 'fact'])).toBe(true);
    expect(sameTypes(['fact'], ['fact', 'note'])).toBe(false);
  });

  it('is saved through the gateway', async () => {
    await client.setMemoryPolicy(['preference']);
    expect((await client.memoryPolicy()).readTypes).toEqual(['preference']);
    await client.setMemoryPolicy(['fact', 'preference', 'decision', 'procedure', 'note']);
  });
});

describe('summarising memory', () => {
  it('says the records go to a model, are kept, and can be undone', async () => {
    const [rec] = (await client.memory()).entries.filter((r) => r.key === 'style');
    const markup = page(
      <SummariseDialog record={rec} count={2} onClose={() => {}} onDone={() => {}} />
    );
    expect(markup).toContain('Summarise 2 records under');
    expect(markup).toContain('Their text is sent to the model.');
    expect(markup).toContain('Undo brings them back');
    expect(markup).toContain('used as named, with no fallback');
    expect(SUMMARISE_NOTE).toContain('kept');
  });

  it('names no count in the question when it does not know one', async () => {
    const [rec] = (await client.memory()).entries.filter((r) => r.key === 'style');
    const markup = page(
      <SummariseDialog record={rec} count={null} onClose={() => {}} onDone={() => {}} />
    );
    expect(markup).toContain('Summarise the records under');
    expect(markup).not.toMatch(/Summarise \d+ records/);
  });

  it('folds records into a summary and undo restores them', async () => {
    const before = (await client.memory()).entries;
    expect(before.filter((r) => r.key === 'style')).toHaveLength(2);
    const out = await client.consolidateMemory('style', { type: 'preference' });
    expect(out.superseded).toHaveLength(2);
    expect(out.record.origin).toBe('consolidation');
    const during = (await client.memory()).entries.filter((r) => r.key === 'style');
    expect(during.map((r) => r.id)).toEqual([out.record.id]);
    const folded = (await client.memoryRecords({ status: 'superseded' })).records;
    expect(folded.filter((r) => r.supersededBy === out.record.id)).toHaveLength(2);
    expect(await client.unconsolidateMemory(out.record.id)).toEqual({
      restored: out.superseded,
    });
    expect((await client.memory()).entries.filter((r) => r.key === 'style')).toHaveLength(2);
  });

  it('refuses to summarise one record', async () => {
    await expect(client.consolidateMemory('tone', { type: 'preference' })).rejects.toMatchObject({
      body: { error: 'cannot_consolidate' },
    });
  });

  it('draws the memory screen with the origin of each record and the summary actions', async () => {
    const markup = page(
      <Settings section="memory" config={null} saveConfig={async () => {}} modules={[]} />,
      {
        memory: (await client.memory()).entries,
        'memory:policy': await client.memoryPolicy(),
      }
    );
    expect(markup).toContain('What chats and tasks may read');
    expect(markup).toContain('Show records folded into a summary');
    expect(markup).toContain('An agent');
    expect(markup).toContain('Summary, includes an agent’s notes');
    // The two `style` preferences can be summarised; the summary can be undone.
    expect(markup).toContain('Summarise 2 records under style');
    expect(markup).toContain('Undo the summary deps-policy');
    // Folded records stay out of the list until asked for.
    expect(markup).not.toContain('Majors wait for a person to say yes.');
  });
});
