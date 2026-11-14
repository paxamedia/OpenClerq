# Running OpenClerq as a server

`clerq-server` is the OpenClerq gateway as a headless daemon: the HTTP API, the automation
scheduler and run queue, the store and the calculation engine, with no desktop app. Use it on a
Linux machine (or a Mac) that should keep running automations while nobody is logged in: a home
server, a small VPS, a build box. It is the same gateway the desktop app starts for itself, so
everything in [API.md](API.md) and [ARCHITECTURE.md](ARCHITECTURE.md#4-gateway) applies, `/v1`
and `GET /version` included.

It has no screens of its own. You talk to it over HTTP with the gateway token (`curl`,
`@clerq/gateway-client`), or with the `clerq` command line ([CLI.md](CLI.md)), which signs in with the
gateway token, adds repositories, applies and runs automations and answers approvals.

This page covers installing it (a one-line installer, release files you can check by hand, or a
container image), running it under systemd or in Docker, configuring it, where its data lives,
upgrading, what to be careful about, and how to put a reverse proxy in front of it. The installer
and the image ship with 1.0.0.

The two one-liners:

```bash
curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh
docker run -d --name openclerq -p 127.0.0.1:18790:18790 -v openclerq-data:/data ghcr.io/paxamedia/openclerq:1
```

## What you need on the machine

- Linux (x64 or arm64, with glibc: not Alpine) or macOS (Apple Silicon or Intel). CI builds, starts
  and tests the two Linux binaries on every push; the macOS ones are built by the release, and the
  Apple Silicon one is run there. Windows is not supported as a server.
- `git`, and `ssh` for repositories over ssh. Automations work in git worktrees.
- `ps` (procps). After a crash, the next start uses it to find and stop agent processes the old
  gateway left running; without it, it logs a warning and leaves them.
- The agent CLIs your automations use (`claude`, `codex`, `cursor-agent`), installed and signed in
  **for the account the server runs as**, or an API key named in the spec (`agent.api_key_secret`).
  The builtin driver needs only a provider key.
- `lsof`, if an automation uses a sandbox profile: the gateway looks for processes a command left
  behind with it.

## Installing

### The installer

```bash
curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh
```

`install.sh` is a release file like the others, one POSIX `sh` script you can read first. It works
out whether this is Linux or macOS and which CPU, downloads that release's tarball and
`SHA256SUMS` from GitHub (no API calls), refuses to go on unless the tarball matches its line in
`SHA256SUMS`, and copies **`clerq-server`, `clerq` and `clerq-calc` into one folder**:
`~/.local/bin` by default. The three go together because the server looks for `clerq-calc` next to
itself. Each file is copied under a temporary name and moved into place, so installing over a
running server is safe (the running one keeps going until you restart it). It ends by running
`clerq-server version` and `clerq --version` and printing what to do next.

What it never does: run as root unless you pass `--system`, edit your shell's startup files (it
prints a `PATH` line if the folder is not on your `PATH`), create an account, or start a service.

| Option or variable              | Meaning                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERQ_VERSION=1.0.0`           | Install that release (a leading `v` is fine). Default: the latest release.                                                                         |
| `CLERQ_INSTALL_DIR=/opt/bin`    | Install there. Default: `~/.local/bin`, or `/usr/local/bin` with `--system`.                                                                       |
| `--system`                      | Install to `/usr/local/bin` for every user. Run it as yourself: it uses `sudo` only for the copy (and refuses to run as root without it).          |
| `--systemd-user`                | Linux: also write the user unit to `~/.config/systemd/user/openclerq.service` and print the `systemctl --user` commands. It runs none of them.     |
| `--no-verify`                   | Skip the checksum check. Only for a machine with neither `sha256sum` nor `shasum`; it says so loudly. Without a tool and without this, it refuses. |
| `CLERQ_DOWNLOAD_BASE=https://…` | Take `SHA256SUMS` and the tarball from here instead of GitHub (a mirror; the tests). Must be https, or http on this computer.                      |

Options go after `sh -s --` when the script comes through a pipe:

```bash
curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh -s -- --system
curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | CLERQ_VERSION=1.0.0 sh
```

Run the same command again to upgrade. To remove it, delete the three files (and, for a user
service, `systemctl --user disable --now openclerq` and the unit). Your data in `~/.clerq` stays.

