# OpenClerq Roadmap

**Status:** Planning · **Baseline:** `main` @ `386face` · **Last updated:** 2026-09-04

This is the single authoritative roadmap for OpenClerq. It supersedes all prior planning
documents and scratch specifications.

---

## 0. How this document was made

Two independent reviews of this repository were merged:

| Source                                                        | Contributed                                                                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude (Opus 5)** — product/orchestration review            | Positioning against Cursor's automations, the provider/driver split, repo + git workspaces, sandbox isolation, verification gates, automations-as-code, distribution model, phase sizing |
| **GPT-5.6 Luna (OpenAI)** — OpenClaw comparison, `2026-09-04` | Agent runtime loop, durable sessions, tool policy engine, event bus, sub-agents, SSRF hardening, context management, approval risk tiers, skill permission manifests, CI gates           |

Every finding below was re-verified against the source tree before inclusion. Where the two
reviews disagreed, §3 records the disagreement and the resolution rather than silently
picking one.

---

## 1. What we are building

### 1.1 Product thesis

Cursor's automations run _Cursor's_ agent, on _Cursor's_ machines, against repos Cursor can
reach. That is a closed loop, and the opening it leaves is the obvious one:

> **OpenClerq is the conductor, not another agent.** It schedules and supervises whichever
> coding agent you already pay for — Claude Code, Codex, cursor-agent, or a raw model API —
> against whichever repos you point it at, on hardware you control.

We are not trying to write a better agent than Anthropic or OpenAI; we would lose. We
compete on **scheduling, isolation, routing, verification, cost control, and auditability** —
the layer every vendor treats as an afterthought because it does not sell tokens.

Because drivers run under the user's _own_ subscriptions, OpenClerq needs no billing
relationship with any model vendor and takes no inference margin. That is the structural
reason it can be free and open source while a hosted equivalent cannot.

### 1.2 Runtime thesis

The current task path is `message → optional calculation → LLM explanation → response`.
That is a prompt router, not an agent. The target is:

```
message
  → session resolution
  → context / memory assembly
  → model + provider resolution
  → policy filtering of the tool set
  → LLM turn
  → tool calls → approval → sandbox → observations
  → repeated turns (bounded)
  → optional sub-agents
  → final answer
  → durable transcript, usage, and audit record
```

These two theses are complementary, not competing. The runtime is _how_ a run executes; the
orchestration layer is _what_ causes runs to happen, _where_ they execute, and _whether their
output is allowed to ship_.

### 1.3 The two domains

OpenClerq's origin is clerical automation. This roadmap adds repository automation. That is
coherent — the same engine (schedule → isolate → execute → verify → report) runs document
processing and dependency triage equally well. Repos are the wedge because the market is
proven and the users are reachable; administrative automation is the larger market
underneath, and we are the only entrant already pointed at it.

---

## 2. Consolidated audit

18 findings, verified against the tree. **Findings 1–4, 7, 10, 14, 15 and 16 are fixed in release 0.4**; the rest remain open and are dated in the release trains below. **S1 blocks Phase 2** — the moment this system gains
shell execution and a server install story, each S1 becomes remote code execution.

### S1 — Blockers

| #   | Finding                                                                                                                                                                                                                                                                                              | Location                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | **Gateway binds every interface.** `app.listen(port, cb)` takes no host argument, so it binds `0.0.0.0` — while the log line it prints claims `http://127.0.0.1`. Reachable from any shared network.                                                                                                 | `packages/gateway/src/gateway.ts:532`        |
| 2   | **There is no authentication.** The license middleware waves through every request when `CLERQ_DEV=1`, which is the setup the README instructs everyone to use. No identity, no token, no session. With #1, an open gateway.                                                                         | `packages/gateway/src/middleware/license.ts` |
| 3   | **Path containment is a string prefix test.** `resolved.startsWith(root)` lets `/srv/repo-secrets` pass a check scoped to `/srv/repo`. No `realpath`, so symlinks escape too.                                                                                                                        | `packages/gateway/src/tools.ts:44`           |
| 4   | **Licensing is being used as authentication.** These answer different questions — _is this install entitled to feature X_ versus _is this caller allowed to control this gateway_. Conflating them means the entitlement check is the only thing standing between the network and the tool registry. | `packages/gateway/src/middleware/license.ts` |

