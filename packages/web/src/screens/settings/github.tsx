/**
 * Settings → GitHub: the GitHub App OpenClerq reaches GitHub with, and who is
 * signed in.
 *
 * The app: not connected (Create it on GitHub, or Import one you made), waiting
 * for GitHub (the manifest was posted, up to ten minutes), connected and not
 * installed anywhere, connected and installed (account, selection, suspended),
 * or connected and GitHub could not be asked (a refused key says to generate a
 * new one and import it).
 *
 * The person: signed out or signed in, through the app's device flow. The user
 * token is for who you are and which repositories you reach through the app; it
 * is not used to clone, push or open a pull request (runs use the app's own
 * short-lived tokens, see docs/GITHUB.md).
 *
 * Every piece that draws a state takes it as props (so each state can be looked
 * at on its own); `GithubSection` is the one that talks to the gateway. A link
 * built from what GitHub or the gateway said is only made for an `https:`
 * address, whatever the gateway already checked.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  CircleAlert,
  Copy,
  GitBranch,
  LogIn,
  LogOut,
  Plug,
  RefreshCw,
  Unplug,
  Upload,
} from 'lucide-react';
import type {
  GithubAppInfo,
  GithubAppStatus,
  GithubInstallation,
  GithubLoginStart,
  GithubLoginStatus,
  GithubUser,
  GithubUserStatus,
} from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { EmptyState, KeyValue, ProgressLine } from '../../ui/Display';
import { Input, Textarea } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Dialog } from '../../ui/Modal';
import { StatusTag } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { useClient, useHost, type Host } from '../../app/client';
import { duration, errorMessage } from '../../app/format';
import { useResource } from '../../app/live';
import { Loaded, Section } from '../../shell/layout';
import { useNow, When } from '../common';

// ---- addresses --------------------------------------------------------------------------

/** The address when it is `https:` with no user name or password, else null: nothing else becomes a link. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** A button that opens an address through the host; for an address that is not https, nothing at all. */
export function ExternalLink({
  url,
  host,
  children,
  size = 'sm',
}: {
  url: unknown;
  host: Pick<Host, 'openUrl'>;
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  const safe = httpsUrl(url);
  if (!safe) return null;
  return (
    <Button variant="ghost" size={size} icon={ArrowUpRight} onClick={() => host.openUrl(safe)}>
      {children}
    </Button>
  );
}

// ---- words ---------------------------------------------------------------------------------

export const SIGN_IN_NOTE =
  'Signing in shows who you are here and lists the repositories you can reach through the app. ' +
  'It is not used to clone, push or open pull requests: a run does those with the app’s own tokens, ' +
  'made for one repository at a time and ended when the run does.';

export const KEY_REFUSED_NOTE =
  'GitHub did not accept the app’s key. If it was deleted on GitHub, generate a new private key on the app’s settings page and import it here.';

/** What GitHub's refusal of the key looks like in the gateway's words. */
export const refusedKey = (message: string | undefined): boolean =>
  Boolean(message && /did not accept|refused|private key|key was/i.test(message));

const SELECTION: Record<string, string> = {
  all: 'All repositories',
  selected: 'Selected repositories',
};

// ---- not connected ----------------------------------------------------------------------------

export interface NotConnectedProps {
  org: string;
  name: string;
  onOrg(value: string): void;
  onName(value: string): void;
  onCreate(): void;
  creating: boolean;
  /** Why the last attempt failed, in words. */
  error?: string | null;
  importForm: ReactNode;
}

/** No app yet: make one on GitHub in one confirmation, or use one you made. */
export function NotConnected({
  org,
  name,
  onOrg,
  onName,
  onCreate,
  creating,
  error,
  importForm,
}: NotConnectedProps) {
  return (
    <div className="github-states">
      <p className="page-hint">
        OpenClerq reaches GitHub with a GitHub App that you own: each run gets a short-lived token
        for the one repository it works on, and nothing long-lived goes near an agent. Making one
        takes one confirmation on GitHub.
      </p>
      <div className="github-card">
        <h3 className="settings-subtitle">Create the app on GitHub</h3>
        <p className="page-hint">
          Opens GitHub in your browser, which shows the app’s name and asks you to confirm. When it
          sends the browser back, this page connects by itself.
        </p>
        <div className="settings-inline">
          <Input
            label="Organisation (optional)"
            value={org}
            onChange={(e) => onOrg(e.target.value)}
            placeholder="your-organisation"
            hint="Leave empty to create it under your own account."
            autoComplete="off"
          />
          <Input
            label="App name (optional)"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="OpenClerq-ab12cd"
            hint="At most 34 characters; GitHub names are unique."
            autoComplete="off"
          />
        </div>
        {error && (
          <p className="github-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-row">
          <Button variant="primary" icon={Plug} busy={creating} onClick={onCreate}>
            Create on GitHub
          </Button>
        </div>
      </div>
      <div className="github-card">
        <h3 className="settings-subtitle">Or import an app you made</h3>
        {importForm}
      </div>
    </div>
  );
}

export interface ImportFormProps {
  appId: string;
  clientId: string;
  /** The key pasted in, when no file is chosen. */
  keyText: string;
  clientSecret: string;
  /** The file chosen, by name; the browser keeps the file itself. */
  keyFile: string | null;
  onAppId(value: string): void;
  onClientId(value: string): void;
  onKeyText(value: string): void;
  onKeyFile(file: File | null): void;
  onClientSecret(value: string): void;
  onSubmit(): void;
  busy: boolean;
  error?: string | null;
  /** Remounts the file picker, so a chosen file is forgotten. */
  fileKey: number;
  /** A new key for the connected app: the ids are fixed. */
  replacing?: boolean;
}

/** An app made by hand: its ids, its key (a file or pasted) and, to renew sign-ins, its client secret. */
export function ImportForm(props: ImportFormProps) {
  const ready =
    /^\d{1,12}$/.test(props.appId.trim()) &&
    props.clientId.trim().length >= 4 &&
    (props.keyText.trim() !== '' || props.keyFile !== null);
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) props.onSubmit();
      }}
    >
      {!props.replacing && (
        <p className="page-hint">
          On GitHub: Settings, Developer settings, GitHub Apps, New GitHub App. Turn Webhook off,
          give it Contents and Pull requests write access, then Generate a private key.
        </p>
      )}
      <div className="settings-inline">
        <Input
          label="App ID"
          mono
          inputMode="numeric"
          value={props.appId}
          onChange={(e) => props.onAppId(e.target.value)}
          readOnly={props.replacing}
          autoComplete="off"
        />
        <Input
          label="Client ID"
          mono
          value={props.clientId}
          onChange={(e) => props.onClientId(e.target.value)}
          readOnly={props.replacing}
          autoComplete="off"
        />
      </div>
      <div className="github-key">
        <label className="ui-field-label" htmlFor="github-key-file">
          Private key (.pem file)
        </label>
        <input
          key={props.fileKey}
          id="github-key-file"
          type="file"
          accept=".pem,application/x-pem-file,text/plain"
          className="github-file"
          onChange={(e) => props.onKeyFile(e.target.files?.[0] ?? null)}
        />
        {props.keyFile && <span className="page-hint">Using {props.keyFile}.</span>}
        <Textarea
          label="Or paste the key"
          mono
          rows={4}
          value={props.keyText}
          onChange={(e) => props.onKeyText(e.target.value)}
          placeholder="Paste the whole contents of the .pem file"
          autoComplete="off"
          spellCheck={false}
          hint="It goes to the gateway and is kept in the vault. This form is emptied once it is sent."
        />
      </div>
      <Input
        label="Client secret (optional)"
        type="password"
        value={props.clientSecret}
        onChange={(e) => props.onClientSecret(e.target.value)}
        autoComplete="off"
        hint="Lets a GitHub sign-in be renewed after eight hours and revoked on sign-out."
      />
      {props.error && (
        <p className="github-error" role="alert">
          {props.error}
        </p>
      )}
      <div className="page-row">
        <Button type="submit" variant="primary" icon={Upload} busy={props.busy} disabled={!ready}>
          {props.replacing ? 'Replace the key' : 'Import the app'}
        </Button>
      </div>
    </form>
  );
}

