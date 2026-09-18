# OpenClerq Roadmap

Where OpenClerq is going, and what has already landed. For the system as it is built today,
see [ARCHITECTURE.md](ARCHITECTURE.md); for what it protects, [SECURITY.md](SECURITY.md).

---

## 1. What we are building

### 1.1 Product

OpenClerq schedules and supervises coding agents on hardware you control. It runs the agent
you already use — Claude Code, Codex, cursor-agent, or a model API directly — against the
repositories you point it at, and provides the layer around it: scheduling, isolation, model
routing, verification, cost control and an audit trail.

Agents run under your own subscriptions, so OpenClerq has no billing relationship with any
model vendor.

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

The runtime is how a run executes; the orchestration layer decides when runs happen, where
they execute, and whether their output ships.

### 1.3 Two domains

OpenClerq began as a clerical automation tool; this roadmap adds repository automation. Both
use the same engine: schedule, isolate, execute, verify, report.

---

## 2. Target architecture

### 2.1 Packages

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

### 2.2 Sessions and runs

Two objects hold state, and both are needed:

- A **session** is a conversational identity with a transcript. Interactive chat is a session. An automation's execution history is a session. Sessions are what make follow-up and takeover possible.
- A **run** is one bounded execution within a session — one scheduled firing, one manual trigger, one sub-agent task. Runs carry status, cost, and a step trace.

One session has many runs. One run has many steps.

### 2.3 Run state machine

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

### 2.4 Schema

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

### 2.5 Event bus

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

## 3. Release trains

### 0.4 — Foundation — shipped

Closes the blocking security gaps and lays the storage layer everything downstream writes
into.

- [x] Bind `127.0.0.1` by default; `--host` requires an explicit flag **and** a configured token
- [x] Split authentication from licensing — `CLERQ_GATEWAY_TOKEN`, `Authorization: Bearer`, `/health` public and everything else authenticated
- [x] Remove the production `CLERQ_DEV` bypass; generate a token on first run and hand it to the desktop app
- [x] Canonical path validation — `realpath` + `path.relative`, explicit symlink policy, size caps
- [x] SSRF hardening on `http.request` — scheme allowlist, manual redirect validation, block loopback/link-local/private ranges and metadata endpoints, timeouts, response size cap, method allowlist
- [x] `packages/store` — SQLite + WAL, migration runner, schema from §2.4
- [x] Migrate `memory.json` and `triggers.json` into SQLite with a one-time importer (`capabilities.json` remains a file)
- [x] Lock CORS to the desktop origin; drop the `*` dev path
- [x] Secrets master key → OS keychain (Keychain / libsecret / DPAPI), generated on first use; mode-0600 key file for headless hosts
- [x] Typed event bus + append-only audit log
- [x] Remove the unused `fsAllowWrite` flag
- [x] Fix version drift; extend `sync-version.js` to cover `/health`
- [x] CI gates: typecheck, lint, Vitest, `cargo test`, `pnpm audit`, `cargo audit`, secret scan — all required before build

### 0.5 — Execution — shipped

Items marked _library_ are built and tested, but nothing in the gateway calls them yet — no
tool runs commands or touches a repository today. The 0.6 agent runtime is their first
consumer.

