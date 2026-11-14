# Threat model

**Status:** OpenClerq 1.0.0, 2026-11-14.

This is what OpenClerq 1.0 is built to defend, against whom, where each defence stops, and what you
decide. [SECURITY.md](SECURITY.md) holds the mechanisms, the binding rules and the release
checklist; this page holds the reasoning and the limits. Where a mechanism is described there, this
page links it rather than repeating it. Where a limit is described here, it is a limit of the code as
it is: every claim was checked against the code and the tests, and what was not run is said so in
[What was not verified](#what-was-not-verified).

## In short

OpenClerq takes instructions in natural language, gives them to a model, and lets the result run
programs, edit files and publish branches **as you**. Everything below follows from that.

- **The default is your account.** Out of the box an automation, a plugin and a chat with a folder
  attached can do what you can do on that computer and on the network. Isolation is something you
  turn on, per automation; plugin checks and skill checks are one switch you turn on. This was a
  decision (2026-11-13): sandboxing is opt-in, not the default.
- **The token is the key to the house.** Whoever holds the gateway token can run agents on the
  machine, read memory and history, and change settings. It is a bearer credential on plain HTTP.
- **Nothing stops a model from believing what it reads.** Prompt injection is not solved, here or
  anywhere. What OpenClerq does is limit what a model that has been fooled can reach: the tools it is
  given, what waits for a person, where its network goes, what a run may publish. Those limits are
  strong only where you chose them.
- **A plugin is code in the gateway; a skill is text for a model.** Approving either records what you
  reviewed and refuses to run something else. It does not confine either one. See
  [the trust boundary](#the-plugin-and-skill-trust-boundary).

| Switch                                   | Default                 | When on                                                                                                                                                                        | Read                                                        |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `sandbox.profile` in an automation spec  | `native` (no isolation) | `seatbelt` (macOS) or `container`: the agent, its commands and the gates run confined, with egress to the hosts the spec names                                                 | [Sandbox profiles](#sandbox-profiles)                       |
| A chat's access level                    | Full access             | Ask before changes, Read only, or Sandboxed (macOS)                                                                                                                            | [Managed chat access levels](#managed-chat-access-levels)   |
| `plugins.enforce` (Settings → Plugins)   | off                     | An unapproved or changed plugin is not loaded, what a plugin does through its context is checked against what it declared, only trusted skills are used and they narrow a chat | [Plugins](#plugins), [Skills](#skills)                      |
| `approvals.push` in an automation spec   | `manual`                | `auto`: a push no longer waits for you, except the automation's first push, which always waits                                                                                 | [SECURITY.md](SECURITY.md#2-what-is-protected-today)        |
| `memory.read` and `memory.include_agent` | off                     | An automation reads saved notes of the types you list, and, with `include_agent`, notes an agent wrote                                                                         | [Memory](#memory)                                           |
| Fallback models (Settings)               | empty                   | A prompt may go to another provider when the first is unavailable                                                                                                              | [Fallbacks](#fallbacks-sending-prompts-to-another-provider) |
| Remote mode, `CLERQ_HOST`                | loopback only           | Reachable from other machines, behind your TLS                                                                                                                                 | [Server mode](#server-mode-behind-a-reverse-proxy)          |

## Assets

What there is to protect, where it lives, and the first thing that protects it. Everything under
`~/.clerq` (or the server's data directory) is private to the account: the directory is mode 0700
and files that hold keys, conversations or secrets are 0600. **That is an account boundary, not
encryption at rest**, except for the vault.

| Asset                                                    | Where it is                                                                                                                                                       | What protects it                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your repositories, and the account OpenClerq runs as** | Your disk and your forge accounts. Whatever the gateway's account can read, write, run and reach                                                                  | Nothing, by default: a `native` run is you. With a profile: a worktree of its own, writes only there, egress limited ([profiles](#sandbox-profiles)). Pushes wait for you unless the spec says otherwise; a pull request is a draft |
| **The vault and its key**                                | Secrets in the store, AES-256-GCM per entry. The key is in the OS keychain (macOS Keychain, libsecret, DPAPI), or `~/.clerq/vault.key` (0600) where there is none | Encryption at rest, names-only listing, an audit file. A process running as you can read the key file, or ask the keychain, as you can                                                                                              |
| **The gateway token**                                    | `~/.clerq/gateway-token` (0600), or `CLERQ_GATEWAY_TOKEN`. The CLI may keep a copy in `~/.clerq/cli.json` (0600)                                                  | Constant-time comparison, loopback by default, never in a log line, a run record or an agent's environment. Readable by anything running as you                                                                                     |
| **Provider keys**                                        | The vault, or the gateway's environment. A CLI agent's key is in its own environment                                                                              | Never in a prompt; redacted from stored runs; the builtin agent's key goes only to its primary model's provider. A `native` agent can read the environment files you keep                                                           |
| **GitHub App private key and tokens**                    | The key and client secret in the vault; your sign-in tokens in one reserved vault entry; installation tokens in memory only                                       | Installation tokens last at most an hour, cover one repository and one purpose, are revoked when the run ends. The key itself is long-lived and makes tokens for every repository the app is installed on ([GitHub](#github-app))   |
| **Memory**                                               | The store (`clerq.db`), plain text                                                                                                                                | The account boundary; origin labels; what an automation may read is set by its spec ([Memory](#memory))                                                                                                                             |
| **Chat history**                                         | The store, plain text, including every prompt and answer, and in the backups the store makes before an upgrade                                                    | The account boundary. Backups are 0600 in a 0700 folder. Deleting a chat deletes its messages; old backups still hold them                                                                                                          |
| **The updater signing key**                              | GitHub Actions secrets of the project, with the owner's own offline backup                                                                                        | Used only by the release workflow, checked against the key in the app on every push to `main`. It cannot be revoked from an installed app ([Updates](#updater-signing-and-download-checks))                                         |

The gateway's own authority is an asset too: it can start processes, so whoever controls it controls
a shell on the machine.

## Actors

Who or what is assumed to try to do harm, and how much it can already do.

| Actor                            | What it can already do                                                                                                                                              | What OpenClerq assumes and does about it                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The operator** (you)           | Everything. Holds the gateway token, decides every switch above, approves plugins and skills, answers approvals                                                     | Trusted, and fallible. The defaults ask before the dangerous things (an automation starts off, a push waits, a model-drafted automation is saved off and dry-run first, a plugin change needs a new approval). Nothing here protects you from turning every check off                 |
| **A model or an agent**          | Whatever its tools and its process allow. It reads text from many places and may act on any of it ([prompt injection](#prompt-injection-where-the-text-comes-from)) | Not adversarial by design but **assumed steerable by anything it reads**, and simply wrong at times, and destructive at scale on a schedule. Defences are the tools it is offered, approvals, the profile, egress limits, budgets, draft pull requests, the kill switch               |
| **A plugin author**              | Code running in the gateway process, with the gateway's access, once you enable the plugin                                                                          | Not defended against in the code ([plugins](#plugins)). The defence is your review and the approval's hash: what you approved is what runs, and a change needs approving again                                                                                                        |
| **A skill author**               | Instructions a model follows, in a chat or an automation that uses the skill                                                                                        | A skill is text: it runs no code, but a model with tools may do what it says. The defence is your review, the checksum, and with enforcement on, narrowing ([skills](#skills))                                                                                                        |
| **Another local account**        | Connect to the loopback port, read what file modes allow, see process lists                                                                                         | Kept out by file modes (`~/.clerq` is 0700) and the token. Not defended: root, and anything running as your own account (out of scope)                                                                                                                                                |
| **A network attacker**           | Reach the gateway's port if it is exposed; read plain HTTP on the path; reach a proxy's logs                                                                        | The gateway binds loopback unless you say otherwise and warns when you do. Every route but a few needs the token. It speaks plain HTTP and has no rate limit on wrong tokens: put TLS and a firewall in front ([server mode](#server-mode-behind-a-reverse-proxy))                    |
| **A paired device** (a phone)    | The mobile API set with its own token: status, runs, approvals (so it can answer them), pause and resume, the inbox, search, records (read)                         | A device token expires after 30 days unused, stops working when remote mode is off, and is revoked at once with `DELETE /devices/:id`. It never holds the gateway token and cannot reach secrets, plugins, settings or the vault ([tokens](#gateway-token-tenants-and-scoped-tokens)) |
| **A GitHub App installation**    | Whatever your app was granted (contents and pull requests: write, metadata: read) on the repositories it is installed on                                            | Tokens are made per repository, per purpose and per run, revoked when the run ends. Whoever holds the app's private key can make tokens for every repository it is installed on, and GitHub itself is a party you trust ([GitHub App](#github-app))                                   |
| **A dependency or a repository** | Text and code that an agent reads and a gate runs                                                                                                                   | Repository content is untrusted input. A gate runs code the agent may have changed. Under a profile the gates run on a fresh checkout of the run's commit, confined; under `native` they run as you                                                                                   |

Out of scope: a local attacker who already has your OS account (anyone who can read `~/.clerq` as
you can read what the gateway can), a malicious model provider (it sees your prompts; you chose it),
physical access, and a flaw in the OS, the container runtime, the browser engine or the language
runtime.

### Prompt injection: where the text comes from

A model cannot tell instructions from data. The places text reaches it, each of which someone other
than you may have written:

- **Repository content**: a README, an issue, a changelog, a code comment, a dependency's description, the output of a test. The agent reads the repository by design.
- **Pasted content** in a chat, and web pages or files you ask it to read.
- **Memory**: a saved note may hold text an agent wrote after reading something else ([Memory](#memory)).
- **Skills**: a skill is instructions on purpose; its text is as trusted as its author ([Skills](#skills)).
- **Tool and command output** fed back into the loop, a sub-agent's answer, a summary written by a model.
- **A plugin's text**: a page, a skill or a reply a plugin supplies.

What stands between that text and harm: **what the model can reach** (no file or shell tools unless
you attach a folder; a profile's limits; an allowed-tools list; policy decides every tool call), **what
waits for you** (a push; in Ask before changes, every write and command; a preference or procedure
note; an automation's first push), **where its network goes** (under a profile), **how far it can
go unattended** (budgets, one run per automation, the kill switch), and **what it can publish** (a
new branch, a draft pull request). Treat repository content as hostile when you choose what to
attach and what to automate.

## Trust boundaries

For each boundary: what it defends against, what it does not, and what you choose. The SECURITY
rows named under "Read" have the mechanisms.

### Gateway token, tenants, and scoped tokens

**Defends against** a caller that does not hold a token (network attacker, another local account, a
web page in your browser: CORS is an allow-list with no wildcard) and against a scoped holder
reaching what its scopes do not name.

- Every route but a few requires a bearer token. The public ones are `GET /health` and `GET /version` (versions only), `POST /devices/pair` (a single-use code), `GET /github/app/callback` (a single-use state) and a module's static UI files (`GET /api/modules/<id>/ui/*`). The token is 256 random bits, compared in constant time.
- **Scoped tokens** reach only what they name and are stored as hashes. A **module** token reaches its module's routes and the core endpoints its manifest declares, lasts 15 minutes by default and is revoked when the plugin stops. A **device** token reaches only the mobile set. A **tenant** token reaches only what is kept per tenant. None reaches the token, device, remote, vault, GitHub, plugin or skill-decision routes, the unfiltered event stream or the logs: those are for the gateway token only.

**Does not defend against:**

- Anyone who holds the gateway token, or can read the file it is in: that is every process running as you, every `native` agent, every in-process plugin, and a chat with Full access. An approved plugin can call the approval routes with it.
- Guessing: there is **no limit on wrong tokens** (the token is 256 bits; the only limit is on pairing codes, 30 wrong a minute). The listener speaks plain HTTP.
- Leaks outside the file: `CLERQ_GATEWAY_TOKEN` in a process environment or `docker inspect`, `?token=` on the three event streams (a proxy that logs query strings keeps it), `~/.clerq/cli.json` (plaintext, 0600; `--token-file` keeps only a path).
- A scope names a route, not an object: a token that may `POST /approvals/:id/approve` can answer any pending approval, one that may `POST /runs/:id/cancel` can cancel any run. The chat console's module token is an example.
- Tenants are kept apart in the gateway's queries, not in the process or the database: module code shares both, so a module's raw SQL must filter on its tenant itself. There is no row-level security.
- `GET /routing` is not operator-only, so a module token whose manifest names it passes the CLI's "is this the gateway's token" probe.

**Your choices:** keep the gateway on loopback; rotate the token (delete the file or change the variable, restart); give clients the narrowest token that works (a phone is paired, not given the token); prefer `--token-file` to a token in a profile.

Read: [SECURITY §2](SECURITY.md#2-what-is-protected-today) (the gateway, scoped tokens, tenants, remote mode, device tokens), [API.md](API.md#who-may-call).

### Sandbox profiles

Applies to an automation run: the agent process (a CLI), every command the builtin agent runs and its
file tools, and the gates. **`native` is the default.**

| Profile                | Defends against                                                                                                                                                                                                                                                                                                                                          | Does not defend against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **native** (default)   | Nothing. The agent's own permission mode (Claude Code), Codex's `workspace-write` sandbox and Cursor's command allowlist apply, as each tool defines them                                                                                                                                                                                                | Everything: the agent and the gates run as you, with your files and your network. Gates execute code the agent may have changed before anyone has seen the diff. The builtin agent's file tools check paths in the gateway, which a concurrently running command can race. The run records that it was unisolated                                                                                                                                                                                                                                    |
| **seatbelt** (macOS)   | Writes outside the run's worktree and a private state home; reads of `~/.clerq`, `~/.ssh`, cloud and forge credentials, keychains, browser profiles and the other agent CLIs' state; network except the egress proxy; Unix-domain sockets; starting apps through LaunchServices; the agent changing git's config, hooks, refs or the worktree's pointers | Reading any other file in your home (documents, other projects, shell history). The egress limit is by **port, not host**: a process that connects straight to an outside host on the proxy's port is not stopped. The proxy lets a listed name through whatever it resolves to, private addresses included. A process that leaves the run's process group and directories and holds no tag file (any process a Node-based CLI starts, with `setsid`) can outlive the run. Apple has deprecated `sandbox-exec`. Cursor's CLI was not tested under it |
| **container** (Docker) | A filesystem of only the worktree and its git entry, at their host paths; the host's uid; no capabilities; `no-new-privileges`; a read-only root; **egress per host** through an internal network and a proxy container; a cancel, a timeout or a crash leaves nothing behind (by name and label)                                                        | The kernel is shared and the **image is trusted**: whatever it holds runs, and the engine pulls it outside the egress limit. As under seatbelt, the proxy lets a listed name through whatever it resolves to. Resource limits (CPU, memory, processes) exist in the library, and specs do not set them. A server in a container cannot offer the profile without the host's engine socket, which is root on the host: not supported                                                                                                                  |

In every profile:

- **What the agent reads can leave through the hosts you list** and through the agent's own model provider, and a CLI's API key is in its environment. List only hosts you would let it send the repository to. Without a profile (`native`), the network is open.
- **A tracked file the agent changes** (a workflow, a build script, a test, `.gitattributes`) is in the commit and runs wherever that branch is built. Pull requests are drafts for this reason.
- **A secret the agent writes into a file is still in the commit.** The diff, the gate output, the commit message and the pull request are redacted of the vault values the run uses (literal, six characters or more; an encoded or split value is not found), and a diff that holds one makes the push wait for you.
- Under a profile the gateway's own git (commit, diff, push) is hardened and runs outside, after the agent and the gates, and only once nothing they started is still running; the commit is built from the files, never from the agent's index.
- **Under a profile the gates run on a fresh checkout of the run's commit**, so files git ignores (`node_modules`, build output) that the agent made are not there: a spec's gates must install what they need, and the profile's network must allow the registry they use ([the spec reference](ROADMAP.md#4-automations-as-code)).

**Your choices:** `sandbox.profile: seatbelt` or `container` per spec, with `sandbox.network` naming only the hosts the automation needs; an agent CLI under a profile needs `agent.api_key_secret` (it does not use your sign-in); `approvals.push: manual`.

Read: [SECURITY §2.1](SECURITY.md#21-automation-sandbox-profiles) for the tables and what the real-engine tests cover, [ARCHITECTURE: Sandbox profiles](ARCHITECTURE.md#sandbox-profiles).

### Managed chat access levels

A **raw** chat has no tools at all. A **managed** chat runs the builtin agent loop with the chat's own
policy, and has no file or shell tools unless you attach a folder. A folder that is, holds or lies
inside `~/.clerq` or the store's directory is refused. With a folder, four levels:

| Level                     | What the agent can do                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full access** (default) | Read, write and run commands in the folder without asking. Commands run **as you**, without isolation                                                                                                     |
| **Ask before changes**    | Reads are free; each write and command waits for you in the approvals inbox                                                                                                                               |
| **Read only**             | Read tools only                                                                                                                                                                                           |
| **Sandboxed** (macOS)     | Full access's rules under seatbelt: writes only in the folder and the chat's own home, no network (a trusted skill's `network_domains` can open those hosts), credential stores and `~/.clerq` unreadable |

**The Full access residual** (also true of a command you approve under Ask before changes):

- A command can read any file you can by its full path, **the gateway token included**, and with it call the gateway: create, enable or run automations, answer its own approvals, change settings. The chat's tools cannot do these; its shell can.
- Commands get a `HOME` of the conversation's own, which hides only what is found through `$HOME` (git's global config, shell dotfiles). ssh takes your home from your account, so `~/.ssh` and its keys still work, and a credential helper in the system or repository git configuration (macOS's keychain helper) still answers.
- A `git push`, `gh pr create` and similar are recognised **by word** and wait for you; a command that hides them (`g=git; $g push`) gets past.
- The token and provider keys are redacted from what the model and the record see, as literal values.

**What the chat's tools cannot do:** the model cannot arm an automation. It can only draft a spec; you dry-run it (required before Save) and save it, it is saved switched off with `authored_by: chat <session>` and a "Written by a chat" badge, switching it on is a separate action, and its first push waits for you. No chat tool saves, enables, edits or runs an automation, and no chat spawns a sub-agent.

**Your choices:** the level per chat; attach no folder for a chat that only talks; use Sandboxed on a Mac for a chat that reads untrusted content; keep Full access for folders and content you would run yourself.

Read: [SECURITY §3](SECURITY.md#3-what-is-not-protected-today) (the Full access row), [ARCHITECTURE: Chat console](ARCHITECTURE.md#chat-console).

### Plugins

A **plugin** is a folder with a `manifest.json` and, often, code. A page built into the app (the chat
console, `@clerq/plugin-chat`, is the only one that ships) is a plugin's UI.

**Defends against** (with `plugins.enforce` on):

- **Running code you did not approve.** A plugin that is new, or whose declared permissions or code changed, is not loaded until you approve exactly what is on disk: the approval names two hashes (the permissions, and a SHA-256 over the manifest, the entry's whole folder, the UI, the skills and the migrations) and is refused with `409` if either differs now, so an approval cannot cover a later change.
- **Running different bytes than you reviewed.** Those files are copied to `~/.clerq/plugin-cache` after being verified against the approved hash, and the plugin is run and served from the copy, so an edit on disk waits for a new approval.
- **Mistakes and declared-surface drift** in a plugin that behaves: `ctx.secrets`, `ctx.services`, `ctx.exec`, `ctx.fetch`, `ctx.fs` and the SQL passed to `ctx.store` refuse what the plugin did not declare, and write an audit row either way.
- A UI that a plugin serves from its own folder runs in a sandboxed frame, is posted only its module token and is cross-origin from the desktop window, and a module token reaches only the endpoints the manifest declares; both hold with the switch off too.

**Does not defend against** (and enforcement does not change this): **a plugin runs inside the gateway process with the gateway's access.** It can read the vault key and the gateway token file, open the database, use the network and start processes **without going through its context**. Enforcement is a check on the context, not a sandbox.

- Direct Node APIs (`child_process`, `fs`, `fetch`, `process`, `import`) are not blocked. Out-of-process plugins are not in 1.0.
- `llm` and `memory` are declared, shown, hashed and **enforced on nothing**: the context offers no model or memory helper.
- A declared command or host is not watched. `ctx.exec` runs the declared name, found once on the gateway's `PATH`, with `PATH`, `LD_*` and similar variables refused; **arguments are not checked**, so a declared `sh`, `node`, `python` or `git` is any command. Not every dangerous variable can be listed.
- `ctx.fetch` does not pin DNS: a declared host that resolves to a private address is reached. `ctx.fs` checks a path and then opens it; a link swapped in between is not caught.
- `ctx.store` checks the **text** of a statement against the plugin's own `mod_<id>__*` objects, and a migration may not read what is not its own. It is over-eager by design and is not a database permission system: a plugin with its own database access ignores it. `ctx.store.transaction` runs whatever its function does.
- The checksum does not cover what is outside the hashed folders: code reached by a bare package name (resolved by walking up to `~/node_modules`) or an absolute path is outside the approval. A legacy module that does either must bundle its dependencies.
- Approvals are one slot per plugin and are not signed: anyone who can write the database can write an approval. The audit rows are in `audit_log` with no route to read them.
- **With enforcement off (the default) a plugin that is not approved, or has changed, loads anyway** and runs with full access; it is only shown as not approved. This is by decision.
- **No plugin is bundled except `chat`**, so every other plugin is third-party. A bundled plugin's approval covers its `manifest.json` only; its page ships in the app's own bundle.
- **A page built into the app is trusted like the app.** It runs in the app's own page and React tree. The scoped client it is given (with enforcement on) checks a declared contract and is not isolation: such a page can import the shared client the desktop gives the gateway token to, and `invoke('gateway_token')`. The rule that a plugin's page imports from the app only the 38 names of `@clerq/web/plugin-ui` (which hands out no host, no app-wide client and no shared live store) is checked by a test; it is a rule the code is held to, not a boundary. Only a UI served from a plugin's own folder in the sandboxed frame holds nothing but its module token, and frames of different plugins share the gateway origin's browser storage. The page is also under the desktop's CSP, which was checked in Chrome and not in the three system webviews ([updates and the app](#updater-signing-and-download-checks)).
- `GET /plugins` and the approve routes are for the gateway token only, so a plugin's own UI token cannot approve itself; an in-process plugin holds the gateway token's file anyway.

**Your choices:** turn `plugins.enforce` on; review before approving ([how](#reviewing-a-plugin)); prefer plugins whose code you can read; disable a plugin you do not use (it is unmounted and cleaned up without a restart). **Only install a plugin you would run as yourself.**

Read: [PLUGINS.md](PLUGINS.md) ([Trust and approval](PLUGINS.md#trust-and-approval), [Enforcement and its limits](PLUGINS.md#enforcement-and-its-limits), [What the scoped client does and does not do](PLUGINS.md#what-the-scoped-client-does-and-does-not-do)).

### Skills

A **skill** is a `SKILL.md` (and its folder) of instructions that is put into a prompt. It is text
for a model, not code. It may declare `tools_required`, `network_domains`, `filesystem_scope` and a
`checksum`.

**Defends against** (state is shown whatever the switch):

- **A skill changing under you.** Trust is for the exact files: a SHA-256 over every file in the folder (links inside it are refused). Trusting names the checksum you were shown, and is refused if the files are not those. A skill whose files, or whose declarations, differ from what you trusted is `modified`; a `blocked` skill is never used, and a block holds through edits until you untrust it (it is kept for the slug and the place the skill was found, so the same files under another slug start untrusted).
- **Using something other than what was trusted.** A skill is read once when it is used, and the instructions come from the same bytes that were hashed.
- **A skill closing its own block.** Its name, slug and instructions sit in one block fenced with a value made with a key only the running gateway has; lookalike tags in the text are escaped; the prompt says the block ends only at that fence and that its text comes from the skill, not from OpenClerq or you.

With enforcement **on**, additionally:

- Only a `trusted` skill is used, and a skill from a plugin awaiting approval contributes none.
- A trusted skill's `tools_required` **narrow** a managed chat's tools (they only take away; the chat's own denies and limits stay).
- Its `filesystem_scope` limits the file tools of a chat with a folder (judged on the resolved real path).
- Its `network_domains` give a Sandboxed chat's commands a network through the egress proxy. **This is wider than the none a Sandboxed chat has otherwise**, and only for a trusted skill with enforcement on.

**Does not defend against:**

- What a model does with text. A trusted skill is still text that steers a model; it can persuade the model to do harm within what it is offered. The fence is a request to the model, which may or may not honour it.
- `run_shell` and `git_status` are not checked against `filesystem_scope`; a chat that is not Sandboxed runs commands as you with your network; macOS filters `network_domains` by port, not host; `/task` has no tools, so a declaration there is shown and nothing is narrowed.
- With enforcement **off** (default): nothing is held back except a blocked skill. Declarations are shown, audited and put in the prompt.
- Skills are **not signed**: the checksum says the files are the ones you looked at, not who wrote them. A decision is by slug and source: a renamed skill starts untrusted, and a decision outlives the folder and applies again to the same slug with exactly the same files.
- The other files of a skill (templates, rules) are read live by whatever reads them. The `<memory>` block ignores a skill's tool list.
- A plugin's skills are covered by the plugin's approval, and cannot be trusted one by one; skill text can come from a plugin or module you did not write.
- The trust routes are operator-only, so a module's token cannot trust its own skill; an in-process plugin can use the gateway token.

**Your choices:** read the instructions and the declarations before trusting; trust by checksum; turn enforcement on; block what you do not want used; untrust to forget a decision.

Read: [SKILLS.md](SKILLS.md) ([Trust states](SKILLS.md#trust-states), [What enforcement does](SKILLS.md#what-enforcement-does), [What this is not](SKILLS.md#what-this-is-not)).

### Memory

Memory records are typed (`fact`, `preference`, `decision`, `procedure`, `note`), carry an `origin`
(`user`, `agent`, `import`, `consolidation`) and an `agent_derived` flag, and are plain text in the store.

**Defends against** a note planted by an agent steering later work, and against a model treating a
note as an instruction:

- Over HTTP an `origin` is the caller's word (`user` or `agent`), and the gateway sets `agent` on a chat's own `memory.write`. It is a **label, not proof**: it is shown ("written by an agent") wherever the record is shown or read into a prompt.
- A **managed chat** reads memory under the gateway's memory policy (every type by default; Settings can narrow it) into a `<memory>` block: preferences always (up to 5) plus up to 5 ranked matches, at most 8 records of 600 characters, with `<` and `>` escaped, introduced as information and not instructions. Raw chat reads nothing.
- An **automation** reads memory only when its spec says so (`memory: { read: [types] }`), and **leaves out notes an agent wrote** unless `memory.include_agent: true`. Tasks the gateway starts from its cron, file and webhook triggers read no memory at all.
- A chat's `memory.write` asks you for a `preference` or a `procedure` at every level that writes (the two types that most directly steer later behaviour), and asks for every write in Ask before changes; Read only offers no save.
- A summary made by a model carries `agent_derived` when any record it covers was an agent's, and the originals are kept and can be restored.

**Does not defend against:**

- A model following a note, an agent's or yours. In Full access a chat can write `fact`, `decision` and `note` records without asking, and a later managed chat reads them (labelled). That is a way for text read in one place to reach another: a hostile page read today can leave a note that tomorrow's chat reads. The label and the framing are advisory.
- Plaintext at rest: memory, history and the store's backups are readable by anything running as you. Summarising sends the records' text to a model, and a fallback sends a prompt, with the notes read into it, to another provider.
- `memory.write.<type>` is reserved and not enforced for automations (no agent in an automation has a memory tool in 1.0); an enforcement of `memory` in a plugin does not exist.

**Your choices:** narrow the memory policy; leave `memory.include_agent` off; review agent-written notes in Settings → Memory (who wrote each is shown) and delete what you do not want; answer the approval for a preference or a procedure with care.

### Sub-agents

A builtin automation may spawn sub-agents (`sessions.spawn`), **only if its spec opts in**
(`agent.subagents`, or the tool named in `allowed_tools`). Managed chat and the CLI drivers do not.

**Defends against** a child doing more than its parent:

- A child's policy is the parent's rules **narrowed** by what the spawn asks, never widened, with the parent's denies and lower limits kept, and it cannot itself spawn (depth 1, enforced three ways).
- At most 4 run at once (a fifth waits); a child's model must be one the spec names, the run's chosen one, or on the spec's `subagents.models` list; the cost of every child counts against the parent's budget, which is reserved while a call is under way; the parent's cancel, kill switch and timeout stop its children; a child's approval names its parent and keeps the parent waiting.

**Does not defend against:**

- Children **share the parent's worktree without locks**: writers can collide, and a child that writes does what the parent could write.
- A child's task is **written by the parent model**, so it may carry text the parent read; a child's answer comes back as text the parent reads.
- The per-child tool-call limit is the parent's (400 each); the total is bounded by budget and time, not by count.

**Your choices:** leave sub-agents off (the default) unless an automation needs them; keep `max_concurrent` low; give `agent.subagents.models` only models you would use anyway.

### Fallbacks: sending prompts to another provider

A **fallback** uses another model when the one in use is unavailable (a 5xx, a rate limit, a missing
key, a timeout; never a 400 or a cancel).

**Defends against** the surprise of a prompt going somewhere you did not name:

- The default chain is **empty** until you name models (Settings → Models & keys → Fallback models, or `PUT /routing`). A spec's `agent.model.fallback` is your own list.
- **A model a person chose is never replaced**: a manual run's `--model`, `/task` with a model, a chat's chosen model, every comparison column and every raw-mode message are strict.
- The builtin agent's API key (`agent.api_key_secret`) is given only to the provider of the spec's own primary model; a fallback on another provider uses that provider's key from the environment, and one without a key is skipped or refused.

**Does not defend against:** a fallback **sends the prompt**, the conversation and the saved notes read into it, to the next model's provider, who keeps whatever it keeps. That provider's terms are yours to read. A run that falls back is recorded (a step and an event), after the fact.

**Your choices:** keep the default chain empty or list only providers you would send the same text to; pin a model for anything sensitive.

### GitHub App

You bring your own GitHub App ([GITHUB.md](GITHUB.md)); runs push and open pull requests with
installation tokens instead of a personal access token.

**Defends against** a long-lived, broad personal token in an agent's reach:

- Per-repository, per-purpose, per-run tokens, each at most an hour: fetch reads contents, push writes contents, a pull request writes pull requests. A wider token than asked for is revoked and refused. They are in memory only, revoked in `finally` when the run ends, never given to the agent or a gate, and redacted from everything the run stores. Git gets them as a header in one command's environment, never in an argument, a URL or a config.
- The pull request is opened by the app's **bot**, not by you; the app does not ask for the `workflows` permission, so GitHub is expected to refuse a push that touches `.github/workflows/` (not yet seen against github.com).
- Your **sign-in** (device flow) is for who you are and which repositories you reach, never for acting: its tokens sit in one reserved vault entry that no spec, agent or `/secrets` call can name, and a run never holds them.
- `/github` routes are for the gateway token only. **The manifest callback is the one unauthenticated route that changes state**: it needs a single-use random state valid ten minutes, tied to the host it was made for, and refuses when an app is already connected or the answer asks for more than the manifest did.
- Revoking: sign out revokes the user token on GitHub when the client secret is stored; disconnecting removes both secrets (the app stays on GitHub); a leaked key is replaced in this order: generate a new key, import it, delete the old one on GitHub.

**Does not defend against:**

- The **private key is long-lived** and makes tokens for every repository the app is installed on, until you delete the key on GitHub. It sits in the vault, which protects it no better than the vault protects any secret: a `native` automation runs as you and can read the key file and the vault. Seatbelt and container hide `~/.clerq`.
- Tokens already made stay valid up to an hour after a key leaks, and tokens of a gateway that stops or crashes mid-run are not revoked (they expire within the hour).
- `contents: write` can push to any branch the installation may write; the gateway pushes only the run's new branch, and **branch protection is the guard**. A bot's pull request is judged by `CODEOWNERS` and review rules differently from yours.
- `CLERQ_GITHUB_API` and `CLERQ_GITHUB_WEB` change where tokens go; whoever sets the gateway's environment already owns it.
- **Nothing of this has been run against github.com** (the list is in [GITHUB.md](GITHUB.md#not-verified-against-githubcom)), including the device flow, which you enable by hand in the app's settings.

**Your choices:** install the app only on the repositories you mean to automate; keep `publish.auth: auto` or `app` (never `token` unless you mean it); protect the vault key (an OS keychain, not `CLERQ_VAULT_KEY`); use branch protection on the branches that matter.

### Server mode, behind a reverse proxy

`clerq-server` runs the same gateway headless, from the installer's tarball or the container image
([SERVER.md](SERVER.md)).

**Defends against** casual exposure: it binds loopback by default and logs a warning for any other
address; a container's image publishes nothing until you map the port; the systemd unit confines the
service (`ProtectSystem=strict`, `NoNewPrivileges`, a 0700 state directory); remote mode refuses
plain HTTP except to localhost and takes the https address of **your** tunnel or proxy; a phone pairs
with a single-use five-minute code and holds a device token, never the gateway token; pushes to
phones carry a generic title and an id, over a random topic per device.

**Does not defend against:**

- The token is a **production credential on plain HTTP** with no rate limit: bind a wider address only behind TLS, a VPN or a firewall. `docker run -p 18790:18790` (without `127.0.0.1:`) publishes plain HTTP past `ufw`. `-e CLERQ_GATEWAY_TOKEN` shows in `docker inspect`.
- **Agents run as the service account** (uid 10001 in the image) and can read `gateway-token`, `.env` and the vault key in its data directory; the unit's hardening confines the service, **not an automation**. A `.env` in the data directory may hold provider keys.
- A proxy must forward the token to the gateway and nowhere else: no mirroring, no forward-auth subrequest, no CDN that logs or caches, **no logging of query strings** (`?token=` is accepted on `/v1/events`, `/v1/events/stream` and `/v1/logs/stream`). It must pass event streams unbuffered, keep `Host` (the GitHub callback is judged by it), not cache `/v1/`, and not put its own `Authorization` header on top. The gateway ignores `X-Forwarded-*`: the client address is the proxy's. The Caddy and nginx examples have **not been run against a live proxy**.
- Two gateways on one data directory are not supported (one may take the other's live runs for abandoned). A server holds one signed-in GitHub person.
- **`curl | sh` trusts GitHub and TLS for `install.sh` itself.** It proves who signed the files only when `minisign` is installed ([updates](#updater-signing-and-download-checks)); `--no-verify` skips the check. The container profile is not offered inside the image (it would need the host's engine socket).
- ntfy.sh (or the server you name) sees the topic, the generic text and when; GHCR visibility of the image is a manual step of the owner.

**Your choices:** the proxy, the firewall and the network; `--system` or user install; the container's published address (`127.0.0.1:`); stop agents' reach with a profile and a data directory they cannot read; rotate the token if it was ever in a log.

### Updater signing and download checks

**Defends against** a tampered update or download: an installed app installs an update only if its
signature verifies against the public key built into it; the release workflow refuses to publish
if any updater signature does not verify against that key (and `updater-key` checks on every push
to `main` that the secrets are the key the apps trust); `SHA256SUMS` carries a signature by the same
key, which `install.sh` checks when `minisign` is installed, **before** taking a version or a file
name from it, and refuses on a mismatch or a missing signature; the `.deb` and `.rpm` are signed too
(and are not offered as updates, because the updater would install them as root). A key rotation's
bridge release is accepted only with a proof, signed by the new key for that version.

**Does not defend against:**

- **There is no in-app revocation of the key.** Losing the private key or its password ends in-app updates for every install; a rotation needs a bridge release signed by the old key, and an app that does not take it before a release signed with the new key is the latest must be reinstalled.
- The owner's offline backup of the key is not checked by anything. Whoever can change the repository's secrets or workflows can sign as the project.
- The **macOS and Windows installers are not code-signed** (Gatekeeper and SmartScreen warn on first run) and the `.dmg` carries no signature of its own. The container image is not signed by the project's key.
- Without `minisign` the installer **checked integrity only** (the file is the one the release lists, not proof of who made it) and says so. An older signed `SHA256SUMS` served as the latest passes: name a version with `CLERQ_VERSION`. The AppImage updater replaces a file you own after a signature check; there is no downgrade protection beyond the version compare.
- The desktop window's Content-Security-Policy was run in Chrome's engine over http, not in WKWebView, WebView2 or WebKitGTK; it allows any `127.0.0.1` port (so a Gateway URL on another port works); and it does not apply to a module's own page in its frame.

**Your choices:** install `minisign` and run the check in [RELEASING.md](RELEASING.md#checking-a-download); read the release's notes for a bridge; pin versions in scripts.

Read: [RELEASING.md](RELEASING.md), [DISTRIBUTION.md](DISTRIBUTION.md).

## The plugin and skill trust boundary

The two are the part of OpenClerq most likely to be installed from someone else, so this section
says it once, in one place, with the same words the settings screens use.

### What an approved plugin can do

**Anything the account running the gateway can do.** A plugin is in-process: approving it is the
decision to run that author's code as you, inside the service that holds the vault key, the gateway
token, the database and every secret. Approval records that you looked at what it declares and at its
code, binds the approval to those exact bytes, and means a later change must be approved again. It
does not limit the code. Declared permissions are a statement of intent that you can read and that
enforcement can hold the plugin's context to; a plugin that wants more does not need the context.

### What an approved skill can do

**Steer a model, within the tools the model is given.** A skill is text: it cannot run anything
itself. A trusted skill can still tell a model to read files, run commands, write notes, send a
request, and a model may do so, with exactly the reach the chat or the automation already has. Trust
means the files are the ones you reviewed; it does not mean a model follows only them, and it says
nothing about who wrote them.

### What enforcement adds

One switch, `plugins.enforce` (off by default), decides.

|              | Off                                                                                         | On                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A plugin** | Loads whatever its approval. Declarations are shown, hashed and audited; nothing is blocked | Not loaded until approved, and stopped if it changes. Its context refuses secrets, services, programs, hosts, paths and SQL it did not declare (and audits). A module token reaches only what its manifest declares (this holds off too) |
| **A skill**  | Used with its state in the prompt and the trace; only a blocked skill is skipped            | Only a trusted skill is used; its `tools_required` narrow a managed chat; its `filesystem_scope` limits the file tools; its `network_domains` give a Sandboxed chat a limited network                                                    |

What it never adds: a sandbox for a plugin, a check on `llm` or `memory`, a check on what an allowed
program does, a check on `run_shell` against a skill's paths, or any guarantee about what a model does
with text.

### Reviewing a plugin

1. **Read what it asks for in words** (Settings → Plugins → Review): programs it may run as you, hosts it may call, folders it may read and write, secrets it may read, services it may control, core endpoints its UI may call. Each is a reason to ask what the plugin needs it for. `llm` and `memory` are shown and not enforced.
2. **Treat a declared `sh`, `node`, `python` or `git` as any command**, and a `net` host that is a general service as a way out for anything the plugin can read.
3. **Read the code that the checksum covers**: the manifest, the whole folder of its entry, its UI, its skills and its migrations (the SQL is a way to reach the store). Look for `child_process`, direct `fetch`, `fs` outside its declared roots, `process.env`, and for imports of a bare package name or an absolute path, which the approval does not cover.
4. **Prefer a plugin that bundles its dependencies** and one whose author you can name. A plugin is not signed.
5. **Turn `plugins.enforce` on before you approve**, so that an unapproved or changed plugin is not imported, and approve the hashes the dialog shows. A change later shows what changed (version, code, each permission as "Can now…" or "Can no longer…") and needs a new approval.
6. **Watch the audit rows** `plugin.permission.denied` and `plugin.permission.undeclared` (they are in `audit_log`; no route reads them yet), and disable what you do not use.

### Reviewing a skill

1. **Read `SKILL.md` and every file in the folder**: the checksum is over all of them, and a tool that reads a template reads it live.
2. **Compare what it declares with what its instructions ask for**: a skill that says it needs `git_diff` and tells the model to run shell commands, or names no hosts and asks for web access, is telling you something. A declaration the skill does not make is not a limit it accepts.
3. **Check the checksum** with `clerq skill checksum <folder>`, against the author's if they published one; the Skills screen shows whether they match. Trust names the checksum you saw.
4. **Know which skills cannot be trusted one by one**: a plugin's skills follow the plugin's approval.
5. **Turn enforcement on if you want the declarations to count**, and keep Full access chats away from content you do not trust: a trusted skill narrows a chat's tools, not its shell.
6. **After any edit, the skill is `modified`** until you trust it again; untrust or block what you stop using.

## What 1.0 does not defend against

One list, from the boundaries above and from the places each part of the release was written down.
Where a section above explains, it is linked.

**Execution and isolation**

- **Prompt injection.** Nothing stops a model from following text it reads. The defences limit what it reaches, and are only as strong as the switches you turn on.
- **The default is no isolation.** Automations run as you unless the spec names a profile; a chat with a folder runs as you unless Sandboxed; gates run code the agent changed before anyone has seen the diff, under `native`. ([profiles](#sandbox-profiles), [chat](#managed-chat-access-levels))
- **Seatbelt:** reads of any file not on the credential list; egress by port, not host (macOS); a process that leaves the process group and the run's directories (any Node-based CLI's child with `setsid`) outlives the run, sandboxed; Cursor under seatbelt untested; Apple has deprecated `sandbox-exec`.
- **Container:** shared kernel, trusted image, an image pull outside the egress limit, no CPU, memory or process limits from a spec, a proxy that never becomes ready or crashes mid-run (not run against an engine), Podman and Docker Desktop on macOS never run.
- **Egress allow-lists** let a listed name through whatever it resolves to, private addresses included, and the listed hosts and the model provider can receive the repository.
- **The commit can carry a secret** the agent wrote into a file; redaction is literal and not of encoded or split values. A tracked file the agent changes runs wherever the branch is built.
- **A git the gateway started** (and its helpers) is left running if the gateway crashes or its terminal is interrupted, until it ends by itself or the next start cleans it up; a desktop app quitting leaves it to finish. Agents a crashed gateway left behind are stopped at the next start, not before.
- Under `native`, a builtin agent's file tools check paths in the gateway, which a concurrently running command can race.
- Two gateways on one data directory (the app and a user-service `clerq-server`, say) are not supported.

**Plugins and skills** ([plugins](#plugins), [skills](#skills))

- A plugin is not isolated from the gateway; nothing blocks direct Node APIs; out-of-process plugins are not in 1.0.
- `llm` and `memory` permissions are declared and enforced on nothing; an allowed command's arguments, an allowed host's DNS and a path between check and use are not checked; code outside the hashed folders is outside the approval; `ctx.store` is a text check.
- With enforcement off, an unapproved plugin runs with full access. Approvals are not signed; the audit rows have no route to read them.
- A page built into the app is trusted like the app, and the chat console's bundled approval covers its manifest only.
- Skills are not signed, their trust is by slug and source, `run_shell` and `git_status` are not checked against a scope, and what a model does with a skill's text is not controlled.

**Data**

- Memory, chat history and store backups are plain text, protected by the account boundary only. Backups hold what the database holds, so deleting a chat leaves it in older backups; a restore of a mismatched file by hand is not stopped by the downgrade guard (a newer database is refused by an older program, nothing more); module migrations get no backup of their own.
- A fallback, a summary and a comparison send text to other providers, and a model provider is out of scope.
- An agent-written memory note can carry text read elsewhere into a later chat; the label is advisory.
- `http.request` checks resolved addresses, but the connection resolves again (DNS rebinding); `capabilities.json` and `config.json` are last-write-wins; the Windows key path (DPAPI falling back to the key file) has no Windows runner.
- A model call under Bun (the desktop's service) does not see a client hang-up: it runs to completion unless cancelled by its run id or the kill switch.

**The gateway and the network** ([token](#gateway-token-tenants-and-scoped-tokens), [server](#server-mode-behind-a-reverse-proxy))

- A bearer token on plain HTTP, no limit on wrong tokens; the token in a process environment, `docker inspect`, a proxy log's query string, or `cli.json`.
- Scopes name routes, not objects; tenants share a process and a database; a module token that names `GET /routing` passes the CLI's probe.
- The Caddy and nginx examples were not run against a live proxy. ntfy sees the topic and the generic text.

**GitHub** ([GitHub App](#github-app))

- A long-lived private key in the vault; tokens valid up to an hour after a leak, or after a gateway crash; `contents: write` on any branch the installation allows; nothing verified against github.com.

**Releases and updates** ([updates](#updater-signing-and-download-checks))

- An updater key that cannot be revoked from an installed app, with an unchecked backup; whoever edits the workflows or secrets can sign; a bridge release strands apps that miss it.
- The macOS and Windows installers are not code-signed, the `.dmg` and the container image carry no signature of the project's, an installer without `minisign` checks integrity only, and an older signed `SHA256SUMS` passes as the latest.
- The desktop CSP was tested in Chrome, not in the three system webviews, and does not cover a module's frame.

## What was not verified

Claims in this document are of the code and its tests. These were **not run** for 1.0, and anything
above that rests on them is stated from reading, not from observation:

- **github.com**: the GitHub App flow, installation tokens, the device flow and the sign-in tokens ran against a fake only.
- **The real agent CLIs under a profile**: `claude`, `codex` and `cursor-agent` were not run under seatbelt or the container profile (the provider hosts each is allowed come from the vendors' documentation and were not observed), and the release checks read `claude`'s help and sign-in state without starting a run; `codex` and `cursor-agent` are not installed on the machine that made the release.
- **Linux and Windows desktop windows**: the packages build and their gateway runs from the unpacked package in CI; nobody launched them. The compiled desktop service was not run with a plugin, and `[gateway]` log lines were not seen in a launched app.
- **Podman, and Docker Desktop on macOS.** The container profile ran on Docker on Linux (amd64 and arm64) in CI.
- A real sleep or wake, and a real provider outage; a real model deciding to spawn a sub-agent or to follow a skill.
- The Caddy and nginx examples; the two systemd units (read by `systemd-analyze verify` in CI, not run by the people who wrote them); the GHCR package's visibility; the installer under `sudo` on a real system; the release workflow end to end.

## How this document is kept honest

- Each boundary above names the tests or the SECURITY rows that hold it; a limit that is not listed in [SECURITY §3](SECURITY.md#3-what-is-not-protected-today) or here is a bug in the document.
- A change that widens what a plugin, a skill, an agent or a token can reach is a change to this page.
- Report a vulnerability privately through GitHub's security advisories on [paxamedia/OpenClerq](https://github.com/paxamedia/OpenClerq/security/advisories), not in a public issue ([SECURITY §7](SECURITY.md#7-reporting-a-vulnerability)).