### S2 — Must fix before 1.0

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                        | Location                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 5   | **Vault master key lives in an environment variable.** `CLERQ_VAULT_KEY` is readable by any process that can see the env, lands in shell history and CI logs, has no KDF and no rotation path. The AES-256-GCM construction is sound; the key protection is not.                                                                                                               | `packages/gateway/src/secrets-vault.ts:32`          |
| 6   | **Nothing that runs is remembered.** A trigger fires, `runTriggeredTask` logs 50 characters, the result is discarded. No run record, no output, no failure history. The largest functional gap in the repo.                                                                                                                                                                    | `packages/gateway/src/triggers.ts:65`               |
| 7   | **`http.request` has no SSRF defences.** Hostname allowlist only. Redirects are followed unvalidated, loopback and link-local ranges are reachable, cloud metadata endpoints (`169.254.169.254`) are not blocked, and there is no timeout, no response size cap, and no method restriction.                                                                                    | `packages/gateway/src/tools.ts:56`                  |
| 8   | **No context management.** Tool output flows into the prompt unbounded. An `fs.read` of a large file or an HTTP response of arbitrary size can blow the context window or the bill.                                                                                                                                                                                            | `packages/gateway/src/agent/explain.ts`             |
| 9   | **Config is JSON files with last-write-wins.** `memory.json`, `triggers.json`, `capabilities.json` are read-modify-write with no locking. Concurrent runs silently clobber each other.                                                                                                                                                                                         | `memory-layer.ts`, `triggers.ts`, `capabilities.ts` |
| 10  | **CORS is `*` in dev mode** — so any web page the user visits can drive their local gateway.                                                                                                                                                                                                                                                                                   | `packages/gateway/src/gateway.ts:37-51`             |
| 11  | **Tauri CSP is `null`** — content security policy is disabled outright in the desktop shell.                                                                                                                                                                                                                                                                                   | `apps/desktop/src-tauri/tauri.conf.json`            |
| 12  | **Updater ships a placeholder public key.** `pubkey` is the literal string `PLACEHOLDER_REPLACE_WITH_TAURI_SIGNER_PUBKEY` while `endpoints` points at a live GitHub Releases URL. Tauri verifies signatures against this key, so it fails closed — the feature is simply broken rather than exploitable — but it is a release blocker and the failure mode is silent to users. | `apps/desktop/src-tauri/tauri.conf.json`            |
| 13  | **CI runs no tests.** `build.yml` builds installers on macOS and Windows. It does not typecheck, lint, run the Vitest suites, run `cargo test`, audit dependencies, or scan for secrets — despite all of those existing as package scripts.                                                                                                                                    | `.github/workflows/build.yml`                       |

### S3 — Cleanups

| #   | Finding                                                                                                                                                                                                                                    | Location                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 14  | **`fsAllowWrite` is a dead flag.** Declared, parsed, validated, stored, passed into `ToolConfig` — and read by no tool. The UI implies a write capability that does not exist.                                                             | `capabilities.ts:14` → `tools.ts:21` |
| 15  | **Model list is hardcoded and stale.** `getAvailableModels()` returns Claude 3.x IDs from 2024. Should be a registry file refreshed independently of releases.                                                                             | `agent/llm-provider.ts:118`          |
| 16  | **Version drift across four places.** Root `package.json`, gateway, desktop and `tauri.conf.json` all say `0.1.0`; `/health` hardcodes `0.1.0` in two spots; git tags are at `v0.3`. `sync-version.js` does not cover the health endpoint. | repo-wide                            |
| 17  | **`App.tsx` is 1,151 lines with no router.** Every panel is a sibling in one component. A run list, run detail and diff viewer will not fit this shape.                                                                                    | `apps/desktop/src/App.tsx`           |
| 18  | **No Linux target in the release matrix** — though `capabilities/desktop.json` already lists Linux, and servers are the deployment target this roadmap needs.                                                                              | `.github/workflows/release.yml`      |

### Documentation accuracy

Three docs currently describe guarantees the code does not provide, which is worse than no
documentation:

- `TOOLS.md` claims _"Any attempt to escape the root (e.g. `../../..`) is rejected"_ — finding #3 contradicts this.
- `SAFETY_CHECKLIST.md` presents the license check as a security control — finding #4.
- `ARCHITECTURE.md` describes the gateway as running an _"agent loop"_ — it runs a single LLM call.

All three are corrected as part of this roadmap (§7).

---

## 3. Review of the GPT-5.6 specification

