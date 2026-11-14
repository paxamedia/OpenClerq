# API

The gateway's HTTP API is what the desktop app, a paired phone, the CLI and plugins all talk to.
This page is the contract between them: what is versioned, how a client says which version it
speaks, and what stays the same within a version. For the list of routes see
[ARCHITECTURE.md](ARCHITECTURE.md#4-gateway); the command-line client is described in
[CLI.md](CLI.md).

## The version

The protocol has one version number, an integer. It is `1`.

It is not the release number. OpenClerq 1.0, 1.4 and 1.9 all speak API 1; the number changes
only when the protocol breaks. It is defined once, in
[`packages/gateway-client/src/protocol.ts`](../packages/gateway-client/src/protocol.ts), and
exported from `@clerq/gateway-client` as `API_VERSION` (the gateway imports it from
`@clerq/gateway-client/protocol`), so the CLI and plugins use the same constant.

## Paths and the header

Every route is served under `/v1`: `GET /v1/runs`, `POST /v1/sessions/:id/send`,
`GET /v1/events/stream`. `@clerq/gateway-client` calls only these.

The paths without the prefix (`GET /runs`) are aliases of the same routes. They keep working
through all of 1.x, because the desktop app, paired phones and module UIs call them today. One
router serves both; `/v1/x` is `/x` with the version noted, so the two never differ.

Some addresses stay as they are, because something other than a client holds them: a webhook URL
(`POST /webhook/:id`), and a module's own files and routes under `/api/modules/<id>/`. A module's
routes are that module's API, not this one.

**`Clerq-Api-Version`** says which version a request speaks and which one answered:

- Every response carries `Clerq-Api-Version: 1`, errors and the event stream included.
- A client sends it on every request. A request that sends none, and has no `/vN` prefix, is a
  version 1 request: that stays true in every later release.
- A browser's `EventSource` cannot set headers; for it the path (`/v1/events/stream`) carries the
  version.
- A version the gateway does not serve (not a whole number, or one it does not speak) is refused
  with 400 before the token is looked at, so a client can learn why without one:

```json
{
  "error": "unsupported_api_version",
  "requested": "2",
  "supported": [1],
  "message": "This gateway does not serve API version \"2\". It serves: 1."
}
```

`requested` is the text as sent. A path prefix and a header that name different versions get
`api_version_mismatch` (400), with `header` and `path`.

## `GET /version`

Needs no token, on `/version` and `/v1/version`:

```json
{
  "gateway": "1.0.0",
  "api": { "version": 1, "supported": [1] },
  "store": { "schema": 21 }
}
```

`gateway` is the release. `api.supported` lists every version this gateway serves; `api.version`
is the one it prefers. `store.schema` is the newest core database migration applied (see
[UPGRADING.md](UPGRADING.md)), or `null` for the moment before the store is open. It contains
nothing secret and nothing particular to one machine. `GET /health` reports `api` too.

## Checking a gateway from a client

`gateway.checkCompatibility()` in `@clerq/gateway-client` asks `GET /v1/version` and never throws:

```ts
{ ok: boolean, kind, gateway: string | null, api: { version, supported } | null, reason: string | null }
```

`kind` is `compatible`, `gateway_newer` (it serves only later versions), `gateway_older` (only
earlier ones, or it predates versioned APIs: before 1.0 there is no `/v1` and no `/version`),
`unreachable` or `unexpected` (something answered that is not a gateway). `reason` is a sentence
for a person, such as "This gateway speaks API 2; this app needs API 1. Update the app or the
gateway." The same words come out of a refused request as a `GatewayError`. The desktop app asks
once when it starts and shows the reason in a bar under the top bar; it says nothing while the
gateway is merely not up yet.

## Adding a repository

`POST /repos` adds a repository by hand (the `clerq repo add` command calls it). A row is otherwise
made the first time an automation naming the repository is queued; this makes the same row, through
the same code, so the two find each other. Added in API version 1 (a new route is an addition).

```json
{ "target": "github:acme/app", "check": true }
```

- `target` is written as an automation's `targets.repos` is, and read by the same parser, so the
  errors say the same words: `local:<path>`, `github:owner/name`, `gitlab:group/name`, or an https URL
  on github.com or gitlab.com. A `#branch` is accepted and ignored (the branch belongs to the spec).
  A local path must be absolute (or start with `~`, which is the gateway's account's home), exist, and be
  the top folder of a git work tree.
- `check` (optional, only for a remote) runs `git ls-remote` for the repository with the credential the
  gateway would clone with, asked of the same hook as a run's (purpose `fetch`: by default the vault
  secret `GITHUB_TOKEN` or `GITLAB_TOKEN`, or the one the row already names), as a hardened git command
  with the token only in its environment. Nothing is cloned.