// ---- waiting ------------------------------------------------------------------------------------

export interface WaitingProps {
  /** When the manifest’s state stops working (ten minutes after it was made). */
  expiresAt: number;
  now: number;
  /** Where GitHub sends the browser back to. */
  redirectUrl: string;
  onStartAgain(): void;
  onCancel(): void;
  busy: boolean;
}

/** The manifest was posted: nothing to do here but wait, for up to ten minutes. */
export function WaitingForGithub({
  expiresAt,
  now,
  redirectUrl,
  onStartAgain,
  onCancel,
  busy,
}: WaitingProps) {
  const left = expiresAt - now;
  const over = left <= 0;
  return (
    <div className="github-card" role="status" aria-live="polite">
      <h3 className="settings-subtitle">
        {over ? 'GitHub did not answer in time' : 'Waiting for GitHub'}
      </h3>
      {over ? (
        <p className="page-hint">
          Ten minutes passed without the app coming back from GitHub. If you did not press Create on
          GitHub, start again.
        </p>
      ) : (
        <>
          <ProgressLine label="Waiting for GitHub" />
          <p className="page-hint">
            In the window that opened, check the app’s name and press Create GitHub App. GitHub then
            sends the browser back to <code>{redirectUrl}</code>, and this page connects by itself.
            About {duration(left)} left.
          </p>
        </>
      )}
      <div className="page-row">
        <Button variant="primary" icon={RefreshCw} busy={busy} onClick={onStartAgain}>
          Start again
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---- connected ------------------------------------------------------------------------------------

export interface AppSummaryProps {
  app: GithubAppInfo;
  secrets?: { privateKey: boolean; clientSecret: boolean };
  /** Where it is installed; null when GitHub could not be asked. */
  installations: GithubInstallation[] | null | undefined;
  installationsError?: string;
  warnings: string[];
  host: Pick<Host, 'openUrl'>;
  onRefresh(): void;
  refreshing: boolean;
  onReplaceKey(): void;
  onDisconnect(): void;
}

/** The connected app, and where it is installed. */
export function AppSummary({
  app,
  secrets,
  installations,
  installationsError,
  warnings,
  host,
  onRefresh,
  refreshing,
  onReplaceKey,
  onDisconnect,
}: AppSummaryProps) {
  return (
    <div className="github-states">
      <KeyValue
        items={[
          {
            label: 'GitHub App',
            value: (
              <span className="github-app-name">
                {app.name} <code>{app.slug}</code>
                <ExternalLink url={app.htmlUrl} host={host}>
                  Open on GitHub
                </ExternalLink>
              </span>
            ),
          },
          { label: 'Owner', value: app.owner ? `${app.owner.login} (${app.owner.type})` : null },
          {
            label: 'Connected',
            value: app.source === 'manifest' ? 'Created from OpenClerq' : 'Imported',
          },
          {
            label: 'Stored',
            value: `Private key ${secrets?.privateKey ? 'yes' : 'missing'}; client secret ${
              secrets?.clientSecret ? 'yes' : 'no'
            }`,
          },
        ]}
      />
      {warnings.length > 0 && (
        <ul className="github-warnings" aria-label="Warnings">
          {warnings.map((w) => (
            <li key={w}>
              <Icon glyph={CircleAlert} size={14} /> {w}
            </li>
          ))}
        </ul>
      )}
      <InstallationsBlock
        app={app}
        installations={installations}
        installationsError={installationsError}
        host={host}
        onReplaceKey={onReplaceKey}
      />
      <div className="page-row">
        <Button icon={RefreshCw} busy={refreshing} onClick={onRefresh}>
          Check again
        </Button>
        <ExternalLink url={app.settingsUrl} host={host} size="md">
          App settings on GitHub
        </ExternalLink>
        <Button variant="danger" icon={Unplug} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </div>
  );
}

/** Not installed anywhere, installed (account, selection, suspended), or GitHub could not be asked. */
export function InstallationsBlock({
  app,
  installations,
  installationsError,
  host,
  onReplaceKey,
}: Pick<
  AppSummaryProps,
  'app' | 'installations' | 'installationsError' | 'host' | 'onReplaceKey'
>) {
  if (installations === null || installations === undefined) {
    const refused = refusedKey(installationsError);
    return (
      <div className="github-card github-card--warn" role="alert">
        <h3 className="settings-subtitle">GitHub could not be asked where the app is installed</h3>
        <p>{installationsError ?? 'GitHub did not answer.'}</p>
        {refused && <p className="page-hint">{KEY_REFUSED_NOTE}</p>}
        {refused && (
          <div className="page-row">
            <Button icon={Upload} onClick={onReplaceKey}>
              Import a new key
            </Button>
          </div>
        )}
      </div>
    );
  }
  if (installations.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="Not installed anywhere yet"
        actions={
          <ExternalLink url={app.installUrl} host={host} size="md">
            Install on GitHub
          </ExternalLink>
        }
      >
        The app reaches only the repositories it is installed on. Choose Only select repositories
        and pick the ones OpenClerq may work on, then come back and check again.
      </EmptyState>
    );
  }
  return (
    <div className="github-installations">
      <h3 className="settings-subtitle">Installed on</h3>
      <ul className="settings-list" aria-label="Installations">
        {installations.map((i) => (
          <li key={i.id}>
            <span className="settings-module">
              <span>{i.account ?? `Installation ${i.id}`}</span>
              <span className="page-hint">
                {i.accountType === 'Organization' ? 'Organisation' : (i.accountType ?? 'Account')} ·{' '}
                {SELECTION[i.repositorySelection ?? ''] ?? 'Repositories unknown'}
              </span>
            </span>
            {i.suspended && <StatusTag tone="warn">Suspended</StatusTag>}
            <ExternalLink url={i.htmlUrl} host={host}>
              Manage
            </ExternalLink>
          </li>
        ))}
      </ul>
      <div className="page-row">
        <ExternalLink url={app.installUrl} host={host}>
          Install on more
        </ExternalLink>
      </div>
    </div>
  );
}

/** What disconnecting did: GitHub still has the app. */
export function DisconnectedNote({
  message,
  settingsUrl,
  host,
  onDismiss,
}: {
  message: string;
  settingsUrl: unknown;
  host: Pick<Host, 'openUrl'>;
  onDismiss(): void;
}) {
  return (
    <div className="github-card" role="status">
      <h3 className="settings-subtitle">Disconnected</h3>
      <p>{message}</p>
      <div className="page-row">
        <ExternalLink url={settingsUrl} host={host} size="md">
          The app on GitHub
        </ExternalLink>
        <Button variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function DisconnectDialog({
  open,
  appName,
  signedIn,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  appName: string;
  signedIn: boolean;
  busy: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Disconnect ${appName}?`}
      description={
        `OpenClerq forgets the app and deletes its private key from the vault${
          signedIn ? ', and signs you out of GitHub' : ''
        }. The app and its installations stay on GitHub until you delete them there, ` +
        'and a run that is using a token keeps it until that run ends.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" icon={Unplug} busy={busy} onClick={onConfirm}>
            Disconnect
          </Button>
        </>
      }
    />
  );
}

// ---- the person -------------------------------------------------------------------------------------

export interface SignInPanelProps {
  user: GithubUserStatus | null | undefined;
  host: Pick<Host, 'openUrl'>;
  now: number;
  onSignIn(): void;
  onSignOut(): void;
  busy: boolean;
  /** The app's settings page, for the device-flow reminder. */
  settingsUrl?: string;
}

/** Signed out or signed in, and what signing in is for. */
export function SignInPanel({
  user,
  host,
  now,
  onSignIn,
  onSignOut,
  busy,
  settingsUrl,
}: SignInPanelProps) {
  const who = user?.user;
  return (
    <div className="github-card">
      <h3 className="settings-subtitle">Your GitHub sign-in</h3>
      <p className="page-hint">{SIGN_IN_NOTE}</p>
      {user?.signedIn ? (
        <>
          <KeyValue
            items={[
              {
                label: 'Signed in as',
                value: who ? (
                  <span className="github-app-name">
                    {who.name ? `${who.name} ` : ''}
                    <code>@{who.login}</code>
                    <ExternalLink url={who.htmlUrl} host={host}>
                      Profile
                    </ExternalLink>
                  </span>
                ) : (
                  'GitHub did not say who'
                ),
              },
              {
                label: 'Lasts',
                value: user.expiresAt ? (
                  <span>
                    until <When at={user.expiresAt} now={now} />
                    {user.refreshable ? ', then renewed' : ', then you sign in again'}
                  </span>
                ) : (
                  'Does not expire'
                ),
              },
            ]}
          />
          {user.message && <p className="page-hint">{user.message}</p>}
          <div className="page-row">
            <Button icon={LogOut} busy={busy} onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            <StatusTag tone="muted">Signed out</StatusTag>
          </p>
          {user?.message && <p className="page-hint">{user.message}</p>}
          <p className="page-hint">
            Signing in needs <strong>Enable Device Flow</strong> switched on in the app’s settings
            on GitHub, under Identifying and authorizing users.{' '}
            <ExternalLink url={settingsUrl} host={host}>
              App settings
            </ExternalLink>
          </p>
          <div className="page-row">
            <Button variant="primary" icon={LogIn} busy={busy} onClick={onSignIn}>
              Sign in with GitHub
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- the sign-in dialog --------------------------------------------------------------------------------

export type LoginView =
  | { phase: 'starting' }
  | { phase: 'waiting'; start: GithubLoginStart; copied: boolean }
  | { phase: 'approved'; user: GithubUser | null; message?: string }
  | { phase: 'ended'; status: 'denied' | 'expired' | 'error'; message: string }
  | { phase: 'disabled'; message: string; settingsUrl: string | null };

/** The words for how a sign-in ended. */
export const ENDED_WORDS: Record<'denied' | 'expired' | 'error', string> = {
  denied: 'The sign-in was refused on GitHub.',
  expired: 'The code ran out before it was approved.',
  error: 'The sign-in did not work.',
};

/** What the dialog shows for the gateway's answer about a flow; null while it is still pending. */
export function loginViewFor(s: GithubLoginStatus): LoginView | null {
  switch (s.status) {
    case 'pending':
      return null;
    case 'approved':
      return { phase: 'approved', user: s.user ?? null, message: s.message };
    case 'disabled':
      return {
        phase: 'disabled',
        message: s.message ?? '',
        settingsUrl: httpsUrl(s.settingsUrl),
      };
    default:
      return { phase: 'ended', status: s.status, message: s.message ?? '' };
  }
}

/** What the dialog shows when no code could be had: device flow off says which setting, else the reason. */
export function loginViewForFailure(e: unknown): LoginView {
  const body = (e as { body?: Record<string, unknown> } | null)?.body;
  if (body?.error === 'device_flow_disabled') {
    return { phase: 'disabled', message: errorMessage(e), settingsUrl: httpsUrl(body.settingsUrl) };
  }
  return { phase: 'ended', status: 'error', message: errorMessage(e) };
}

export interface LoginDialogProps {
  open: boolean;
  view: LoginView | null;
  now: number;
  host: Pick<Host, 'openUrl'>;
  onCopy(): void;
  onOpenGithub(): void;
  onRetry(): void;
  onClose(): void;
}

/** The code to type on GitHub, a Copy button, an Open GitHub button, and what is happening. */
export function LoginDialog({
  open,
  view,
  now,
  host,
  onCopy,
  onOpenGithub,
  onRetry,
  onClose,
}: LoginDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Sign in with GitHub"
      description="GitHub asks you to type a code, so you never type a password here."
      size="md"
      actions={
        view?.phase === 'ended' || view?.phase === 'disabled' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {view.phase === 'ended' && (
              <Button variant="primary" icon={RefreshCw} onClick={onRetry}>
                Try again
              </Button>
            )}
          </>
        ) : view?.phase === 'approved' ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <LoginBody view={view} now={now} host={host} onCopy={onCopy} onOpenGithub={onOpenGithub} />
    </Dialog>
  );
}

function LoginBody({
  view,
  now,
  host,
  onCopy,
  onOpenGithub,
}: Pick<LoginDialogProps, 'view' | 'now' | 'host' | 'onCopy' | 'onOpenGithub'>) {
  if (!view || view.phase === 'starting') {
    return <ProgressLine label="Asking GitHub for a code" />;
  }
  if (view.phase === 'disabled') {
    return (
      <div className="github-login" role="alert">
        <p>
          <strong>Device flow is not switched on for this app.</strong>
        </p>
        <ol className="github-steps">
          <li>Open the app’s settings page on GitHub.</li>
          <li>Under “Identifying and authorizing users”, tick “Enable Device Flow”.</li>
          <li>Save, then try again here.</li>
        </ol>
        <ExternalLink url={view.settingsUrl} host={host} size="md">
          App settings on GitHub
        </ExternalLink>
      </div>
    );
  }
  if (view.phase === 'ended') {
    return (
      <div className="github-login" role="alert">
        <p>{ENDED_WORDS[view.status]}</p>
        {view.message && view.message !== ENDED_WORDS[view.status] && (
          <p className="page-hint">{view.message}</p>
        )}
      </div>
    );
  }
  if (view.phase === 'approved') {
    return (
      <div className="github-login" role="status">
        <p>
          <StatusTag tone="ok">Signed in</StatusTag>{' '}
          {view.user ? (
            <>
              as <code>@{view.user.login}</code>
            </>
          ) : (
            'to GitHub'
          )}
          .
        </p>
        {view.message && <p className="page-hint">{view.message}</p>}
      </div>
    );
  }
  const left = Date.parse(view.start.expiresAt) - now;
  return (
    <div className="github-login">
      <ol className="github-steps">
        <li>Copy this code.</li>
        <li>Open GitHub and paste it where it asks for the code.</li>
        <li>Approve the app. This window then finishes by itself.</li>
      </ol>
      <div className="github-code-row">
        <code className="github-code" aria-label="Your code">
          {view.start.userCode}
        </code>
        <Button icon={Copy} onClick={onCopy}>
          {view.copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="primary" icon={ArrowUpRight} onClick={onOpenGithub}>
          Open GitHub
        </Button>
      </div>
      <p className="page-hint">
        <code>{view.start.verificationUri}</code>
      </p>
      <p className="github-status" role="status" aria-live="polite">
        {left > 0
          ? `Waiting for you to approve it. The code works for ${duration(left)}.`
          : 'The code has run out.'}
      </p>
      <ProgressLine label="Waiting for you to approve it on GitHub" />
    </div>
  );
}

// ---- the section ------------------------------------------------------------------------------------------

interface Waiting {
  expiresAt: number;
  redirectUrl: string;
}

const POLL_MS = 2_000;

/** Whether the manifest's ten minutes are up: nothing can come back from GitHub after that. */
export function waitingIsOver(waiting: { expiresAt: number } | null, now: number): boolean {
  return waiting !== null && now >= waiting.expiresAt;
}

/** Post a form to `url` in a window the click opened (the web host has no `openForm`). */
function postFormToWindow(url: string, fields: Record<string, string>, target: string): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = url;
  form.target = target;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

export function GithubSection() {
  const client = useClient();
  const host = useHost();
  const toast = useToast();
  const now = useNow(1000);
  const app = useResource('github-app', () => client.githubApp());
  const connected = app.data?.connected === true;
  const user = useResource(connected ? 'github-user' : null, () => client.githubUser());

  const [org, setOrg] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  const [importing, setImporting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [appId, setAppId] = useState('');
  const [clientId, setClientId] = useState('');
  const [keyText, setKeyText] = useState('');
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [clientSecret, setClientSecret] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnected, setDisconnected] = useState<{ message: string; settingsUrl: string } | null>(
    null
  );
  const [signingOut, setSigningOut] = useState(false);

  const [loginOpen, setLoginOpen] = useState(false);
  const [login, setLogin] = useState<LoginView | null>(null);
  const flow = useRef<string | null>(null);

  // The app comes back from GitHub by itself: look every two seconds while waiting.
  const reload = useRef(app.reload);
  reload.current = app.reload;
  // ...until the ten minutes are up: then the page says so and offers Start again, and stops asking.
  const waitOver = waitingIsOver(waiting, now);
  useEffect(() => {
    if (!waiting || waitOver) return;
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const status = await client.githubApp();
        if (stopped || !status.connected) return;
        stopped = true;
        setWaiting(null);
        toast({ message: `Connected the GitHub App ${status.app?.name ?? ''}.`, tone: 'ok' });
        void reload.current();
      } catch {
        /* the gateway is busy or restarting: the next look will do */
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [waiting, waitOver, client, toast]);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    // The window is opened now, while the click still counts, and the form is posted into it.
    const named = 'clerq-github-app';
    const reserved = host.openForm ? null : window.open('', named);
    try {
      const offer = await client.githubManifest({
        baseUrl: client.getUrl(),
        ...(org.trim() ? { owner: org.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      const target = httpsUrl(offer.url);
      if (!target)
        throw new Error(
          'The gateway gave an address for GitHub that is not https, so nothing was opened.'
        );
      const fields = { manifest: JSON.stringify(offer.manifest) };
      if (host.openForm) await host.openForm(target, fields);
      else if (reserved) postFormToWindow(target, fields, named);
      else
        throw new Error(
          'Your browser blocked the window GitHub opens in. Allow pop-ups for this page and try again.'
        );
      setWaiting({ expiresAt: Date.parse(offer.expiresAt), redirectUrl: offer.redirectUrl });
    } catch (e) {
      reserved?.close();
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const startImport = (fixed?: { appId: number; clientId: string }) => {
    setReplacing(Boolean(fixed));
    setAppId(fixed ? String(fixed.appId) : '');
    setClientId(fixed?.clientId ?? '');
    setImporting(true);
    setImportError(null);
  };
  const clearKey = () => {
    setKeyText('');
    setKeyFile(null);
    setClientSecret('');
    setFileKey((n) => n + 1);
  };
  const submit = async () => {
    setImportError(null);
    let privateKey = keyText;
    try {
      if (keyFile) privateKey = await keyFile.text();
    } catch {
      setImportError('That file could not be read.');
      return;
    }
    const body = {
      appId: appId.trim(),
      clientId: clientId.trim(),
      privateKey,
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
    };
    setImportBusy(true);
    // Sent: nothing of the key stays in this form, whichever way the answer goes.
    clearKey();
    try {
      const done = await client.importGithubApp(body);
      setImporting(false);
      setReplacing(false);
      toast({
        message: done.replacedKey
          ? 'The key was replaced.'
          : `Connected the GitHub App ${done.app.name}.`,
        tone: 'ok',
      });
      void app.reload();
    } catch (e) {
      setImportError(errorMessage(e));
    } finally {
      setImportBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await client.githubApp({ refresh: true });
      await app.reload();
    } catch (e) {
      toast({ message: `Couldn’t ask GitHub. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setRefreshing(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const done = await client.disconnectGithubApp();
      setConfirmDisconnect(false);
      setDisconnected({ message: done.message, settingsUrl: done.settingsUrl });
      setImporting(false);
      void app.reload();
    } catch (e) {
      toast({ message: `Couldn’t disconnect. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setDisconnecting(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      const done = await client.githubSignOut();
      toast({ message: done.message, tone: done.revoked ? 'ok' : 'neutral' });
    } catch (e) {
      toast({ message: `Couldn’t sign out. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setSigningOut(false);
      void user.reload();
    }
  };

  // ---- the sign-in dialog ----
  const stopFlow = () => {
    const id = flow.current;
    flow.current = null;
    if (id) void client.cancelGithubLogin(id).catch(() => undefined);
  };
  const startLogin = async () => {
    stopFlow();
    setLogin({ phase: 'starting' });
    setLoginOpen(true);
    try {
      const start = await client.startGithubLogin();
      flow.current = start.flowId;
      setLogin({ phase: 'waiting', start, copied: false });
    } catch (e) {
      setLogin(loginViewForFailure(e));
    }
  };
  const closeLogin = () => {
    stopFlow();
    setLoginOpen(false);
    setLogin(null);
  };
  useEffect(() => {
    if (!loginOpen || login?.phase !== 'waiting') return;
    const id = flow.current;
    if (!id) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const s = await client.githubLogin(id);
        const next = loginViewFor(s);
        if (stopped || !next) return;
        stopped = true;
        flow.current = null;
        setLogin(next);
        if (next.phase === 'approved') void user.reload();
      } catch (e) {
        if (stopped) return;
        stopped = true;
        flow.current = null;
        setLogin({ phase: 'ended', status: 'error', message: errorMessage(e) });
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginOpen, login?.phase, client]);
  const copy = async () => {
    if (login?.phase !== 'waiting') return;
    try {
      await navigator.clipboard.writeText(login.start.userCode);
      setLogin({ ...login, copied: true });
    } catch {
      toast({ message: 'Couldn’t copy. Select the code and copy it yourself.', tone: 'neutral' });
    }
  };
  const openGithub = () => {
    if (login?.phase !== 'waiting') return;
    const url = httpsUrl(login.start.verificationUri);
    if (url) host.openUrl(url);
  };

  const importForm = (
    <ImportForm
      appId={appId}
      clientId={clientId}
      keyText={keyText}
      keyFile={keyFile?.name ?? null}
      clientSecret={clientSecret}
      onAppId={setAppId}
      onClientId={setClientId}
      onKeyText={setKeyText}
      onKeyFile={setKeyFile}
      onClientSecret={setClientSecret}
      onSubmit={() => void submit()}
      busy={importBusy}
      error={importError}
      fileKey={fileKey}
      replacing={replacing}
    />
  );

  return (
    <Section title="GitHub">
      <Loaded resource={app} what="the GitHub App" skeleton="rows">
        {(status: GithubAppStatus) => {
          const info = status.app;
          if (!status.connected || !info) {
            if (waiting) {
              return (
                <WaitingForGithub
                  expiresAt={waiting.expiresAt}
                  now={now}
                  redirectUrl={waiting.redirectUrl}
                  busy={creating}
                  onStartAgain={() => void create()}
                  onCancel={() => setWaiting(null)}
                />
              );
            }
            return (
              <>
                {disconnected && (
                  <DisconnectedNote
                    message={disconnected.message}
                    settingsUrl={disconnected.settingsUrl}
                    host={host}
                    onDismiss={() => setDisconnected(null)}
                  />
                )}
                <NotConnected
                  org={org}
                  name={name}
                  onOrg={setOrg}
                  onName={setName}
                  onCreate={() => void create()}
                  creating={creating}
                  error={createError}
                  importForm={importForm}
                />
              </>
            );
          }
          return (
            <>
              <AppSummary
                app={info}
                secrets={status.secrets}
                installations={status.installations}
                installationsError={status.installationsError}
                warnings={[...(info.warnings ?? []), ...(status.warnings ?? [])]}
                host={host}
                refreshing={refreshing}
                onRefresh={() => void refresh()}
                onReplaceKey={() => startImport({ appId: info.appId, clientId: info.clientId })}
                onDisconnect={() => setConfirmDisconnect(true)}
              />
              {importing && replacing && (
                <div className="github-card">
                  <h3 className="settings-subtitle">Import a new key for {info.name}</h3>
                  {importForm}
                  <div className="page-row">
                    <Button variant="ghost" onClick={() => setImporting(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              <Loaded resource={user} what="your GitHub sign-in" skeleton="text">
                {(u) => (
                  <SignInPanel
                    user={u}
                    host={host}
                    now={now}
                    busy={signingOut}
                    settingsUrl={info.settingsUrl}
                    onSignIn={() => void startLogin()}
                    onSignOut={() => void signOut()}
                  />
                )}
              </Loaded>
              <DisconnectDialog
                open={confirmDisconnect}
                appName={info.name}
                signedIn={user.data?.signedIn === true}
                busy={disconnecting}
                onClose={() => setConfirmDisconnect(false)}
                onConfirm={() => void disconnect()}
              />
            </>
          );
        }}
      </Loaded>
      <LoginDialog
        open={loginOpen}
        view={login}
        now={now}
        host={host}
        onCopy={() => void copy()}
        onOpenGithub={openGithub}
        onRetry={() => void startLogin()}
        onClose={closeLogin}
      />
    </Section>
  );
}
