/**
 * The vault names the GitHub App connection keeps its secrets under. In a file
 * of their own, with no imports, so the spec parser can refuse them without
 * pulling in the store.
 */

export const APP_PRIVATE_KEY_SECRET = 'GITHUB_APP_PRIVATE_KEY';
export const APP_CLIENT_SECRET_SECRET = 'GITHUB_APP_CLIENT_SECRET';

/** Names a spec or a `POST /secrets` may not use: the app's own. */
export const RESERVED_SECRETS: readonly string[] = [
  APP_PRIVATE_KEY_SECRET,
  APP_CLIENT_SECRET_SECRET,
];

export function isReservedSecret(name: string): boolean {
  return RESERVED_SECRETS.includes(name);
}