The answer is the repository as `GET /repos` lists it, plus `created` (false when the row already
existed, which is returned untouched, its credential name included) and, with `check`, `check`:

```json
{
  "id": "repo_…",
  "kind": "github",
  "name": "acme/app",
  "created": true,
  "check": {
    "reachable": true,
    "message": "Reached github.com/acme/app with GITHUB_TOKEN.",
    "defaultBranch": "main",
    "credential": { "secret": "GITHUB_TOKEN", "present": true, "source": "vault:GITHUB_TOKEN" }
  }
}
```

`201` for a new row, `200` for one that was listed. `400` with `error`: `invalid_target` (not a
repository this release can work on, or a relative path), `repo_path_missing`, `not_a_repository` (not
a folder, not a git work tree, or inside one: the answer names its top folder), `invalid_check`.
`422 repo_unreachable` when `check` could not reach a remote that was not yet listed: **nothing is
added**, and the body carries `check`. For one already listed, the answer is `200` with
`check.reachable: false`. No answer or log line carries the token: git's own message is scrubbed of
it, and `check.credential` says only the secret's name, whether the hook found one and where it came
from. Like every route it needs the token; a scoped token reaches it only if its scopes name it.

## Errors

A request that fails before a route can answer it, or that a route lets fail, gets a JSON answer that
holds nothing taken from the request, and carries `Clerq-Api-Version` like every answer:

| Status    | `error`                  | When                                                                                                 |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| 400       | `invalid_json`           | the body is not valid JSON (the answer does not quote it, and neither does the log)                  |
| 413       | `payload_too_large`      | the body is over the limit (`CLERQ_MAX_BODY`, 1 MB by default)                                       |
| 404, 403  | `not_found`, `forbidden` | a file that is not there or not allowed, such as a module's `ui/` file                               |
| other 4xx | `invalid_request`        | the request could not be read                                                                        |
| 500       | `internal`               | anything else: the log has the method, path (no query) and where it was thrown, not the error's text |

A route's own errors (`400 invalid_request`, `404 repo_not_found`, …) are as that route documents them;
this is only what no route answered. It applies to a module's routes too.

## The GitHub App

Connecting the user's own GitHub App, and what a run does with it, is in [GITHUB.md](GITHUB.md).
These routes were added in API version 1 (new routes are additions). All need the gateway token and
are not reachable with a scoped token (`403`); `GET /github/app/callback` alone takes none.

`POST /github/app/manifest` with `{ "baseUrl": "http://127.0.0.1:18790", "owner"?: "<org>", "name"?: "…" }`
makes a manifest and a state for GitHub's manifest flow:

```json
{
  "url": "https://github.com/settings/apps/new?state=<64 hex>",
  "manifest": {
    "name": "OpenClerq-3fa91c",
    "public": false,
    "redirect_url": "…/v1/github/app/callback",
    "default_permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" },
    "hook_attributes": { "url": "…", "active": false },
    "…": "…"
  },
  "state": "<64 hex>",
  "expiresAt": "2026-11-14T10:10:00.000Z",
  "redirectUrl": "http://127.0.0.1:18790/v1/github/app/callback"
}
```

With `owner`, `url` is under `/organizations/<org>/settings/apps/new`. `400` with `error`:
`invalid_base_url` (not an address, or plain http to anything but `127.0.0.1`, `localhost` or `[::1]`,
or with a user name, query or fragment), `invalid_owner`, `invalid_name`. `409 app_already_connected`.
The state is 32 random bytes, kept in memory, valid ten minutes, once.

