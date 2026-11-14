import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationSummary } from '@clerq/gateway-client';
import { EnvironmentContext, type GatewayClient } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import type { ModuleProps } from '../../app/modules';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import { AuthoredBy, AutomationsScreen } from './Automations';
import { modelHint, RunWithModel, runWithModel, STRICT_NOTE } from './RunWithModel';
import { catchUpWords, missedSince, missedWords, runNow } from './words';

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

const screen = (parts: string[]) => (
  <AutomationsScreen
    {...({
      parts,
      base: '/m/automations',
      client,
      host: { kind: 'web', version: '1.0.0', openUrl: () => {} },
      route: { path: '/m/automations', segments: [], query: new URLSearchParams() },
      config: null,
      navigate: () => {},
    } satisfies ModuleProps)}
  />
);

async function held() {
  return {
    automations: (await client.automations()).automations,
    'runs:latest': (await client.runs(500)).runs,
  };
}

const missed: NonNullable<AutomationSummary['missedSlots']> = {
  count: 2,
  capped: false,
  first: '2026-11-09T08:00:00.000Z',
  last: '2026-11-10T08:00:00.000Z',
  reason: 'catch_up_off',
  noticed: 'wake',
  at: '2026-11-10T09:00:00.000Z',
};

describe('what the list says about queueing and missed times', () => {
  it('words a missed run by why it was missed', () => {
    expect(missedWords(missed)).toBe(
      'Missed 2 scheduled runs: skipped, because catch-up is off for this automation.'
    );
    expect(missedWords({ ...missed, count: 1 })).toContain('Missed 1 scheduled run:');
    expect(missedWords({ ...missed, count: 50, capped: true })).toContain('Missed 50 or more');
    expect(missedWords({ ...missed, reason: 'paused' })).toContain('emergency stop');
    expect(missedWords({ ...missed, reason: 'already_queued' })).toContain('already waiting');
    expect(missedWords({ ...missed, reason: 'enqueue_failed', error: 'disk full' })).toContain(
      'could not be queued (disk full).'
    );
    expect(missedSince(missed)).toMatch(/^The first was due /);
  });

  it('says whether a schedule catches up', () => {
    expect(catchUpWords({ schedule: '0 8 * * *', catchUp: true })).toContain(
      'runs once when it wakes'
    );
    expect(catchUpWords({ schedule: '0 8 * * *', catchUp: false })).toContain('is skipped');
    expect(catchUpWords({ schedule: null, catchUp: true })).toBeNull();
  });

  it('shows queued, catch-up, missed times and a chat’s authorship in the table', async () => {
    const markup = page(screen([]), await held());
    // aut_tests is running with another run queued behind it.
    expect(markup).toContain('Running');
    expect(markup).toContain('Next one queued');
    // aut_deps catches up; aut_docs does not, and missed two times.
    expect(markup.match(/Catches up when it wakes/g)).toHaveLength(1);
    expect(markup).toContain('Missed 2 times');
    // aut_licence was drafted in a chat.
    expect(markup).toContain('From a chat');
    expect(markup.match(/From a chat/g)).toHaveLength(1);
  });

  it('explains the missed times and the catch-up on an automation’s page', async () => {
    const markup = page(screen(['aut_docs']), await held());
    expect(markup).toContain('Missed times');
    expect(markup).toContain('skipped, because catch-up is off for this automation');
    expect(markup).toContain('A time missed while the computer slept is skipped.');
  });

  it('says a schedule catches up when it does', async () => {
    const markup = page(screen(['aut_deps']), await held());
    expect(markup).toContain(
      'Catches up: a time missed while the computer slept runs once when it wakes.'
    );
    expect(markup).not.toContain('Missed times');
  });

  it('says a run is waiting on an automation’s page', async () => {
    const markup = page(screen(['aut_tests']), await held());
    expect(markup).toContain('A run is waiting behind the one going now.');
  });

  it('does not offer Run now while a run waits, and says what is happening', () => {
    expect(runNow({ running: false, queued: false, problem: null })).toEqual({
      label: 'Run now',
      disabled: false,
    });
    expect(runNow({ running: true, queued: false, problem: null })).toEqual({
      label: 'Running',
      disabled: false,
    });
    expect(runNow({ running: false, queued: true, problem: null })).toEqual({
      label: 'Queued',
      disabled: true,
    });
    expect(runNow({ running: false, queued: false, problem: 'bad spec' }).disabled).toBe(true);
  });
});

describe('running with a chosen model', () => {
  const automation = (driver: string): AutomationSummary =>
    ({ id: 'aut_1', name: 'weekly-deps', driver }) as AutomationSummary;

  it('says the choice is strict', () => {
    const markup = page(
      <RunWithModel automation={automation('builtin')} open onClose={() => {}} />
    );
    expect(markup).toContain('Run with a chosen model');
    expect(markup).toContain('is used as chosen');
    expect(markup).toContain('it never moves to another model');
    expect(markup).toContain('failed gate still applies');
    expect(STRICT_NOTE).toContain('If it is unavailable the run fails');
  });

  it('asks for provider/model for the builtin agent, and offers the ready providers’ models', () => {
    const markup = page(
      <RunWithModel automation={automation('builtin')} open onClose={() => {}} />
    );
    expect(markup).toContain('provider/model');
    expect(markup).toContain('<datalist id="run-model-options">');
    expect(modelHint('claude-code')).toContain('passed to it as written');
    const cli = page(
      <RunWithModel automation={automation('claude-code')} open onClose={() => {}} />
    );
    expect(cli).not.toContain('<datalist');
  });

  it('sends the named model with the run, trimmed, and nothing for an empty name', async () => {
    const runAutomation = vi.fn().mockResolvedValue({ runId: 'run_1', queued: false });
    const fake = { runAutomation } as unknown as GatewayClient;
    await expect(runWithModel(fake, 'aut_1', '  anthropic/claude-haiku-5-5 ')).resolves.toEqual({
      runId: 'run_1',
      queued: false,
    });
    expect(runAutomation).toHaveBeenCalledWith('aut_1', 'anthropic/claude-haiku-5-5');
    await expect(runWithModel(fake, 'aut_1', '   ')).rejects.toThrow('Name the model');
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });
});

describe('an automation a chat wrote', () => {
  it('is marked, linking to the chat', () => {
    const markup = page(<AuthoredBy by="chat ses_3" />);
    expect(markup).toContain('Written by a chat');
    expect(markup).toContain('href="#/m/chat/ses_3"');
    expect(page(<AuthoredBy by={null} />)).toBe('');
  });
});