What the checksum does and does not tell you: `SHA256SUMS` is a release file too, so it shows that
the tarball you got is the one that was released and was not damaged on the way, not that GitHub
or your connection is honest. The release files are not signed. On a Mac, a file saved by a
browser carries a quarantine mark that makes Gatekeeper refuse an unsigned program; `curl` and
this installer do not set it (for a browser download, `xattr -d com.apple.quarantine <file>`).

### Check a download by hand

For anyone who does not pipe a script to a shell. The release page lists, for each version
`X.Y.Z`: `openclerq-server-X.Y.Z-<os>-<arch>.tar.gz` for `linux-x64`, `linux-arm64`,
`darwin-arm64` and `darwin-x64`, `SHA256SUMS` and `install.sh`.

```bash
v=1.0.0; target=linux-x64        # linux-x64, linux-arm64, darwin-arm64 or darwin-x64
base=https://github.com/paxamedia/OpenClerq/releases/download/v$v
curl -fsSLO "$base/SHA256SUMS" -O "$base/openclerq-server-$v-$target.tar.gz"
grep " openclerq-server-$v-$target.tar.gz\$" SHA256SUMS | sha256sum --check -     # macOS: shasum -a 256 --check -
tar -xzf "openclerq-server-$v-$target.tar.gz"
cd "openclerq-server-$v-$target"
sudo install -m 0755 clerq-server clerq clerq-calc /usr/local/bin/      # or any folder; keep the three together
```

The tarball has one folder holding the three programs, `LICENSE`, `NOTICE`, the two example units
under `systemd/` and a `README.txt`. `install -m 0755` is all the installer's copy does. With `install.sh` downloaded beside it, the same
`grep " install.sh\$" SHA256SUMS | sha256sum --check -` checks that file too.

### Build it yourself

From a checkout of this repository (Node 24, pnpm, and Rust for the engine):

```bash
pnpm install
cargo build --release --manifest-path packages/calculation-core/Cargo.toml
node scripts/package-server.js            # the tarball for this machine, in dist/server/
# or only the programs: node scripts/build-binary.js --entry apps/server/src/main.ts --name clerq-server
# for another machine: --target linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64  (bun-… for build-binary.js)
```

`package-server.js` leaves the programs in `apps/server/dist/<target>/` and
`apps/cli/dist/<target>/` and the tarball (with its SHA-256) in `dist/server/`. The server uses a
`clerq-calc` that sits next to its own executable; `CLERQ_CALC_PATH` overrides that.
Cross-compiling (the Linux binary on a Mac) works, and needs network access the first time, for Bun
to fetch the target's runtime; the engine for another target needs
`cargo build --release --target <triple>`. `build-binary.js` takes `--entry`, `--name`, `--target`,
`--out-dir`, `--calc`, `--no-calc`, `--require-calc`, `--skip-build` and `--json`; its header says
what each does.

Try it in a terminal first:

```bash
clerq-server version            # the release, the API version, the store schema
clerq-server                    # runs until Ctrl-C; the first lines say where everything is
```

## The commands

| Command                         | What it does                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `clerq-server` (or `run`)       | Starts the server and runs until SIGTERM or SIGINT.                                              |
| `clerq-server healthcheck`      | Asks `/v1/health` of the server on this machine; exit 0 if it says `ok`, else 1 with the reason. |
| `clerq-server version [--json]` | The release, the API version it serves and the newest store schema it knows. Starts nothing.     |
| `clerq-server --help`           | The commands and settings.                                                                       |

Exit codes: `0` stopped cleanly (or healthy); `1` failed to start, crashed, or did not stop within
10 s (or unhealthy); `2` a bad argument or setting.

`healthcheck` needs no `curl` and reads the same settings as the server (`CLERQ_PORT`,
`CLERQ_HOST`, and `~/.clerq/.env`). It connects to `127.0.0.1`, or to the address `CLERQ_HOST`
names when that is one particular address; for `localhost` (which may mean `127.0.0.1` or `::1`)
and for `::` it tries both. Healthy means the process is answering requests; the
store is open when `store.schema` in `GET /v1/version` is a number rather than `null`.

## Configuration

The server reads its settings from the process environment and from one file, `~/.clerq/.env`
(the one the desktop app writes provider keys to). A variable set in the environment wins over
the file. It does **not** read a `.env` from the working directory or the repository, so where it
was started from changes nothing. Under `Environment=` or `EnvironmentFile=` in a systemd unit, or
`-e` in a container, that is what is meant by "the environment".