`GET /github/app/callback?code=…&state=…` is GitHub's redirect: an HTML page, no token, `GET` only (the
exemption is this exact path, in both the `/v1` and bare forms). It spends the state whatever happens.
`200` "Connected…" with the install link; `400` for an unknown, used or expired state, the wrong
`Host`, a bad code, an app under another organisation than the one asked for or with a wider permission than asked, or
a key that cannot be read or that the vault refuses; `409` when an app is connected already, or another callback connected one first (this one's app is left on GitHub: the page links its settings page so you can delete it); `502` when GitHub refuses the code;
`503` when the vault has no key. Nothing is stored on any of them.

`POST /github/app/import` with `{ appId, clientId, privateKey, clientSecret? }` proves the key with a
JWT and `GET /app`, then stores the app and the secrets: `201` (`{ connected: true, app, replacedKey: false }`),
or `200` with `replacedKey: true` for a new key of the app already connected. `400 invalid_request`
(a field is missing or malformed), `409 app_already_connected` (another app), `409 app_changed` (the connection changed while GitHub was being asked), `422` with `error`
`invalid_private_key` (not an RSA PEM), `github_rejected` (GitHub's own `message`),
`clock_skew` (a 401 because this computer's clock is more than 30 seconds from GitHub's: say so instead of blaming the key) or
`client_id_mismatch`, `502 github_unreachable`, `503 vault_unavailable`.

`GET /github/app` answers `{ "connected": false }`, or

```json
{
  "connected": true,
  "app": {
    "appId": 424242,
    "slug": "…",
    "name": "…",
    "clientId": "Iv23li…",
    "owner": { "login": "…", "type": "User" },
    "htmlUrl": "…",
    "source": "manifest",
    "createdAt": "…",
    "installUrl": "…",
    "settingsUrl": "…"
  },
  "secrets": { "privateKey": true, "clientSecret": false },
  "installations": [
    {
      "id": 1,
      "account": "acme",
      "accountType": "Organization",
      "repositorySelection": "selected",
      "suspended": false,
      "permissions": { "…": "…" },
      "htmlUrl": "…"
    }
  ],
  "installationsError": "…"
}
```

`secrets` says whether each is stored, never what it is. An address GitHub gives (the app's, an
installation's, a pull request's) is passed on only if it is `https://` on GitHub's own website
(`javascript:`, another host and look-alikes are not): otherwise it is left out (`null`) and the answer
carries a warning, in `app.warnings` for the app or `warnings` for an installation. `installations` is from GitHub (null, with
`installationsError`, when GitHub could not be asked), cached for a minute; `?refresh=1` asks again.
`DELETE /github/app` answers `{ disconnected: true, slug, appDeletedOnGitHub: false, settingsUrl, message }`
(`404 app_not_connected` when none): the app on GitHub is not touched. If somebody was signed in, they
are signed out first (while the client secret is still there to revoke with) and the answer carries
`user`, the sign-out's answer below, with its words added to `message`. Sign-ins still waiting for a
person on GitHub are cancelled first (`GET /github/login/{flowId}` then says `error`, "disconnected").

### Signing in as yourself

The app's device flow, for who is signed in and the repositories they reach (not for pushing: see
[GITHUB.md](GITHUB.md#what-the-sign-in-token-is-for-and-what-it-is-not-for)). Same rules as above:
the gateway token only, and no token, code or secret in any answer, log line or error text.

`POST /github/login` (no body) asks GitHub for a code and starts polling it in the background:

```json
{
  "flowId": "<32 hex>",
  "userCode": "WDJB-MJHT",
  "verificationUri": "https://github.com/login/device",
  "expiresAt": "2026-11-14T10:15:00.000Z",
  "interval": 5
}
```

`409 app_not_connected` (no app), `409 device_flow_disabled` (with `settingsUrl`: the app's page,
where "Enable Device Flow" is), `422 github_rejected` (GitHub did not know the client ID),
`502 invalid_verification_uri` (not `https` on GitHub's website: nothing is started) or
`502 github_unreachable`. The gateway holds at most five flows; starting another cancels the oldest.

`GET /github/login/{flowId}` answers `{ status, message?, settingsUrl?, user?, expiresAt?, interval? }`
with `status` `pending` (with `expiresAt` and the current `interval`), `approved` (`user` is
`{ login, id, name, avatarUrl, htmlUrl }`, or `null` with a `message` when GitHub would not say), `denied`,
`expired`, `disabled` (`settingsUrl`) or `error` (`message`). A finished flow can be read for ten
minutes. `404 flow_not_found` for one that never was, was cancelled or was forgotten.
`DELETE /github/login/{flowId}` cancels: `{ cancelled: true }`, or `404`.

`GET /github/user` answers `{ signedIn, user?, expiresAt?, refreshable, message? }`: `refreshable` is
true when a refresh token and the app's client secret are both there; `message` says why a sign-in
ended (it ran out and cannot be renewed, GitHub no longer accepts it) or could not be renewed right now
(then it is kept and tried again). `avatarUrl` is `https` only and `htmlUrl` `https` on GitHub's
website; one that is not is `null`. Who is signed in is cached for a minute.

`DELETE /github/user` answers `{ signedOut: true, revoked, message, authorizationsUrl }`
(`404 not_signed_in` when nobody is). The tokens are forgotten first, whatever follows; `revoked` is
true when GitHub revoked the authorization (`DELETE /applications/{client_id}/grant`, which needs the
app's client secret). Otherwise `message` says why and `authorizationsUrl` is where to revoke it by hand.

`GET /github/user/repositories` answers

```json
{
  "repositories": [
    {
      "fullName": "acme/app",
      "owner": "acme",
      "name": "app",
      "private": true,
      "htmlUrl": "https://github.com/acme/app",
      "installationId": 1001,
      "account": "acme",
      "added": true,
      "repoId": "repo_…"
    }
  ],
  "truncated": false,
  "limit": 1000,
  "message": "…",
  "warnings": ["…"]
}
```

`added` says OpenClerq has a row for it (names are compared without regard to case); `repoId` is that
row. Only GitHub rows (`kind: github`) count: a local clone whose `origin` is the same repository is a
different row, so the repository still shows `added: false`. The list stops at `limit` (1,000), and `truncated` and `message` say so. `warnings` name a
suspended installation or names OpenClerq cannot use. `409 not_signed_in` when nobody is signed in (or
GitHub no longer accepts the sign-in: it is dropped), `409 sign_in_unusable` when it cannot be used
right now, `502 github_unreachable`.

The sign-in is one vault entry, `GITHUB_USER_TOKENS`, which `POST /secrets`, `DELETE /secrets/<name>`,
a spec's `publish.token_secret` and `agent.api_key_secret`, and the forge credential lookup all refuse
(`400`). Every route here has a method on the client: `githubApp`, `githubManifest`,
`importGithubApp`, `disconnectGithubApp`, `startGithubLogin`, `githubLogin`, `cancelGithubLogin`,
`githubUser`, `githubSignOut`, `githubRepositories`.

Other additions in the same change:

- `GET /repos`, `GET /repos/:id` and the answer of `POST /repos` carry `reachedWith` on each GitHub
  repository, `{ via: "app" | "secret" | "none" | "unknown", app?: { slug, installationId? }, secret?, note? }`
  (null for a local repository and for GitLab), and each automation's `credential` gains `auth` (its
  `publish.auth`) and its own `reachedWith`. Asking never makes a token.
- A spec may set `publish.auth: auto | app | token`; `app` is refused for a `gitlab:` repository.
- `POST /secrets` and `DELETE /secrets/<name>` refuse `GITHUB_APP_PRIVATE_KEY`,
  `GITHUB_APP_CLIENT_SECRET` and `GITHUB_USER_TOKENS` (`400`).
- A run's clone, fetch, push and pull request steps carry `credential` (the source, never a token) and,
  for the app, `pushedAs` / `openedBy` (`<slug>[bot]`). `POST /repos` with `check` may say
  `github-app:<slug>/installation/<id>` as its `credential.source`.

## The 1.x promise

Within API version 1, changes are additive only:

- new routes;
- new optional request fields;
- new fields in responses;
- new event types.

Anything else is a break and waits for version 2: removing or renaming a route or a field,
changing a field's type, changing what a field or a route means, making an optional request field
required.

So a client of version 1 must **ignore response fields it does not know, and event types it does
not know** (the desktop app already does: an event family it has no use for is dropped).

When something is to go in version 2, version 1 says so first. The route or field keeps working
and its responses carry `Deprecation` and `Sunset` headers for at least one minor release before
version 2 removes it, and the old version stays in `api.supported` while it is served. Nothing is
deprecated yet, so no response carries these headers today.

Two tests keep the promise. A route, or a client name, that is gone or renamed fails its test
with a message that says it needs API version 2. A new one fails too, until it is recorded on
purpose, so additions are deliberate:

- `packages/gateway/src/api-surface.v1.json` lists every route the gateway serves, read from the
  Express app rather than written by hand.
- `packages/gateway-client/src/api-surface.v1.json` lists the client's exported names and the
  methods of `gateway`.

```sh
CLERQ_UPDATE_API_SURFACE=1 pnpm --filter @clerq/gateway exec vitest run src/api-surface.test.ts
CLERQ_UPDATE_API_SURFACE=1 pnpm --filter @clerq/gateway-client exec vitest run src/surface.test.ts
```

The command rewrites the file, and refuses to if anything was removed. Commit the file with the
change that added the route.

## Who may call

Authentication and tenants are described once, in [ARCHITECTURE.md](ARCHITECTURE.md#authentication)
and [SECURITY.md](SECURITY.md); this page only adds that `/v1` changes nothing about them. In short:
every route except `GET /health`, `GET /version`, `POST /devices/pair` and a module's UI files needs
a bearer token; a
scoped token (a module UI's, a phone's) reaches only the routes its scopes name, and
`X-Clerq-Tenant` picks a tenant for the gateway token. Scopes are written, and checked, against the
path without the prefix, so a token's scopes mean the same whether a client calls `/v1/records` or
`/records`.