The specification is a strong runtime and security document. Its section 29 ("what not to
copy from OpenClaw") is a discipline most roadmaps lack, and six of its findings are adopted
verbatim below. The following are the substantive corrections.

### 3.1 The largest gap: policy is not a sandbox

The spec's tool policy engine (its §7) is an application-layer allow/deny list. It includes
an `exec` capability in the `coding` and `dangerous` profiles with no containment story
whatsoever.

**Policy and sandbox are different layers and you need both.** Policy governs what the agent
is _allowed to ask for_. The sandbox governs what the spawned process can _physically do_.
An allowlist that permits `exec` and then hands the command to `child_process.spawn` on the
host has authorised arbitrary code execution with the gateway's full privileges — the
allowlist is a comment at that point.

Adopted: the tool policy engine, in full. Added: `packages/sandbox` as a hard requirement
before any `exec` tool ships (Phase 2).

### 3.2 Missing: repositories, git, and workspaces

The spec has no concept of a repository, a checkout, a branch, a diff, or a pull request. Its
automation subsystem (§15) sends prompts to sessions on a cron — which is what
`triggers.ts` already does, plus durable state.

That omits the stated product goal. Repository automation needs registered repos, a fresh
`git worktree` per run so concurrent runs cannot collide, and a publish path through branch →
commit → push → PR. Added as `packages/workspaces` (Phase 2).

### 3.3 Missing: verification gates

Nothing in the spec runs the test suite before publishing. An agent that opens PRs on a
schedule without verification is a machine for generating review burden. Gates are the
difference between "30 PRs this morning" and "3 PRs and all of them are green" — and they are
what makes it safe to set `approvals.push: auto`, which is where the actual time saving
lives. Added to the automation spec (§6).

### 3.4 Drivers before the built-in loop

The spec treats the in-house agent runtime as P0. Building a competitive tool-calling loop is
several weeks; wrapping `claude -p` is about a day.

Resolution: **ship drivers first, make the built-in loop the eventual default.** The driver
interface forces the `Step`/`Event` shape to be defined correctly, which is precisely what the
built-in loop needs — so drivers de-risk the loop rather than delaying it. We conduct agents
that already work while we build our own.

### 3.5 Provider list

The spec proposes `anthropic / openai / google / local`. The actual requirement is Claude,
Kimi, Codex, MiniMax, Cursor, GLM and DeepSeek. Two corrections:

- Six of those seven are **OpenAI-compatible endpoints**, so they are a registry file and one
  adapter, not six integrations.
- **Cursor has no public model API.** It enters only as a CLI driver (`cursor-agent -p`)
  under the user's own subscription. Same for Codex, which is a CLI over OpenAI's API.

### 3.6 Scope: channels and browser

Telegram/Discord/WhatsApp/Signal (spec §20) and browser automation (§18) are _OpenClaw's_
identity, not ours. Multi-channel is deferred indefinitely; browser automation stays an
optional module, relevant to the clerical domain and not to the repository one. Cloning a
competitor's feature list is not a strategy.

### 3.7 Package structure

The spec places everything under `packages/gateway/src/` — agent, automation, memory, tools,
providers, plugins, security, sessions. That makes the gateway a monolith with the
dependency footprint of every subsystem it hosts. Anything with heavy dependencies or
independent test surface becomes its own workspace package (§4).

### 3.8 Smaller corrections

- **Version numbers.** The spec targets `0.2`; the repo is already tagged `v0.3`. Release trains renumbered to 0.4 / 0.5 / 0.6 / 1.0 (§5).
- **Architectural scoring** (its §32) is not actionable and is dropped.
- **Sub-agent depth.** The spec's `maxDepth = 1` default is right and is kept — recursive agent spawning is an unbounded cost and blast-radius multiplier.

### 3.9 Adopted from the specification

Fully adopted, and better than the original Claude review on each: durable **sessions** as
first-class objects distinct from runs; the typed **event bus** as the single source for UI
streaming, logs, metrics and audit; **SSRF hardening** specifics (redirect validation,
private-range and metadata-endpoint blocking, size and time caps); **context management**
with tool-output truncation; **sub-agents** with concurrency and depth limits; **skill
manifests** that declare required tools, network domains and filesystem scope so a skill
cannot silently imply authority; **approval risk tiers**; and the **CI quality gates**.

---

## 4. Target architecture

### 4.1 Packages

```
apps/
  desktop/            Tauri v2 — mac / win / linux            [exists, + Automations UI]
  server/             headless daemon + web UI, Docker image  [new]
  cli/                clerq — login, repo, automation, run    [new]
packages/
  gateway/            HTTP/WS API, auth, sessions, agent loop [exists, extended]
  orchestrator/       queue, scheduler, run state machine     [new]
  providers/          model adapters + providers.yaml         [new]
  drivers/            claude-code, codex, cursor-agent, builtin [new]
  workspaces/         checkout, worktrees, branch/commit/PR   [new]
  sandbox/            native / seatbelt / container profiles  [new]
  policy/             capability grants, approvals, redaction [new]
  store/              SQLite (WAL) + migrations               [new]
  web/                React UI shared by desktop and server   [new]
  plugin-sdk/         plugin contract + permission manifest   [new]
  calculation-core/   Rust deterministic engine               [exists, → optional module]
  module-schema/      manifest schema                         [exists]
  gateway-client/     typed API client                        [exists, regenerated]
modules/
  chat-console/       raw + managed + compare chat, automation authoring [new]
recipes/              shareable automation definitions (YAML) [new]
```

### 4.2 Sessions and runs

The two reviews modelled state differently. Both objects are needed:

- A **session** is a conversational identity with a transcript. Interactive chat is a session. An automation's execution history is a session. Sessions are what make follow-up and takeover possible.
- A **run** is one bounded execution within a session — one scheduled firing, one manual trigger, one sub-agent task. Runs carry status, cost, and a step trace.

One session has many runs. One run has many steps.

### 4.3 Run state machine

Every transition is written to SQLite _before_ it takes effect, which is what makes runs
resumable after a crash and auditable after the fact.

```
queued → leased → preparing → executing → verifying → publishing → done
                      ↓           ↓           ↓            ↓
                   failed      failed      failed       failed
                                  ↓
                       awaiting_approval → executing | cancelled
```

`preparing` creates the worktree and installs dependencies. `executing` hands control to the
driver. `verifying` runs the gates. `publishing` pushes and opens the PR. A run that dies
mid-`executing` is reaped by lease expiry — no zombie holding a worktree forever.

### 4.4 Schema

| Table                              | Holds                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sessions`                         | id, agent_id, title, status, model, created_at, updated_at, metadata                                                       |
| `messages`                         | session_id, role, content, tool_name, tool_call_id, token_estimate                                                         |
| `repos`                            | id, name, kind (`local`/`github`/`gitlab`), url, default_branch, local_path, credential_ref, setup_commands                |
| `automations`                      | id, name, spec (YAML), schedule, enabled, driver, model_policy, sandbox_profile, budget, next_run_at                       |
| `automation_targets`               | automation_id × repo_id — the join that makes fleet runs possible                                                          |
| `runs`                             | id, session_id, automation_id, repo_id, status, trigger, lease_until, branch, pr_url, cost_usd, tokens_in/out, exit_reason |
| `run_steps`                        | run_id, seq, kind (`llm`/`shell`/`fs`/`git`/`gate`), input, output, duration_ms, tokens, cost                              |
| `tool_calls`                       | run_id, name, input, output, status, duration_ms, approval_state                                                           |
| `artifacts`                        | run_id, kind (`diff`/`log`/`file`/`report`), path or blob, sha256                                                          |
| `approvals`                        | run_id, step_id, requested_at, decided_by, decision, reason                                                                |
| `memory`                           | id, type, key, value, source_session, confidence, created_at, expires_at (+ FTS index)                                     |
| `users`, `sessions_auth`, `tokens` | GitHub identity, session cookies, scoped API tokens                                                                        |
| `audit_log`                        | append-only: who changed what, who approved what, when                                                                     |

SQLite with WAL covers a single-node install well past any realistic load here and keeps the
download-and-run story intact. Keep queries portable in case a hosted multi-tenant version
later needs Postgres, but do not pay for that now.

### 4.5 Event bus

One typed internal bus, consumed by the UI stream, the log writer, the metrics collector and
the audit log — rather than each growing its own ad-hoc mechanism.

```
gateway.started / stopped
session.created / updated / completed
run.queued / started / completed / failed / cancelled
agent.turn.started / completed
tool.requested / approval_required / started / completed / failed
gate.started / passed / failed
model.fallback
budget.exceeded
memory.updated
```

Correlation IDs on every event: `request_id`, `session_id`, `run_id`, `tool_call_id`. This is
what makes autonomous behaviour debuggable.

---

## 5. Release trains

Existing tags are at `v0.3`, so numbering continues from there. Sizing assumes one focused
engineer.

### 0.4 — Foundation _(~2.5 weeks)_ — **in progress**

Nothing else merges before this lands. Closes every S1 finding and lays the storage layer
everything downstream writes into.

- [x] Bind `127.0.0.1` by default; `--host` requires an explicit flag **and** a configured token
- [x] Split authentication from licensing — `CLERQ_GATEWAY_TOKEN`, `Authorization: Bearer`, `/health` public and everything else authenticated
- [x] Remove the production `CLERQ_DEV` bypass; generate a token on first run and hand it to the desktop app
- [x] Canonical path validation — `realpath` + `path.relative`, explicit symlink policy, size caps
- [x] SSRF hardening on `http.request` — scheme allowlist, manual redirect validation, block loopback/link-local/private ranges and metadata endpoints, timeouts, response size cap, method allowlist
- [x] `packages/store` — SQLite + WAL, migration runner, schema from §4.4 _(landed)_
- [x] Migrate `memory.json` / `triggers.json` / `capabilities.json` into SQLite with a one-time importer _(landed)_
- [x] Lock CORS to the desktop origin; drop the `*` dev path
- [ ] Secrets master key → OS keychain (Keychain / DPAPI), age-encrypted file for headless _(moved to 0.5)_
- [ ] Typed event bus + append-only audit log _(moved to 0.5)_
- [x] Remove the dead `fsAllowWrite` flag or implement it
- [x] Fix version drift; extend `sync-version.js` to cover `/health`
- [x] CI gates: typecheck, lint, Vitest, `cargo test`, `pnpm audit`, `cargo audit`, secret scan — all required before build

### 0.5 — Execution _(~3 weeks)_

The phase that decides whether this is safe to leave running overnight.

- [x] `packages/sandbox` — `native` (dev only, loud warning), `seatbelt` (macOS `sandbox-exec`), `container` (Docker/Podman, server default)
- [x] Per-run limits: wall clock, CPU, memory, disk, process count; hard kill on breach
- [ ] Egress allowlist enforced at the sandbox boundary, not in application code
- [x] `packages/policy` — tool groups (`fs`/`runtime`/`web`/`sessions`/`memory`/`automation`), profiles, allow/deny, `maxCallsPerRun`
- [ ] Approval system with risk tiers; `POST /approvals/:id/approve|deny`; allow once / allow for session / deny
- [x] `packages/workspaces` — register local paths, clone remotes to a content-addressed cache, one `git worktree` per run
- [x] Git publish path: branch, commit with a machine-identifiable trailer, push, PR via GitHub/GitLab API
- [x] Secret injection as sandbox env only, with output redaction on the way back
- [ ] `packages/providers` + `providers.yaml` — base URL, auth env var, model list, context window, price per million tokens
- [ ] Per-call token and cost accounting into `run_steps`
- [ ] **Chat console — raw mode.** Per-provider conversations, streaming, full request/response inspection. Needs only 0.4 auth plus the provider registry
- [ ] **Chat console — comparison mode.** One message fanned out to N models, side by side with latency, tokens and cost

### 0.6 — Agents and automations _(~3 weeks)_

- [ ] Driver interface + process supervision (stream parsing, cancellation, orphan reaping)
- [ ] `claude-code`, `codex`, `cursor-agent` drivers; each detects its CLI and says so plainly if absent
- [ ] `builtin` driver — real tool-calling loop, every call through `packages/policy`
- [ ] Context management — token estimation, rolling history, compaction, pinned context, tool-output truncation
- [ ] Durable queue with leases; missed-schedule catch-up on wake from sleep
- [ ] Concurrency caps per automation and global; fair scheduling across repos
- [ ] Retry with backoff; model escalation on gate failure
- [ ] YAML automation spec parser + validator with line-accurate errors
- [ ] Gate runner — shell gates and `diff.*` assertions
- [ ] Budget enforcement with automation pause
- [ ] Model routing and fallback chains with strictness rules (explicit user selection is strict; defaults and scheduled jobs may fall back)
- [ ] Memory 2.0 — typed records, SQLite FTS search, summarisation, policy-controlled retrieval
- [ ] Sub-agents — `sessions.spawn`, isolated policy, `maxConcurrent = 4`, `maxDepth = 1`
- [ ] `packages/web` extracted from `App.tsx` with routing; Automations, Runs, Approvals, Repos, Providers screens
- [ ] **Chat console — managed mode.** System prompt, skills, memory, policy-filtered tools, inline approvals, mode diff against raw
- [ ] **Conversational automation authoring.** Draft → preview → dry run → save disabled, with `approvals.push` forced to manual on first run
- [ ] Console registered through the existing module slot contract rather than extending `App.tsx`

### 1.0 — Platform _(~3 weeks + hardening)_

- [ ] GitHub sign-in via **GitHub App** (not OAuth App) — short-lived installation tokens, per-repo scope, revocable; device flow for CLI and headless
- [ ] `apps/server` — headless daemon, systemd unit, Docker image, reverse-proxy guidance
- [ ] `apps/cli` — `clerq login | repo add | automation apply | run | logs | approve`
- [ ] Linux packages in the release matrix (`.deb`, `.rpm`, AppImage)
- [ ] `curl | sh` installer and a one-line `docker run`
- [ ] Restrictive Tauri CSP replacing `null`
- [ ] Real updater signing keys, signed artifacts, documented rotation and recovery
- [ ] `packages/plugin-sdk` — declared permissions, lifecycle, treated as code not prompt text
- [ ] Chat console migrated onto `plugin-sdk` as the reference first-party plugin — proving the contract by using it
- [ ] Skill manifests with `tools_required`, `network_domains`, `filesystem_scope`, checksum, trust states
- [ ] Versioned API protocol + migration system
- [ ] Published threat model and documented plugin/skill trust boundary

### Post-1.0 — Differentiators

Routing strategies (`cost_aware` / `quality_first` / `race` / `consensus`) · fleet runs across
repo globs with roll-up reporting · recipe registry · run replay and cost analytics · MCP
server exposure so other agents can drive OpenClerq · browser module · optional channel
adapter.

---

## 6. Automations as code

Cursor's automations live in Cursor's database. Ours are files — versionable, diffable,
reviewable in a PR, shareable as recipes. That single decision creates the ecosystem story.

```yaml
name: nightly-dependency-triage
description: Audit deps, patch safe bumps, open a draft PR

on:
  schedule: '0 3 * * 1-5' # weekday 03:00, host timezone
  catch_up: true # run once on wake if the slot was missed
  events: [pr_opened, issue_labeled:security]

targets:
  repos: [local:~/code/openclerq, github:paxamedia/*]
  max_parallel: 4

agent:
  driver: claude-code # builtin | claude-code | codex | cursor-agent
  model:
    primary: claude-opus-5
    fallback: [deepseek-reasoner, glm-4.6]
    strategy: cost_aware # quality_first | cost_aware | race | consensus

prompt: |
  Review dependency updates available in this repo.
  Apply only patch and minor bumps with no breaking changes noted.
  Update the lockfile. Do not touch source files.

sandbox:
  profile: container # native | seatbelt | container
  network: [registry.npmjs.org, api.github.com]
  filesystem: repo_only
  timeout: 20m

gates: # all must pass or the run does not publish
  - run: pnpm install --frozen-lockfile
  - run: pnpm test
  - assert: diff.files_changed <= 5
  - assert: diff.touches_none_of [src/**, .github/**]

publish:
  branch: 'auto/{{automation}}/{{date}}'
  pull_request: draft
  on_no_changes: skip
  notify: [desktop]

budget:
  max_usd_per_run: 2.00
  max_usd_per_month: 60.00
  on_exceed: pause_automation

approvals:
  push: auto
  merge: manual
  secrets_access: manual
```

Three surfaces over the same object: a form for people who want a form, a YAML pane for
people who want the file, and `clerq automation apply nightly.yaml` for people who want CI to
manage it.

---

## 7. Providers and drivers

### Layer 1 — Providers (raw model APIs)

| Provider                        | Adapter         | Notes                                                    |
| ------------------------------- | --------------- | -------------------------------------------------------- |
| Anthropic (Claude)              | `native`        | Already wired via `@anthropic-ai/sdk`; refresh model IDs |
| OpenAI (incl. Codex models)     | `openai-compat` | Existing generic adapter once a base URL is set          |
| DeepSeek                        | `openai-compat` | Registry row; chat + reasoner variants                   |
| Moonshot (Kimi)                 | `openai-compat` | Registry row; separate CN and international hosts        |
| Z.ai / Zhipu (GLM)              | `openai-compat` | Registry row; also exposes an Anthropic-shaped endpoint  |
| MiniMax                         | `openai-compat` | Registry row; also ships an Anthropic-shaped endpoint    |
| Local (Ollama, LM Studio, vLLM) | `openai-compat` | Already working                                          |
| **Cursor**                      | —               | **No public model API.** Layer 2 only                    |

> Base URLs, model IDs, context limits and prices change every few weeks. Ship them as
> `providers.yaml` that users can edit and that updates independently of releases. Verify
> every endpoint against current vendor documentation at implementation time — anything
> hardcoded today is stale by the next release, which is exactly finding #15.

### Layer 2 — Drivers (agent runtimes that edit files and run commands)

| Driver                       | Invocation                   | Model source                      | Effort    |
| ---------------------------- | ---------------------------- | --------------------------------- | --------- |
| `claude-code`                | `claude -p`, streaming JSON  | User's Claude subscription or key | Low       |
| `codex`                      | `codex exec` non-interactive | User's OpenAI account             | Low       |
| `cursor-agent`               | `cursor-agent -p` headless   | User's Cursor subscription        | Low       |
| `builtin`                    | In-process tool loop         | Any layer-1 provider              | High      |
| `aider`, `opencode`, `goose` | CLI                          | Any                               | Community |

A driver is a small interface — `prepare(workspace)`, `run(prompt, signal) → AsyncIterable<Step>`,
`collect() → Diff`. All drivers normalise to the same `Step` stream so the run detail view is
driver-agnostic.

---

## 8. Chat console

The automation runner is the unattended path. The chat console is the attended one — and
architecturally it is nearly free, because **a chat message is just a run with
`trigger: manual` in a session that has no schedule.** Same providers, same drivers, same
policy engine, same sandbox, same `runs` and `run_steps` records. Building it as a separate
thing would be the mistake.

It exists for three jobs.

### 8.1 Talk to any model you have a key for

One window, every configured provider. Pick a model per conversation, or fan one message out
to several and compare.

**Comparison mode** sends the same message to N models in parallel and streams the responses
side by side, each column labelled with model, latency, tokens and cost. Any column can be
promoted into the transcript as the canonical turn; the others are retained as alternatives on
that message.

This is the interactive form of the `race` and `consensus` routing strategies from §5 — the
same machinery, a different surface. Which makes the console the place where you _develop_ a
routing policy before committing it: try the cheap model against the expensive one on real
prompts, see where it actually falls down, then write the result into
`agent.model.strategy` in an automation spec.

### 8.2 See exactly what the pipeline does

Two pipeline modes, switchable per conversation and per message.

| Mode        | What OpenClerq adds                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Raw**     | Nothing. Your message goes to the provider as-is. No system prompt, no skill selection, no memory injection, no tool offer. The request body and the complete response — reasoning blocks, token counts, finish reason, raw JSON — are all inspectable. |
| **Managed** | The full pipeline: system prompt, skill routing, memory retrieval, policy-filtered tool set, approvals, secret redaction, output truncation, durable transcript.                                                                                        |

To be unambiguous about what "raw" means: it removes **OpenClerq's** additions, not the model
vendor's. Both modes are the same HTTPS call to the same endpoint under the user's own key, so
each provider's own policies apply identically in either. What raw mode buys is **pipeline
transparency** — when a managed answer or an overnight automation misbehaves, raw mode is how
you establish whether the model was wrong or our prompt assembly was. The existing
`POST /context/preview` endpoint is the seed of this; the console makes it a first-class
surface, and shows the two modes as a diff.

A raw conversation carries no tools and no filesystem reach by construction. It is a text
channel to a provider, and the policy engine has nothing to decide.

### 8.3 Write automations by talking

Describe what you want; the console drafts the spec from §6.

```text
You    Every weekday morning check my three repos for failing CI on main
       and open an issue summarising what broke.

Clerq  Drafted `weekday-ci-triage`.
       Schedule  Mon–Fri 08:00 Europe/Tallinn — next run Mon 8 Sep, 08:00
       Targets   3 repos      Driver  claude-code
       Estimate  $0.40–1.10 per run, ~$16/month

       [ Preview YAML ]   [ Dry run ]   [ Save — starts disabled ]
```

The flow is draft → preview → dry run → save, and the final step is deliberately awkward:

- A model-authored automation is **proposed, never armed.** It saves with `enabled: false` and must be switched on by a human action separate from the conversation that produced it.
- Its first run is forced to `approvals.push: manual` regardless of what the draft requested. The author can relax that afterwards, by hand, in the editor.
- The dry run resolves targets, expands the schedule into real dates, and prints the plan without executing anything.

That ceremony is not friction for its own sake. The console is the one place where untrusted
text — a pasted log, a repo file, an error message — meets a system that can create scheduled
jobs holding git push credentials. Without those two rules, "summarise this README for me"
becomes a path to a persistent backdoor. Rule 6 in [SECURITY.md](SECURITY.md) applies here
with particular force.

### 8.4 Modular by construction

The console ships as a **first-party module over the same contract third-party plugins use**,
not as a special case wired into the shell. That is deliberate: dogfooding the plugin API is
the only reliable way to learn whether it is good enough for anyone else.

The desktop already has the seam. `apps/desktop/src/moduleSlots.ts` defines
`ModuleUIComponent` and `BundledModuleMap`, `moduleRegistry.ts` tracks loaded manifests, and
`ModuleHost.tsx` renders them; the gateway side registers routes through the existing
`mountModuleRoutes` path. The console registers into that rather than extending `App.tsx`.

What that buys:

- **Removable.** Disable the module and the gateway, scheduler and automations keep running unchanged — no code edits, no rebuild.
- **Replaceable.** The three panels — raw, managed, compare — are panel _types_ over one transport, declared in the manifest. Anyone who wants a different chat UI ships their own module against the same API and drops ours.
- **Headless-safe.** A server install can omit it entirely; the automation engine has no dependency on it.
- **Reusable transport.** `POST /sessions/:id/send` with a streaming response is the same endpoint `clerq chat` uses from the CLI. The UI is one client of that endpoint, not the definition of it.

---

## 9. The two-week slice

The full plan is roughly three months. Do not build it in order and hope. Cut one vertical
slice, use it daily for a week, and let what annoys you set the order of everything after.

| In                                         | Deliberately out                        |
| ------------------------------------------ | --------------------------------------- |
| Release 0.4 in full — non-negotiable       | Remote repo cloning                     |
| Local repos, registered by path            | Every driver except one                 |
| One driver: `claude-code`                  | Containers and seatbelt                 |
| Cron schedule + manual "run now"           | GitHub sign-in, server mode, CLI        |
| `native` sandbox with an explicit warning  | Routing, budgets, approvals, sub-agents |
| Git worktree → branch → commit → push → PR | `diff.*` assertions                     |
| Shell gates (`run:`) only                  | Fleet runs                              |
| Runs persisted, streamed, viewable         | The `builtin` driver                    |
|                                            | The chat console — both modes           |

This answers the only question that matters early: _is a scheduled agent that opens gated PRs
actually useful, or does it just make noise?_ The console is out despite being cheap, because it
answers a different question and would absorb the fortnight if allowed to. Everything in 0.5 and beyond is amplification —
and if the slice is not useful, amplifying it is the wrong move.

---

## 10. What we deliberately do not build

Restraint is a feature. A smaller core with stronger boundaries is the position.

- **No messaging channels** initially — Telegram, Discord, WhatsApp, Signal are someone else's identity
- **No unrestricted plugins** — executable plugins are code, and declare permissions
- **No remote gateway access by default** — remote mode is explicit, authenticated, and TLS-terminated
- **Localhost is not authentication** — never treat a loopback bind as an authorisation decision
- **Developer mode is not production authority** — `CLERQ_DEV` must not disable auth
- **No unlimited sub-agent tools or depth** — spawned agents get a narrower policy than their parent, never a wider one
- **Skills do not imply permissions** — a skill declares what it needs; the policy engine decides
- **HTTP redirects do not bypass network policy** — every hop is revalidated
- **No plaintext provider secrets** as the production path
- **No autonomous loop without a budget and a timeout**
- **Browser automation never inherits the personal browser profile**
- **Push is not merge** — draft PRs by default; auto-merge is opt-in and gated
- **No self-arming automations** — a spec drafted in chat saves disabled and pushes manually on its first run, whatever the draft asked for
- **Raw chat gets no tools** — a conversation that bypasses the pipeline bypasses the tool set with it; there is no mode that strips our prompt scaffolding while keeping filesystem or shell reach

---

## 11. Security posture

Be clear-eyed about what this is: a service that takes untrusted natural language, hands it to
a model, and executes the result with filesystem, shell, network and git-push access —
optionally on a server with a login page. Handled carelessly that is a remote code execution
product with a friendly UI. Handled deliberately, the discipline is a feature nobody else in
this category is selling.

The nine binding rules and the threat model live in [SECURITY.md](SECURITY.md).

---

## 12. Open decisions

These change what gets built and should be settled before release 0.4 starts.

1. **Does the clerical identity survive?** The repo promises local administrative automation; this roadmap adds repository automation. Coherent — same engine, two domains — but the README, product name and positioning need a deliberate rewrite. If the clerical framing is being retired instead, say so now: it changes the Rust engine's fate and about a third of the docs.
2. **Is the server multi-user, or single-user with remote access?** The biggest scope fork here. Single-user is roughly a week. Multi-user adds RBAC, per-user credentials, repo permissions and tenancy through every table. _Recommendation: single-user now, schema designed so `user_id` can be threaded through later._
3. **Hosted runners eventually?** If yes, the sandbox interface needs a remote implementation designed in from the start — cheap now, expensive to retrofit. This also decides whether there is a commercial layer above the open core.
4. **Licensing posture.** Currently MIT. If a hosted version is ever the business, MIT lets any cloud vendor host this verbatim. Decide before contributors arrive — relicensing afterwards requires their consent and is usually impossible in practice.
5. **Are raw-mode transcripts persisted?** Managed conversations must be — they carry tool calls, approvals and spend, and rule 9 requires an audit trail. Raw mode is arguably a scratchpad, and users may reasonably expect it not to be recorded. _Recommendation: persist by default with a visible per-conversation "ephemeral" toggle, and never persist the raw request body of a conversation marked ephemeral._ Decide before the console ships in 0.5 — retrofitting deletion semantics onto an append-only store is painful.
6. **What happens to `packages/calculation-core`?** _Recommendation: keep it, and generalise its pattern rather than its content._ Deterministic local execution with a signed proof object, applied to diffs and gate results instead of arithmetic, turns "an AI wrote this" into "an AI wrote this and here is the evidence it is safe" — which is the objection that actually blocks team adoption.

---

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — current system as built
- [SECURITY.md](SECURITY.md) — threat model, binding rules, release checklist
- [TOOLS.md](TOOLS.md) — tool reference and capability configuration
- [MODULE_SYSTEM.md](MODULE_SYSTEM.md) — skills and modules
- [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md) — running locally
- [DISTRIBUTION.md](DISTRIBUTION.md) — signing, notarization, updater
