/**
 * `githubAppCredentials`: the gateway's forge credential lookup.
 *
 * For a GitHub repository, with the user's GitHub App connected and installed
 * on it, an installation token for that repository and purpose. Otherwise the
 * vault secret the spec names, as before, so existing specs keep working.
 *
 * Precedence, from the spec's `publish.auth`:
 *
 *   auto (default)  the app when it is installed on the repository, else the
 *                   vault secret. When the app is installed but cannot be used
 *                   (GitHub unreachable, the key refused, a missing
 *                   permission), the run fails with the reason rather than
 *                   quietly pushing as the user instead of the app; only
 *                   `fetch`, which reads and cannot push, falls back to the
 *                   vault secret.
 *   app             only the app; not installed is an error before any work.
 *   token           only the vault secret; the app is not asked.
 *
 * With `dryRun` (the spec preview) nothing is made: it says which credential a
 * run would use.
 */

import {
  vaultCredentials,
  type CredentialRequest,
  type ForgeCredential,
  type ForgeCredentials,
} from '../automations/credentials.js';
import { logger } from '../logger.js';
import { AppUnavailable, type GithubApp } from './app.js';
import { installUrl } from './config.js';

const TOKEN_HINT = ' Set publish.auth: token to use the vault secret instead.';

export function githubAppCredentials(
  app: GithubApp,
  getSecret: (name: string) => string | undefined
): ForgeCredentials {
  const vault = vaultCredentials(getSecret);

  return async (request: CredentialRequest): Promise<ForgeCredential | undefined> => {
    const auth = request.auth ?? 'auto';
    if (request.forge !== 'github') {
      if (auth === 'app') {
        throw new Error(
          'publish.auth: app is for GitHub repositories. A GitLab project uses a token: set publish.auth: token (the default for GitLab).'
        );
      }
      return vault(request);
    }
    if (auth === 'token') return vault(request);

    const config = app.config();
    if (!config) {
      if (auth === 'app') {
        throw new Error(
          'publish.auth is "app", but no GitHub App is connected. Connect one (docs/GITHUB.md), or set publish.auth: token.'
        );
      }
      return vault(request);
    }

    // The app is connected: is it installed on this repository, and can it be used?
    const unusable = (e: AppUnavailable): ForgeCredential | undefined => {
      if (auth === 'auto' && request.purpose === 'fetch') {
        // Reading only: carry on with the vault secret, and say so.
        logger.warn('The GitHub App could not be used to fetch; using the vault secret', {
          repository: request.project,
          reason: e.message,
        });
        return undefined;
      }
      throw new Error(e.message + (auth === 'auto' ? TOKEN_HINT : ''));
    };

    let lookup;
    try {
      lookup = await app.installationFor(request.project);
    } catch (e) {
      if (!(e instanceof AppUnavailable)) throw e;
      return unusable(e) ?? vault(request);
    }
    if (!lookup.installed) {
      if (auth === 'app') {
        throw new Error(
          `publish.auth is "app", but the GitHub App ${config.slug} is not installed on ${request.project}. ` +
            `Install it on that repository (${installUrl(config)}), or set publish.auth: token.`
        );
      }
      return vault(request);
    }
    const { installation } = lookup;
    if (installation.suspended) {
      return (
        unusable(
          new AppUnavailable(
            `The GitHub App ${config.slug} is suspended on ${request.project}: unsuspend it in the installation's settings on GitHub.`
          )
        ) ?? vault(request)
      );
    }

    const source = `github-app:${config.slug}/installation/${installation.id}`;
    const actor = `${config.slug}[bot]`;
    if (request.dryRun) return { token: '', source, actor };

    try {
      const minted = await app.mint(request.project, installation, request.purpose, request.runId);
      return {
        token: minted.token,
        source,
        actor,
        expiresAt: minted.expiresAt,
        release: minted.release,
      };
    } catch (e) {
      if (!(e instanceof AppUnavailable)) throw e;
      return unusable(e) ?? vault(request);
    }
  };
}
