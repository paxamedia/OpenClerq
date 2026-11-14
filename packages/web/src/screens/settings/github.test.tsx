import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  GithubAppInfo,
  GithubAppStatus,
  GithubInstallation,
  GithubUserStatus,
} from '@clerq/gateway-client';
import { EnvironmentContext } from '../../app/client';
import { LiveProvider, LiveStore } from '../../app/live';
import { createFixtureClient, FIXTURE_NOW } from '../../fixtures';
import { ToastProvider } from '../../ui/Toast';
import {
  AppSummary,
  DisconnectDialog,
  DisconnectedNote,
  ENDED_WORDS,
  ExternalLink,
  GithubSection,
  httpsUrl,
  waitingIsOver,
  ImportForm,
  InstallationsBlock,
  KEY_REFUSED_NOTE,
  LoginDialog,
  loginViewFor,
  loginViewForFailure,
  NotConnected,
  refusedKey,
  SIGN_IN_NOTE,
  SignInPanel,
  WaitingForGithub,
  type ImportFormProps,
  type LoginView,
} from './github';
import { SETTINGS_SECTIONS } from './Settings';

const client = createFixtureClient({ now: FIXTURE_NOW });
const host = { kind: 'web' as const, version: '1.0.0', openUrl: () => {} };
const noop = () => {};

