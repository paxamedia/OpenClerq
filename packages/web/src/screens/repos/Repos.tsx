/**
 * Repos: the repositories automations work on, read-only. A repository is
 * listed once an automation that names it in `targets.repos` has been queued;
 * there is nothing to add here. The page says where each is on this computer,
 * which vault secret it is reached with (the name, never the value), what
 * targets it and what is running against it.
 */

import { FolderGit2, Plus } from 'lucide-react';
import type { RepoDetail, RepoSummary, RunSummary } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { EmptyState, KeyValue } from '../../ui/Display';
import { RunStatus, StatusTag, type Tone } from '../../ui/Status';
import { Table, type Column } from '../../ui/Table';
import { useClient } from '../../app/client';
import { duration, money } from '../../app/format';
import { useResource } from '../../app/live';
import { Link, navigate } from '../../app/router';
import { costWithChildren, runSpan } from '../../app/stats';
import { ErrorState, Loaded, Page, PageHeader, PageSkeleton, Section } from '../../shell/layout';
import { useNow, When } from '../common';
import { runName } from '../runs/Runs';
import './repos.css';

export const reposPath = (id?: string) => (id ? `/repos/${encodeURIComponent(id)}` : '/repos');

const KIND_WORD: Record<RepoSummary['kind'], string> = {
  local: 'Local folder',
  github: 'GitHub',
  gitlab: 'GitLab',
};

export interface RepoPlace {
  tone: Tone;
  /** Short, for the list. */
  label: string;
  /** One or two sentences, for the detail: what it means and what happens next. */
  note: string;
}

/** Whether the repository (or its clone) is on disk, in words. A missing folder is said, not hidden. */
export function placeOf(repo: RepoSummary): RepoPlace {
  if (repo.kind === 'local') {
    if (!repo.path) return { tone: 'warn', label: 'No folder', note: 'No folder is recorded.' };
    return repo.path.exists
      ? { tone: 'ok', label: 'On disk', note: 'The folder is there.' }
      : {
          tone: 'err',
          label: 'Folder missing',
          note: 'This folder is gone. A run of an automation that targets it fails until the folder is back or the automation names another repository.',
        };
  }
  if (!repo.path) {
    return {
      tone: 'muted',
      label: 'Not cloned yet',
      note: 'No run has cloned it yet. The first run clones it into the workspace cache.',
    };
  }
  return repo.path.exists
    ? {
        tone: 'ok',
        label: 'Cloned',
        note: 'The clone is in the workspace cache. A run fetches it first.',
      }
    : {
        tone: 'warn',
        label: 'Clone missing',
        note: 'The clone is not on disk. The next run clones it again.',
      };
}

export interface CredentialState {
  tone: Tone;
  label: string;
}

/** What the vault says about a secret a repository is reached with. */
export function vaultState(present: boolean): CredentialState {
  return present
    ? { tone: 'ok', label: 'In the vault' }
    : { tone: 'warn', label: 'Not in the vault' };
}

/**
 * The secret a repository is reached with, across the automations that target
 * it. Each names its own (`publish.token_secret`), and the repository's row
 * keeps only whichever was queued last, so one secret is shown only where they
 * all agree. With no automation left, the last one recorded is all there is.
 */
export type Reach =
  | { kind: 'none' }
  | { kind: 'one'; secret: string; present: boolean; recorded: boolean }
  | { kind: 'differ'; secrets: string[] };

export function reachOf(repo: RepoSummary): Reach {
  if (repo.automations.length === 0) {
    return repo.credential ? { kind: 'one', ...repo.credential, recorded: true } : { kind: 'none' };
  }
  const named = repo.automations.flatMap((a) => (a.credential ? [a.credential] : []));
  const secrets = [...new Set(named.map((c) => c.secret))];
  if (secrets.length === 0) return { kind: 'none' };
  if (secrets.length > 1) return { kind: 'differ', secrets };
  return {
    kind: 'one',
    secret: secrets[0],
    present: named.every((c) => c.present),
    recorded: false,
  };
}

/** An automation whose own secret is not in the vault, and what that costs it. */
export function missingSecrets(
  repo: RepoSummary
): Array<{ automation: string; secret: string; note: string }> {
  return repo.automations.flatMap((a) =>
    a.credential && !a.credential.present
      ? [
          {
            automation: a.name,
            secret: a.credential.secret,
            note:
              repo.kind === 'local'
                ? 'its push or pull request will fail'
                : 'only a public repository can be cloned, and its push or pull request will fail',
          },
        ]
      : []
  );
}

