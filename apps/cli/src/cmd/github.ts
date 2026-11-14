/**
 * `clerq github connect | import | status | disconnect | login | logout | repos`.
 *
 * The GitHub App and the person's sign-in live in the gateway (docs/GITHUB.md);
 * these commands drive its routes. No key, secret or token is taken on the
 * command line or printed: a key comes from a file, and the gateway answers
 * none of them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GatewayError,
  gateway,
  type GithubAppInfo,
  type GithubAppStatus,
  type GithubLoginStatus,
  type GithubManifestOffer,
  type GithubUserStatus,
} from '@clerq/gateway-client';
import { flag, str, type Call } from '../args.js';
import { connect } from '../connect.js';
import { isLoopbackHost } from '../connection.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { dateTime, duration, table } from '../format.js';
import { confirm } from '../prompt.js';
import { targetOf } from './repo.js';
import { tildePath } from '../config.js';

const posix = process.platform !== 'win32';

/**
 * Only an https address (or http on this computer, which is how a test points at its own
 * fake) is ever printed as one to follow or handed to the browser.
 */
export const safeLink = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))
      ? url
      : null;
  } catch {
    return null;
  }
};

const html = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Wait `ms`, or until Ctrl-C. */
function pause(ctx: Context, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    ctx.signal.addEventListener('abort', done, { once: true });
  });
}

/** Ask until `look` has an answer, for at most `ms`. */
async function waitFor<T>(
  ctx: Context,
  ms: number,
  look: () => Promise<T | undefined>
): Promise<{ done: T } | { ended: 'timeout' | 'interrupted' }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await look();
    if (found !== undefined) return { done: found };
    if (ctx.signal.aborted) return { ended: 'interrupted' };
    if (Date.now() >= deadline) return { ended: 'timeout' };
    await pause(ctx, Math.min(ctx.githubPollMs, Math.max(1, deadline - Date.now())));
    if (ctx.signal.aborted) return { ended: 'interrupted' };
  }
}

const rowsOf = (ctx: Context, rows: Array<[string, string]>) => {
  const width = Math.max(0, ...rows.map(([k]) => k.length));
  for (const [k, v] of rows) ctx.out.say(`  ${ctx.out.bold(k.padEnd(width))}  ${v}`);
};

// ---- connect -----------------------------------------------------------------------------

/**
 * The page that posts the manifest to GitHub by itself. The manifest is not
 * secret (it names the app and what it asks for); the state is single use and
 * lasts ten minutes. In a folder only this account can read, deleted afterwards.
 */
export function formPage(offer: GithubManifestOffer): string {
  if (!safeLink(offer.url)) {
    throw new CliError(
      `The gateway gave ${offer.url} to post the app to, which is not an https address. Nothing was opened.`
    );
  }
  const action = new URL(offer.url);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create the GitHub App</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}</style>
</head><body>
<h1>Create the GitHub App</h1>
<p>Sending the app's description to GitHub, which asks you to confirm it. If nothing happens, press the button.</p>
<form id="f" method="post" action="${html(action.href)}">
<input type="hidden" name="manifest" value="${html(JSON.stringify(offer.manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>
`;
}

function appRows(ctx: Context, app: GithubAppInfo): void {
  const install = safeLink(app.installUrl);
  const settings = safeLink(app.settingsUrl);
  ctx.out.say('');
  if (install) {
    ctx.out.say('Install the app on the repositories it may use:');
    ctx.out.say(`  ${install}`);
  }
  if (settings) {
    ctx.out.say('');
    ctx.out.say(
      'To sign in as yourself (`clerq github login`), switch on "Enable Device Flow" under "Identifying and authorizing users" on its settings page:'
    );
    ctx.out.say(`  ${settings}`);
  }
}

/**
 * GitHub sends the browser back to the gateway's address with a one-time code that anyone
 * holding it can trade for the app's private key, so a gateway on another computer must be
 * reached over https; plain http is only for this computer.
 */
export function assertCallbackAddress(baseUrl: string): void {
  const u = new URL(baseUrl);
  if (u.protocol !== 'https:' && !isLoopbackHost(u.hostname)) {
    throw new CliError(
      `GitHub sends your browser back to the gateway's address, ${baseUrl}, with a one-time code, and that must not cross the network in the clear. ` +
        'Reach this gateway over https (a reverse proxy with TLS, see docs/SERVER.md): `clerq login https://your-gateway`, then run this again.'
    );
  }
}

