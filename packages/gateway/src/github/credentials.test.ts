/**
 * Which credential a run gets: the GitHub App's installation token or the
 * vault secret, by `publish.auth`, against a fake GitHub.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialRequest } from '../automations/credentials.js';
import { GithubApp } from './app.js';
import { APP_PRIVATE_KEY_SECRET, clearAppConfig, writeAppConfig } from './config.js';
import { githubAppCredentials } from './credentials.js';
import { FakeGithub } from './fake-github.js';
import { closeStore, initStore } from '../store.js';

let fake: FakeGithub;
const saved = process.env.CLERQ_GITHUB_API;
const VAULT_TOKEN = 'ghp_vault_personal_token_000000';
const secrets: Record<string, string> = {
  GITHUB_TOKEN: VAULT_TOKEN,
  GITLAB_TOKEN: 'glpat-vault-000000',
};
const asked: string[] = [];
const getSecret = (name: string) => {
  asked.push(name);
  return name === APP_PRIVATE_KEY_SECRET ? fake.privateKeyPem : secrets[name];
};

let lookup: ReturnType<typeof githubAppCredentials>;

const request = (extra: Partial<CredentialRequest> = {}): CredentialRequest => ({
  forge: 'github',
  project: 'acme/app',
  purpose: 'push',
  secretName: 'GITHUB_TOKEN',
  automationId: 'aut_1',
  runId: 'run_1',
  ...extra,
});

const connect = () =>
  writeAppConfig({
    appId: fake.app.id,
    slug: fake.app.slug,
    name: fake.app.name,
    clientId: fake.app.clientId,
    owner: fake.app.owner,
    htmlUrl: `https://github.com/apps/${fake.app.slug}`,
    source: 'import',
    createdAt: new Date().toISOString(),
  });

beforeAll(async () => {
  fake = await new FakeGithub().listen();
  process.env.CLERQ_GITHUB_API = fake.url;
  await initStore(':memory:');
});

afterAll(async () => {
  closeStore();
  await fake.close();
  if (saved === undefined) delete process.env.CLERQ_GITHUB_API;
  else process.env.CLERQ_GITHUB_API = saved;
});

beforeEach(() => {
  fake.reset();
  fake.installations.length = 0;
  asked.length = 0;
  connect();
  lookup = githubAppCredentials(new GithubApp({ getSecret }), (n) => secrets[n]);
});

describe('with the app installed on the repository', () => {
  beforeEach(() => void fake.install({ id: 31, repos: ['acme/app'] }));

  it('gives an installation token for the purpose, and not the vault secret (auto)', async () => {
    const got = await lookup(request());
    expect(got).toMatchObject({
      source: `github-app:${fake.app.slug}/installation/31`,
      actor: `${fake.app.slug}[bot]`,
    });
    expect(got?.token).toMatch(/^ghs_/);
    expect(got?.token).not.toBe(VAULT_TOKEN);
    expect(got?.expiresAt).toBeGreaterThan(Date.now());
    expect(typeof got?.release).toBe('function');
    expect(fake.tokens.get(got?.token as string)?.permissions).toEqual({ contents: 'write' });
    expect(asked).not.toContain('GITHUB_TOKEN');
  });

  it('gives the same answer for `app`, and the vault secret for `token` without asking GitHub', async () => {
    expect((await lookup(request({ auth: 'app' })))?.source).toMatch(/^github-app:/);
    fake.seen.length = 0;
    expect(await lookup(request({ auth: 'token' }))).toEqual({
      token: VAULT_TOKEN,
      source: 'vault:GITHUB_TOKEN',
    });
    expect(fake.seen).toHaveLength(0);
  });

  it('makes a token for each purpose with its own permissions', async () => {
    const fetchTok = await lookup(request({ purpose: 'fetch' }));
    const pr = await lookup(request({ purpose: 'pull_request' }));
    expect(fake.tokens.get(fetchTok?.token as string)?.permissions).toEqual({ contents: 'read' });
    expect(fake.tokens.get(pr?.token as string)?.permissions).toEqual({
      pull_requests: 'write',
      contents: 'read',
    });
  });

  it('keeps a run’s token for a second ask and never shares one between runs', async () => {
    const a = await lookup(request({ runId: 'run_1' }));
    expect((await lookup(request({ runId: 'run_1' })))?.token).toBe(a?.token);
    expect((await lookup(request({ runId: 'run_2' })))?.token).not.toBe(a?.token);
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(2);
  });

  it('for a preview says which credential, and makes nothing', async () => {
    const got = await lookup(request({ dryRun: true, runId: '' }));
    expect(got).toEqual({
      token: '',
      source: `github-app:${fake.app.slug}/installation/31`,
      actor: `${fake.app.slug}[bot]`,
    });
    expect(fake.calls('POST', '/access_tokens')).toHaveLength(0);
    expect(fake.tokens.size).toBe(0);
  });

  it('for the vault, a preview does not carry the secret either', async () => {
    expect(await lookup(request({ dryRun: true, auth: 'token' }))).toEqual({
      token: '',
      source: 'vault:GITHUB_TOKEN',
    });
  });
});

describe('with the app connected but not installed on the repository', () => {
  it('falls back to the vault secret (auto) and to the vault only (token)', async () => {
    expect(await lookup(request())).toEqual({ token: VAULT_TOKEN, source: 'vault:GITHUB_TOKEN' });
    expect(fake.calls('GET', '/installation')).toHaveLength(1);
  });

  it('fails a run that insists on the app, before any work, saying how to install it', async () => {
    await expect(lookup(request({ auth: 'app' }))).rejects.toThrow(
      new RegExp(
        `publish.auth is "app", but the GitHub App ${fake.app.slug} is not installed on acme/app.*/apps/${fake.app.slug}/installations/new`
      )
    );
    // Nothing was made.
    expect(fake.tokens.size).toBe(0);
  });

  it('says there is nothing to use when neither exists', async () => {
    expect(await lookup(request({ secretName: 'NOT_THERE' }))).toBeUndefined();
  });
});

describe('with no app connected', () => {
  beforeEach(() => clearAppConfig());

  it('is the vault secret, as before, and GitHub is not asked', async () => {
    expect(await lookup(request())).toEqual({ token: VAULT_TOKEN, source: 'vault:GITHUB_TOKEN' });
    expect(fake.seen).toHaveLength(0);
  });

  it('fails a run that insists on the app', async () => {
    await expect(lookup(request({ auth: 'app' }))).rejects.toThrow(/no GitHub App is connected/);
  });
});

describe('when the app is installed but cannot be used', () => {
  beforeEach(() => void fake.install({ repos: ['acme/app'] }));

  it('stops a push rather than pushing as the user, and says how to opt out', async () => {
    fake.failNext.set('/access_tokens', { status: 500, message: 'Server Error' });
    await expect(lookup(request({ purpose: 'push' }))).rejects.toThrow(
      /Could not get a push token.*Set publish.auth: token/
    );
    expect(asked).not.toContain('GITHUB_TOKEN');
  });

  it('reads with the vault secret instead (fetch cannot push), unless the spec insists on the app', async () => {
    fake.failNext.set('/access_tokens', { status: 500, message: 'Server Error' });
    expect(await lookup(request({ purpose: 'fetch' }))).toMatchObject({
      source: 'vault:GITHUB_TOKEN',
    });
    fake.failNext.set('/access_tokens', { status: 500, message: 'Server Error' });
    await expect(lookup(request({ purpose: 'fetch', auth: 'app' }))).rejects.toThrow(
      /Could not get a fetch token/
    );
  });

  it('does the same when it cannot even be asked whether it is installed', async () => {
    fake.failNext.set('/repos/acme/app/installation', { status: 500, message: 'Server Error' });
    const app = new GithubApp({ getSecret });
    const fresh = githubAppCredentials(app, (n) => secrets[n]);
    await expect(fresh(request({ purpose: 'pull_request' }))).rejects.toThrow(
      /Could not ask GitHub whether the app is installed on acme\/app/
    );
    fake.failNext.set('/repos/acme/app/installation', { status: 500, message: 'Server Error' });
    expect(
      await githubAppCredentials(
        new GithubApp({ getSecret }),
        (n) => secrets[n]
      )(request({ purpose: 'fetch' }))
    ).toMatchObject({
      source: 'vault:GITHUB_TOKEN',
    });
  });

  it('treats a suspended installation as unusable', async () => {
    fake.installations.length = 0;
    fake.install({ repos: ['acme/app'], suspended: true });
    await expect(lookup(request())).rejects.toThrow(/suspended/);
  });

  it('says so when the preview cannot tell', async () => {
    fake.failNext.set('/repos/acme/app/installation', { status: 500, message: 'Server Error' });
    await expect(lookup(request({ dryRun: true }))).rejects.toThrow(/Could not ask GitHub/);
  });
});

describe('GitLab and the app’s own secrets', () => {
  it('keeps GitLab on its token, and refuses `app` for it', async () => {
    const got = await lookup(
      request({ forge: 'gitlab', project: 'group/lab', secretName: 'GITLAB_TOKEN' })
    );
    expect(got).toEqual({ token: 'glpat-vault-000000', source: 'vault:GITLAB_TOKEN' });
    await expect(
      lookup(
        request({ forge: 'gitlab', project: 'group/lab', secretName: 'GITLAB_TOKEN', auth: 'app' })
      )
    ).rejects.toThrow(/GitHub repositories/);
    expect(fake.seen).toHaveLength(0);
  });

  it('never hands out the app’s private key as a token', async () => {
    secrets[APP_PRIVATE_KEY_SECRET] = fake.privateKeyPem;
    try {
      expect(
        await lookup(request({ secretName: APP_PRIVATE_KEY_SECRET, auth: 'token' }))
      ).toBeUndefined();
    } finally {
      delete secrets[APP_PRIVATE_KEY_SECRET];
    }
  });
});