/** "2 running · 1 queued", or "Idle". */
export function activityWords(runs: RepoSummary['runs']): string {
  const parts = [
    runs.running ? `${runs.running} running` : '',
    runs.queued ? `${runs.queued} queued` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Idle';
}

function RepoName({ repo }: { repo: RepoSummary }) {
  return (
    <span className="repos-name">
      <span className="repos-name-title">{repo.name}</span>
      <span className="repos-name-sub">{repo.url ?? repo.path?.value ?? ''}</span>
    </span>
  );
}

export function RepoList() {
  const client = useClient();
  const repos = useResource('repos', async () => (await client.repos()).repos, {
    on: ['runs', 'automations'],
  });
  const now = useNow(30_000);

  const columns: Column<RepoSummary>[] = [
    {
      key: 'name',
      header: 'Repository',
      cell: (r) => <RepoName repo={r} />,
      sortValue: (r) => r.name,
    },
    {
      key: 'kind',
      header: 'Where',
      hideOnPhone: true,
      cell: (r) => KIND_WORD[r.kind],
      sortValue: (r) => r.kind,
      width: 'sm',
    },
    {
      key: 'place',
      header: 'On disk',
      cell: (r) => {
        const p = placeOf(r);
        return <StatusTag tone={p.tone}>{p.label}</StatusTag>;
      },
      sortValue: (r) => placeOf(r).label,
      width: 'md',
    },
    {
      key: 'reach',
      header: 'Reached with',
      hideOnPhone: true,
      cell: (r) => <ReachCell repo={r} />,
      sortValue: (r) => {
        const reach = reachOf(r);
        return reach.kind === 'one' ? reach.secret : reach.kind === 'differ' ? '~differ' : null;
      },
      width: 'md',
    },
    {
      key: 'automations',
      header: 'Automations',
      hideOnPhone: true,
      cell: (r) =>
        r.automations.length ? (
          r.automations.map((a) => a.name).join(', ')
        ) : (
          <span className="page-muted">None now</span>
        ),
      sortValue: (r) => r.automations.length,
      width: 'lg',
    },
    {
      key: 'activity',
      header: 'Runs now',
      hideOnPhone: true,
      cell: (r) => activityWords(r.runs),
      sortValue: (r) => r.runs.running * 1000 + r.runs.queued,
      width: 'md',
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (r) =>
        r.lastRun ? (
          <span className="repos-last">
            <RunStatus state={r.lastRun.status} />
            <When
              at={r.lastRun.finishedAt ?? r.lastRun.startedAt ?? r.lastRun.createdAt}
              now={now}
            />
          </span>
        ) : (
          <span className="page-muted">Never</span>
        ),
      sortValue: (r) =>
        r.lastRun
          ? Date.parse(r.lastRun.finishedAt ?? r.lastRun.startedAt ?? r.lastRun.createdAt)
          : null,
      width: 'lg',
    },
  ];

  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Repos' }]} />
      <Loaded resource={repos} what="repositories" skeleton="rows">
        {(list) => (
          <Table
            label="Repositories"
            columns={columns}
            rows={list}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(reposPath(r.id))}
            initialSort={{ key: 'name', direction: 'asc' }}
            empty={<NoRepos />}
          />
        )}
      </Loaded>
    </Page>
  );
}

/** How a repository gets here, for the empty list. */
export function NoRepos() {
  return (
    <EmptyState
      icon={FolderGit2}
      title="No repositories yet"
      actions={
        <Button variant="primary" icon={Plus} onClick={() => navigate('/m/automations/new')}>
          New automation
        </Button>
      }
    >
      A repository appears here when an automation that names it in <code>targets.repos</code> is
      queued, for example <code>local:~/code/app</code> or <code>github:owner/name</code>.
    </EmptyState>
  );
}

/** The secret in a list row or a fact: its name and the vault's answer, or that automations differ. */
export function ReachCell({ repo }: { repo: RepoSummary }) {
  const reach = reachOf(repo);
  if (reach.kind === 'none') return <span className="page-muted">—</span>;
  if (reach.kind === 'differ') {
    return (
      <span className="page-muted" title={reach.secrets.join(', ')}>
        Differs by automation
      </span>
    );
  }
  const state = vaultState(reach.present);
  return (
    <span className="repos-secret">
      <code>{reach.secret}</code>
      <StatusTag tone={state.tone}>{state.label}</StatusTag>
    </span>
  );
}

