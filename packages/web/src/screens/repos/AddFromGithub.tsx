/**
 * Add from GitHub: a picker over the repositories the signed-in person reaches
 * through the GitHub App (`GET /github/user/repositories`), each added with
 * `POST /repos`. It is offered only when somebody is signed in to GitHub.
 */

import { useEffect, useState } from 'react';
import { CircleAlert, Plus } from 'lucide-react';
import type { GithubUserRepositories, GithubUserRepository } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/Display';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Dialog } from '../../ui/Modal';
import { StatusTag } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { useClient } from '../../app/client';
import { errorMessage } from '../../app/format';
import { ErrorState } from '../../shell/layout';
import { ProgressLine } from '../../ui/Display';

/** The most rows drawn at once; the filter narrows the rest. */
export const PICKER_ROWS = 200;

/** The repositories whose name has the filter in it, ignoring case. */
export function matching(list: GithubUserRepository[], filter: string): GithubUserRepository[] {
  const needle = filter.trim().toLowerCase();
  return needle ? list.filter((r) => r.fullName.toLowerCase().includes(needle)) : list;
}

export interface PickerRowsProps {
  list: GithubUserRepositories;
  filter: string;
  /** The full name being added right now. */
  adding: string | null;
  /** Full names added in this window, besides the ones the gateway already knew. */
  added: ReadonlySet<string>;
  onAdd(repo: GithubUserRepository): void;
}

/** The list, the limit and the warnings: no gateway calls in here. */
export function PickerRows({ list, filter, adding, added, onAdd }: PickerRowsProps) {
  const rows = matching(list.repositories, filter);
  const shown = rows.slice(0, PICKER_ROWS);
  return (
    <div className="repos-pick">
      {list.truncated && (
        <p className="repos-pick-note" role="status">
          <Icon glyph={CircleAlert} size={14} />{' '}
          {list.message ?? `Only the first ${list.limit} repositories are listed.`}
        </p>
      )}
      {(list.warnings ?? []).map((w) => (
        <p key={w} className="repos-pick-note">
          <Icon glyph={CircleAlert} size={14} /> {w}
        </p>
      ))}
      {list.repositories.length === 0 ? (
        <EmptyState icon={Plus} title="Nothing to add">
          The app is not installed on any repository you can reach. Install it on GitHub (Settings,
          GitHub), then open this again.
        </EmptyState>
      ) : shown.length === 0 ? (
        <p className="page-hint">No repository has “{filter.trim()}” in its name.</p>
      ) : (
        <ul className="repos-pick-list" aria-label="Repositories on GitHub">
          {shown.map((r) => {
            const isAdded = r.added || added.has(r.fullName);
            return (
              <li key={`${r.installationId}:${r.fullName}`}>
                <span className="repos-pick-name">
                  <code>{r.fullName}</code>
                  <span className="page-hint">{r.account ?? 'No account'}</span>
                </span>
                <StatusTag tone="muted">{r.private ? 'Private' : 'Public'}</StatusTag>
                {isAdded ? (
                  <StatusTag tone="ok">Added</StatusTag>
                ) : (
                  <Button
                    size="sm"
                    icon={Plus}
                    busy={adding === r.fullName}
                    disabled={adding !== null}
                    aria-label={`Add ${r.fullName}`}
                    onClick={() => onAdd(r)}
                  >
                    Add
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > shown.length && (
        <p className="page-hint">
          Showing the first {PICKER_ROWS} of {rows.length}. Type in the box to narrow the list.
        </p>
      )}
    </div>
  );
}

function PickerBody({ onAdded }: { onAdded(): void }) {
  const client = useClient();
  const toast = useToast();
  const [list, setList] = useState<GithubUserRepositories | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  const load = () => {
    setError(null);
    setList(null);
    client.githubRepositories().then(setList, setError);
  };
  // Drawn only while the dialog is open, so this is a fresh look each time.
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (repo: GithubUserRepository) => {
    setAdding(repo.fullName);
    try {
      await client.addRepo(`github:${repo.fullName}`);
      setAdded((prev) => new Set(prev).add(repo.fullName));
      toast({ message: `Added ${repo.fullName}.`, tone: 'ok' });
      onAdded();
    } catch (e) {
      toast({ message: `Couldn’t add ${repo.fullName}. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setAdding(null);
    }
  };

  if (error)
    return <ErrorState error={error} onRetry={load} what="your GitHub repositories" compact />;
  if (!list) return <ProgressLine label="Asking GitHub which repositories you reach" />;
  return (
    <>
      <Input
        label="Filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="owner/name"
        autoComplete="off"
      />
      <PickerRows
        list={list}
        filter={filter}
        adding={adding}
        added={added}
        onAdd={(r) => void add(r)}
      />
    </>
  );
}

/** The dialog the Repos page opens. */
export function AddFromGithub({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose(): void;
  onAdded(): void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add from GitHub"
      description="The repositories you reach through the GitHub App. Adding one lists it here; an automation can then work on it."
      size="lg"
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <PickerBody onAdded={onAdded} />
    </Dialog>
  );
}
