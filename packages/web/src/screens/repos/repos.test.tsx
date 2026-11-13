import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RepoDetail, RepoSummary } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import { activityWords, credentialState, NoRepos, placeOf, RepoDetailView } from './Repos';

const client = createFixtureClient({ now: FIXTURE_NOW });
const html = (node: ReactElement) =>
  renderToStaticMarkup(
    <EnvironmentContext.Provider
      value={{ client, host: { kind: 'web', version: '1.0.0', openUrl: () => {} } }}
    >
      <ToastProvider>{node}</ToastProvider>
    </EnvironmentContext.Provider>
  );

const base: RepoSummary = {
  id: 'repo_1',
  kind: 'local',
  name: 'shop',
  url: null,
  path: { value: '/Users/me/code/shop', exists: true, role: 'repository' },
  credential: null,
  automations: [{ id: 'aut_1', name: 'weekly-deps', enabled: true }],
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
  it('reports the secret as there or not, never more', () => {
    expect(credentialState(base)).toBeNull();
    expect(credentialState(remote)).toEqual({ tone: 'ok', label: 'In the vault' });
    expect(
      credentialState({ ...remote, credential: { secret: 'ACME_TOKEN', present: false } })
    ).toEqual({ tone: 'warn', label: 'Not in the vault' });
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

  it('points to Secrets when the vault lacks the secret', () => {
    const markup = html(
      <RepoDetailView repo={detail({ credential: { secret: 'ACME_TOKEN', present: false } })} />
    );
    expect(markup).toContain('Not in the vault');
    expect(markup).toContain('href="#/settings/secrets"');
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
