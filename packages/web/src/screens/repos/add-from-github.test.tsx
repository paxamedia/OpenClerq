import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GithubUserRepositories, GithubUserRepository } from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import { AddFromGithub, matching, PICKER_ROWS, PickerRows } from './AddFromGithub';

const client = createFixtureClient({ now: FIXTURE_NOW });
const html = (node: ReactElement) =>
  renderToStaticMarkup(
    <EnvironmentContext.Provider
      value={{ client, host: { kind: 'web', version: '1.0.0', openUrl: () => {} } }}
    >
      <ToastProvider>{node}</ToastProvider>
    </EnvironmentContext.Provider>
  );

const repo = (
  fullName: string,
  over: Partial<GithubUserRepository> = {}
): GithubUserRepository => ({
  fullName,
  owner: fullName.split('/')[0],
  name: fullName.split('/')[1],
  private: true,
  htmlUrl: `https://github.com/${fullName}`,
  installationId: 1,
  account: fullName.split('/')[0],
  added: false,
  ...over,
});
const list = (
  repositories: GithubUserRepository[],
  over: Partial<GithubUserRepositories> = {}
): GithubUserRepositories => ({
  repositories,
  truncated: false,
  limit: 1000,
  ...over,
});
const rows = (l: GithubUserRepositories, over: Partial<Parameters<typeof PickerRows>[0]> = {}) =>
  html(
    <PickerRows list={l} filter="" adding={null} added={new Set()} onAdd={() => {}} {...over} />
  );

describe('the picker', () => {
  it('lists the repositories with their account and visibility, and an Add button for each not added', () => {
    const text = rows(
      list([repo('acme/shop'), repo('acme/docs', { private: false, added: true })])
    );
    expect(text).toContain('acme/shop');
    expect(text).toContain('Private');
    expect(text).toContain('Public');
    expect(text).toContain('aria-label="Add acme/shop"');
    // The one OpenClerq has already is marked, and has no button.
    expect(text).toContain('Added');
    expect(text).not.toContain('aria-label="Add acme/docs"');
  });

  it('marks one added in this window too', () => {
    const text = rows(list([repo('acme/shop')]), { added: new Set(['acme/shop']) });
    expect(text).not.toContain('aria-label="Add acme/shop"');
    expect(text).toContain('Added');
  });

  it('disables every Add while one is being added', () => {
    const text = rows(list([repo('acme/a'), repo('acme/b')]), { adding: 'acme/a' });
    expect(text.match(/<button[^>]*disabled/g)?.length).toBe(2);
    expect(text).toContain('aria-busy="true"');
  });

  it('filters by name, ignoring case, and says when nothing matches', () => {
    const l = list([repo('acme/Shop'), repo('acme/docs')]);
    expect(matching(l.repositories, ' SHOP ').map((r) => r.fullName)).toEqual(['acme/Shop']);
    expect(matching(l.repositories, '').length).toBe(2);
    expect(rows(l, { filter: 'zzz' })).toContain('No repository has “zzz” in its name.');
  });

  it('says so when the limit cut the list, and shows the gateway’s warnings', () => {
    const text = rows(
      list([repo('acme/a')], {
        truncated: true,
        message: 'Only the first 1000 repositories are listed.',
        warnings: ['The installation on old is suspended, so its repositories are not listed.'],
      })
    );
    expect(text).toContain('Only the first 1000 repositories are listed.');
    expect(text).toContain('is suspended');
    expect(rows(list([repo('acme/a')], { truncated: true }))).toContain('Only the first 1000');
    expect(rows(list([repo('acme/a')]))).not.toContain('role="status"');
  });

  it('draws at most a few hundred rows and says how to narrow the rest', () => {
    const many = list(Array.from({ length: PICKER_ROWS + 50 }, (_, i) => repo(`acme/r${i}`)));
    const text = rows(many);
    expect(text.match(/aria-label="Add acme\//g)).toHaveLength(PICKER_ROWS);
    expect(text).toContain(`Showing the first ${PICKER_ROWS} of ${PICKER_ROWS + 50}`);
  });

  it('says what to do when the app is installed nowhere the person reaches', () => {
    expect(rows(list([]))).toContain('Nothing to add');
  });

  it('is a dialog that draws only while open', () => {
    expect(
      html(<AddFromGithub open={false} onClose={() => {}} onAdded={() => {}} />)
    ).not.toContain('Filter');
    const open = html(<AddFromGithub open onClose={() => {}} onAdded={() => {}} />);
    expect(open).toContain('Add from GitHub');
    expect(open).toContain('Asking GitHub which repositories you reach');
  });
});
