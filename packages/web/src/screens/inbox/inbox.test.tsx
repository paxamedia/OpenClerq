import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Approval } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import { ApprovalOrigin, Inbox } from './Inbox';

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

const approval = (over: Partial<Approval>): Approval => ({
  id: 7,
  runId: 'run_1',
  tool: 'runtime.shell',
  tier: 'medium',
  reason: 'r',
  requestedAt: '2026-11-11T10:00:00.000Z',
  ...over,
});

describe('where an approval came from', () => {
  it('names the run a sub-agent belongs to, as a link', () => {
    const markup = page(<ApprovalOrigin approval={approval({ parentRunId: 'run_p' })} />);
    expect(markup).toContain('Sub-agent of run');
    expect(markup).toContain('href="#/runs/run_p"');
    expect(markup).not.toContain('Open the chat');
  });

  it('links the chat that is waiting for the answer', () => {
    const markup = page(<ApprovalOrigin approval={approval({ sessionId: 'ses 9' })} />);
    expect(markup).toContain('href="#/m/chat/ses%209"');
    expect(markup).toContain('Open the chat');
    expect(markup).not.toContain('Sub-agent of');
  });

  it('says nothing for an approval of an ordinary run', () => {
    expect(page(<ApprovalOrigin approval={approval({})} />)).toBe('');
  });
});

describe('the approvals list', () => {
  it('shows the sub-agent’s parent and the chat on their rows, outside the row’s button', async () => {
    const markup = page(<Inbox id={null} />, {
      inbox: (await client.inbox({ status: 'open' })).items,
      approvals: (await client.approvals()).approvals,
    });
    expect(markup).toContain('Sub-agent of run');
    expect(markup).toContain('href="#/runs/run_subs01"');
    expect(markup).toContain('href="#/m/chat/ses_3"');
    // A link inside a button is not valid, and would not be reachable by keyboard as expected.
    for (const button of markup.match(/<button[\s\S]*?<\/button>/g) ?? []) {
      expect(button).not.toContain('<a ');
    }
  });
});
