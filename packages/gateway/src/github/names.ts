/**
 * The vault names the GitHub connection keeps its secrets under. In a file
 * of their own, with no imports, so the spec parser can refuse them without
 * pulling in the store.
 */

export const APP_PRIVATE_KEY_SECRET = 'GITHUB_APP_PRIVATE_KEY';
export const APP_CLIENT_SECRET_SECRET = 'GITHUB_APP_CLIENT_SECRET';
/**
 * The signed-in GitHub user's tokens: one vault entry, JSON of the user token,
 * the refresh token and their expiry times. One entry on purpose: GitHub
 * invalidates the old refresh token when it hands out a new pair, so storing
 * the pieces one by one could lose the sign-in if the second write failed.
 */
export const USER_TOKENS_SECRET = 'GITHUB_USER_TOKENS';

/** Names a spec or a `POST /secrets` may not use: the connection's own. */
export const RESERVED_SECRETS: readonly string[] = [
  APP_PRIVATE_KEY_SECRET,
  APP_CLIENT_SECRET_SECRET,
  USER_TOKENS_SECRET,
];

export function isReservedSecret(name: string): boolean {
  return RESERVED_SECRETS.includes(name);
}

/**
 * Why a spec may not name a reserved secret, for the line it is on. The two
 * app names say where the key is; the sign-in says what it is.
 */
export function reservedInSpec(name: string, why: 'token' | 'key'): string {
  if (name === USER_TOKENS_SECRET) {
    return (
      `"${name}" is where OpenClerq keeps your GitHub sign-in; a spec cannot use it. ` +
      'To use GitHub from an automation, connect the GitHub App and leave "publish.token_secret" out.'
    );
  }
  return (
    `"${name}" is where the GitHub App connection keeps its private key; a spec cannot use it. ` +
    (why === 'token'
      ? 'To use the app, leave "publish.token_secret" out (or set "publish.auth: app").'
      : 'Use a secret of your own for the agent.')
  );
}

/** What `POST /secrets` and `DELETE /secrets/:name` say about a reserved name. */
export function reservedInVault(name: string, action: 'set' | 'delete'): string {
  if (name === USER_TOKENS_SECRET) {
    return `${name} is your GitHub sign-in. ${
      action === 'set' ? 'Sign in with POST /github/login.' : 'Sign out with DELETE /github/user.'
    }`;
  }
  return action === 'set'
    ? `${name} belongs to the GitHub App connection. Import the app's key again with POST /github/app/import.`
    : `${name} belongs to the GitHub App connection. Forget it with DELETE /github/app.`;
}