| Variable                    | Default                      | Meaning                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOME`                      | the account's home           | The data directory is `$HOME/.clerq`. Must be an absolute path the account can write to.                                                                                                                                         |
| `CLERQ_HOST`                | `127.0.0.1`                  | Address to listen on. Anything but loopback is logged as a warning at start.                                                                                                                                                     |
| `CLERQ_PORT`                | `18790`                      | Port to listen on, 1 to 65535.                                                                                                                                                                                                   |
| `CLERQ_GATEWAY_TOKEN`       | `~/.clerq/gateway-token`     | The API token. Left out, one is generated on first start (mode 0600).                                                                                                                                                            |
| `CLERQ_CALC_PATH`           | `clerq-calc` next to the exe | The calculation engine.                                                                                                                                                                                                          |
| Provider keys               | none                         | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`; `CLERQ_LLM_PROVIDER`, `CLERQ_MODEL`, `CLERQ_OLLAMA_URL`, `CLERQ_LLM_BASE_URL` pick and point the default model. |
| `CLERQ_MAX_CONCURRENT_RUNS` | `2`                          | Automation runs at once.                                                                                                                                                                                                         |
| `CLERQ_MAX_BODY`            | `1mb`                        | Largest JSON request body. Keep a reverse proxy's limit at least this high.                                                                                                                                                      |
| `CLERQ_CORS_ORIGINS`        | the desktop's origins        | Browser origins allowed to call the API. There is no wildcard.                                                                                                                                                                   |
| `CLERQ_SSE_HEARTBEAT_MS`    | `15000`                      | How often an event stream sends a `: ping` comment.                                                                                                                                                                              |
| `CLERQ_LOG_JSON`            | off                          | `1` writes log lines as JSON, one object per line.                                                                                                                                                                               |
| `CLERQ_VAULT_KEY`           | none                         | The vault's master key, for a place with no keychain. See below.                                                                                                                                                                 |

`.env.example` in the repository lists the rest, which are the same as for the desktop app.

The server logs, as it starts: its release, the API version and store schema; the address it
listens on; the data directory; where the token is (a path, or "from `CLERQ_GATEWAY_TOKEN`",
never the token); which `clerq-calc` it uses; and a warning when it listens beyond loopback.
Everything goes to standard output and error, which systemd keeps in the journal
(`journalctl -u openclerq`) and a container runtime in its logs.

## Where things live

The data directory is `$HOME/.clerq`, and `HOME` is the only knob: there is no separate data-path
setting, so nothing can end up in two places. For the system service below, `HOME` is
`/var/lib/openclerq`, so the data is in `/var/lib/openclerq/.clerq`.

