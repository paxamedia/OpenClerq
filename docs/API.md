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
`Host`, a bad code, an app under another account than asked or with a wider permission than asked, or
a key that cannot be read or that the vault refuses; `409` when an app is connected already; `502` when GitHub refuses the code;
`503` when the vault has no key. Nothing is stored on any of them.

`POST /github/app/import` with `{ appId, clientId, privateKey, clientSecret? }` proves the key with a
JWT and `GET /app`, then stores the app and the secrets: `201` (`{ connected: true, app, replacedKey: false }`),
or `200` with `replacedKey: true` for a new key of the app already connected. `400 invalid_request`
(a field is missing or malformed), `409 app_already_connected` (another app), `422` with `error`
`invalid_private_key` (not an RSA PEM), `github_rejected` (GitHub's own `message`) or
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

`secrets` says whether each is stored, never what it is. `installations` is from GitHub (null, with
`installationsError`, when GitHub could not be asked), cached for a minute; `?refresh=1` asks again.
`DELETE /github/app` answers `{ disconnected: true, slug, appDeletedOnGitHub: false, settingsUrl, message }`
(`404 app_not_connected` when none): the app on GitHub is not touched.

Other additions in the same change:

- `GET /repos`, `GET /repos/:id` and the answer of `POST /repos` carry `reachedWith` on each GitHub
  repository, `{ via: "app" | "secret" | "none" | "unknown", app?: { slug, installationId? }, secret?, note? }`
  (null for a local repository and for GitLab), and each automation's `credential` gains `auth` (its
  `publish.auth`) and its own `reachedWith`. Asking never makes a token.
- A spec may set `publish.auth: auto | app | token`; `app` is refused for a `gitlab:` repository.
- `POST /secrets` and `DELETE /secrets/<name>` refuse `GITHUB_APP_PRIVATE_KEY` and
  `GITHUB_APP_CLIENT_SECRET` (`400`).
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
