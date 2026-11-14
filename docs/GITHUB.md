# GitHub App

OpenClerq reaches GitHub for an automation (to clone, fetch, push a branch and open a pull request)
with a **GitHub App that you own**, when you connect one. Each run gets short-lived tokens for the
one repository it works on; nothing long-lived goes near the agent. Without an app it uses the
vault secret the spec names (`publish.token_secret`, a personal access token), as before.

What is here today is the gateway side: the routes below, the run behaviour and the Repos page. A
`clerq github …` command and a Settings page that drive these routes are the next step, so for now
you connect the app with the routes (`curl`, shown below). Everything here is about github.com: a
self-hosted GitHub Enterprise server is not supported, as for remote repositories in general.

- [Why a GitHub App, and why your own](#why-a-github-app-and-why-your-own)
- [Connect an app](#connect-an-app)
- [Install it on repositories](#install-it-on-repositories)
- [What it asks for](#what-it-asks-for)
- [Tokens](#tokens)
- [Which credential a run uses: `publish.auth`](#which-credential-a-run-uses-publishauth)
- [The pull request's author](#the-pull-requests-author)
- [Revoking, uninstalling, disconnecting](#revoking-uninstalling-disconnecting)
- [What is stored where](#what-is-stored-where)
- [Not verified against github.com](#not-verified-against-githubcom)

## Why a GitHub App, and why your own

|            | Personal access token (`publish.token_secret`) | OAuth App                     | GitHub App                        |
| ---------- | ---------------------------------------------- | ----------------------------- | --------------------------------- |
| Lifetime   | until you revoke it, often a year or never     | until revoked                 | **one hour at most**              |
| Reach      | every repository the token's owner picked      | the `repo` scope: all of them | **one repository per token**      |
| Acts as    | you                                            | you                           | **the app's own account** (a bot) |
| Taken away | delete the token                               | revoke the grant              | **uninstall it, or the run ends** |

A GitHub App's installation token is the narrowest of the three, which is why 1.0 uses one.

**Why your own.** OpenClerq runs on your machine or your server and has no service of its own. An
app owned by OpenClerq would need its private key on every install, or a hosted service that signs
for everyone. So each person (or team) makes an app of their own, and its private key stays in
their own vault. Making one takes a minute and a click on GitHub's page.

## Connect an app

Two ways. Both end with the app's id, slug and client ID stored in settings and its **private key**
(and client secret, if there is one) in the vault, under the fixed names `GITHUB_APP_PRIVATE_KEY` and
`GITHUB_APP_CLIENT_SECRET`. Neither is ever returned by a route or written to a log. Every route
below needs the gateway token (`~/.clerq/gateway-token`), is not reachable with a phone's or a
module's token, and exists under `/v1` as well as bare.

```sh
TOKEN=$(cat ~/.clerq/gateway-token)
GW=http://127.0.0.1:18790
```

### Create the app from a manifest

GitHub can create an app from a description of it (a manifest) and hand the key back once.

1. Ask OpenClerq for the manifest. `baseUrl` is the address your **browser** uses to reach the gateway;
   GitHub sends the browser back to it. It must be `http://127.0.0.1:<port>` (or `localhost`) for this
   computer, and an `https://` address for a server behind a proxy. Add `"owner": "<organisation>"` to
   create the app under an organisation, and `"name"` to choose its name (default `OpenClerq-` and six
   hex digits; GitHub names are unique and at most 34 characters).

   ```sh
   curl -s -X POST "$GW/v1/github/app/manifest" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"baseUrl": "http://127.0.0.1:18790"}'
   ```

   The answer is `{ url, manifest, state, expiresAt, redirectUrl }`. The state is good for ten minutes
   and for one use.

2. Your browser posts the manifest to `url` (a form with one field, `manifest`). There is no button
   for this yet, so a page like this does it (put the answer's `url` in `action` and the `manifest`
   object, as JSON, in `value`):

   ```html
   <form method="post" action="https://github.com/settings/apps/new?state=…">
     <input type="hidden" name="manifest" value='{"name":"OpenClerq-…", …}' />
     <button>Create the app on GitHub</button>
   </form>
   ```

3. GitHub shows the app's name, asks you to confirm, creates it and sends the browser back to
   `GET /v1/github/app/callback`. That is the one route that takes no token (a browser lands on it):
   it checks the state, trades GitHub's one-time code for the key, stores everything and shows a page
   that says "Connected. Now install the app on the repositories it may use:" with the link.

The callback refuses, and stores nothing, if the state is unknown, was used, is older than ten
minutes, or arrives at another address than the one the manifest named (so behind a proxy, pass the
`Host` header on: the nginx example in [SERVER.md](SERVER.md) does). It also refuses an app created
under another account than the one asked for, or with a permission the manifest did not ask for.

### Import an app you made

If you made the app yourself on GitHub (Settings → Developer settings → GitHub Apps → New GitHub
App): turn **Webhook** off, grant the [permissions below](#what-it-asks-for), keep it private ("Only
on this account"), then **Generate a private key** (a `.pem` file downloads) and note the **App ID**
and the **Client ID** at the top of the page.

```sh
curl -s -X POST "$GW/v1/github/app/import" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({
        appId: 123456,
        clientId: "Iv23li…",
        privateKey: require("fs").readFileSync(process.argv[1], "utf8")
      }))' ~/Downloads/my-app.private-key.pem)"
```

OpenClerq signs a token with the key and asks GitHub `GET /app`: if GitHub says no, the answer is
`422` with GitHub's own message and nothing is stored. `clientSecret` is optional. A key pasted with
`\n` for its line breaks (as in an `.env` file) is accepted.

**Rotating the key:** generate a new private key on the app's settings page, import it again with the
same App ID (the old key is replaced, the rest kept), then delete the old key on GitHub. A different
app is refused (`409`) while one is connected: disconnect first.

### See and forget it

- `GET /v1/github/app` shows the app (no secrets), which secrets are stored, and `installations`:
  where it is installed, from GitHub, kept for a minute (`?refresh=1` asks again). It still answers when GitHub does not.
- `DELETE /v1/github/app` forgets the app, its key and its client secret. It cannot delete the app on
  GitHub: the answer says so and links to the app's settings page.

## Install it on repositories

A GitHub App does nothing until it is **installed**, and it reaches only the repositories it is
installed on. Open the link the callback page gave (or `installUrl` from `GET /v1/github/app`), pick
the account, and choose **Only select repositories**. Add a repository later, or take one away, on the
installation's page on GitHub. An organisation's owner may have to approve the installation.

The Repos page (and `GET /v1/repos`) says, for each GitHub repository, whether a run would be
**reached with the GitHub App** (installed there) or with a vault secret, and for each automation
that targets it, by its own `publish.auth`. Finding out never makes a token.

## What it asks for

The manifest asks for the least a run needs, and nothing else: no webhook, not public, no user
authorization at install.

| Permission      | Level | Why                                                       |
| --------------- | ----- | --------------------------------------------------------- |
| `contents`      | write | clone and fetch the repository, and push the run's branch |
| `pull_requests` | write | open the draft pull request                               |
| `metadata`      | read  | GitHub gives this to every app                            |

It does not ask for `workflows`, so GitHub refuses a push that adds or changes a file under
`.github/workflows/`; that is deliberate.

Write access to `contents` can push to any branch the app may write to. OpenClerq only ever pushes
the run's own new branch, and never merges (see [SECURITY.md](SECURITY.md)); branch protection on
your default branch is still the right guard against anything else.

## Tokens

A run asks for a token when it needs one, for **one repository** and **one purpose**, and each has
only the permissions of its purpose:

| Purpose        | Used for                     | Permissions                              |
| -------------- | ---------------------------- | ---------------------------------------- |
| `fetch`        | clone, and fetching the base | `contents: read`                         |
| `push`         | pushing the run's branch     | `contents: write`                        |
| `pull_request` | opening the pull request     | `pull_requests: write`, `contents: read` |

- **At most one hour**, as GitHub makes them. A token is kept in the gateway's memory only, never on
  disk and never in the database, and shown to nobody: not the agent, not a gate, not a log line, not
  a run record (the record names the credential, `github-app:<slug>/installation/<id>`, not the
  token).
- **It reaches git as an HTTP header** in the environment of the one git command that needs it, as a
  vault token does, and reaches GitHub's API only in the request that opens the pull request.
- **One run's tokens are its own.** They are reused within the run while they have more than five
  minutes left, and made again when closer: a push that waited hours for your approval gets a fresh
  token. Two runs never share one, so ending one run's token cannot break another.
- **They are revoked when the run ends**, whichever way it ends (finished, failed, cancelled, or an
  error before any work). A revoke that fails is logged without the token and ignored: the token
  expires on its own. If the gateway itself is stopped or crashes mid-run, its tokens are not revoked
  and expire within the hour.
- **A token wider than asked for is refused and revoked.** The gateway checks what GitHub says the
  token can do (its permissions, and that it is for the one repository) before using it.
- Everything a run stores is redacted of the tokens it held: the diff, gate output, agent text and tool
  calls, step details, the pull request's title and body, error messages and the log. This is literal
  matching of the token and of its base64 form; a diff that contains one makes the push wait for
  approval, as for any vault secret. The commit itself still carries a value the agent wrote into a
  file.

`POST /repos` with `check: true` makes one `fetch` token, reads with it and ends it at once. The spec
preview makes none.

## Which credential a run uses: `publish.auth`

A spec may say where its forge credential comes from. The default is `auto`.

| `publish.auth`   | The run uses                                                              | If the app is not installed on the repository      |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `auto` (default) | **the app when it is installed on the repository, else the vault secret** | the vault secret `publish.token_secret`, as before |
| `app`            | the app only                                                              | the run fails before any work, with the reason     |
| `token`          | the vault secret only; GitHub is not asked about the app                  | not relevant                                       |

```yaml
publish:
  auth: app # or auto (the default), or token
```

- **Existing specs keep working.** With no app connected, or the app not installed on a repository,
  `auto` is the vault secret.
- **`auto` will not guess when the app is installed but cannot be used** (GitHub unreachable, the key
  refused, the installation suspended, a permission not accepted): a run that pushes stops with the
  reason, rather than quietly pushing as you instead of as the app. Set `publish.auth: token` to opt
  out of the app for that automation. A `fetch` (reading) falls back to the vault secret instead.
- `publish.auth: app` is refused when the spec is saved for a `gitlab:` repository. For a local
  repository the forge is known from its `origin` only when a run starts.
- The spec preview (`POST /v1/automations/preview`) says which credential a run would use, and why a
  run that insists on the app would stop.
- The vault secrets of the app itself (`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`) cannot be
  named as `publish.token_secret` or `agent.api_key_secret`, and `POST /secrets` and `DELETE
/secrets/<name>` refuse them.

## The pull request's author

A token made for the app acts as the app: the pull request (and the push) is by **`<slug>[bot]`**,
not by you. The run's push and pull request steps say so ("Done as `<slug>[bot]`"), and so does the
spec preview. The commit's author is what OpenClerq sets on every run (`OpenClerq`, with an
`OpenClerq-Run` trailer), as with a personal token. Because the bot opened the pull request, you can
review and approve it yourself.

## Revoking, uninstalling, disconnecting

From the smallest to the largest:

1. **A run's tokens end with the run.** Nothing to do.
2. **Uninstall the app from a repository or an account** (the installation's page on GitHub). New
   tokens cannot be made for it, and `auto` falls back to the vault secret (or `app` fails). OpenClerq
   believes an "installed" answer for five minutes; `GET /v1/github/app?refresh=1` makes it ask again.
3. **Delete the private key** on the app's settings page. OpenClerq can no longer make tokens
   (`GET /v1/github/app` still lists the app; runs say the key was refused). Import a new one to carry on.
4. **`DELETE /v1/github/app`** makes OpenClerq forget the app and delete its key from the vault.
5. **Delete the app on GitHub** (its settings page, the link in the answer of step 4). Only this removes
   the app itself and every installation of it.

The private key in the vault is a **long-lived credential that can make tokens for every repository
the app is installed on.** Protect the vault: see [SECURITY.md](SECURITY.md). If you think it leaked,
delete the key on GitHub (step 3) first, then import a new one.

## What is stored where

| What                                                               | Where                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| App id, slug, name, client ID, owner, URLs, when                   | the `settings` table of `clerq.db`, key `github.app`: not secret      |
| The private key, the client secret                                 | the vault: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`       |
| Installation tokens, installation lookups, waiting manifest states | memory of the running gateway only (lost on a restart)                |
| Which credential a run used                                        | the run's steps: `github-app:<slug>/installation/<id>`, never a token |
| That an app was connected, imported, re-keyed or forgotten         | the audit log (`github.app.*`: app id and slug)                       |

The webhook secret GitHub returns with a manifest is not stored: the app has no webhook.

## Routes

All under `/v1`, for the gateway token only (a scoped token gets `403`). Added to API version 1.

| Route                       | Does                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /github/app/manifest` | `{ baseUrl, owner?, name? }` → `{ url, manifest, state, expiresAt, redirectUrl }`                                             |
| `GET /github/app/callback`  | GitHub's redirect; no token; `?code=&state=`; an HTML page                                                                    |
| `POST /github/app/import`   | `{ appId, clientId, privateKey, clientSecret? }` → `201`, or `200` for a new key of the same app; `422` with GitHub's message |
| `GET /github/app`           | `{ connected, app, secrets, installations }`; `?refresh=1`                                                                    |
| `DELETE /github/app`        | forgets the app and its key; `404` when none                                                                                  |

Details and error codes are in [API.md](API.md#the-github-app).

## Not verified against github.com

Everything here was tested against a fake GitHub API that follows GitHub's documentation and what
we know of its behaviour, not against github.com (no live call is made in development). Check these
once against the real service before relying on them:

- **The manifest.** That GitHub accepts exactly these fields: `hook_attributes` with
  `active: false` and a URL (the homepage, never called), no `callback_urls`, `public: false`,
  `request_oauth_on_install: false`, `default_events: []`, and a `redirect_url` on `http://127.0.0.1`.
  That the conversion returns `id`, `slug`, `client_id`, `client_secret`, `pem`, `owner` and `permissions`.
- **`repositories` with `permissions` in one call** to `POST /app/installations/{id}/access_tokens`
  (the documentation lists them as independent body parameters), and the shape of the answer
  (`permissions`, `repository_selection`, `repositories`) that OpenClerq checks.
- **Revoking.** That `DELETE /installation/token` with the token as its own bearer answers `204`, and
  what GitHub does to a token when its app is uninstalled or its key deleted.
- **The JWT.** That `iss` as the App ID (OpenClerq's choice; GitHub also takes the client ID) is
  accepted, with `iat` a minute in the past and `exp` nine minutes ahead.
- **Pushing over HTTPS** with the installation token as `x-access-token` Basic credentials (the
  documented form), and that a push that touches `.github/workflows/` is refused without
  `workflows` permission.
- **A repository that was renamed** answers `301` to `GET /repos/{owner}/{repo}/installation`;
  OpenClerq does not follow it and reports that the app could not be asked.
- **Device flow** (for signing in as a user, the next step) is switched on in the app's settings
  ("Enable Device Flow"); as far as the manifest documentation shows it is not a manifest field, so
  an app made from a manifest will need that one click.