/** The facts about one repository, as label and value pairs. */
export function RepoFacts({ repo }: { repo: RepoSummary }) {
  const place = placeOf(repo);
  const reach = reachOf(repo);
  const missing = missingSecrets(repo);
  return (
    <>
      <KeyValue
        items={[
          { label: 'Where', value: KIND_WORD[repo.kind] },
          ...(repo.url ? [{ label: 'URL', value: repo.url, mono: true }] : []),
          {
            label:
              repo.path?.role === 'clone' ? 'Clone' : repo.kind === 'local' ? 'Folder' : 'Clone',
            value: repo.path?.value,
            mono: true,
          },
          { label: 'On disk', value: <StatusTag tone={place.tone}>{place.label}</StatusTag> },
          {
            label: reach.kind === 'one' && reach.recorded ? 'Last reached with' : 'Reached with',
            value:
              reach.kind === 'differ' ? (
                'Differs by automation, listed below'
              ) : reach.kind === 'none' ? (
                repo.kind === 'local' ? (
                  'Nothing: it is a folder, and no automation here pushes or opens a pull request'
                ) : (
                  'Nothing recorded'
                )
              ) : (
                <ReachCell repo={repo} />
              ),
          },
          { label: 'Runs now', value: activityWords(repo.runs) },
        ]}
      />
      <p className="page-hint">{place.note}</p>
      {missing.map((m) => (
        <p key={`${m.automation}:${m.secret}`} className="page-hint">
          {m.automation} names {m.secret}, which is not in the vault, so {m.note}. Add it in{' '}
          <Link className="page-link" to="/settings/secrets">
            Settings → Secrets
          </Link>
          .
        </p>
      ))}
      {reach.kind === 'one' && reach.recorded && !reach.present && (
        <p className="page-hint">
          The last run named {reach.secret}, which is not in the vault. No automation targets this
          repository now.
        </p>
      )}
    </>
  );
}

function RepoRuns({ runs }: { runs: RunSummary[] }) {
  const now = useNow(15_000);
  return (
    <Table
      label="Latest runs"
      rows={runs}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/runs/${encodeURIComponent(r.id)}`)}
      columns={[
        {
          key: 'status',
          header: 'Status',
          cell: (r) => <RunStatus state={r.status} />,
          width: 'sm',
        },
        { key: 'name', header: 'Run', cell: (r) => runName(r) },
        {
          key: 'started',
          header: 'Started',
          cell: (r) => <When at={r.startedAt ?? r.createdAt} now={now} />,
          sortValue: (r) => Date.parse(r.createdAt),
          width: 'sm',
        },
        {
          key: 'duration',
          header: 'Duration',
          hideOnPhone: true,
          align: 'end',
          mono: true,
          cell: (r) => {
            const [a, b] = runSpan(r, now);
            return r.startedAt ? duration(b - a) : '—';
          },
          width: 'sm',
        },
        {
          key: 'cost',
          header: 'Cost',
          hideOnPhone: true,
          align: 'end',
          mono: true,
          cell: (r) => {
            const cost = costWithChildren(r);
            return money(cost.usd, { atLeast: cost.atLeast });
          },
          width: 'sm',
        },
      ]}
      empty={<p className="page-hint">No run has used it yet.</p>}
    />
  );
}

/** One repository, with what targets it and its latest runs. */
export function RepoDetailView({ repo }: { repo: RepoDetail }) {
  return (
    <>
      <Section title="Repository">
        <RepoFacts repo={repo} />
      </Section>
      <Section title={`Automations (${repo.automations.length})`}>
        {repo.automations.length ? (
          <ul className="repos-automations">
            {repo.automations.map((a) => (
              <li key={a.id}>
                <Link className="page-link" to={`/m/automations/${encodeURIComponent(a.id)}`}>
                  {a.name}
                </Link>
                <StatusTag tone={a.enabled ? 'ok' : 'muted'}>{a.enabled ? 'On' : 'Off'}</StatusTag>
                {a.credential && (
                  <span className="repos-secret">
                    <code>{a.credential.secret}</code>
                    <StatusTag tone={vaultState(a.credential.present).tone}>
                      {vaultState(a.credential.present).label}
                    </StatusTag>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="page-hint">
            No automation targets it now. Name it in an automation’s <code>targets.repos</code> to
            use it again.
          </p>
        )}
      </Section>
      <Section title="Latest runs">
        <RepoRuns runs={repo.recentRuns} />
        {repo.recentRuns.length >= 20 && (
          <p className="page-hint">The latest 20. Older runs are under Runs.</p>
        )}
      </Section>
    </>
  );
}

function RepoPage({ id }: { id: string }) {
  const client = useClient();
  const repo = useResource(`repo:${id}`, () => client.repo(id), { on: ['runs', 'automations'] });
  const name = repo.data?.name ?? 'Repository';
  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Repos', to: reposPath() }, { label: name }]} />
      {repo.data ? (
        <>
          {repo.error ? <ErrorState error={repo.error} onRetry={repo.reload} compact /> : null}
          <RepoDetailView repo={repo.data} />
        </>
      ) : (repo.error as { status?: number } | null)?.status === 404 ? (
        <EmptyState icon={FolderGit2} title="No repository with that id">
          It may have been removed. The list shows every repository an automation has used.
        </EmptyState>
      ) : repo.error ? (
        <ErrorState error={repo.error} onRetry={repo.reload} what="this repository" />
      ) : (
        <PageSkeleton />
      )}
    </Page>
  );
}

export function Repos({ id }: { id: string | null }) {
  return id ? <RepoPage id={id} /> : <RepoList />;
}