| Path (under the data directory) | What it is                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `gateway-token`                 | The API token, mode 0600. A production credential (see [Security](#security-notes)).             |
| `clerq.db`                      | The store: runs, steps, approvals, memory, triggers, audit log.                                  |
| `backups/`                      | A copy of the database taken before each upgrade, the newest five. Same privacy as the database. |
| `.env`                          | Optional settings, as above.                                                                     |
| `secrets.vault`, `vault.key`    | The encrypted vault and, on a machine with no keychain, its master key (mode 0600).              |
| `workspaces/`                   | Clones of remote repositories and the worktrees of runs in progress.                             |
| `providers.yaml`                | Optional replacement for the provider registry.                                                  |

A headless machine usually has no keychain to use, so the vault's master key is made in `vault.key`
(mode 0600), and the server logs a warning that it is there. `CLERQ_VAULT_KEY` can supply it
instead, which anything able to read the process's environment can also read. Back up the vault
and its key together, and guard that backup: the vault alone is unreadable, and the two together
are every secret in it.

**Backups.** The copies in `backups/` are for upgrades; they live beside the database, so they do
not survive losing the disk. For your own backups, copy the whole data directory. While the
server is running, take the database with SQLite (`sqlite3 clerq.db "VACUUM INTO '/backups/clerq.db'"`),
which is consistent under load. After a clean stop the write-ahead log has been folded into
`clerq.db`, so the file alone is the database. Restoring a copy is described in
[UPGRADING.md](UPGRADING.md#downgrades-are-refused).

## Running it under systemd

Two example units are in [`apps/server/systemd/`](../apps/server/systemd/). Read the comments in
them; they say what each line is for and which ones were left out on purpose.

### As a system service

A dedicated account, its own state directory, and a read-only view of the rest of the system.
The programs are the ones from the [release tarball](#installing) (`install.sh --system` puts
them in `/usr/local/bin`, which is what the unit's `ExecStart` names; the unit is in the tarball
under `systemd/` and in this repository):

```bash
sudo useradd --system --user-group --no-create-home --home-dir /var/lib/openclerq \
  --shell /usr/sbin/nologin openclerq
sudo install -m 0755 clerq-server clerq clerq-calc /usr/local/bin/
sudo install -m 0644 apps/server/systemd/openclerq.service /etc/systemd/system/openclerq.service
sudo systemctl daemon-reload
sudo systemctl enable --now openclerq
```

The unit makes `/var/lib/openclerq` (the account's home, and the data directory's parent) owned by
the service account with mode 0700 (`StateDirectoryMode=0700`; systemd's default would be 0755,
which lets every user on the machine list the account's `~/.ssh` and `~/.gitconfig`). If you
made the directory yourself first, for example with `useradd --create-home`, check it with
`ls -ld /var/lib/openclerq` and run `sudo chmod 0700 /var/lib/openclerq` if it is wider.

The agent CLIs must be installed where that account finds them (on its `PATH`, or under
`/var/lib/openclerq`) and signed in as that account (for example, run `sudo -u openclerq -H claude` once and sign in).

The token is generated on first start. Read it with
`sudo cat /var/lib/openclerq/.clerq/gateway-token`.

Settings that are not secret go in the unit (`sudo systemctl edit openclerq`, then
`[Service]` and `Environment=CLERQ_PORT=8080`). Provider keys and a fixed token go in
`/etc/openclerq/openclerq.env` (`root:root`, mode 0600, one `NAME=value` per line), which the
unit reads and which only root can see. Do not put them in the unit file itself: it is readable
by every user.

What the unit does at stop: systemd sends SIGTERM to `clerq-server` alone (`KillMode=mixed`).
At once it stops starting anything (a run waiting for a slot stays queued for the next start),
refuses new requests with 503 and ends the open event streams; requests already under way get up
to 8 s to finish; then it closes the store and exits 0 (or exits 1 if that has not happened by 10 s). Whatever agent
processes remain are then killed by systemd. A chat reply still being generated when the 8 s are
over is lost: the message you sent is kept, the reply is not stored, and the run is settled as
interrupted at the next start; send the message again. A failed start is retried every 5 s, at
most five times in five minutes, and not at all after exit 2.

**Repositories outside the state directory.** The unit makes the system read-only to the service
(`ProtectSystem=strict`); it can write `/var/lib/openclerq` and its private `/tmp`. Clones of
`github:` and `gitlab:` repositories and every run's worktree are under `workspaces/`, so they
work as they are. A local repository elsewhere needs `ReadWritePaths=` for it (a run's worktree
is added to the repository's own `.git`), or the run fails with "Read-only file system":

```ini
[Service]
ReadWritePaths=/srv/repos /home/alice/code
```

The service account must also own the repository, or have write access to it by group, and git
must be allowed to use it (`git config --global --add safe.directory /srv/repos/app`, as that account).

### As a user service

To run as yourself, with your own `~/.clerq`, your repositories and your signed-in CLIs. That is
the desktop app's data directory too, and two gateways must not share a data directory, so do not
run both at once against it (a second gateway's start-up recovery can settle the first one's runs
as abandoned, because it cannot always tell that their gateway is still alive):

```bash
mkdir -p ~/.local/bin ~/.config/systemd/user
install -m 0755 clerq-server clerq clerq-calc ~/.local/bin/
install -m 0644 apps/server/systemd/openclerq-user.service ~/.config/systemd/user/openclerq.service
systemctl --user daemon-reload
systemctl --user enable --now openclerq
loginctl enable-linger "$USER"    # keep it running after you log out
journalctl --user -u openclerq -f
```

Agents then run as you, with nothing confining them beyond what you already have.
`install.sh --systemd-user` does the first three lines (it writes the unit with the install
folder in `ExecStart`) and prints the rest without running it.

## Upgrading

Replace the binaries and restart. The database is brought up to date by the new version, after a
copy is written to `backups/`; an older version refuses a database from a newer one. The
details, including the way back, are in [UPGRADING.md](UPGRADING.md). In a container, pull the
new image and start a new container on the same volume ([above](#running-it-in-docker)).

```bash
curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh -s -- --system
sudo systemctl restart openclerq
clerq-server version
```

(For a user service, the installer without `--system`, then `systemctl --user restart openclerq`.
By hand: `sudo install -m 0755 clerq-server clerq clerq-calc /usr/local/bin/` from the new tarball.)

A restart stops the old process (SIGTERM, as above) before starting the new one. A run that was
in progress is not waited for: its lease stops being renewed, and the new process, on starting,
puts it back in the queue if its spec allows a retry (`retry`) and it had not got as far as
publishing, or fails it as interrupted, and removes its worktree. Runs waiting in the queue stay
queued and go on. Pick a quiet moment if a run matters.

Keep room on the disk for a copy of `clerq.db`: an upgrade that cannot make its copy changes
nothing and does not start.

## Security notes

- **The token is a production credential.** Whoever has it can run agents on this machine with
  the service account's powers, read memory and run history, and change settings. Treat it like
  an SSH key: it is mode 0600 in a 0700 directory, and should not be pasted into tickets, shell
  history, a world-readable unit file or a chat. To rotate it, delete `gateway-token` (or change
  `CLERQ_GATEWAY_TOKEN`), restart, and give the new one to every client.
- **Do not expose the port directly.** The default is loopback. Bind a wider address only behind
  TLS (a [reverse proxy](#putting-a-reverse-proxy-in-front)), a VPN or a firewall that lets only
  your clients in. The gateway speaks plain HTTP and does not limit how often a wrong token may be tried (the token
  is 256 bits, but that is not a reason to leave the port open).
- **Agents run as the service account, with its permissions.** They can read everything it can,
  including `gateway-token`, `.env` and the vault key in its data directory, and reach the network
  as it can. The unit's hardening confines the _service_ (what it can write, what it can do to the
  kernel); it is not a sandbox for an automation.
- **Native is the default; isolation is opt-in, per automation.** An automation that should be
  confined asks for it with `sandbox.profile` in its spec. `seatbelt` is macOS only, so on Linux the
  choices are `native` and `container`. The container profile has not yet been run against a real
  Docker or Podman engine; read [SECURITY.md](SECURITY.md#21-automation-sandbox-profiles) before
  relying on it.
- **Do not give a containerised server the host's Docker socket.** The container profile starts
  containers through the engine it finds, at the host's paths, so a gateway in a container would need
  the engine's socket (access to which is root on the host) and the same state directory mounted at
  the same path on both sides. That is not recommended. Run the server on the host, or a VM, if its
  automations use the container profile.
- **Updates are yours to apply.** The server does not update itself.

## Putting a reverse proxy in front

The gateway serves plain HTTP on loopback. For access from other machines, terminate TLS in a
proxy on the same host and send it to `127.0.0.1:18790`. The examples below are **examples to
adapt**: they have not been run against a live proxy as part of OpenClerq's tests, so check them
with `caddy validate` or `nginx -t` first.

What any proxy in front of it must do:

- **Pass event streams through unbuffered.** `GET /v1/events/stream`, `GET /v1/events`,
  `GET /v1/logs/stream` and the chat's `POST /v1/sessions/:id/send` answer with
  `text/event-stream` and stay open. Turn response buffering off for them, allow read timeouts of
  an hour or more (the gateway sends a `: ping` every 15 s, so an idle timeout above that is
  enough), and do not compress them: a compressing proxy holds bytes back.
- **Allow a request body at least as large as `CLERQ_MAX_BODY`** (1 MB by default). nginx's own
  default is the same, and Caddy has no limit unless you set one.
- **Forward `Authorization` and `Clerq-Api-Version`** and do not cache anything under `/v1/`,
  `GET /v1/version` in particular.
- **Keep the token to itself.** Forward it to the gateway and nowhere else: no mirroring, no
  forward-auth subrequest, no CDN in between that logs or caches. Do not log request headers.
  The event streams also accept `?token=`, because a browser's `EventSource` cannot set a header,
  so do not log query strings either (the nginx example logs `$uri`, not `$request_uri`).
- **Do not put your own `Authorization` header on top.** The gateway reads that header for its
  token, so basic auth at the proxy would collide with it. If you want a second layer, use client
  certificates, an IP allow-list or a VPN.
- **Proxy only what you use.** Everything the API serves is under `/v1/`. The bare paths without the
  prefix are aliases that exist for older clients, and `/webhook/:id` and a module's own routes
  (`/api/modules/…`) sit outside it. If your clients speak `/v1` only, expose that prefix and
  nothing else.

The gateway does not read `X-Forwarded-*` headers, so the proxy's address is the client address
as far as the gateway is concerned.

If you use Remote mode for phones, `PUT /v1/remote { "enabled": true, "publicUrl": "https://…" }`
takes the HTTPS address of this proxy; plain HTTP is refused except to localhost.

### Caddy

```caddyfile
openclerq.example.com {
	# Caddy obtains and renews the certificate for a public name by itself.
	handle /v1/* {
		reverse_proxy 127.0.0.1:18790 {
			# Send event-stream bytes as they arrive, with no buffering.
			flush_interval -1
		}
		request_body {
			max_size 1MB
		}
	}
	respond 404

	# If you turn on access logs, keep tokens out of them.
	log {
		format filter {
			wrap console
			fields {
				request>headers>Authorization delete
				request>uri query {
					delete token
				}
			}
		}
	}
}
```

Caddy compresses only if you add `encode` and sets no timeout on a proxied response unless you
configure one (`transport http { … }`); leave both off for `/v1/*`.

### nginx

```nginx
# http { … } context: a log format without the query string, where ?token= can appear.
log_format openclerq '$remote_addr [$time_local] "$request_method $uri $server_protocol" '
                     '$status $body_bytes_sent';

server {
    listen 80;
    server_name openclerq.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;          # nginx 1.25.1 and later also accept: http2 on;
    server_name openclerq.example.com;

    ssl_certificate     /etc/letsencrypt/live/openclerq.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openclerq.example.com/privkey.pem;

    access_log /var/log/nginx/openclerq.access.log openclerq;

    # The gateway's own limit is CLERQ_MAX_BODY (1mb); this must not be lower.
    client_max_body_size 1m;

    location /v1/ {
        proxy_pass http://127.0.0.1:18790;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;

        # Event streams: pass bytes as they arrive, never compress, wait a long time.
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        return 404;
    }
}
```

Authorization and `Clerq-Api-Version` reach the gateway without any line for them: nginx passes
request headers on unless told not to.

nginx's _error_ log is a second place a query string can land: on a 502 or an upstream timeout it
records the full request line, so `?token=` on an event-stream address ends up there. The
`access_log` format above does not help with it. Where a client can send a header (the CLI, a script,
anything that is not a browser's `EventSource`), send the token in `Authorization` and not in the
address; and keep `error_log` at `crit` for this server (`error_log /var/log/nginx/openclerq.error.log crit;`),
which leaves out those upstream failures, or keep that log as private as the token.

## Troubleshooting

| You see                                                                         | Because                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Not started: This database was written by a newer OpenClerq …`, exit 1         | A newer version used this data directory. Install that version again, or restore a backup as [UPGRADING.md](UPGRADING.md#downgrades-are-refused) describes. `backups/` is in the data directory; systemd stops retrying after five failures. |
| `Not started: … EADDRINUSE`, exit 1                                             | Another process (or a second copy of the server) has `CLERQ_PORT`. Set another port.                                                                                                                                                         |
| `CLERQ_PORT must be a port number …`, `HOME must be an absolute path …`, exit 2 | A setting is wrong; the message says which. Starting again changes nothing.                                                                                                                                                                  |
| `Not started: Could not back up the database before upgrading it …`             | The disk is full or the data directory is not writable. Nothing was changed.                                                                                                                                                                 |
| A run fails with "Read-only file system"                                        | The repository is outside the state directory; add `ReadWritePaths=` ([above](#as-a-system-service)).                                                                                                                                        |
| `Calculation engine not found … ` at start                                      | `clerq-calc` is not next to `clerq-server` and `CLERQ_CALC_PATH` is not set. Calculations fail until it is.                                                                                                                                  |
| `install.sh`: `could not download SHA256SUMS … may not be uploaded yet`         | The release exists but its server files are not on it (they follow the desktop installers by a few minutes), or `CLERQ_VERSION` names a release that has none. Try again, or name an older version.                                          |
| `install.sh`: `the download does not match SHA256SUMS … Nothing was installed`  | The file was damaged or replaced on the way. Try again; if it persists, do not use that file.                                                                                                                                                |
| `Did not stop within 10 s; exiting`, exit 1                                     | Something held the shutdown. The next start recovers whatever was in flight.                                                                                                                                                                 |
| `healthcheck` is healthy but `store.schema` in `/v1/version` is `null`          | The store could not be opened (the log says why). The gateway answers, but memory and run history are unavailable.                                                                                                                           |

## Running it in Docker

The image is `ghcr.io/paxamedia/openclerq`, for `linux/amd64` and `linux/arm64`, built from
[`apps/server/Dockerfile`](../apps/server/Dockerfile). It holds `clerq-server`, the `clerq`
command line and `clerq-calc` on Debian 12, with `git`, `ssh`, `ps` (procps) and CA certificates,
under `tini`, as a user that is not root.

```bash
docker run -d --name openclerq -p 127.0.0.1:18790:18790 -v openclerq-data:/data ghcr.io/paxamedia/openclerq:1
```

Tags: `1.0.0` (that release, for good), `1` (the newest 1.x) and `latest`. A pre-release such as
`1.0.0-rc.1` has its own tag and moves neither of the other two. Pin the full version if you want
upgrades to be your decision.

**The token.** The server makes one on first start. Read it with

```bash
docker exec openclerq cat /data/.clerq/gateway-token
```

or choose your own with `-e CLERQ_GATEWAY_TOKEN=<64 hex characters from openssl rand -hex 32>`.
A token passed with `-e` is visible to anyone who can run `docker inspect` on the container, which
is anyone with access to the Docker socket; if that matters, put `CLERQ_GATEWAY_TOKEN=…` in a
`.env` file at `/data/.clerq/.env` inside the volume instead. The server's log says where the
token is and never shows it.

**Reaching it from the command line.** Inside the container, `clerq` needs no setup, because the
token file is in its own home:

```bash
docker exec openclerq clerq status
```

From the machine that runs Docker, with the `clerq` command line installed there (the installer
above puts it in the same tarball):

```bash
docker exec openclerq cat /data/.clerq/gateway-token | clerq login http://127.0.0.1:18790 --token-stdin
clerq status
```

If something else on the host already uses port 18790 (the desktop app, a `clerq-server` of your
own), publish another host port (`-p 127.0.0.1:18791:18790`), log in to that address, and give it
a profile of its own (`clerq login http://127.0.0.1:18791 --profile docker --token-stdin`, then
`--profile docker` on later commands). The CLI sends a saved token only to the address it was
saved for ([CLI.md](CLI.md)). From another machine, put a reverse proxy in front and log in to its
`https://` address.

**Why the example publishes on `127.0.0.1` only.** The server inside the container listens on
every interface of the container (`CLERQ_HOST=0.0.0.0`), because a container's own network is
its boundary. `-p 18790:18790` with no address would publish that on every interface of the host,
past a host firewall such as `ufw` (Docker writes its own rules ahead of it), as
plain HTTP with only the token between the internet and your agents. With `127.0.0.1` the port is
reachable from the machine itself, and anything that should reach it from outside goes through a
[reverse proxy](#putting-a-reverse-proxy-in-front) that terminates TLS and talks to
`127.0.0.1:18790`. The same is true of a Compose file or `--network host`: bind the published port
to loopback.

**What is in the image.** `clerq-server`, `clerq` and `clerq-calc` in `/usr/local/bin`; `git`,
`openssh-client`, `procps`, `ca-certificates`, `tini`; nothing else: no Node.js, no `curl`, no
agent CLI. The process runs as `openclerq`, uid and gid 10001, home `/data`, with a passwd entry
(ssh needs one). `HOME=/data`, so the data directory is `/data/.clerq` and the whole of it is on
the volume: the database, `backups/`, the token, the vault and its key, clones and worktrees. The
image's health check is `clerq-server healthcheck`, which `docker ps` shows as `healthy` once the
server answers; it takes up to 30 s to run the first time, and has 60 s of grace at start for a
slow migration.

**Stopping and upgrading.** `docker stop` sends SIGTERM to `tini`, which passes it to the server;
a clean stop takes milliseconds (a chat reply still being written can take up to 8 s) and the
container's exit code is 0. Docker's default wait before it kills is 10 s, the same as the server's
own limit, so give it room: `--stop-timeout 15` (Compose: `stop_grace_period: 15s`). To upgrade,
pull the new image and start a new container on the same volume:

```bash
docker pull ghcr.io/paxamedia/openclerq:1
docker stop --time 15 openclerq && docker rm openclerq
docker run -d --name openclerq --stop-timeout 15 -p 127.0.0.1:18790:18790 -v openclerq-data:/data ghcr.io/paxamedia/openclerq:1
```

The new version brings the database up to date after copying it to `/data/.clerq/backups`, as
described in [Upgrading](#upgrading). A container started on a database from a newer version exits
with code 1 and says why in `docker logs openclerq`; see
[UPGRADING.md](UPGRADING.md#downgrades-are-refused). The backups are in the volume, so they
do not survive losing it: copy `/data` somewhere else for a real backup, as in
[Where things live](#where-things-live).

A Compose file for the same thing (an example to adapt; not run as part of OpenClerq's tests):

```yaml
services:
  openclerq:
    image: ghcr.io/paxamedia/openclerq:1
    restart: unless-stopped
    ports:
      - '127.0.0.1:18790:18790'
    volumes:
      - openclerq-data:/data
    stop_grace_period: 15s
    # environment:
    #   ANTHROPIC_API_KEY: ...    # or put provider keys in /data/.clerq/.env
volumes:
  openclerq-data:
```

**A folder instead of a named volume.** A bind mount (`-v /srv/openclerq:/data`) keeps whatever
owner the folder has, and the server runs as uid 10001, so make it that user's first:
`sudo install -d -o 10001 -g 10001 -m 0700 /srv/openclerq`. Without that the server cannot create
its data directory and does not start. A first start on an empty named volume needs nothing: the
image's own `/data`, owned by 10001 with mode 0700, is what the volume starts from. Do not share one
`/data` between two containers (or with a desktop app): one gateway per data directory.

**Repositories.** `github:` and `gitlab:` targets are cloned into `/data/.clerq/workspaces`, with a
token from the vault (`GITHUB_TOKEN`, `GITLAB_TOKEN`) or the spec's `publish.token_secret`. A
repository on the host is reached by mounting it (`-v /srv/repos/app:/repos/app`), which must be
writable by uid 10001 because a run adds its worktree to the repository's own `.git`; git must also
trust it (`docker exec openclerq git config --global --add safe.directory /repos/app`).

### Agents in the container

- **They run as uid 10001**, inside the container, with the permissions of that user and the
  container's network: the same model as the systemd service, except the host is one layer further
  away. They can read everything the server's own user can, including the token file and the vault
  key in `/data/.clerq` ([Security notes](#security-notes)). The container confines the server from
  the host; it does not make an automation safe from the server.
- **The `builtin` driver works out of the box.** It needs only a model: pass a provider key
  (`-e ANTHROPIC_API_KEY=…`, or `OPENAI_API_KEY` and the others in the table above), or
  `CLERQ_OLLAMA_URL` for a model server on the network.
- **The CLI drivers (`claude-code`, `codex`, `cursor-agent`) need their program in the image**, which
  the image does not contain. Make a derived image and name an API key in the spec
  (`agent.api_key_secret`) so no sign-in is needed. This is an example of the idea; it has not been
  built or run, and the install step is the vendor's, so follow its current instructions:

  ```dockerfile
  FROM ghcr.io/paxamedia/openclerq:1
  USER root
  # Node.js from the official image, for a CLI that installs with npm
  COPY --from=node:24-bookworm-slim /usr/local/ /usr/local/
  RUN npm install -g @anthropic-ai/claude-code
  USER 10001
  ```

  A CLI's own state (`~/.claude`, `~/.codex`) would live under `/data`, so a sign-in made with
  `docker exec -it openclerq claude` would persist in the volume.

- **The `container` sandbox profile is not available inside this container, and giving it what it
  needs is not recommended.** That profile starts a Docker or Podman container for each run, with the
  worktree mounted at the same path the host sees. A gateway in a container would need the host's
  Docker socket mounted into it (which is root on the host for anything that can use it, an agent
  included, and defeats the isolation the profile is for) and its state directory mounted at the
  same path on both sides. If an automation needs the container profile, run the server on the host
  or in a VM, under systemd. The `seatbelt` profile is macOS only, so in this image automations run
  as `native`.
