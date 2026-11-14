/**
 * `/github/app`: connect, look at and forget the user's GitHub App.
 *
 *   POST   /github/app/manifest   a manifest and a state to create the app on GitHub
 *   GET    /github/app/callback   where GitHub sends the browser back (no token: a
 *                                 browser lands on it; it needs the state)
 *   POST   /github/app/import     use an app that already exists (its id, client id, key)
 *   GET    /github/app            the connection and where the app is installed
 *   DELETE /github/app            forget the connection and the stored key (and sign out)
 *
 * and the person's own sign-in (the app's device flow, see `signin.ts`):
 *
 *   POST   /github/login               start: answers the code to type on GitHub
 *   GET    /github/login/:flowId       pending, approved, denied, expired, disabled, error
 *   DELETE /github/login/:flowId       cancel
 *   GET    /github/user                who is signed in
 *   DELETE /github/user                sign out, and revoke on GitHub when possible
 *   GET    /github/user/repositories   what they reach through the app's installations
 *
 * Every route but the callback is for the gateway's own token: a scoped token
 * (a module's, a phone's) never reaches `/github` (see `OPERATOR_ONLY`). The
 * private key and client secret are in the vault and in no answer, page or log.
 */

import type { Express, Request, Response } from 'express';
import { parseRemote } from '@clerq/workspaces';
import { logger } from '../logger.js';
import { getStore } from '../store.js';
import { GithubApiError } from './api.js';
import { GithubApp, type AppInfo, type Installation } from './app.js';
import {
  APP_CLIENT_SECRET_SECRET,
  APP_PRIVATE_KEY_SECRET,
  REJECTED_URL,
  githubUrl,
  githubWebBase,
  installUrl,
  readAppConfig,
  settingsUrl,
  type GithubAppConfig,
} from './config.js';
import {
  ConnectConflict,
  ConnectError,
  forgetConnection,
  realVault,
  saveConnection,
  type Vault,
} from './connect.js';
import { InvalidKeyError, parsePrivateKey } from './jwt.js';
import { MANIFEST_PERMISSIONS, ManifestFlows, ManifestRequestError, hostOf } from './manifest.js';
import { GithubSignIn, SignInError } from './signin.js';

export interface GithubRouteDeps {
  app: GithubApp;
  /** The person's sign-in. Default: one on the vault. */
  signin?: GithubSignIn;
  flows?: ManifestFlows;
  vault?: Vault;
  now?: () => number;
}

const STATUS_WAIT_MS = 8_000;

/** HTML text, escaped. Everything from GitHub or the request goes through this. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res: Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The address carries a one-time code: do not pass it on.
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="color-scheme" content="light dark"><title>${esc(title)}</title>` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}` +
        `a{word-break:break-all}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`
    );
}

/** The app's config as a client sees it: nothing secret, with its two GitHub pages. */
function publicConfig(config: GithubAppConfig) {
  return {
    ...config,
    // Whatever is in the settings row, a link is shown only if it is on GitHub's website.
    htmlUrl:
      githubUrl(config.htmlUrl) ?? `${githubWebBase()}/apps/${encodeURIComponent(config.slug)}`,
    installUrl: installUrl(config),
    settingsUrl: settingsUrl(config),
  };
}

function publicInstallation(i: Installation) {
  return {
    id: i.id,
    account: i.account,
    accountType: i.accountType,
    repositorySelection: i.repositorySelection,
    suspended: i.suspended,
    permissions: i.permissions,
    htmlUrl: i.htmlUrl,
  };
}

