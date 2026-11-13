import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RepoDetail, RepoSummary } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import {
  activityWords,
  missingSecrets,
  NoRepos,
  placeOf,
  reachOf,
  RepoDetailView,
  RepoList,
  vaultState,
} from './Repos';

const client = createFixtureClient({ now: FIXTURE_NOW });
const html = (node: ReactElement) =>
  renderToStaticMarkup(
    <EnvironmentContext.Provider
      value={{ client, host: { kind: 'web', version: '1.0.0', openUrl: () => {} } }}
    >
      <ToastProvider>{node}</ToastProvider>
    </EnvironmentContext.Provider>
  );

/** A page drawn from what the store already holds. */
function listPage(held: Record<string, unknown>): string {
  const store = new LiveStore();
  for (const [key, data] of Object.entries(held)) store.write(key, () => data);
  return renderToStaticMarkup(
    <EnvironmentContext.Provider
      value={{ client, host: { kind: 'web', version: '1.0.0', openUrl: () => {} } }}
    >
      <LiveProvider client={client} store={store}>
        <ToastProvider>
          <RepoList />
        </ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}

const base: RepoSummary = {
  id: 'repo_1',
  kind: 'local',
  name: 'shop',
  url: null,
  path: { value: '/Users/me/code/shop', exists: true, role: 'repository' },
  credential: null,
  automations: [{ id: 'aut_1', name: 'weekly-deps', enabled: true, credential: null }],
  runs: { queued: 0, running: 0 },
  lastRun: null,
  createdAt: '2026-11-01T00:00:00.000Z',
};
const remote: RepoSummary = {
  ...base,
  id: 'repo_2',
  kind: 'github',
  name: 'acme/widgets',
  url: 'https://github.com/acme/widgets.git',
  path: { value: '/cache/widgets-abc', exists: true, role: 'clone' },
  credential: { secret: 'ACME_TOKEN', present: true },
  automations: [
    {
      id: 'aut_1',
      name: 'weekly-deps',
      enabled: true,
      credential: { secret: 'ACME_TOKEN', present: true },
    },
  ],
};

describe('where a repository is', () => {
  it('says a local folder is there', () => {
    expect(placeOf(base)).toMatchObject({ tone: 'ok', label: 'On disk' });
  });

  it('says a local folder has gone, and what that does to a run', () => {
    const gone = placeOf({ ...base, path: { ...(base.path as object), exists: false } as never });
    expect(gone).toMatchObject({ tone: 'err', label: 'Folder missing' });
    expect(gone.note).toContain('A run of an automation that targets it fails');
  });

  it('tells a remote that was never cloned from one whose clone has gone', () => {
    expect(placeOf({ ...remote, path: null })).toMatchObject({
      tone: 'muted',
      label: 'Not cloned yet',
    });
    const lost = placeOf({ ...remote, path: { value: '/cache/x', exists: false, role: 'clone' } });
    expect(lost).toMatchObject({ tone: 'warn', label: 'Clone missing' });
    expect(lost.note).toContain('clones it again');
    expect(placeOf(remote)).toMatchObject({ tone: 'ok', label: 'Cloned' });
  });
});

describe('credentials', () => {
  const auto = (name: string, secret: string | null, present = true) => ({
    id: `aut_${name}`,
    name,
    enabled: true,
    credential: secret ? { secret, present } : null,
  });

  it('reports the vault’s answer for a secret, never more', () => {
    expect(vaultState(true)).toEqual({ tone: 'ok', label: 'In the vault' });
    expect(vaultState(false)).toEqual({ tone: 'warn', label: 'Not in the vault' });
  });

  it('shows one secret when every automation names the same', () => {
    const repo = { ...remote, automations: [auto('a', 'ACME_TOKEN'), auto('b', 'ACME_TOKEN')] };
    expect(reachOf(repo)).toEqual({
      kind: 'one',
      secret: 'ACME_TOKEN',
      present: true,
      recorded: false,
    });
  });

  it('says they differ when the automations name different secrets, whatever the row last recorded', () => {
    const repo = {
      ...remote,
      credential: { secret: 'ACME_TOKEN', present: true },
      automations: [auto('a', 'ACME_TOKEN'), auto('b', 'OTHER_TOKEN', false)],
    };
    expect(reachOf(repo)).toEqual({ kind: 'differ', secrets: ['ACME_TOKEN', 'OTHER_TOKEN'] });
  });

  it('leaves out an automation that needs no secret, and says none when none does', () => {
    const quiet = { ...base, automations: [auto('q', null)] };
    expect(reachOf(quiet)).toEqual({ kind: 'none' });
    const mixed = { ...base, automations: [auto('q', null), auto('p', 'GITHUB_TOKEN')] };
    expect(reachOf(mixed)).toMatchObject({ kind: 'one', secret: 'GITHUB_TOKEN' });
  });

  it('falls back to the recorded secret only when no automation targets it', () => {
    expect(reachOf({ ...remote, automations: [] })).toEqual({
      kind: 'one',
      secret: 'ACME_TOKEN',
      present: true,
      recorded: true,
    });
    expect(reachOf({ ...base, automations: [], credential: null })).toEqual({ kind: 'none' });
  });

  it('names the automation whose secret is missing', () => {
    const repo = {
      ...remote,
      automations: [auto('a', 'ACME_TOKEN'), auto('b', 'OTHER_TOKEN', false)],
    };
    expect(missingSecrets(repo)).toEqual([
      {
        automation: 'b',
        secret: 'OTHER_TOKEN',
        note: 'only a public repository can be cloned, and its push or pull request will fail',
      },
    ]);
    const local = { ...base, automations: [auto('p', 'GITHUB_TOKEN', false)] };
    expect(missingSecrets(local)[0].note).toBe('its push or pull request will fail');
    expect(missingSecrets({ ...remote, automations: [auto('a', 'ACME_TOKEN')] })).toEqual([]);
  });
});

describe('the list', () => {
  it('shows a secret only where the automations agree, and says when they differ', async () => {
    const { repos } = await client.repos();
    const markup = listPage({ repos });
    expect(markup).toContain('Reached with');
    // example/widgets: one automation names GITHUB_TOKEN, the other WIDGETS_DOCS_TOKEN.
    expect(markup.match(/Differs by automation/g)).toHaveLength(1);
    // No secret is shown as the repository's own: the names are only on hover.
    expect(markup).not.toContain('<code>WIDGETS_DOCS_TOKEN</code>');
    expect(markup).toContain('title="GITHUB_TOKEN, WIDGETS_DOCS_TOKEN"');
    // lab/tools: one automation, GITLAB_TOKEN, not in the vault.
    expect(markup).toContain('GITLAB_TOKEN');
    expect(markup).toContain('Not in the vault');
    // The licence repo's automation only reads: nothing to reach it with.
    expect(markup).toContain('GITHUB_TOKEN');
  });
});

describe('activity', () => {
  it('reads running and queued in words', () => {
    expect(activityWords({ queued: 0, running: 0 })).toBe('Idle');
    expect(activityWords({ queued: 1, running: 0 })).toBe('1 queued');
    expect(activityWords({ queued: 2, running: 3 })).toBe('3 running · 2 queued');
  });
});

describe('the empty list', () => {
  it('says how a repository gets here', () => {
    const markup = html(<NoRepos />);
    expect(markup).toContain('No repositories yet');
    expect(markup).toContain('targets.repos');
    expect(markup).toContain('local:~/code/app');
    expect(markup).toContain('github:owner/name');
  });
});

describe('one repository', () => {
  const detail = (over: Partial<RepoDetail> = {}): RepoDetail => ({
    ...remote,
    recentRuns: [],
    ...over,
  });

  it('shows the secret by name and links the automations that target it', () => {
    const markup = html(<RepoDetailView repo={detail()} />);
    expect(markup).toContain('ACME_TOKEN');
    expect(markup).toContain('In the vault');
    expect(markup).toContain('https://github.com/acme/widgets.git');
    expect(markup).toContain('href="#/m/automations/aut_1"');
    expect(markup).toContain('weekly-deps');
    expect(markup).toContain('No run has used it yet.');
  });

  it('ties the missing-secret warning to the automation that names it, and lists each automation’s secret', () => {
    const markup = html(
      <RepoDetailView
        repo={detail({
          automations: [
            {
              id: 'aut_a',
              name: 'bumps',
              enabled: true,
              credential: { secret: 'ACME_TOKEN', present: true },
            },
            {
              id: 'aut_b',
              name: 'docs',
              enabled: false,
              credential: { secret: 'DOCS_TOKEN', present: false },
            },
          ],
        })}
      />
    );
    expect(markup).toContain('Differs by automation, listed below');
    expect(markup).toContain('ACME_TOKEN');
    expect(markup).toContain('DOCS_TOKEN');
    expect(markup).toContain(
      'docs names DOCS_TOKEN, which is not in the vault, so only a public repository can be cloned'
    );
    expect(markup).not.toContain('bumps names');
    expect(markup).toContain('href="#/settings/secrets"');
  });

  it('points to Secrets for the last recorded secret when nothing targets the repository', () => {
    const markup = html(
      <RepoDetailView
        repo={detail({ automations: [], credential: { secret: 'ACME_TOKEN', present: false } })}
      />
    );
    expect(markup).toContain('Last reached with');
    expect(markup).toContain('The last run named ACME_TOKEN, which is not in the vault.');
  });

  it('keeps a repository nobody targets any more, and says so', () => {
    const markup = html(<RepoDetailView repo={detail({ automations: [] })} />);
    expect(markup).toContain('No automation targets it now.');
  });

  it('lists a missing folder as missing, with its path', () => {
    const markup = html(
      <RepoDetailView
        repo={{
          ...base,
          path: { value: '/Users/me/code/gone', exists: false, role: 'repository' },
          recentRuns: [],
        }}
      />
    );
    expect(markup).toContain('/Users/me/code/gone');
    expect(markup).toContain('Folder missing');
  });

  it('lists the fixture repositories, one of them with its folder gone', async () => {
    const { repos } = await client.repos();
    expect(repos.map((r) => r.name)).toContain('kit');
    expect(repos.find((r) => r.name === 'kit')?.path?.exists).toBe(false);
    const detailOf = await client.repo(repos[0].id);
    expect(Array.isArray(detailOf.recentRuns)).toBe(true);
    await expect(client.repo('repo_nope')).rejects.toMatchObject({ status: 404 });
  });
});