function html(node: ReactElement, held: Record<string, unknown> = {}): string {
  const store = new LiveStore();
  for (const [key, data] of Object.entries(held)) store.write(key, () => data);
  return renderToStaticMarkup(
    <EnvironmentContext.Provider value={{ client, host }}>
      <LiveProvider client={client} store={store}>
        <ToastProvider>{node}</ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}

const app: GithubAppInfo = {
  appId: 424242,
  slug: 'openclerq-acme',
  name: 'OpenClerq-acme',
  clientId: 'Iv23liTEST',
  owner: { login: 'acme', type: 'Organization' },
  htmlUrl: 'https://github.com/apps/openclerq-acme',
  installUrl: 'https://github.com/apps/openclerq-acme/installations/new',
  settingsUrl: 'https://github.com/organizations/acme/settings/apps/openclerq-acme',
  source: 'manifest',
  createdAt: '2026-11-01T00:00:00.000Z',
};
const installation: GithubInstallation = {
  id: 1,
  account: 'acme',
  accountType: 'Organization',
  repositorySelection: 'selected',
  suspended: false,
  permissions: {},
  htmlUrl: 'https://github.com/organizations/acme/settings/installations/1',
};
const summary = (over: Partial<Parameters<typeof AppSummary>[0]> = {}) =>
  html(
    <AppSummary
      app={app}
      secrets={{ privateKey: true, clientSecret: true }}
      installations={[installation]}
      warnings={[]}
      host={host}
      onRefresh={noop}
      refreshing={false}
      onReplaceKey={noop}
      onDisconnect={noop}
      {...over}
    />
  );

describe('addresses that become links', () => {
  it('are https, with no user name or password', () => {
    expect(httpsUrl('https://github.com/login/device')).toBe('https://github.com/login/device');
    for (const bad of [
      'http://github.com/x',
      'javascript:alert(1)',
      'data:text/html,<b>',
      'file:///etc/passwd',
      'https://user:pw@github.com/x',
      '//github.com/x',
      'github.com',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(httpsUrl(bad)).toBeNull();
    }
  });

  it('draw a button only for such an address, and nothing for the rest', () => {
    const good = html(
      <ExternalLink url="https://github.com/acme" host={host}>
        Open it
      </ExternalLink>
    );
    expect(good).toContain('<button');
    expect(good).toContain('Open it');
    for (const url of ['javascript:alert(1)', 'http://github.com/acme', undefined]) {
      const bad = html(
        <ExternalLink url={url} host={host}>
          Open it
        </ExternalLink>
      );
      expect(bad).not.toContain('<button');
      expect(bad).not.toContain('javascript:');
      expect(bad).not.toContain('Open it');
    }
  });
});

describe('not connected', () => {
  const importProps: ImportFormProps = {
    appId: '',
    clientId: '',
    keyText: '',
    clientSecret: '',
    keyFile: null,
    onAppId: noop,
    onClientId: noop,
    onKeyText: noop,
    onKeyFile: noop,
    onClientSecret: noop,
    onSubmit: noop,
    busy: false,
    fileKey: 0,
  };
  const page = (error?: string) =>
    html(
      <NotConnected
        org=""
        name=""
        onOrg={noop}
        onName={noop}
        onCreate={noop}
        creating={false}
        error={error}
        importForm={<ImportForm {...importProps} />}
      />
    );

  it('offers Create and Import side by side', () => {
    const text = page();
    expect(text).toContain('Create the app on GitHub');
    expect(text).toContain('Create on GitHub');
    expect(text).toContain('Or import an app you made');
    expect(text).toContain('Organisation (optional)');
    expect(text).toContain('Import the app');
    expect(text).not.toContain('role="alert"');
  });

  it('says why the last try failed', () => {
    const text = page('Your browser blocked the window GitHub opens in.');
    expect(text).toContain('role="alert"');
    expect(text).toContain('blocked the window');
  });
});

describe('the import form', () => {
  const props = (over: Partial<ImportFormProps> = {}): ImportFormProps => ({
    appId: '12',
    clientId: 'Iv23liTEST',
    keyText: '',
    clientSecret: '',
    keyFile: null,
    onAppId: noop,
    onClientId: noop,
    onKeyText: noop,
    onKeyFile: noop,
    onClientSecret: noop,
    onSubmit: noop,
    busy: false,
    fileKey: 0,
    ...over,
  });

  it('takes the key as a file or pasted, and the secret as a password', () => {
    const text = html(<ImportForm {...props()} />);
    expect(text).toContain('type="file"');
    expect(text).toContain('accept=".pem');
    expect(text).toContain('Or paste the key');
    expect(text).toMatch(
      /type="password"[^>]*autoComplete="off"|autoComplete="off"[^>]*type="password"/
    );
    // The place the key is pasted in starts empty, whatever the form was given.
    expect(text).toMatch(/<textarea[^>]*><\/textarea>/);
  });

  it('cannot be sent until there are ids and a key', () => {
    expect(html(<ImportForm {...props()} />)).toMatch(/<button[^>]*disabled[^>]*>.*Import the app/);
    expect(html(<ImportForm {...props({ keyText: 'x' })} />)).not.toMatch(
      /<button[^>]*disabled[^>]*>.*Import the app/
    );
    expect(html(<ImportForm {...props({ keyFile: 'my-app.pem' })} />)).toContain(
      'Using my-app.pem.'
    );
    expect(html(<ImportForm {...props({ appId: 'abc', keyText: 'x' })} />)).toMatch(
      /<button[^>]*disabled[^>]*>.*Import the app/
    );
  });

  it('is for a new key of the connected app when replacing: ids fixed', () => {
    const text = html(<ImportForm {...props({ replacing: true })} />);
    expect(text).toContain('Replace the key');
    expect(text.match(/readonly/g)).toHaveLength(2);
    expect(text).not.toContain('On GitHub: Settings, Developer settings');
  });

  it('shows what GitHub said when it refused', () => {
    const text = html(<ImportForm {...props({ error: 'GitHub rejected the key.' })} />);
    expect(text).toContain('role="alert"');
    expect(text).toContain('GitHub rejected the key.');
  });
});

describe('waiting for GitHub', () => {
  const waiting = (now: number) =>
    html(
      <WaitingForGithub
        expiresAt={600_000}
        now={now}
        redirectUrl="http://127.0.0.1:18790/v1/github/app/callback"
        onStartAgain={noop}
        onCancel={noop}
        busy={false}
      />
    );

  it('says what to do on GitHub, where the browser comes back to, and how long is left', () => {
    const text = waiting(0);
    expect(text).toContain('Waiting for GitHub');
    expect(text).toContain('Create GitHub App');
    expect(text).toContain('http://127.0.0.1:18790/v1/github/app/callback');
    expect(text).toContain('10 min');
    expect(text).toContain('Start again');
    expect(text).toContain('Cancel');
    expect(text).toContain('role="progressbar"');
  });

  it('is over at the manifest’s end, and only then (so the polling stops)', () => {
    expect(waitingIsOver(null, 1_000_000)).toBe(false);
    expect(waitingIsOver({ expiresAt: 600_000 }, 599_999)).toBe(false);
    expect(waitingIsOver({ expiresAt: 600_000 }, 600_000)).toBe(true);
    expect(waitingIsOver({ expiresAt: 600_000 }, 700_000)).toBe(true);
  });

  it('says it took too long after ten minutes, and still offers to start again', () => {
    const text = waiting(600_000);
    expect(text).toContain('GitHub did not answer in time');
    expect(text).toContain('Start again');
    expect(text).not.toContain('role="progressbar"');
  });
});

describe('connected', () => {
  it('shows the app, what is stored, and the ways on', () => {
    const text = summary();
    expect(text).toContain('OpenClerq-acme');
    expect(text).toContain('openclerq-acme');
    expect(text).toContain('acme (Organization)');
    expect(text).toContain('Created from OpenClerq');
    expect(text).toContain('Private key yes; client secret yes');
    expect(text).toContain('Check again');
    expect(text).toContain('App settings on GitHub');
    expect(text).toContain('Disconnect');
  });

  it('with no installation, says so and links the install page', () => {
    const text = summary({ installations: [] });
    expect(text).toContain('Not installed anywhere yet');
    expect(text).toContain('Install on GitHub');
    expect(text).toContain('Only select repositories');
  });

  it('with installations, lists the account, the selection and a suspended one', () => {
    const text = summary({
      installations: [
        installation,
        {
          ...installation,
          id: 2,
          account: 'octocat',
          accountType: 'User',
          repositorySelection: 'all',
          suspended: true,
        },
      ],
    });
    expect(text).toContain('Installed on');
    expect(text).toContain('acme');
    expect(text).toContain('Organisation · Selected repositories');
    expect(text).toContain('octocat');
    expect(text).toContain('All repositories');
    expect(text).toContain('Suspended');
    expect(text.match(/Manage/g)).toHaveLength(2);
    expect(text).not.toContain('Not installed anywhere yet');
  });

  it('does not make a link of an address that is not https', () => {
    const text = html(
      <InstallationsBlock
        app={{ ...app, installUrl: 'javascript:alert(1)' }}
        installations={[{ ...installation, htmlUrl: 'http://github.com/x' }]}
        host={host}
        onReplaceKey={noop}
      />
    );
    expect(text).not.toContain('javascript:');
    expect(text).not.toContain('<button');
    const none = html(
      <InstallationsBlock
        app={{ ...app, installUrl: 'javascript:alert(1)' }}
        installations={[]}
        host={host}
        onReplaceKey={noop}
      />
    );
    expect(none).not.toContain('<button');
    expect(none).not.toContain('javascript:');
  });

  it('when GitHub could not be asked, says why, and for a refused key says to import a new one', () => {
    const message =
      'Could not list the installations of the app: GitHub did not accept the app’s key (A JSON web token could not be decoded).';
    const refused = summary({ installations: null, installationsError: message });
    expect(refused).toContain('GitHub could not be asked where the app is installed');
    expect(refused).toContain('A JSON web token could not be decoded');
    expect(refused).toContain(KEY_REFUSED_NOTE);
    expect(refused).toContain('Import a new key');
    const down = summary({
      installations: null,
      installationsError: 'GitHub did not answer in time.',
    });
    expect(down).toContain('GitHub did not answer in time.');
    expect(down).not.toContain('Import a new key');
    expect(refusedKey(message)).toBe(true);
    expect(refusedKey('GitHub did not answer in time.')).toBe(false);
    expect(refusedKey(undefined)).toBe(false);
  });

  it('lists what was left out of GitHub’s answers', () => {
    const text = summary({
      warnings: [
        'GitHub gave an address for installation 3 that is not on its website; it was left out.',
      ],
    });
    expect(text).toContain('Warnings');
    expect(text).toContain('left out');
  });

  it('says a missing private key is missing', () => {
    expect(summary({ secrets: { privateKey: false, clientSecret: false } })).toContain(
      'Private key missing; client secret no'
    );
  });
});

describe('disconnecting', () => {
  it('asks first, and says what stays on GitHub', () => {
    const text = html(
      <DisconnectDialog
        open
        appName="OpenClerq-acme"
        signedIn
        busy={false}
        onClose={noop}
        onConfirm={noop}
      />
    );
    expect(text).toContain('Disconnect OpenClerq-acme?');
    expect(text).toContain('signs you out of GitHub');
    expect(text).toContain('stay on GitHub');
    expect(text).toContain('Keep it');
    expect(
      html(
        <DisconnectDialog
          open
          appName="x"
          signedIn={false}
          busy={false}
          onClose={noop}
          onConfirm={noop}
        />
      )
    ).not.toContain('signs you out');
    expect(
      html(
        <DisconnectDialog
          open={false}
          appName="x"
          signedIn
          busy={false}
          onClose={noop}
          onConfirm={noop}
        />
      )
    ).not.toContain('Disconnect x?');
  });

  it('then shows the answer and the app’s settings page', () => {
    const text = html(
      <DisconnectedNote
        message="OpenClerq forgot the app openclerq-acme. The app itself still exists on GitHub."
        settingsUrl="https://github.com/settings/apps/openclerq-acme"
        host={host}
        onDismiss={noop}
      />
    );
    expect(text).toContain('Disconnected');
    expect(text).toContain('still exists on GitHub');
    expect(text).toContain('The app on GitHub');
  });
});

describe('the sign-in', () => {
  const panel = (
    user: GithubUserStatus | null,
    settingsUrl: string | undefined = app.settingsUrl
  ) =>
    html(
      <SignInPanel
        user={user}
        host={host}
        now={Date.parse('2026-11-14T00:00:00Z')}
        onSignIn={noop}
        onSignOut={noop}
        busy={false}
        settingsUrl={settingsUrl}
      />
    );

  it('says what signing in is for, and that it is not for pushing', () => {
    const text = panel({ signedIn: false, refreshable: false });
    expect(text).toContain('not used to clone, push or open pull requests');
    expect(SIGN_IN_NOTE).toContain('app’s own tokens');
  });

  it('signed out: a button, the reason when there is one, and where Enable Device Flow is', () => {
    const text = panel({
      signedIn: false,
      refreshable: false,
      message: 'Your GitHub sign-in ran out. Sign in again.',
    });
    expect(text).toContain('Signed out');
    expect(text).toContain('Sign in with GitHub');
    expect(text).toContain('Your GitHub sign-in ran out');
    expect(text).toContain('Enable Device Flow');
    expect(text).toContain('App settings');
    expect(text).not.toContain('Sign out');
  });

  it('signed in: who, until when, renewed or not, and a way out', () => {
    const user: GithubUserStatus = {
      signedIn: true,
      user: {
        login: 'octocat',
        id: 1,
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        htmlUrl: 'https://github.com/octocat',
      },
      expiresAt: '2026-11-14T08:00:00.000Z',
      refreshable: true,
    };
    const text = panel(user);
    expect(text).toContain('@octocat');
    expect(text).toContain('The Octocat');
    expect(text).toContain('then renewed');
    expect(text).toContain('Sign out');
    expect(text).not.toContain('Sign in with GitHub');
    expect(text).toContain('Profile');
    expect(panel({ ...user, refreshable: false })).toContain('then you sign in again');
    expect(panel({ ...user, expiresAt: undefined })).toContain('Does not expire');
    // A profile address that is not https is not a link.
    expect(
      panel({ ...user, user: { ...(user.user as object), htmlUrl: 'http://x/octocat' } as never })
    ).not.toContain('Profile');
    // No avatar image is drawn: the desktop window may not load pictures from other hosts.
    expect(text).not.toContain('<img');
  });
});

describe('the sign-in dialog', () => {
  const start = {
    flowId: 'f1',
    userCode: 'WDJB-MJHT',
    verificationUri: 'https://github.com/login/device',
    expiresAt: '2026-11-14T00:15:00.000Z',
    interval: 5,
  };
  const dialog = (view: LoginView | null, open = true) =>
    html(
      <LoginDialog
        open={open}
        view={view}
        now={Date.parse('2026-11-14T00:00:00Z')}
        host={host}
        onCopy={noop}
        onOpenGithub={noop}
        onRetry={noop}
        onClose={noop}
      />
    );

  it('shows the code, Copy, Open GitHub and what it is waiting for', () => {
    const text = dialog({ phase: 'waiting', start, copied: false });
    expect(text).toContain('Sign in with GitHub');
    expect(text).toContain('WDJB-MJHT');
    expect(text).toContain('>Copy<');
    expect(text).toContain('Open GitHub');
    expect(text).toContain('https://github.com/login/device');
    expect(text).toContain('Waiting for you to approve it. The code works for 15 min');
    expect(text).toContain('role="progressbar"');
    expect(text).toContain('>Cancel<');
    expect(dialog({ phase: 'waiting', start, copied: true })).toContain('>Copied<');
  });

  it('says the code has run out when it has', () => {
    const text = html(
      <LoginDialog
        open
        view={{ phase: 'waiting', start, copied: false }}
        now={Date.parse('2026-11-14T00:20:00Z')}
        host={host}
        onCopy={noop}
        onOpenGithub={noop}
        onRetry={noop}
        onClose={noop}
      />
    );
    expect(text).toContain('The code has run out.');
  });

  it('is a progress line while the code is asked for', () => {
    expect(dialog({ phase: 'starting' })).toContain('role="progressbar"');
    expect(dialog(null)).toContain('role="progressbar"');
  });

  it('says who signed in', () => {
    const text = dialog({
      phase: 'approved',
      user: { login: 'octocat', id: 1, name: null, avatarUrl: null, htmlUrl: null },
    });
    expect(text).toContain('Signed in');
    expect(text).toContain('@octocat');
    expect(text).toContain('>Done<');
  });

  it('says how each failure ended, with a way to try again', () => {
    for (const status of ['denied', 'expired', 'error'] as const) {
      const text = dialog({ phase: 'ended', status, message: 'GitHub said no.' });
      expect(text).toContain(ENDED_WORDS[status]);
      expect(text).toContain('GitHub said no.');
      expect(text).toContain('Try again');
      expect(text).toContain('role="alert"');
    }
  });

  it('when device flow is off, says which setting to turn on and links the app’s settings', () => {
    const text = dialog({
      phase: 'disabled',
      message: 'Device flow is not switched on.',
      settingsUrl: 'https://github.com/settings/apps/openclerq-acme',
    });
    expect(text).toContain('Device flow is not switched on for this app');
    expect(text).toContain('Identifying and authorizing users');
    expect(text).toContain('Enable Device Flow');
    expect(text).toContain('App settings on GitHub');
    expect(text).not.toContain('Try again');
    // With an address that is not https, the instructions stay and there is no link.
    const bad = dialog({ phase: 'disabled', message: '', settingsUrl: null });
    expect(bad).toContain('Enable Device Flow');
    expect(bad).not.toContain('App settings on GitHub</span></button>');
  });

  it('draws nothing of its own while closed', () => {
    expect(dialog({ phase: 'waiting', start, copied: false }, false)).not.toContain('WDJB-MJHT');
  });
});

describe('what the dialog makes of the gateway’s answers', () => {
  it('keeps waiting while the flow is pending, and finishes on anything else', () => {
    expect(loginViewFor({ status: 'pending', interval: 5 })).toBeNull();
    expect(loginViewFor({ status: 'approved', user: null })).toEqual({
      phase: 'approved',
      user: null,
      message: undefined,
    });
    expect(loginViewFor({ status: 'denied', message: 'No.' })).toEqual({
      phase: 'ended',
      status: 'denied',
      message: 'No.',
    });
    expect(loginViewFor({ status: 'expired' })).toMatchObject({
      phase: 'ended',
      status: 'expired',
    });
    expect(loginViewFor({ status: 'error', message: 'It broke.' })).toMatchObject({
      phase: 'ended',
      status: 'error',
      message: 'It broke.',
    });
  });

  it('turns disabled into instructions, with a link only if it is https', () => {
    expect(
      loginViewFor({
        status: 'disabled',
        message: 'Switch it on.',
        settingsUrl: 'https://github.com/settings/apps/x',
      })
    ).toEqual({
      phase: 'disabled',
      message: 'Switch it on.',
      settingsUrl: 'https://github.com/settings/apps/x',
    });
    expect(loginViewFor({ status: 'disabled', settingsUrl: 'javascript:alert(1)' })).toMatchObject({
      phase: 'disabled',
      settingsUrl: null,
    });
  });

  it('turns a refused start into disabled when that is why, and into the reason otherwise', () => {
    const refused = (body: Record<string, unknown>) =>
      Object.assign(new Error('Gateway 409'), { status: 409, body });
    expect(
      loginViewForFailure(
        refused({
          error: 'device_flow_disabled',
          message: 'Switch it on.',
          settingsUrl: 'https://github.com/s',
        })
      )
    ).toEqual({ phase: 'disabled', message: 'Switch it on.', settingsUrl: 'https://github.com/s' });
    expect(
      loginViewForFailure(
        refused({ error: 'app_not_connected', message: 'No GitHub App is connected.' })
      )
    ).toEqual({ phase: 'ended', status: 'error', message: 'No GitHub App is connected.' });
    expect(loginViewForFailure(new TypeError('Failed to fetch'))).toMatchObject({
      phase: 'ended',
      status: 'error',
    });
  });
});

describe('the section', () => {
  const connected: GithubAppStatus = {
    connected: true,
    app,
    secrets: { privateKey: true, clientSecret: true },
    installations: [installation],
  };
  const signedIn: GithubUserStatus = {
    signedIn: true,
    user: {
      login: 'octocat',
      id: 1,
      name: 'The Octocat',
      avatarUrl: null,
      htmlUrl: 'https://github.com/octocat',
    },
    refreshable: true,
  };

  it('is one of the settings sections, after Secrets', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids).toContain('github');
    expect(ids.indexOf('github')).toBe(ids.indexOf('secrets') + 1);
  });

  it('not connected: Create and Import', () => {
    const text = html(<GithubSection />, { 'github-app': { connected: false } });
    expect(text).toContain('Create on GitHub');
    expect(text).toContain('Import the app');
    expect(text).not.toContain('Sign in with GitHub');
  });

  it('connected and signed out: the app, where it is installed, and Sign in', () => {
    const text = html(<GithubSection />, {
      'github-app': connected,
      'github-user': { signedIn: false, refreshable: false },
    });
    expect(text).toContain('OpenClerq-acme');
    expect(text).toContain('Installed on');
    expect(text).toContain('Sign in with GitHub');
    expect(text).not.toContain('Create on GitHub');
  });

  it('connected and signed in: who, and Sign out', () => {
    const text = html(<GithubSection />, { 'github-app': connected, 'github-user': signedIn });
    expect(text).toContain('@octocat');
    expect(text).toContain('Sign out');
  });

  it('shows a refused key as the app’s state, not as a failure of the page', () => {
    const text = html(<GithubSection />, {
      'github-app': {
        ...connected,
        installations: null,
        installationsError: 'GitHub did not accept the app’s key (Bad credentials).',
      },
      'github-user': { signedIn: false, refreshable: false },
    });
    expect(text).toContain('GitHub could not be asked');
    expect(text).toContain('Import a new key');
  });
});