- [x] _library_ — `packages/sandbox` — `native` (development only, warns), `seatbelt` (macOS `sandbox-exec`), `container` (Docker/Podman, server default)
- [x] _library_ — Per-run limits: wall clock and output size everywhere; CPU, memory and process count in containers; the process group is killed on breach
- [x] _library_ — Egress allowlist enforced at the sandbox boundary, not in application code — a local proxy the sandbox forces traffic through; profiles that cannot enforce it refuse it (see [SECURITY.md](SECURITY.md) for what macOS can and cannot filter)
- [x] _library_ — `packages/policy` — tool groups (`fs`/`runtime`/`web`/`sessions`/`memory`/`automation`), profiles, allow/deny, `maxCallsPerRun`
- [x] Approval system with risk tiers; `POST /approvals/:id/approve|deny`; allow once / allow for session / deny — _the inbox and endpoints are live, but nothing raises an approval until a tool needs one (0.6)_
- [x] _library_ — `packages/workspaces` — register local paths, clone remotes to a content-addressed cache, one `git worktree` per run
- [x] _library_ — Git publish path: branch, commit with a machine-identifiable trailer, push, PR via GitHub/GitLab API
- [x] _library_ — Secret injection as sandbox env only, with output redaction on the way back
- [x] `packages/providers` + `providers.yaml` — base URL, auth env var, model list, context window, price per million tokens
- [x] Per-call token and cost accounting into `run_steps` — an unpriced model records unknown cost, never $0
- [x] **Chat console — raw mode.** Per-provider conversations, streaming, full request/response inspection
- [x] **Chat console — comparison mode.** One message fanned out to N models, side by side with latency, tokens and cost; any column can be promoted into the transcript

### 0.6 — Agents and automations

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

### 1.0 — Platform

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

## 4. Automations as code

Automations are files — versioned, diffable, reviewable in a pull request, and shareable as
recipes.

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

## 5. Providers and drivers

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
> hardcoded today is stale by the next release.

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

## 6. Chat console

The automation runner is the unattended path. The chat console is the attended one — and
architecturally it is nearly free, because **a chat message is just a run with
`trigger: manual` in a session that has no schedule.** Same providers, same drivers, same
policy engine, same sandbox, same `runs` and `run_steps` records. Building it as a separate
thing would be the mistake.

It exists for three jobs.

### 6.1 Talk to any model you have a key for

One window, every configured provider. Pick a model per conversation, or fan one message out
to several and compare.

**Comparison mode** sends the same message to N models in parallel and streams the responses
side by side, each column labelled with model, latency, tokens and cost. Any column can be
promoted into the transcript as the canonical turn; the others are retained as alternatives on
that message.

This is the interactive form of the `race` and `consensus` routing strategies from §3 — the
same machinery, a different surface. Which makes the console the place where you _develop_ a
routing policy before committing it: try the cheap model against the expensive one on real
prompts, see where it actually falls down, then write the result into
`agent.model.strategy` in an automation spec.

### 6.2 See exactly what the pipeline does

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

### 6.3 Write automations by talking

Describe what you want; the console drafts the spec from §4.

```text
You    Every weekday morning check my three repos for failing CI on main
       and open an issue summarising what broke.

Clerq  Drafted `weekday-ci-triage`.
       Schedule  Mon–Fri 08:00 Europe/Tallinn — next run Mon 8 Sep, 08:00
       Targets   3 repos      Driver  claude-code
       Estimate  $0.40–1.10 per run, ~$16/month

       [ Preview YAML ]   [ Dry run ]   [ Save — starts disabled ]
```

The flow is draft → preview → dry run → save:

- A model-authored automation is **proposed, never armed.** It saves with `enabled: false` and must be switched on by a human action separate from the conversation that produced it.
- Its first run is forced to `approvals.push: manual` regardless of what the draft requested. The author can relax that afterwards, by hand, in the editor.
- The dry run resolves targets, expands the schedule into real dates, and prints the plan without executing anything.

The console is where untrusted text — a pasted log, a repo file, an error message — meets a
system that can create scheduled jobs holding git push credentials. The first two rules stop
a prompt injected through that text from arming a persistent job (see rule 6 in
[SECURITY.md](SECURITY.md)).

### 6.4 Modular by construction

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

## 7. What we deliberately do not build

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

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — current system as built
- [SECURITY.md](SECURITY.md) — threat model, binding rules, release checklist
- [TOOLS.md](TOOLS.md) — tool reference and capability configuration
- [MODULE_SYSTEM.md](MODULE_SYSTEM.md) — skills and modules
- [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md) — running locally
- [DISTRIBUTION.md](DISTRIBUTION.md) — signing, notarization, updater