/** Normalise a pasted PEM: line endings, and `\n` typed as two characters, as in an .env file. */
function cleanPem(text: string): string {
  let pem = text.trim().replace(/\r\n?/g, '\n');
  if (!pem.includes('\n') && pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  return pem;
}

/** A repository's address as `repos.url` keeps it, for comparing: no case, no `.git`. */
function urlKey(url: string): string {
  return url.toLowerCase().replace(/\.git$/, '');
}

function withinRequested(permissions: Record<string, string>): string | null {
  const asked: Record<string, string> = MANIFEST_PERMISSIONS;
  for (const [name, level] of Object.entries(permissions)) {
    const allowed = asked[name];
    const rank = (l: string | undefined) =>
      l === 'write' || l === 'admin' ? 2 : l === 'read' ? 1 : 0;
    if (rank(level) > rank(allowed)) return `${name}: ${level}`;
  }
  return null;
}

export function mountGithubRoutes(app: Express, deps: GithubRouteDeps): void {
  const now = deps.now ?? Date.now;
  const github = deps.app;
  const vault = deps.vault ?? realVault;
  const flows = deps.flows ?? new ManifestFlows(now, githubWebBase);
  const signin = deps.signin ?? new GithubSignIn({ vault, now });

  const status = async (refresh: boolean) => {
    const config = readAppConfig();
    if (!config) return { connected: false as const };
    if (refresh) github.invalidate();
    let installations: ReturnType<typeof publicInstallation>[] | null = null;
    let installationsError: string | undefined;
    const warnings: string[] = [];
    try {
      const list = await Promise.race([
        github.installations({ refresh }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('GitHub did not answer in time.')),
            STATUS_WAIT_MS
          ).unref()
        ),
      ]);
      installations = list.map(publicInstallation);
      for (const i of list) {
        if (i.htmlUrlRejected) warnings.push(REJECTED_URL(`installation ${i.id}`));
      }
    } catch (e) {
      installationsError = e instanceof Error ? e.message : String(e);
    }
    return {
      connected: true as const,
      app: publicConfig(config),
      // Which secrets are stored, never what they are.
      secrets: {
        privateKey: Boolean(vault.get(APP_PRIVATE_KEY_SECRET)),
        clientSecret: Boolean(vault.get(APP_CLIENT_SECRET_SECRET)),
      },
      installations,
      ...(installationsError ? { installationsError } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };

  // A manifest for the browser to post to GitHub, and the state that ties the answer to it.
  app.post('/github/app/manifest', (req: Request, res: Response) => {
    try {
      if (readAppConfig()) {
        return res.status(409).json({
          error: 'app_already_connected',
          message:
            'A GitHub App is connected already. Disconnect it first (DELETE /github/app), or import a new key for it to replace the old one.',
        });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const offer = flows.start({
        owner: body.owner as string | undefined,
        name: body.name as string | undefined,
        baseUrl: body.baseUrl as string,
      });
      res.json({
        url: offer.url,
        manifest: offer.manifest,
        state: offer.state,
        expiresAt: offer.expiresAt,
        redirectUrl: offer.redirectUrl,
      });
    } catch (e) {
      if (e instanceof ManifestRequestError) {
        return res.status(400).json({ error: e.code, message: e.message });
      }
      logger.error('github manifest error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'github_manifest_failed' });
    }
  });

  // GitHub sends the browser here. No token: the state is what is checked.
  app.get('/github/app/callback', async (req: Request, res: Response) => {
    const refuse = (status: number, title: string, text: string) =>
      page(res, status, title, `<p>${text}</p><p>Nothing was connected.</p>`);

    const taken = flows.take(req.query.state);
    if ('error' in taken) {
      return refuse(
        400,
        'This link is not valid',
        'It has expired or was already used. Start again from OpenClerq.'
      );
    }
    const flow = taken.flow;
    if (hostOf(req.headers.host) !== flow.host) {
      return refuse(
        400,
        'Wrong address',
        'This page was opened at a different address than the one the app was created for. Start again from OpenClerq, using the address you reach it at.'
      );
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!/^[A-Za-z0-9_.-]{6,128}$/.test(code)) {
      return refuse(
        400,
        'No code from GitHub',
        'GitHub did not send the code that completes the app.'
      );
    }
    if (readAppConfig()) {
      return refuse(409, 'An app is connected already', 'Disconnect the connected app first.');
    }
    // Before the code is spent: it works once, and the key it returns must have somewhere to go.
    if (!vault.available()) {
      return refuse(
        503,
        'The vault is not available',
        'The key that GitHub hands over could not be stored on this computer.'
      );
    }

    let converted;
    try {
      converted = await github.convertManifest(code);
    } catch (e) {
      const why =
        e instanceof GithubApiError
          ? e.status === 0
            ? e.message
            : `GitHub answered ${e.status}: ${e.message}`
          : 'The answer could not be read.';
      return refuse(502, 'GitHub did not accept the code', esc(why));
    }

    const web = githubWebBase();
    const where = settingsUrl({ slug: converted.slug, owner: converted.owner });
    // This app exists on GitHub now and OpenClerq is not keeping it: say where to delete it.
    const mismatch = (title: string, text: string, status = 400) =>
      page(
        res,
        status,
        title,
        `<p>${esc(text)}</p><p>Nothing was connected, and the key GitHub handed over was discarded. ` +
          `Delete the app on GitHub (<a href="${esc(where)}">${esc(where)}</a>) and start again.</p>`
      );
    const conflict = (text: string) => mismatch('Another app was connected first', text, 409);
    if (flow.org && converted.owner?.login.toLowerCase() !== flow.org.toLowerCase()) {
      return mismatch(
        'The app is under another organisation',
        `The app was asked for under ${flow.org}.`
      );
    }
    const wider = withinRequested(converted.permissions);
    if (wider) {
      return mismatch(
        'The app has more access than asked',
        `GitHub gave the app a permission that was not in the manifest (${wider}).`
      );
    }
    try {
      parsePrivateKey(converted.privateKey);
    } catch (e) {
      return mismatch(
        'The key could not be read',
        e instanceof InvalidKeyError ? e.message : 'GitHub sent a key that is not usable.'
      );
    }

    const config: GithubAppConfig = {
      appId: converted.appId,
      slug: converted.slug,
      name: converted.name,
      clientId: converted.clientId as string,
      owner: converted.owner,
      htmlUrl: converted.htmlUrl ?? `${web}/apps/${converted.slug}`,
      source: 'manifest',
      createdAt: new Date(now()).toISOString(),
      ...(converted.htmlUrlRejected ? { warnings: [REJECTED_URL('the app')] } : {}),
    };
    if (config.warnings)
      logger.warn('GitHub gave an address that is not on its website', { app: config.slug });
    try {
      saveConnection(vault, {
        config,
        privateKey: converted.privateKey,
        clientSecret: converted.clientSecret,
        // None was connected when this callback began; if one is now, another callback won.
        expected: null,
        actor: 'github-manifest',
        action: 'github.app.connected',
      });
    } catch (e) {
      if (e instanceof ConnectConflict) {
        return conflict(
          e.connected
            ? `Another app, ${e.connected.slug}, was connected while this one was being created, so it stays the connected one.`
            : 'The connection changed while this app was being created.'
        );
      }
      return mismatch(
        'The key could not be stored',
        e instanceof ConnectError ? e.message : 'The connection could not be stored.'
      );
    }
    github.invalidate();
    flows.clear();
    const link = installUrl(config);
    page(
      res,
      200,
      'Connected',
      `<p>Connected. Now install the app on the repositories it may use: ` +
        `<a href="${esc(link)}">${esc(link)}</a></p>` +
        `<p>The app is <strong>${esc(config.name)}</strong>. Only the repositories you pick there will be reachable, ` +
        `and you can change them later on GitHub.</p>` +
        `<p>To sign in as yourself from OpenClerq (to see your repositories there), switch on ` +
        `<strong>Enable Device Flow</strong> in the app's settings: <a href="${esc(settingsUrl(config))}">${esc(settingsUrl(config))}</a>. ` +
        `You can close this page and go back to OpenClerq.</p>`
    );
  });

  // An app that exists already: its id, client id and private key.
  app.post('/github/app/import', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bad = (message: string) => res.status(400).json({ error: 'invalid_request', message });

    const appId =
      typeof body.appId === 'number'
        ? body.appId
        : typeof body.appId === 'string' && /^\d{1,12}$/.test(body.appId.trim())
          ? Number(body.appId.trim())
          : Number.NaN;
    if (!Number.isSafeInteger(appId) || appId <= 0)
      return bad('"appId" must be the app\'s number.');
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (!/^[A-Za-z0-9._-]{4,100}$/.test(clientId)) {
      return bad('"clientId" is required: the app\'s client ID, as shown on its settings page.');
    }
    if (
      typeof body.privateKey !== 'string' ||
      !body.privateKey.trim() ||
      body.privateKey.length > 20_000
    ) {
      return bad('"privateKey" is required: the contents of the .pem file GitHub gave you.');
    }
    let clientSecret: string | null = null;
    if (body.clientSecret !== undefined && body.clientSecret !== null && body.clientSecret !== '') {
      if (typeof body.clientSecret !== 'string' || body.clientSecret.length > 500) {
        return bad('"clientSecret" must be text.');
      }
      clientSecret = body.clientSecret.trim();
    }

    const existing = readAppConfig();
    if (existing && existing.appId !== appId) {
      return res.status(409).json({
        error: 'app_already_connected',
        message: `The GitHub App ${existing.slug} is connected. Disconnect it first (DELETE /github/app) to connect another; to replace its key, import the same app's id with the new key.`,
      });
    }
    const privateKey = cleanPem(body.privateKey);
    try {
      parsePrivateKey(privateKey);
    } catch (e) {
      return res.status(422).json({
        error: 'invalid_private_key',
        message: e instanceof InvalidKeyError ? e.message : 'The private key cannot be used.',
      });
    }
    if (!vault.available()) {
      return res.status(503).json({
        error: 'vault_unavailable',
        message: 'The vault has no master key on this computer, so the key cannot be stored.',
      });
    }

    let info: AppInfo;
    try {
      info = await github.describeApp(appId, privateKey);
    } catch (e) {
      if (e instanceof GithubApiError) {
        if (e.status === 0 || e.status >= 500) {
          return res.status(502).json({ error: 'github_unreachable', message: e.message });
        }
        // A 401 because of this computer's clock says nothing about the key.
        const clock = github.clockNote(e);
        if (clock) return res.status(422).json({ error: 'clock_skew', message: clock });
        // GitHub's own words: a key that does not match the app, an app that does not exist.
        return res.status(422).json({ error: 'github_rejected', message: e.message });
      }
      if (e instanceof InvalidKeyError) {
        return res.status(422).json({ error: 'invalid_private_key', message: e.message });
      }
      logger.error('github import error', { err: e instanceof Error ? e.message : String(e) });
      return res.status(500).json({ error: 'github_import_failed' });
    }
    if (info.clientId && info.clientId !== clientId) {
      return res.status(422).json({
        error: 'client_id_mismatch',
        message: `GitHub says app ${appId} has a different client ID than the one given. Copy it again from the app's settings page.`,
      });
    }

    const replacing = existing !== null;
    const config: GithubAppConfig = {
      appId: info.appId,
      slug: info.slug,
      name: info.name,
      clientId,
      owner: info.owner,
      htmlUrl: info.htmlUrl ?? `${githubWebBase()}/apps/${info.slug}`,
      ...(info.htmlUrlRejected ? { warnings: [REJECTED_URL('the app')] } : {}),
      source: replacing ? existing.source : 'import',
      createdAt: replacing ? existing.createdAt : new Date(now()).toISOString(),
      ...(replacing ? { keyUpdatedAt: new Date(now()).toISOString() } : {}),
    };
    try {
      saveConnection(vault, {
        config,
        privateKey,
        clientSecret,
        // The app that was connected when this began; GitHub was asked in between.
        expected: existing?.appId ?? null,
        actor: 'operator',
        action: replacing ? 'github.app.key_replaced' : 'github.app.imported',
      });
    } catch (e) {
      if (e instanceof ConnectConflict) {
        return res.status(409).json({
          error: 'app_changed',
          message:
            'The connected GitHub App changed while the key was being checked. Nothing was stored; look at GET /github/app and try again.',
        });
      }
      return res.status(500).json({
        error: 'github_import_failed',
        message: e instanceof ConnectError ? e.message : 'The connection could not be stored.',
      });
    }
    github.invalidate();
    flows.clear();
    res.status(replacing ? 200 : 201).json({
      connected: true,
      app: publicConfig(config),
      replacedKey: replacing,
    });
  });

  app.get('/github/app', async (req: Request, res: Response) => {
    try {
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      res.json(await status(refresh));
    } catch (e) {
      logger.error('github status error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'github_status_failed' });
    }
  });

  app.delete('/github/app', async (_req: Request, res: Response) => {
    try {
      if (!readAppConfig()) {
        return res
          .status(404)
          .json({ error: 'app_not_connected', message: 'No GitHub App is connected.' });
      }
      // A sign-in still waiting for the person would store tokens for an app that is going.
      signin.cancelAll();
      // The person's sign-in belongs to this app, and revoking it needs the app's client secret:
      // before the secret is deleted.
      const signedOut = await signin.signOut().catch(() => null);
      const config = forgetConnection(vault, 'operator');
      if (!config) {
        return res
          .status(404)
          .json({ error: 'app_not_connected', message: 'No GitHub App is connected.' });
      }
      github.invalidate();
      const settings = settingsUrl(config);
      res.json({
        disconnected: true,
        slug: config.slug,
        appDeletedOnGitHub: false,
        settingsUrl: settings,
        ...(signedOut ? { user: signedOut } : {}),
        message:
          `OpenClerq forgot the app ${config.slug} and deleted its key from the vault. ` +
          `The app itself still exists on GitHub, and so do its installations: uninstall it or delete the app at ${settings}. ` +
          'Installation tokens a run is using stay valid until that run ends (at most an hour).' +
          (signedOut ? ` ${signedOut.message}` : ''),
      });
    } catch (e) {
      const message =
        e instanceof ConnectError ? e.message : 'The connection could not be removed.';
      logger.error('github disconnect error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'github_disconnect_failed', message });
    }
  });

  // ---- the person's sign-in -------------------------------------------------------------

  const refuse = (res: Response, e: unknown, what: string) => {
    if (e instanceof SignInError) {
      return res.status(e.status).json({ error: e.code, message: e.message, ...e.extra });
    }
    logger.error(`github ${what} error`, { err: e instanceof Error ? e.name : 'unknown' });
    res.status(500).json({ error: `github_${what}_failed` });
  };

  // Start a device flow: the answer is what the person types on GitHub. Polling is in the background.
  app.post('/github/login', async (_req: Request, res: Response) => {
    try {
      res.json(await signin.start());
    } catch (e) {
      refuse(res, e, 'login');
    }
  });

  app.get('/github/login/:flowId', (req: Request, res: Response) => {
    const view = signin.status(String(req.params.flowId));
    if (!view) {
      return res.status(404).json({
        error: 'flow_not_found',
        message:
          'There is no such sign-in. It may have finished long ago, or been cancelled. Start again.',
      });
    }
    res.json(view);
  });

  app.delete('/github/login/:flowId', (req: Request, res: Response) => {
    if (!signin.cancel(String(req.params.flowId))) {
      return res
        .status(404)
        .json({ error: 'flow_not_found', message: 'There is no such sign-in.' });
    }
    res.json({ cancelled: true });
  });

  app.get('/github/user', async (_req: Request, res: Response) => {
    try {
      res.json(await signin.user());
    } catch (e) {
      refuse(res, e, 'user');
    }
  });

  app.delete('/github/user', async (_req: Request, res: Response) => {
    try {
      const out = await signin.signOut();
      if (!out) {
        return res
          .status(404)
          .json({ error: 'not_signed_in', message: 'Nobody is signed in to GitHub.' });
      }
      res.json(out);
    } catch (e) {
      refuse(res, e, 'signout');
    }
  });

  // What the signed-in person reaches through the app: each repository says whether OpenClerq lists it already.
  app.get('/github/user/repositories', async (_req: Request, res: Response) => {
    try {
      const list = await signin.repositories();
      const known = new Map<string, string>();
      for (const row of getStore()
        .prepare("SELECT id, url FROM repos WHERE kind = 'github' AND url IS NOT NULL")
        .all()) {
        known.set(urlKey(String(row.url)), String(row.id));
      }
      res.json({
        repositories: list.repositories.map((r) => {
          const url = parseRemote(`github:${r.fullName}`)?.url;
          const repoId = url ? known.get(urlKey(url)) : undefined;
          return { ...r, added: repoId !== undefined, ...(repoId ? { repoId } : {}) };
        }),
        truncated: list.truncated,
        limit: list.limit,
        ...(list.truncated
          ? {
              message: `Only the first ${list.limit} repositories are listed. To add another, name it: clerq repo add github:owner/name.`,
            }
          : {}),
        ...(list.warnings.length > 0 ? { warnings: list.warnings } : {}),
      });
    } catch (e) {
      refuse(res, e, 'repositories');
    }
  });
}
