# GitHub App

OpenClerq reaches GitHub for an automation (to clone, fetch, push a branch and open a pull request)
with a **GitHub App that you own**, when you connect one. Each run gets short-lived tokens for the
one repository it works on; nothing long-lived goes near the agent. Without an app it uses the
vault secret the spec names (`publish.token_secret`, a personal access token), as before.

You connect the app, and sign in to GitHub as yourself, from three places that drive the same
routes: **`clerq github …`** ([CLI.md](CLI.md#clerq-github-connect--import--status--disconnect--login--logout--repos)),
**Settings → GitHub** in the desktop app, and the routes themselves (`curl`, shown below). Everything
here is about github.com: a self-hosted GitHub Enterprise server is not supported, as for remote
repositories in general.

- [Why a GitHub App, and why your own](#why-a-github-app-and-why-your-own)
- [Connect an app](#connect-an-app)
- [Install it on repositories](#install-it-on-repositories)
- [Sign in as yourself: the device flow](#sign-in-as-yourself-the-device-flow)
- [What the sign-in token is for, and what it is not for](#what-the-sign-in-token-is-for-and-what-it-is-not-for)
- [Renewing the sign-in, and signing out](#renewing-the-sign-in-and-signing-out)
- [From a terminal, or a server with no browser](#from-a-terminal-or-a-server-with-no-browser)
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
their own vault. Making one is one confirmation on GitHub's page.

## Connect an app

Two ways, each from the command line, from Settings → GitHub, or with the routes. Both end with the
app's id, slug and client ID stored in settings and its **private key**
(and client secret, if there is one) in the vault, under the fixed names `GITHUB_APP_PRIVATE_KEY` and
`GITHUB_APP_CLIENT_SECRET`. OpenClerq returns neither from any route and writes neither to a log or an
error answer: a request body that is not valid JSON is refused with a plain `400 invalid_json` that repeats
none of it (the gateway answers every failed request that way, see [API.md](API.md#errors)). Every route
below needs the gateway token (`~/.clerq/gateway-token`), is not reachable with a phone's or a
module's token, and exists under `/v1` as well as bare.

```sh
TOKEN=$(cat ~/.clerq/gateway-token)
GW=http://127.0.0.1:18790
```

**The short way:** `clerq github connect` (create) or `clerq github import --app-id … --client-id …
--private-key-file …` (use an app you made), or **Settings → GitHub → Create on GitHub** / **Import**.
The rest of this section is what they do, step by step.

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

2. Your browser posts the manifest to `url` (a form with one field, `manifest`). `clerq github
connect` writes that page to a private temporary folder, opens it with your system's opener and
   deletes it when it is done; Settings does it in a new window (in the desktop app, in your default
   browser, which is the one GitHub should ask). By hand, a page like this does it (put the answer's
   `url` in `action` and the `manifest` object, as JSON, in `value`):

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

After the app is created, switch on **Enable Device Flow** by hand if you want to sign in (next
section): GitHub's manifest has no field for it, as far as the documentation shows.

The callback refuses, and stores nothing, if the state is unknown, was used, is older than ten
minutes, or arrives at another address than the one the manifest named (so behind a proxy, pass the
`Host` header on: the nginx example in [SERVER.md](SERVER.md) does). It also refuses an app with a
permission the manifest did not ask for, and, **when you asked for an organisation** (`owner`), an app
that GitHub created under another one. For your own account there is no such check: GitHub creates the
app under whoever is signed in to it in the browser, and OpenClerq cannot know who that is, so look at
the name on GitHub's confirmation page. If two manifests are in flight, the first callback to finish is
the connection; the other stores nothing and its page links to its app's settings page, so you can
delete it.

### Import an app you made

If you made the app yourself on GitHub (Settings → Developer settings → GitHub Apps → New GitHub
App): turn **Webhook** off, grant the [permissions below](#what-it-asks-for), keep it private ("Only
on this account"), tick **Enable Device Flow** if you want to sign in, then **Generate a private
key** (a `.pem` file downloads) and note the **App ID** and the **Client ID** at the top of the page.
Add a **client secret** too if you want the sign-in renewed and revoked (see below).

`clerq github import` reads the key from a file (never from the command line) and refuses a file
that other users of the computer can read (`chmod 600` it); Settings has a file picker or a paste
field that is emptied once the form is sent. By hand:

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
`422` with GitHub's own message and nothing is stored. (A refusal that is really this computer's clock being more than 30 seconds from GitHub's is said so, `clock_skew`, since GitHub refuses a token signed at the wrong time with the same 401: the same words appear in a run's failure.) `clientSecret` is optional. A key pasted with
`\n` for its line breaks (as in an `.env` file) is accepted.

**Rotating the key:** generate a new private key on the app's settings page, import it again with the
same App ID (the old key is replaced, the rest kept), then delete the old key on GitHub. A different
app is refused (`409`) while one is connected: disconnect first.

### See and forget it

- `GET /v1/github/app` shows the app (no secrets), which secrets are stored, and `installations`:
  where it is installed, from GitHub, kept for a minute (`?refresh=1` asks again). It still answers when GitHub does not.
- Addresses from GitHub are checked: one that is not `https://` on github.com (a `javascript:` link, another
  host, a look-alike) is left out and a warning says so (`app.warnings`, `warnings`), and the install and
  settings links are built from the app's slug, never taken from GitHub.
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

## Sign in as yourself: the device flow

Signing in tells OpenClerq who you are on GitHub, and lets it list the repositories **you** reach
through the app's installations, so you can add one from a list. It uses the app's **device flow**:
OpenClerq asks GitHub for a short code, you type it on github.com and approve, and OpenClerq is given
a token for you. No password is typed anywhere in OpenClerq, and the flow needs no callback address,
so it works the same on this computer and on a server.

**Switch it on first, by hand.** On the app's settings page on GitHub, under **Identifying and
authorizing users**, tick **Enable Device Flow** and save. (OpenClerq cannot do this for you, and
says so, with the link, whenever GitHub answers that it is off: `device_flow_disabled`.)

1. `clerq github login`, or **Settings → GitHub → Sign in with GitHub**, or `POST /v1/github/login`.
   It answers a **code** to type (`userCode`), the address to type it at (`verificationUri`, on
   github.com), when the code stops working (`expiresAt`: GitHub's `expires_in`, normally 15 minutes) and the interval GitHub asked
   for.
2. You open that address, type the code and approve. The command, the dialog or your own client
   watches `GET /v1/github/login/<flowId>`.
3. The gateway polls GitHub in the background at GitHub's interval (never faster than once a second),
   five seconds slower after every `slow_down`. The status is `pending`, then one of `approved`
   (with `user`), `denied` (you refused on GitHub), `expired` (the code ran out), `disabled` (device
   flow is off: `settingsUrl` and the words say which setting) or `error`. `DELETE
/v1/github/login/<flowId>` cancels, and a cancelled flow keeps nothing even if you approve it later.

`GET /v1/github/user` says who is signed in (`signedIn`, `user: { login, id, name, avatarUrl, htmlUrl }`,
`expiresAt`, `refreshable`, `message` when it ran out). `GET /v1/github/user/repositories` lists what
the person reaches: each repository says which installation and account reach it and whether OpenClerq
**already has a row for it** (`added`, with `repoId`); the list stops at 1,000 repositories and says so
(`truncated`). Adding one is `POST /v1/repos` (`clerq github repos --add owner/name`, or **Repos → Add
from GitHub**).

One person is signed in per gateway: the gateway has one operator. Signing in again replaces the
earlier sign-in, and several sign-in windows can be open at once (the last to be approved is the one
kept).

Addresses from GitHub are checked before they are passed on: the sign-in address must be `https` on
GitHub's website (otherwise nothing is started), the profile link the same, an avatar `https`.

## What the sign-in token is for, and what it is not for

- **It is for** two things: saying **who is signed in** ("signed in as @login") and **listing the
  repositories** you can reach through the app.
- **It is not used to clone, fetch, push or open a pull request.** A run does those with the app's
  **installation tokens** ([Tokens](#tokens)): one repository, one purpose, ended with the run, never
  your personal authority. Signing in does not make a run act as you, and a run never sees your token.
- Nothing a spec, an agent or `/secrets` can name reaches it: it is stored under the reserved name
  `GITHUB_USER_TOKENS`, which `publish.token_secret`, `agent.api_key_secret`, `POST /secrets`,
  `DELETE /secrets/<name>` and the forge credential lookup all refuse.
- It is in no route's answer and no log line, and is cut out of anything GitHub says before that is
  passed on (an error that echoes it, the device code, the refresh token).

## Renewing the sign-in, and signing out

GitHub Apps' user tokens last **eight hours** (the app's "Expire user authorization tokens" setting,
on by default) and come with a refresh token that lasts about six months.

- **With the app's client secret stored** (give it when you import the app, or generate one on the
  app's settings page and import again), an expired token is renewed on the next use, and the new pair
  replaces the old in the vault in one write. GitHub accepts a refresh token once, so renewals are
  serialised: any number of callers at once cause exactly one request to GitHub.
- **Without a client secret** the sign-in simply ends at expiry. `GET /v1/github/user` then says
  `signedIn: false` and why ("this app has no client secret stored, so it cannot be renewed. Sign in
  again"), and the dead token is deleted. If the app does not expire user tokens, nothing ever ends.
- A sign-in that GitHub no longer accepts (you revoked it on GitHub, the refresh token ran out) is
  dropped and reported the same way. If GitHub cannot be reached for a renewal, or the secret is wrong,
  the sign-in is **kept** and tried again on the next use.
- **Signing out** (`clerq github logout`, **Sign out**, `DELETE /v1/github/user`) forgets the tokens at
  once, and then, **if the client secret is stored**, asks GitHub to revoke the authorization
  (`DELETE /applications/{client_id}/grant`, with the client id and secret as basic credentials and the
  token in the body), so the app also vanishes from your authorized apps. Without the secret it says
  so, and where to revoke it yourself: `<github>/settings/apps/authorizations`. A token that had
  already expired cannot be revoked by itself; the answer says that and links the same page.
- **Disconnecting the app** (`DELETE /v1/github/app`) signs you out first, while the secret is still
  there to revoke with.

## From a terminal, or a server with no browser

**Signing in needs no browser on the server.** `clerq github login` prints the address and the code;
type them in a browser on any computer, your laptop or phone. Add `--no-browser` so the command does
not try to open one.

**Creating the app needs the gateway's callback to be reachable from the browser.** GitHub sends the
browser back to `<baseUrl>/v1/github/app/callback` with a one-time code; that address is where the
**browser** reaches the gateway, whatever the CLI uses. So:

- On this computer it is `http://127.0.0.1:<port>` and it just works.
- For a gateway on a server, run `clerq login https://your-gateway` and then `clerq github connect`:
  the CLI uses that profile address, and **it must be `https://`** (the one-time code can be traded for
  the app's private key, so it never crosses plain http). The reverse proxy must pass the `Host` header
  ([SERVER.md](SERVER.md)). `connect` opens the page on the computer where you run it; with
  `--no-browser` it prints the page's path, which you open in a browser on a computer that can reach
  the gateway's https address (copy the file there if the CLI runs on the server).
- If that is not possible (the gateway is only reachable from the server), create the app on GitHub
  by hand and use `clerq github import` instead: it sends nothing to a browser and needs no callback.

## What it asks for

The manifest asks for the least a run needs, and nothing else: no webhook, not public, no user
authorization at install. (Signing in as yourself is a separate step, through the device flow, and
asks for nothing beyond identity and the list of your installations.)

| Permission      | Level | Why                                                       |
| --------------- | ----- | --------------------------------------------------------- |
| `contents`      | write | clone and fetch the repository, and push the run's branch |
| `pull_requests` | write | open the draft pull request                               |
| `metadata`      | read  | GitHub gives this to every app                            |

It does not ask for `workflows`, so GitHub should refuse a push that adds or changes a file under
`.github/workflows/` (not verified, see the end); that is deliberate.

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
3. **Delete a private key** on the app's settings page. GitHub will not delete an app's last key, so
   this is how an old key is retired after a new one has been imported (rotation, above); to cut
   OpenClerq off entirely use step 2, 4 or 5. Once the key OpenClerq holds is deleted, it can no
   longer make tokens (`GET /v1/github/app` still lists the app; runs say the key was refused).
4. **`DELETE /v1/github/app`** makes OpenClerq forget the app and delete its key from the vault (and
   sign you out, revoking the sign-in on GitHub when the client secret is stored).
5. **Delete the app on GitHub** (its settings page, the link in the answer of step 4). Only this removes
   the app itself and every installation of it.

The private key in the vault is a **long-lived credential that can make tokens for every repository
the app is installed on.** Protect the vault: see [SECURITY.md](SECURITY.md).

**If you think the key leaked**, in this order: generate a new private key on the app's settings page
(GitHub will not delete an app's last key, so the new one has to exist first), import it
(`POST /v1/github/app/import`, with the same App ID), then delete the leaked key on GitHub. Tokens
already made with the leaked key stay valid until they expire, **up to an hour**, whatever you do to
the key; to cut the repositories off sooner, uninstall the app (step 2) or delete it (step 5), and
check the installations' activity on GitHub.

## What is stored where

| What                                                                 | Where                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| App id, slug, name, client ID, owner, URLs, when                     | the `settings` table of `clerq.db`, key `github.app`: not secret      |
| The private key, the client secret                                   | the vault: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`       |
| Your GitHub sign-in: user token, refresh token, their expiry times   | the vault, one entry: `GITHUB_USER_TOKENS`                            |
| Waiting sign-in flows (the device code), who is signed in (a minute) | memory of the running gateway only (lost on a restart)                |
| Installation tokens, installation lookups, waiting manifest states   | memory of the running gateway only (lost on a restart)                |
| Which credential a run used                                          | the run's steps: `github-app:<slug>/installation/<id>`, never a token |
| That an app was connected, imported, re-keyed or forgotten           | the audit log (`github.app.*`: app id and slug)                       |
| That you signed out                                                  | the audit log (`github.user.signed_out`: whether GitHub revoked it)   |

The webhook secret GitHub returns with a manifest is not stored: the app has no webhook. The
sign-in is one vault entry rather than one per token because GitHub spends the old refresh token when
it hands out a new pair: storing the pieces separately could lose the sign-in if the second write
failed.

## Routes

All under `/v1`, for the gateway token only (a scoped token gets `403`). Added to API version 1.

| Route                           | Does                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /github/app/manifest`     | `{ baseUrl, owner?, name? }` → `{ url, manifest, state, expiresAt, redirectUrl }`                                             |
| `GET /github/app/callback`      | GitHub's redirect; no token; `?code=&state=`; an HTML page                                                                    |
| `POST /github/app/import`       | `{ appId, clientId, privateKey, clientSecret? }` → `201`, or `200` for a new key of the same app; `422` with GitHub's message |
| `GET /github/app`               | `{ connected, app, secrets, installations }`; `?refresh=1`                                                                    |
| `DELETE /github/app`            | forgets the app and its key, and signs out; `404` when none                                                                   |
| `POST /github/login`            | starts the device flow → `{ flowId, userCode, verificationUri, expiresAt, interval }`; `409` with no app or device flow off   |
| `GET /github/login/{flowId}`    | `{ status: pending \| approved \| denied \| expired \| disabled \| error, message?, settingsUrl?, user? }`                    |
| `DELETE /github/login/{flowId}` | cancels the flow                                                                                                              |
| `GET /github/user`              | `{ signedIn, user?, expiresAt?, refreshable, message? }`                                                                      |
| `DELETE /github/user`           | signs out → `{ signedOut, revoked, message, authorizationsUrl }`; `404` when nobody is signed in                              |
| `GET /github/user/repositories` | `{ repositories: [{ fullName, installationId, account, private, added, repoId? }], truncated, limit }`; `409` when signed out |

Details and error codes are in [API.md](API.md#the-github-app). Every route has a method on the client
(`@clerq/gateway-client`: `githubApp`, `githubManifest`, `importGithubApp`, `disconnectGithubApp`,
`startGithubLogin`, `githubLogin`, `cancelGithubLogin`, `githubUser`, `githubSignOut`,
`githubRepositories`); the callback is a browser's, so it has none.

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
- **Device flow.** That an app made from a manifest needs "Enable Device Flow" switched on by hand
  (as far as the manifest documentation shows it is not a manifest field), and that GitHub then
  answers `POST /login/device/code` with `device_code`, `user_code`, `verification_uri` (on
  github.com), `expires_in` and `interval`; that errors come in a 200's body or a 4xx
  (`device_flow_disabled`, `incorrect_client_credentials`; OpenClerq reads the body whatever the
  status); the poll's `authorization_pending`, `slow_down` (with a new `interval`), `access_denied`
  and `expired_token`; that `Accept: application/json` with a JSON body is accepted by both
  `/login/` endpoints; and what a wrong client ID answers to the code request.
- **User tokens.** That the device flow's answer carries `expires_in`, `refresh_token` and
  `refresh_token_expires_in` (about 8 hours and 6 months) when the app expires user tokens, and none
  when it does not; that `grant_type=refresh_token` with the client id and secret returns a new pair
  and spends the old refresh token; the error names `bad_refresh_token` and
  `incorrect_client_credentials`.
- **The user's reads.** `GET /user` with `Authorization: Bearer <user token>`; `GET
/user/installations` (`{ installations: [...] }`) and `GET /user/installations/{id}/repositories`
  (`{ repositories: [...] }`) with that token, `per_page=100` and `Link` paging; that a suspended
  installation refuses its repositories; that `avatar_url` and `html_url` are the https addresses
  OpenClerq expects.
- **Revoking the sign-in.** That `DELETE /applications/{client_id}/grant` with basic credentials
  `client_id:client_secret` and a body of `{ "access_token": … }` works for a GitHub App's client id
  (the documentation is written for OAuth apps, and also describes `DELETE
/applications/{client_id}/token`, which revokes one token without the grant), that it answers `204`,
  what it answers for an expired token (OpenClerq reads `404` and `422` as "could not revoke by that
  token"), and that the page a person revokes from is `<github>/settings/apps/authorizations`.
- **A browser posting the manifest form** to `/settings/apps/new` and following the redirect to the
  gateway: the page `clerq github connect` and Settings write, as opposed to the fake's imitation of
  it.
