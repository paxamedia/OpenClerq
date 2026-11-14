# The `clerq` command line

`clerq` drives a gateway from a terminal: sign in to it, add repositories, apply an automation from
a YAML file, run it, watch it, and answer what it asks. It talks to the gateway only through
[`@clerq/gateway-client`](../packages/gateway-client) over the versioned HTTP API
([API.md](API.md)), so it works the same against the desktop app's gateway on this computer and
against a [`clerq-server`](SERVER.md) somewhere else.

```text
clerq login [url]                     sign in, save a profile
clerq logout                          remove a saved profile and its token
clerq status                          which gateway, which versions, is the token accepted
clerq repo add <target> [--check]     add a repository; also: repo list, repo show
clerq automation apply -f <file>      create or update an automation; also: list, show, enable, disable
clerq run <automation> [--follow]     start an automation now
clerq logs <run> [--follow]           a run's steps, tool calls and status
clerq approvals                       what is waiting for an answer
clerq approve <id> | deny <id>        answer one
```

`clerq help` lists them, `clerq help <command>` (or `clerq <command> --help`) explains one, and
`clerq --version` prints the release and the API version.

## Install

From 1.0.0, `clerq` comes with the server files: the installer puts `clerq`, `clerq-server` and
`clerq-calc` in `~/.local/bin` (Linux and macOS, after checking the download against `SHA256SUMS`),
and the [container image](SERVER.md#running-it-in-docker) has it at `/usr/local/bin/clerq`:

```sh
curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh
clerq --version
```

`clerq` is one standalone program (Bun-compiled, no Node needed) that needs nothing beside it; the
server's tarball is the only release file that holds it. [SERVER.md](SERVER.md#installing) lists
the installer's options and how to check and unpack the tarball by hand. To build it from the
repository instead (Node.js 24 or later):

```sh
pnpm install
pnpm --filter @clerq/cli build            # plain JavaScript in apps/cli/dist/
node apps/cli/dist/main.js --help         # runs on Node

# One standalone binary, with no Node needed, for this machine:
node scripts/build-binary.js --entry apps/cli/src/main.ts --name clerq --no-calc
#   -> apps/cli/dist/<target>/clerq   (for example bun-darwin-arm64)
# For another machine (Bun fetches that target's runtime the first time):
node scripts/build-binary.js --entry apps/cli/src/main.ts --name clerq --no-calc --target bun-linux-x64

install -m 0755 apps/cli/dist/bun-darwin-arm64/clerq /usr/local/bin/clerq
```

`pnpm --filter @clerq/cli build:binary` runs the same compile for this machine. The binary does not
read a `.env` or a `bunfig.toml` from the folder you run it in; it reads the settings named below
and nothing else. Targets are the ones `scripts/build-binary.js` knows (see
[DISTRIBUTION.md](DISTRIBUTION.md)); the release builds `linux-x64`, `linux-arm64`, `darwin-arm64`
and `darwin-x64`.

## Connecting

Which gateway, and which token, are settled from these, first match wins:

|     | Address                                                       | Token                                                           |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `--gateway <url>`, or the profile named by `--profile <name>` | the profile named by `--profile`                                |
| 2   | `CLERQ_GATEWAY_URL`                                           | `CLERQ_GATEWAY_TOKEN`                                           |
| 3   | the profile `default` in `~/.clerq/cli.json`                  | the profile `default`                                           |
| 4   | `http://127.0.0.1:18790`, the gateway on this computer        | `~/.clerq/gateway-token`, for the gateway on this computer only |

So on the machine where the desktop app (or `clerq-server`) runs, `clerq status` works with no setup.
For another gateway, sign in once:

```sh
clerq login https://clerq.example.com                       # asks for the token, without showing it
clerq login https://clerq.example.com --profile work        # a second profile, used with --profile work
cat token.txt | clerq login https://clerq.example.com --token-stdin
clerq login https://clerq.example.com --token-file /etc/clerq/token   # keeps the path, reads the file each time
clerq login                                                 # on a machine with a local gateway: checks it, saves nothing
```

`login` checks that the gateway speaks this CLI's API version and that the token is the gateway's own
(one call only that token may make, `GET /routing`; a paired phone's or a module's token, which the
gateway knows, is refused and said to be) before it saves anything. It saves no token shorter than 16
characters: the gateway's own are 64, a short one is easy to guess, and the CLI could not keep it out of
its own output. It does not read `CLERQ_GATEWAY_TOKEN`: a token in the
environment needs no `login`. `clerq logout [--profile <name>]` removes the profile and the token
stored in it (a token file is left where it is).

A token saved in a profile is sent **only to that profile's own address**, and the local token file
only to **the gateway on this computer**: `localhost`, `127.x.x.x` or `::1` on port 18790, the port the
desktop app and `clerq-server` use unless told otherwise. `--gateway https://elsewhere` never carries a
token that was saved for somewhere else, and a mistyped port on `localhost` does not hand your token to
whatever listens there. A token in `CLERQ_GATEWAY_TOKEN` goes wherever you point it, since you set both.
A `clerq-server` on another port of this computer needs one `login` to say so:
`clerq login http://127.0.0.1:18800 --token-file ~/.clerq/gateway-token`.

### `~/.clerq/cli.json`

```json
{
  "version": 1,
  "profiles": {
    "default": { "url": "https://clerq.example.com", "token": "…" },
    "work": { "url": "https://work.example.com", "tokenFile": "/etc/clerq/token" }
  }
}
```

Written by `login` and `logout`, mode 0600 (the folder 0700 when `login` makes it), replaced in one
step so it is never half written. If the file holds a token and can be read by other users, every
command says so and how to fix it (`chmod 600`). You can edit it by hand.

### Every command checks the version first

Before anything else a command asks the gateway (no token needed) which API versions it serves. A
gateway that speaks another version, or is older than 1.0, or is not a gateway, gets the plain reason
and **exit 3**; so does one that does not answer, and one that answers with a **redirect**, which is
never followed (see Security notes). A request the gateway has not begun to answer
within 30 seconds is given up on (`CLERQ_TIMEOUT=60` changes that, in seconds); a followed run, once
its stream has begun, is not cut off.

## Commands

Every command takes `--json`, `--gateway`, `--profile`, `--insecure`, `--no-color` and `-h`.

### `clerq status`

```text
Gateway     http://127.0.0.1:18790  (the gateway on this computer, the default)
Profile     none in use
Token       in ~/.clerq/gateway-token
Gateway is  OpenClerq 0.5.1, API 1 (serves 1), store schema 21
This CLI    0.5.1, API 1
Compatible  yes
Token is    accepted
```

It never prints the token, only where it comes from. Exit 0 when the gateway is usable and the token
accepted, 3 when the gateway cannot be used, 1 when there is no token or it is refused.

### `clerq repo add | list | show`

`add` takes a target written as an automation's `targets.repos` is: a folder (or `local:<path>`),
`github:owner/name`, `gitlab:group/name`, or an https URL on github.com or gitlab.com.

```sh
clerq repo add .                                  # this folder, which must be a git work tree's top folder
clerq repo add github:acme/app --check            # also reach it with the credential a run would use
```

```text
Added app (local, id repo_8c1f…).
  Where  /home/ana/code/app

Added acme/app (github, id repo_41d0…).
  Address       https://github.com/acme/app.git
  Reached with  GITHUB_TOKEN (not in the vault: a private repository needs it)
  Check         Reached github.com/acme/app without a credential (a public repository). Default branch: main.
```

- A relative folder is made absolute from where you run the command. A path is **on the gateway's
  computer**, so for a gateway elsewhere give a path that exists there (the CLI says so). The CLI
  expands `~` itself only for the gateway on this computer (loopback, port 18790, the same rule as for the
  token); for any other address, an `ssh -L` to a gateway elsewhere included, it leaves `~` for the
  gateway to expand and says the path is on the gateway's computer.
- The row is made the way an automation naming the repository makes it, so the two find each other.
  Adding one that is listed says so and changes nothing. The `#branch` an automation's target may carry
  is accepted and ignored here: the branch belongs to the spec.
- `--check` only means something for a remote: it runs `git ls-remote` with the credential the gateway
  would clone with (the vault secret `GITHUB_TOKEN` or `GITLAB_TOKEN`, or the one an automation chose),
  and **adds nothing if it cannot be reached** (exit 1, with why). It stores nothing else.
- `list` shows each repository with its automations, runs and last run; `show <repo>` takes an id, or
  a name (`acme/app`, or a folder's name) when that is unambiguous.

This is `POST /repos` ([API.md](API.md#adding-a-repository)).

### `clerq automation apply | list | show | enable | disable`

```sh
clerq automation apply -f nightly-tidy.yaml              # check it, then create or update
clerq automation apply -f nightly-tidy.yaml --enable     # and switch it on
clerq automation apply -f nightly-tidy.yaml --dry-run    # say what would change; change nothing
cat nightly-tidy.yaml | clerq automation apply -f -
```

`apply` checks the spec first (the same check the desktop editor runs, against the gateway's machine:
the repository, the agent, the models, credentials). **Errors** are printed and the command exits 1
with nothing saved; a spec error carries its position the way a compiler's does, so an editor can
jump to it. **Warnings** are printed and do not stop it.

```text
nightly-tidy.yaml:13:15: "nope" is not a valid cron expression.
```

If no automation has the spec's `name`, one is created, **switched off** unless you pass `--enable`.
If one has, it is updated, or reported unchanged when the file says what is saved (line endings and
trailing blank space do not count). Whether it is on does not change unless you pass `--enable`.

```text
Created nightly-tidy (aut_9e1c…).
nightly-tidy is switched off. Switch it on with `clerq automation enable nightly-tidy`, or apply with --enable.
```

`list` and `show <name|id>` read them back (`show <name> --source` prints the YAML as saved, nothing
else); `enable` and `disable` switch one on or off.

### `clerq run <automation> [--model <provider/model>] [--follow]`

```text
$ clerq run nightly-tidy --follow
Started run run_3f2a… of nightly-tidy.
12:00:01  Fetched the base branch
12:00:01  Opened a worktree on auto/nightly-tidy/2026-11-13-3f2a
12:00:09  Write a file (fs.write)  CHANGELOG.md  [done]
12:00:31  Gate: pnpm test
12:00:40  Committed 3ab9434
12:00:41  Pushed auto/nightly-tidy/2026-11-13-3f2a
          Run succeeded. Published: https://github.com/acme/app/pull/12
          Branch: auto/nightly-tidy/2026-11-13-3f2a
          Cost: $0.25
```

Without `--follow` it prints the run's id and returns (exit 0); the run goes on in the gateway. It
says when the run is **queued**: the limit on runs at once is reached, and it starts when a place
frees. With `--follow` it watches until the run finishes:

- Exit **0** the run succeeded, **1** it failed or was cancelled.
- A run that needs an approval (the first push of every automation does) **keeps being waited for**.
  The approval and how to answer it are printed once:

  ```text
            Waiting for approval 7: Push (git.push). Push auto/nightly-tidy/… (3 files, +40 −2) to origin.
              Approve: clerq approve 7    Deny: clerq deny 7
  ```

  With `--stop-at-approval` it stops there instead and exits **2**, for a script that should not wait
  for a person. The run goes on waiting in the gateway.

- Ctrl-C stops the watching, never the run (exit 130).
- `--model` runs with that model instead of the spec's. It is **used as chosen**: if it is
  unavailable the run fails, it does not fall back to another model. The command says so once.

How a followed run is read: the CLI listens to the gateway's event stream (`GET /events/stream`)
filtered to the run and its sub-agents, and looks at the run again when something happens, and at
least every few seconds. A gateway that restarts or a connection that drops is waited out (it tries
six times, saying so once); a refusal that will not change (an unknown run, a refused token) ends it at
once.

### `clerq logs <run> [--follow]`

Prints a run's header (state, times, model if one was chosen, branch, pull request, cost), then its
steps and tool calls in time order, in the words the desktop app's run page uses (they are the same
code: `describeStep` and `toolLabel` in `@clerq/gateway-client`). A tool call is one line, with whether
a person was asked. Give an automation's name instead of a run id for its latest run.

```sh
clerq logs run_3f2a…              # a finished or running run, as it is now
clerq logs nightly-tidy -f        # the latest run of an automation, watched to the end
```

Without `--follow` it exits 0 whatever the run's outcome (it is a viewer); with `--follow` the exit
codes are the ones of `run --follow`. A sub-agent is shown as a line with its state; `clerq logs <its
id>` shows its own steps.

### `clerq approvals`, `approve <id>`, `deny <id>`

`approvals` lists what is waiting: the number, where it was asked (`Run … of nightly-tidy`, `Chat …`,
or `Sub-agent of run …`), the tool, why, and when.

```sh
clerq approvals
clerq approve 7
clerq deny 7 --reason "Not on a Friday"
```

A decision is recorded as made by `cli`, with the reason. Deciding one that is already decided, or whose
run has ended, says so and exits 1.

## Output

- **Plain words.** Colour only when the stream is a terminal, `NO_COLOR` is unset (or empty) and
  `--no-color` was not given.
- **`--json`** writes data to **stdout** and every message (notes, warnings, errors) to **stderr**.
  Commands that give one answer print one JSON object on one line: `status` (the url, `profile`,
  `source`, `cli`, `gateway`, `compatibility`, `token.state`, never the token), `repo add` (the
  repository with `created` and `check`), `repo list`, `automation apply`
  (`{ ok, dryRun, action: created|updated|unchanged, name, id, enabled, switchedOn, errors: [{ line,
column, message }], warnings }`), `automation list|show`, `approvals`, `approve`/`deny`, `logs` without
  `--follow` (`{ type: "run", run }`, the whole run with its steps and tool calls). With `--follow`
  (`run` and `logs`) every line is one JSON object with a `type`: `started`, `run`, `step`, `tool`,
  `subagent`, `approval`, `finished`, and last `result` (`{ type: "result", runId, status, exitReason,
branch, prUrl, costUsd, exitCode }`). Clients should ignore fields and types they do not know.
- A failure leaves stdout empty (unless the failure is itself data, like an `apply` with errors) and
  says why on stderr.

## Exit codes

| Code | Meaning                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done.                                                                                                                                                           |
| 1    | It failed: a run failed or was cancelled, a spec has errors, a request was refused (including a token the gateway does not accept), or `--insecure` was needed. |
| 2    | A run is waiting for an approval (`run`/`logs` with `--follow --stop-at-approval`).                                                                             |
| 3    | The gateway cannot be used: nothing answers, it does not answer in time, it answers with a redirect, or it speaks another API version.                          |
| 64   | Bad arguments or options; nothing was sent.                                                                                                                     |
| 130  | Stopped with Ctrl-C.                                                                                                                                            |

64 is `EX_USAGE` from `sysexits.h`. It is not 2 on purpose: a typo must never read as "waiting for an
approval".

## Security notes

- **There is no `--token <value>` option.** A token on the command line stays in your shell history and
  is visible in `ps`. Use the prompt, `--token-stdin`, `--token-file`, or `CLERQ_GATEWAY_TOKEN`.
  The prompt does not echo, and needs a terminal.
- **Where the token is kept.** `login` stores it in `~/.clerq/cli.json` (0600) unless you give
  `--token-file`, which keeps only the path. It is never printed: not by `status`, not in an error,
  not under `--json`. Everything the CLI writes passes through one filter that replaces the token in use
  with `***` (a value of 8 characters or more; `login` will not save a shorter one), as a last line of
  defence.
- **Plain http.** A token sent over `http://` to another computer can be read by anyone on the way. The
  CLI refuses that, for every command, **before sending anything**, unless you pass `--insecure` (on that
  command; it is not remembered). Loopback addresses are exempt. Put TLS in front of a server instead
  ([SERVER.md](SERVER.md#putting-a-reverse-proxy-in-front-of-it)). `login` refuses before it asks for a token.
- **A redirect is never followed.** A gateway does not redirect, so an answer of 301, 302, 307 or 308
  means something else is answering at that address, and following it would send your request, a
  POST's body with it, on to wherever it points, possibly over plain http. Every request is made with
  redirects refused; the command says the address answered with a redirect and exits 3. If a proxy
  redirects http to https, use the https address.
- **A profile's token goes to its own address only** (see Connecting).
- **The token is the gateway's own.** A scoped token (a phone's, a module's) reaches a few routes
  only; `login` and `status` say so (a phone may read approvals, so they ask for something it may not). Anyone with the gateway token can do everything the CLI can, and run commands as the
  account the gateway runs as: keep `cli.json` and token files to yourself.
- `repo add --check` hands the vault's forge token to one `git ls-remote` through that command's
  environment (never its arguments), hardened as every git command the gateway runs; the answer carries
  the secret's name and whether it exists, never the value.

## What it does not do

- There is no GitHub sign-in (`clerq login` takes a gateway token) and no `clerq github` command yet:
  the gateway can connect your own GitHub App through its routes ([GITHUB.md](GITHUB.md)), and
  `repo add --check` then reaches a GitHub repository with a short-lived token of the app where it
  is installed (the answer says `github-app:<slug>/installation/<id>`), else with the vault secret.
  There is no Windows build either: the release holds `clerq` for Linux and macOS only.
- It cannot remove a repository or delete an automation (`disable` switches one off), and there is no
  command that lists runs: `automation show` and `repo show` give a last run's id, and `logs <name>` the
  latest run of an automation.
- It reads and writes nothing in a repository: a run happens in the gateway, on the gateway's machine.
- Tested against scripted agents and a real gateway in one process, and by hand against a compiled
  `clerq-server` on macOS (Bun). Not run on Linux or Windows, and not against a real forge.
