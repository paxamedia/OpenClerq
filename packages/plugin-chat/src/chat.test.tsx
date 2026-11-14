import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ModeDiff } from '@clerq/gateway-client';
import { createFixtureClient, FIXTURE_NOW } from '@clerq/web/fixtures';
import { PluginTestFrame } from '@clerq/web/testing';
import { questionFor } from './Chat';
import {
  DraftFacts,
  DryRunResult,
  LiveActivity,
  ModeDiffBody,
  skillLine,
  toolLabel,
} from './Managed';

const client = createFixtureClient({ now: FIXTURE_NOW });
const html = (node: ReactElement) =>
  renderToStaticMarkup(<PluginTestFrame client={client}>{node}</PluginTestFrame>);

describe('managed chat', () => {
  it('names tools in words', () => {
    expect(toolLabel('fs.write')).toBe('Write a file');
    expect(toolLabel('memory.write.preference')).toBe('Save a note');
    expect(toolLabel('automation.draft')).toBe('Draft an automation');
    expect(toolLabel('something.else')).toBe('something.else');
  });

  it('shows tool activity and an approval to answer in the stream', () => {
    const markup = html(
      <LiveActivity
        tools={[
          { id: 'c1', name: 'fs.read', status: 'ok' },
          { id: 'c2', name: 'fs.write', status: 'running' },
        ]}
        approvals={[
          {
            approval: {
              id: 9,
              runId: 'run_1',
              tool: 'fs.write',
              tier: 'medium',
              reason: 'A chat wants to run fs.write.',
              requestedAt: new Date(FIXTURE_NOW).toISOString(),
              input: { path: 'out.txt' },
            },
          },
        ]}
        onDecided={() => {}}
      />
    );
    expect(markup).toContain('Read a file');
    expect(markup).toContain('Needs approval');
    expect(markup).toContain('>Approve<');
    expect(markup).toContain('>Deny<');
    expect(markup).toContain('out.txt');
  });

  it('shows a decided approval without buttons', () => {
    const markup = html(
      <LiveActivity
        tools={[]}
        approvals={[
          {
            approval: {
              id: 9,
              runId: 'r',
              tool: 'runtime.shell',
              tier: 'high',
              reason: 'r',
              requestedAt: 't',
            },
            decided: true,
            approved: false,
          },
        ]}
        onDecided={() => {}}
      />
    );
    expect(markup).toContain('Refused');
    expect(markup).not.toContain('>Approve<');
  });

  it('describes a draft and says saving does not switch it on', async () => {
    const draft = await client.draft('ses_3', 'drf_1');
    const markup = html(<DraftFacts draft={draft} />);
    expect(markup).toContain('weekday-ci-triage');
    expect(markup).toContain('>Draft<');
    expect(markup).toContain('starts off');
    expect(markup).toContain('first push waits for your approval');
    expect(markup).toContain('Check CI on main and summarise what broke.');
    expect(markup).toContain('without isolation');
    expect(markup).toContain('None: your account’s access');
    const saved = html(<DraftFacts draft={{ ...draft, automationId: 'aut_1' }} />);
    expect(saved).toContain('Saved, off');
  });

  it('shows a dry run’s checks, real dates in the host time zone, and the estimate', async () => {
    const result = await client.dryRunDraft('ses_3', 'drf_1');
    const markup = html(<DryRunResult result={result} />);
    expect(markup).toContain('Checked without running anything.');
    expect(markup).toContain('Next runs (Europe/Tallinn)');
    expect(markup).toContain('Average of the last 12 finished runs');
    expect(markup).toContain('Warning');
  });

  it('shows what managed adds over raw as additions', async () => {
    const diff: ModeDiff = await client.modeDiff('ses_3', { text: 'Hi' });
    const markup = html(<ModeDiffBody diff={diff} />);
    expect(markup).toContain('What managed adds');
    expect(markup).toContain('+ You are Clerq…');
    expect(markup).toContain('System prompt (raw sends none)');
    expect(markup).toContain('then openai/gpt-5-mini if it is unavailable');
    expect(markup).toContain('Search saved notes');
    expect(markup).toContain('/Users/me/code/shop · Full access');
  });

  it('finds the question an answer replies to', () => {
    const messages = [
      { id: 1, role: 'user', content: 'first', createdAt: '' },
      { id: 2, role: 'assistant', content: 'a', createdAt: '' },
      { id: 3, role: 'user', content: 'second', createdAt: '' },
      { id: 4, role: 'assistant', content: 'b', createdAt: '' },
    ] as ChatMessage[];
    expect(questionFor(messages, messages[3])).toBe('second');
    expect(questionFor(messages, messages[1])).toBe('first');
    expect(questionFor(messages, null)).toBe('');
  });
});

describe('the chat’s mode diff', () => {
  const diff = (over: Record<string, unknown>) =>
    ({
      skill: { slug: 'vat-core', name: 'VAT' },
      skillPolicy: { used: { trust: 'trusted' }, notes: [] },
      ...over,
    }) as unknown as Parameters<typeof skillLine>[0];

  it('says the skill and where it stands', () => {
    expect(skillLine(diff({}))).toBe('VAT (trusted)');
    expect(skillLine(diff({ skillPolicy: { used: { trust: 'modified' }, notes: [] } }))).toBe(
      'VAT (changed since you trusted it)'
    );
    expect(skillLine(diff({ skillPolicy: { used: { trust: 'untrusted' }, notes: [] } }))).toBe(
      'VAT (not trusted)'
    );
    expect(skillLine(diff({ skill: null }))).toBe('None');
    // A gateway that does not say (an older one) is shown as before.
    expect(skillLine(diff({ skillPolicy: undefined }))).toBe('VAT');
  });
});
