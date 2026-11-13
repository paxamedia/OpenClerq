/**
 * The credential a run uses with its forge: to clone and fetch the repository,
 * to push its branch, and to open the pull request.
 *
 * Today it is a token in the vault, named by `publish.token_secret` (a
 * personal access token). The lookup is a function of the forge, the project
 * and the purpose, so that a GitHub App can hand out a short-lived
 * installation token scoped to one repository instead, without the runner
 * changing: pass `forgeCredentials` in the runner's dependencies.
 *
 * The token reaches git only as an HTTP header in the environment of the git
 * command that needs it (`forgeAuthEnv`), and the forge's API only in the
 * request that opens the pull request. The agent and the gates never see it,
 * and it is taken out of everything the run stores.
 */

import type { Forge } from '@clerq/workspaces';

export type CredentialPurpose = 'fetch' | 'push' | 'pull_request';

export interface CredentialRequest {
  forge: Forge;
  /** "owner/name" or "group/name". */
  project: string;
  purpose: CredentialPurpose;
  /** The vault secret the spec names (`publish.token_secret`). */
  secretName: string;
  automationId: string;
  runId: string;
}

export interface ForgeCredential {
  token: string;
  /** Where it came from, for the run's record: `vault:GITHUB_TOKEN`. Never the token. */
  source: string;
}

/** Finds the credential for one forge operation, or undefined when there is none. */
export type ForgeCredentials = (
  request: CredentialRequest
) => Promise<ForgeCredential | undefined> | ForgeCredential | undefined;

/** The vault lookup: the secret the spec names, whatever the purpose. */
export function vaultCredentials(
  getSecret: (name: string) => string | undefined
): ForgeCredentials {
  return (request) => {
    const token = getSecret(request.secretName);
    return token ? { token, source: `vault:${request.secretName}` } : undefined;
  };
}