export async function runConnect(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const resolved = await connect(ctx);
  const baseUrl = resolved.url;
  assertCallbackAddress(baseUrl);
  const before = await gateway.githubApp();
  if (before.connected && before.app) {
    out.data({ connected: true, alreadyConnected: true, app: before.app });
    out.error(
      `A GitHub App is connected already: ${before.app.name} (${before.app.slug}). \`clerq github status\` shows it; \`clerq github disconnect\` forgets it.`
    );
    return EXIT.failed;
  }

  const org = str(call, 'org');
  const name = str(call, 'name');
  const offer = await gateway.githubManifest({
    baseUrl,
    ...(org ? { owner: org } : {}),
    ...(name ? { name } : {}),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-github-'));
  const file = path.join(dir, 'create-github-app.html');
  try {
    fs.writeFileSync(file, formPage(offer), { mode: 0o600 });
    const opened = flag(call, 'no-browser') ? false : await ctx.openUrl(file);
    if (opened) {
      out.note(
        'Opened your browser. On GitHub, check the app\'s name and press "Create GitHub App".'
      );
    } else {
      out.note(
        `${flag(call, 'no-browser') ? 'Open' : 'Could not open a browser. Open'} this page in a browser on a computer that can reach the gateway at ${baseUrl}:`
      );
      out.note(`  ${file}`);
    }
    out.note(
      `GitHub sends the browser back to ${offer.redirectUrl}, so that address has to work in the browser you use.`
    );
    out.note(
      `Waiting for the app to be created (up to ${duration(ctx.githubWaitMs)}, Ctrl-C to stop)…`
    );

    const result = await waitFor<GithubAppStatus>(ctx, ctx.githubWaitMs, async () => {
      const status = await gateway.githubApp();
      return status.connected ? status : undefined;
    });
    if ('ended' in result) {
      out.error(
        result.ended === 'interrupted'
          ? 'Stopped. Nothing was connected here; if you already pressed the button on GitHub, `clerq github status` shows whether it arrived.'
          : `Nothing was connected within ${duration(ctx.githubWaitMs)}. Run \`clerq github connect\` again.`
      );
      return result.ended === 'interrupted' ? EXIT.interrupted : EXIT.failed;
    }
    const app = result.done.app as GithubAppInfo;
    out.data({ connected: true, app, installUrl: app.installUrl, settingsUrl: app.settingsUrl });
    out.say(`Connected the GitHub App ${out.bold(app.name)} (${app.slug}).`);
    for (const w of [...(app.warnings ?? []), ...(result.done.warnings ?? [])]) out.warn(w);
    appRows(ctx, app);
    return EXIT.ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- import --------------------------------------------------------------------------------

const MAX_FILE = 20_000;

/** A secret kept in a file: a plain file only this account can read, not too long. */
function readSecretFile(file: string, what: string, ctx: Context): string {
  const shown = tildePath(path.resolve(ctx.cwd, file), ctx.home);
  const resolved = path.resolve(ctx.cwd, file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new CliError(`Cannot read ${what} file ${shown}: no such file.`);
  }
  if (!stat.isFile()) throw new CliError(`${shown} is not a file.`);
  if (stat.size > MAX_FILE) throw new CliError(`${shown} is far longer than ${what}.`);
  if (posix) {
    const mode = stat.mode & 0o777;
    if ((mode & 0o007) !== 0) {
      throw new CliError(
        `${shown} can be read by every user of this computer (mode ${mode.toString(8)}). Keep ${what} private: \`chmod 600 ${shown}\`, then run this again.`
      );
    }
    if ((mode & 0o070) !== 0) {
      ctx.out.warn(
        `${shown} can be read by other users in its group (mode ${mode.toString(8)}). Consider: chmod 600 ${shown}`
      );
    }
  }
  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch {
    throw new CliError(`Cannot read ${what} file ${shown}.`);
  }
  if (!text.trim()) throw new CliError(`${shown} is empty.`);
  ctx.out.hide(text.trim());
  return text;
}

export async function runImport(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const appId = str(call, 'app-id');
  const clientId = str(call, 'client-id');
  const keyFile = str(call, 'private-key-file');
  const secretFile = str(call, 'client-secret-file');
  const missing = [
    ['--app-id', appId],
    ['--client-id', clientId],
    ['--private-key-file', keyFile],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new UsageError(
      `"clerq github import" needs ${missing.join(', ')}. The key is read from a file, never from the command line.`
    );
  }
  if (!/^\d{1,12}$/.test(appId as string)) {
    throw new UsageError("--app-id is the number shown at the top of the app's settings page.");
  }
  // Read before anything is sent: a key that cannot be used asks nobody.
  const privateKey = readSecretFile(keyFile as string, 'the private key', ctx);
  const clientSecret = secretFile
    ? readSecretFile(secretFile, 'the client secret', ctx).trim()
    : undefined;
  await connect(ctx);
  const done = await gateway.importGithubApp({
    appId: Number(appId),
    clientId: clientId as string,
    privateKey,
    ...(clientSecret ? { clientSecret } : {}),
  });
  out.data(done);
  out.say(
    done.replacedKey
      ? `Replaced the key of the GitHub App ${out.bold(done.app.name)} (${done.app.slug}). Delete the old key on its settings page when nothing needs it.`
      : `Connected the GitHub App ${out.bold(done.app.name)} (${done.app.slug}).`
  );
  for (const w of done.app.warnings ?? []) out.warn(w);
  if (!clientSecret) {
    out.say('');
    out.say(
      'No client secret was given. You can sign in (`clerq github login`), but the sign-in ends after about 8 hours and cannot be renewed, and `logout` cannot revoke it on GitHub. Import again with --client-secret-file to add it.'
    );
  }
  appRows(ctx, done.app);
  return EXIT.ok;
}

// ---- status ----------------------------------------------------------------------------------

const selectionWords = (s: string | null) =>
  s === 'all'
    ? 'all repositories'
    : s === 'selected'
      ? 'selected repositories'
      : 'repositories unknown';

export async function runStatus(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const app = await gateway.githubApp({ refresh: flag(call, 'refresh') });
  const user: GithubUserStatus | null = app.connected ? await gateway.githubUser() : null;
  out.data({ ...app, user });
  if (!app.connected || !app.app) {
    out.say(
      'No GitHub App is connected. `clerq github connect` creates one; `clerq github import` uses one you made.'
    );
    return EXIT.ok;
  }
  const a = app.app;
  const rows: Array<[string, string]> = [
    [
      'GitHub App',
      `${a.name} (${a.slug})${a.owner ? `, owned by ${a.owner.login}` : ''}; connected by ${a.source} on ${dateTime(a.createdAt)}`,
    ],
    [
      'Stored',
      `private key ${app.secrets?.privateKey ? 'yes' : 'MISSING'}; client secret ${app.secrets?.clientSecret ? 'yes' : 'no (a sign-in cannot be renewed or revoked from here)'}`,
    ],
  ];
  if (app.installations === null || app.installations === undefined) {
    rows.push(['Installed', `could not ask GitHub: ${app.installationsError ?? 'no answer'}`]);
  } else if (app.installations.length === 0) {
    rows.push(['Installed', `nowhere yet. Install it: ${safeLink(a.installUrl) ?? '(no link)'}`]);
  } else {
    app.installations.forEach((i, n) =>
      rows.push([
        n === 0 ? 'Installed' : '',
        `${i.account ?? `installation ${i.id}`} (${selectionWords(i.repositorySelection)})${i.suspended ? ', SUSPENDED' : ''}`,
      ])
    );
  }
  if (user?.signedIn) {
    rows.push([
      'Signed in',
      `${user.user ? `@${user.user.login}${user.user.name ? ` (${user.user.name})` : ''}` : 'yes'}${
        user.expiresAt
          ? `; the token ends ${dateTime(user.expiresAt)}${user.refreshable ? ' and is renewed' : ', and cannot be renewed'}`
          : ''
      }${user.message ? `. ${user.message}` : ''}`,
    ]);
  } else {
    rows.push([
      'Signed in',
      `no${user?.message ? `. ${user.message}` : '. `clerq github login` signs you in.'}`,
    ]);
  }
  rowsOf(ctx, rows);
  for (const w of [...(a.warnings ?? []), ...(app.warnings ?? [])]) out.warn(w);
  if (app.installationsError) {
    out.warn(
      /refused|did not accept|key/i.test(app.installationsError)
        ? `${app.installationsError} If the key was deleted on GitHub, generate a new private key on the app's settings page and import it: \`clerq github import\`.`
        : app.installationsError
    );
  }
  return EXIT.ok;
}

// ---- disconnect --------------------------------------------------------------------------------

export async function runDisconnect(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const status = await gateway.githubApp();
  if (!status.connected || !status.app) {
    out.data({ disconnected: false, connected: false });
    out.say('No GitHub App is connected.');
    return EXIT.ok;
  }
  if (!flag(call, 'yes')) {
    const yes = await confirm(
      ctx.io,
      `Forget the GitHub App ${status.app.name} (${status.app.slug}), delete its key from the vault and sign out? The app stays on GitHub.`
    );
    if (!yes) {
      out.error('Nothing was changed.');
      return EXIT.failed;
    }
  }
  const done = await gateway.disconnectGithubApp();
  out.data(done);
  // The message already says where the app's settings page is.
  out.say(done.message);
  return EXIT.ok;
}

// ---- login, logout ------------------------------------------------------------------------------

const DISABLED_HOW =
  'Open the app\'s settings page, find "Identifying and authorizing users", tick "Enable Device Flow", save, and run this again.';

function printDisabled(ctx: Context, message: string, settingsUrl?: string): void {
  ctx.out.error(message);
  const link = safeLink(settingsUrl);
  if (link) {
    ctx.out.say(DISABLED_HOW);
    ctx.out.say(`  ${link}`);
  }
}

export async function runLogin(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  let start;
  try {
    start = await gateway.startGithubLogin();
  } catch (e) {
    if (e instanceof GatewayError && e.body?.error === 'device_flow_disabled') {
      out.data({ status: 'disabled', message: e.body.message, settingsUrl: e.body.settingsUrl });
      printDisabled(
        ctx,
        String(e.body.message),
        typeof e.body.settingsUrl === 'string' ? e.body.settingsUrl : undefined
      );
      return EXIT.failed;
    }
    throw e;
  }
  const link = safeLink(start.verificationUri);
  if (!link) {
    await gateway.cancelGithubLogin(start.flowId).catch(() => undefined);
    throw new CliError(
      `The gateway gave ${start.verificationUri} to sign in at, which is not an https address. Nothing was opened.`
    );
  }
  out.note(`Open ${link} and enter the code:`);
  out.note('');
  out.note(`    ${out.bold(start.userCode)}`);
  out.note('');
  if (!flag(call, 'no-browser')) {
    if (await ctx.openUrl(link)) out.note('Opened your browser.');
    else out.note('Could not open a browser: open that address yourself, on any computer.');
  }
  out.note(
    `Waiting for you to approve it (the code works for ${duration(Date.parse(start.expiresAt) - Date.now())}, Ctrl-C to stop)…`
  );

  let last: GithubLoginStatus = { status: 'pending' };
  const result = await waitFor<GithubLoginStatus>(ctx, ctx.githubWaitMs, async () => {
    last = await gateway.githubLogin(start.flowId);
    return last.status === 'pending' ? undefined : last;
  });
  if ('ended' in result) {
    await gateway.cancelGithubLogin(start.flowId).catch(() => undefined);
    out.error(
      result.ended === 'interrupted'
        ? 'Stopped. Nothing was signed in.'
        : 'Gave up waiting. Run `clerq github login` again.'
    );
    return result.ended === 'interrupted' ? EXIT.interrupted : EXIT.failed;
  }
  const done = result.done;
  out.data(done);
  switch (done.status) {
    case 'approved':
      out.say(
        done.user
          ? `Signed in to GitHub as @${done.user.login}${done.user.name ? ` (${done.user.name})` : ''}.`
          : 'Signed in to GitHub.'
      );
      if (done.message) out.warn(done.message);
      return EXIT.ok;
    case 'denied':
      out.error('The sign-in was refused on GitHub.');
      return EXIT.failed;
    case 'expired':
      out.error('The code ran out before it was approved. Run `clerq github login` again.');
      return EXIT.failed;
    case 'disabled':
      printDisabled(
        ctx,
        done.message ?? 'Device flow is not switched on for this app.',
        done.settingsUrl
      );
      return EXIT.failed;
    default:
      out.error(done.message ?? 'The sign-in failed.');
      return EXIT.failed;
  }
}

export async function runLogout(ctx: Context, _call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  try {
    const done = await gateway.githubSignOut();
    out.data(done);
    out.say(done.message);
    if (!done.revoked)
      out.warn(
        'GitHub still lists the app as authorized for your account until you revoke it there.'
      );
    return EXIT.ok;
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404 && e.body?.error === 'not_signed_in') {
      out.data({ signedOut: false, signedIn: false });
      out.say('Nobody is signed in to GitHub.');
      return EXIT.ok;
    }
    throw e;
  }
}

// ---- repos --------------------------------------------------------------------------------------

export async function runRepos(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const add = str(call, 'add');
  if (add) {
    const name = add.replace(/^github:/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(name)) {
      throw new UsageError('--add takes a repository as owner/name, such as acme/app.');
    }
    const { target } = targetOf(`github:${name}`, ctx.cwd, ctx.home, false);
    const added = await gateway.addRepo(target);
    out.data({ ok: true, ...added });
    out.say(
      added.created
        ? `Added ${added.name} (${added.kind}, id ${added.id}).`
        : `${added.name} (${added.kind}, id ${added.id}) was already listed; nothing changed.`
    );
    return EXIT.ok;
  }
  const list = await gateway.githubRepositories();
  out.data(list);
  if (list.repositories.length === 0) {
    out.say(
      'The app is not installed on any repository you can reach. Install it on GitHub (`clerq github status` has the link), then try again.'
    );
  } else {
    for (const line of table(
      ['REPOSITORY', 'ACCOUNT', 'VISIBILITY', 'ADDED'],
      list.repositories.map((r) => [
        r.fullName,
        r.account ?? '-',
        r.private ? 'private' : 'public',
        r.added ? 'yes' : 'no',
      ])
    ))
      out.say(line);
    out.say('');
    out.say('Add one with `clerq github repos --add owner/name`.');
  }
  if (list.truncated && list.message) out.warn(list.message);
  for (const w of list.warnings ?? []) out.warn(w);
  return EXIT.ok;
}
