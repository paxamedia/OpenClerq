# Changelog

All notable changes to OpenClerq will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Automations.** A YAML spec (a subset of the format in `docs/ROADMAP.md` §4) runs a coding agent against a local repository, on a schedule or on demand: in a fresh git worktree started from origin's copy of the base branch, then the spec's gates, then a push and a draft pull request. New automations are saved disabled. Pushing waits in the approvals inbox unless the spec sets `approvals.push: auto`, and an automation's first push always waits. Endpoints under `/automations`, plus `GET /drivers` and `GET /runs/:id/artifacts/:id`.
- **`claude-code` driver** (`packages/drivers`). It runs Claude Code's CLI under the user's own sign-in, with no API key unless the spec names a vault secret.
- **`codex` and `cursor-agent` drivers.** `agent.driver` accepts both. `codex` runs `codex exec --json` in Codex's own sandbox (`workspace-write` for `acceptEdits`, with network access turned on because Codex turns it off there; `read-only` for the other modes); `cursor-agent` runs `cursor-agent --print --output-format stream-json`, which in agent mode edits the workspace and runs only commands on the user's own allowlist (`plan` and `default`/`dontAsk` use Cursor's plan and ask modes). `dontAsk` is the restrictive end in every driver, as in Claude Code. Both stream the same events as `claude-code`, stop their process group on cancel or timeout, and say plainly when the CLI is missing or not signed in; `detect` also reads the CLI's `--help` and names an option an older CLI lacks. Neither is ever started with its run-everything switch. Neither CLI reports a cost or takes a spend limit or a tool list, so a spec that sets `budget.max_usd_per_run`, `budget.max_usd_per_month` or `agent.allowed_tools` for them is refused when saved, naming the key. `agent.api_key_secret` is handed to the CLI as `CODEX_API_KEY` or `CURSOR_API_KEY`. Their output formats follow the vendors' documentation and are tested against fake CLIs only. Override the CLI path with `CLERQ_CODEX_BIN` or `CLERQ_CURSOR_BIN`.
- `GET /drivers` lists all three drivers, each with `signedIn` where the CLI says; a spec that does not name its own key needs the driver to be signed in.
- **Agent processes a crashed gateway left behind are stopped.** The gateway records every agent and gate process of a run (pid, process group, the OS's start time, command) in the new `run_processes` table, and on the next start stops what is still running before it marks interrupted runs failed and removes their worktrees, saying so on the run. A group is stopped only if its leader is still there with the recorded start time and, for an agent, a command line that still names the CLI; the leader is read again just before the group is signalled, and a group whose leader has gone, or a record with no start time, is left alone. Runs now carry the pid and start time of the gateway that created them, and a run whose gateway is still running is not treated as interrupted. Needs `ps` with `lstart` (macOS, procps).
- When an agent or a gate exits, anything it left running in its process group is stopped. `exec()` in `@clerq/sandbox` gains `onSpawn` and `reapGroup` options.
- Budgets per run (passed to the CLI) and per month (pausing the automation), one run per automation at a time, and a global cap, `CLERQ_MAX_CONCURRENT_RUNS`; runs beyond it wait in the queue.
- A run records the worktree, the agent's tool calls, each gate, the commit, the push and the PR as steps, and keeps the diff and the agent's output. A run interrupted by a restart has its worktree removed and is marked failed, or retried when its spec allows.
- Desktop **Automations** module: a spec editor that checks a spec against this machine before saving, runs with their steps and diff, and the approvals inbox.
- `packages/web`, the start of the rebuilt desktop interface: design tokens for light and dark, bundled DM Sans and JetBrains Mono, an icon wrapper, and tests that fail on corners over 1px, inline styles, colours or fonts outside the tokens, and text contrast below WCAG AA.
- `GET /events/stream`: the event bus as resumable SSE, with `Last-Event-ID`, a `reset` frame, name filters and a heartbeat. `gateway.streamEvents()` and `gateway.eventsStreamUrl()` in `@clerq/gateway-client`.
- **Module platform.** A module's `register(ctx)` gets a ModuleContext: routes, store, secrets, approvals, audit, logger and config, scoped to its id. Types in the new `@clerq/module-sdk`, with a hello-world example. `GET /modules` lists modules and whether each loaded.
- Module migrations: `<module>/migrations/NNNN_name.sql`, applied by `packages/store` and limited to tables named `mod_<id>__*`.
- Module events: `ctx.events.emit('x')` puts `module.<id>.x` on the event bus.
- Module handler triggers (cron, file, webhook), each firing recorded as a run with `moduleId` and `triggerId`, and paused by the kill switch.
- Scoped module tokens: `POST /modules/:id/token` issues a short-lived token valid for `/api/modules/:id/*` plus the manifest's `coreEndpoints`; `DELETE /modules/:id/tokens` revokes them.
- Module UIs: the gateway serves `<module>/dist/ui` at `/api/modules/:id/ui/`.
- `ctx.notify` and `ctx.notify.badge` emit `notify.posted` and `notify.badge` for the desktop and devices. `@clerq/gateway-client` gains `modules()`, `moduleToken()`, `revokeModuleTokens()` and `fireModuleTrigger()`.
- Module services: start, stop and status for the launchd agents a manifest declares, as `ctx.services` and under `/api/modules/:id/services`.
- **Shared records**: people, organisations and activities with identity resolution by email, phone and domain, refs (`<module>:<type>:<id>`), links between any refs, and merge. Endpoints under `/records`, `/links` and `/activities`; `ctx.records` for modules.
- Manifest `extensions` (`nav`, `home.tile`, `record.panel`, `record.action`, `search`, `inbox.item`, `settings.page`) listed at `GET /extensions`; `GET /search` across core records and modules; one inbox at `GET /inbox` with module items and pending approvals.
- **Tenants**: records, links, activities, inbox items and every module table carry a `tenant_id` (default `default`). A request's tenant comes from its scoped token or `X-Clerq-Tenant`; `ctx.tenant`, `ctx.withTenant()` and the tenant-scoped `ctx.store.rows()` for modules. A single-tenant install behaves as before.
- **Remote mode and device pairing**: an opt-in HTTPS address for the user's tunnel, single-use pairing codes valid five minutes, device tokens scoped to the mobile API set with last-seen and instant revocation. The gateway stays on loopback.
- Push to paired phones through ntfy, one random topic per device: approvals, new inbox items, failed runs and module notifications, as a generic title and an id only.
- Manifest `permissions` are parsed, listed at `GET /modules`, stored, and audited when they change. Not enforced.
- Automation summaries carry `monthBudgetUsd` and `nextFirings` (the next ten); `GET /runs` takes `since`.
- Component kit in `packages/web` for the new interface: buttons, fields, checkbox, switch, segmented control, tabs, a sortable table, run status tags, key–value lists, code blocks, skeletons, empty states, tooltips, popovers, menus, dialogs, a drawer and toasts. All keyboard-operable; the Foundations page shows each one in both themes.
- **New interface** in `packages/web`, mounted by the desktop: a rail (bottom tabs at phone width), a top bar, a status bar with connection, running runs and month spend, a ⌘K palette that searches records and every module, and routes for every page (`#/runs/<id>`, `#/m/<module>/<path>`) with Back across modules. Pages follow `/events/stream` live.
- Home with tiles and 14-day sparklines, an activity timeline, next runs, what needs you, a first-run checklist and module tiles. Automations with run strips, budget meters, a schedule heatmap, cost per run and an editor that checks the spec as you type. Runs with filters, a pipeline stepper, a step waterfall and a diff viewer. One inbox for approvals and module items, with J/K/A/D keys. Records with module panels and actions. Chat with an inspector and comparison bars.
- Settings in the main window: General (theme, start page, emergency stop), Models & keys with a **Test** per provider, Secrets, Skills, Memory, Triggers, Remote, Devices (pairing QR, last seen, revoke), Advanced, and modules' own settings pages. Developer: tool runner, calculator, task runner with context preview, live log, service figures.
- Module UIs in a frame with a token bridge; module notifications as native notifications; the inbox count on the app icon; a content security policy that allows only the loopback gateway.
- `pnpm ui:shots`: every page in both themes at three sizes, over fixture data.
- **Tool calling in `@clerq/providers`.** `call` and `callStream` take `tools` and a conversation of text, tool-call and tool-result blocks, and return the model's `toolCalls`, its whole turn as `content` and a normalised `stopReason`, for the `anthropic` adapter (`tool_use` / `tool_result`, streamed `input_json_delta`) and `openai-compat` (`tools` / `tool_calls` / `role: "tool"`, streamed argument fragments). Tool input that is not valid JSON is flagged rather than guessed at. Anthropic `thinking` blocks are handed back unchanged; an OpenAI-compatible server's `reasoning_content` is sent back only when its registry entry sets `replayReasoning: true`. Tokens and cost are recorded per call as before; an unpriced cloud model's cost stays unknown.
- **Context management** in `@clerq/providers`: token estimation (the provider's count once reported, a documented heuristic until then), a context budget from the registry's context window, a conversation with pinned turns and rolling history, compaction that has the model summarise older turns (or drops them with a note, keeping any earlier summary), skipped when it would free too little, and tool-output truncation that says how to get the rest.
- **`builtin` agent driver.** `agent.driver: builtin` with `agent.model: <provider>/<model>` runs OpenClerq's own tool loop over any model in the registry. Its tools read, list, search, write and edit files in the run's worktree, run shell commands through the sandbox, and show `git status` and `git diff`. Every call goes through `packages/policy`: full access by default, a push from the shell waits for approval in every mode, `permission_mode: default` sends writes and commands to the approvals inbox, and `agent.allowed_tools` takes policy rules. Paths follow links whose target does not exist yet, and writes do not follow a link. Tool inputs and outputs are redacted of the vault values the run uses. An approval the agent is waiting on is closed when the agent stops or runs out of time. Bounded by 60 turns, `sandbox.timeout`, 400 tool calls and `budget.max_usd_per_run`, measured from recorded cost with each next call counted at its full output limit; a dollar budget for an unpriced cloud model fails the spec check. A turn cut off at the output limit does not run its last tool call, and a turn that ends without an answer fails the run. Each model call is a run step with its tokens and cost, and older context is compacted when the window fills. `GET /drivers` lists it with each provider's readiness. Tested against a scripted model only.
- Every tool call an agent makes is also a row in the new `tool_calls` table (store migration 13), with whether a person was asked.
- **Durable run queue with leases.** Automation runs are queued as rows (`queued`), leased by a gateway (`leased`, `lease_until`, renewed while the run works) and survive a restart. A run whose lease has expired and whose gateway is gone is claimed in one conditional write, so two gateways on one store cannot both settle it, then its processes are stopped, its worktree removed, and it is retried or failed; a run only leased is put back at most three times. A queued run can be cancelled, switching an automation off cancels its queued runs, and the kill switch cancels queued runs and holds the queue. The kill switch's pause is kept in the store, so a restart does not release it. The desktop says when a started run has to wait. `POST /automations/:id/run` answers `queued: true` when the run waits for a place. Store migration 14 (`runs.attempt`, `runs.not_before`, `automations.last_slot_at`).
- **Missed-schedule catch-up.** A slot missed while the machine slept or the gateway was down runs once when noticed with `on.catch_up: true`, however many were missed; without it the slots are skipped and recorded (audit log `automation.slots_missed`, event `schedule.missed`, `missedSlots` in the automation summary), and so is a slot whose run could not be queued. A slot is claimed by compare-and-set in the same transaction as its run, so two gateways on one store cannot both fire it. Sleep is noticed as the wall clock jumping past the monotonic clock (`schedule.woke`). Slots missed while the kill switch held schedules are never caught up.
- **Fair scheduling across repositories.** With more runs queued than `CLERQ_MAX_CONCURRENT_RUNS` allows, the next is taken from the repository with the fewest runs going, then the one served longest ago, oldest first within it. `targets.max_parallel` stays refused: targets are one repository per automation.
- **Retries with backoff.** `retry.max_retries` and `retry.backoff` (doubling, at most an hour) retry a run after an agent crash, a provider 5xx/429 or outage, or an expired lease, never after a policy decision, a budget, a time limit, a denial, a gate or a cancel, nor once the automation is switched off. Only what the driver reports is read, never the agent's final message. Every attempt is one run, under one `max_usd_per_run` for what the attempts reported; a crashed attempt with no reported cost makes the run's cost a lower bound. Drivers report `crashed` when the CLI exited without a result, and `apiError` for an API error the CLI itself printed.
- **Model escalation on gate failure.** `agent.model.escalate: [model, …]` runs the agent again with the next model when a gate fails, in the same worktree, with the failed check in its prompt; one commit per run. Each attempt is an `agent.escalate` step and gets only what is left of the run budget; the month budget is checked before each. Every model is checked before the run starts, so an unpriced model with a dollar budget is refused at the spec check (builtin). Event `model.escalated`.
- **Gate diff assertions.** `assert: diff.files_changed | diff.lines_added | diff.lines_removed <op> N` and `assert: diff.touches_none_of | diff.touches_only [globs]`, read by a small parser when the spec is saved (errors carry line and column), checked against the run's diff from its base, each recorded as a gate step.
- **Model fallback.** `agent.model.fallback: [model, …]` names the models to use, in order, when the one in use is unavailable: its provider is down, overloaded or rate limiting, did not answer, refused the key, or has no key. It is decided from what the provider adapter reports about the failed call (`ProviderError.unavailable` in `@clerq/providers`), never from the words of an answer; a request the provider refused as malformed, or an unknown model id, never falls back. The builtin agent switches in the middle of its run (the failed call is recorded, the old model's reasoning is dropped from the history, the conversation is fitted to the new model's window, and the turn does not count against the turn limit); a CLI agent is started again with the next model at once, without a backoff or a retry used, and told what the interrupted attempt left in the worktree. When every model is unavailable the run fails, and `retry` may take it from the top. Each move is a `model.fallback` event with the run (and chat session), a `model.fallback` run step, and `llm_fallbacks_total` in `GET /metrics`. Budgets keep applying: each attempt is held to what is left, and a fallback model with no price under a dollar budget is refused at the spec check. `agent.model.strategy` stays refused, now saying it is planned after 1.0 and which keys to use instead.
- **Strictness.** A model a person chose is used as chosen. `POST /automations/:id/run` takes `{ "model": "…" }`, which runs that model in place of the spec's primary and never falls back (the choice is kept through a retry; store migration 15, `runs.model_override`). The spec's models, and the defaults, may.
- **A default chain for chat and tasks.** `PUT /routing { fallback: ["provider/model", …] }` (read with `GET /routing`) names the models managed chat, `/task`, `/explain` and gateway triggers use when the default model is unavailable. A call that names a model (`/task` or `/explain` `model`, a session's model, a comparison column) uses it as chosen, and so does every raw-mode message, since a raw call is one request to one model. A stream that has already sent text is never moved. Empty by default.
- The builtin agent's API key (`agent.api_key_secret`) is only given to models of the provider of the spec's own primary model, so a fallback, an escalation or a model named for one run on another provider uses that provider's own key and the key is never sent to a vendor it was not for. A spec check and a run check every model of the chain through one function.
- **Memory 2.0.** Memory records have a type (`fact`, `preference`, `decision`, `procedure`, `note`), any number to a key, an origin, a confidence, a source session and an expiry. Search is SQLite FTS5, best match first (the key counts more than the value), falling back to substring match where the SQLite in use has no FTS5 or nothing matches by word; checked under Node and Bun. A model can fold the records of one key into one (`POST /memory/consolidate`, a run of its own, an audit entry, the records kept as `superseded`), and `POST /memory/records/:id/unconsolidate` restores them. The summary expires with the latest of its sources (never, if any source does not), carries `agentDerived` when any source came from an agent (store migration 17), and deleting or expiring a summary removes everything folded into it, at any depth; undoing a summary that is itself folded into another is refused. Managed chats and `/task` read memory into the system prompt under a policy of `memory.read.<type>` rules in `packages/policy`: the preferences always, other types by relevance, only the types the policy allows (`GET`/`PUT /memory/policy`, every type by default). An automation reads memory only when its spec says so (`memory: { read: [types] }`, off by default, so an unattended run does not send saved notes to a model unasked): the types become `memory.read.<type>` rules of the run's own policy, and what was read is a run step. Raw mode reads nothing, and neither do cron, file and webhook triggers. Every `<` and `>` in a note's key or value is escaped in the block. Expired records are never read, and are removed at start and when memory is read, at most hourly. `memory.updated` is emitted for every change. New endpoints under `/memory/records`, `/memory/search`, `/memory/consolidate` and `/memory/policy`; the Memory screen in Settings picks a type and searches. Store migration 16 rebuilds the `memory` table and copies every existing row across as a `fact`.

### Removed

- The 0.5 interface: the entry screen, mode picker, Builder/Operator toggle and the separate settings window. Their features are in the new pages.

### Changed

- The module manifest schema accepts `config`, `coreEndpoints`, `services`, `permissions` and `extensions`.
- `packages/sandbox` gives a command a minimal environment unless `inheritEnv` is set, streams output line by line, and stops on an abort signal.
- In this release automations run without isolation, and a spec must say `sandbox: { profile: native }` to run.
- An OpenAI-compatible server that refuses `max_tokens` and names `max_completion_tokens` instead (OpenAI's reasoning models) is retried once with it.
- The canonical path-containment check moved from the gateway to `@clerq/sandbox` (`resolveWithinRoot`), so the agent drivers use the same one.
- `GET /memory`, `GET /memory/:key` and `POST /memory` answer as before with the record's `id`, `type`, `origin`, `status` and other fields added; a key may now appear more than once, and `DELETE /memory/:key` forgets all of them. A key set with `POST /memory` is still one `fact`, updated in place.

### Fixed

- Deleting a memory entry from the desktop sent no gateway token.
- Cron triggers with a weekday or day-of-month field, such as `0 8 * * 1`, could fail to fire: node-cron 4.2.1 miscalculated when they were next due. Upgraded to 4.6.0.
- A module list saved in the desktop settings hid modules bundled with later releases.

### Security

- `body-parser` and `qs`, used by Express in the gateway, are pinned to their patched releases.
- The desktop's `rustls-webpki` and `webpki-root-certs` are updated past advisories that let distrusted certificate intermediates verify.
- Build and test tooling moves to `vite` 7.3.7 and `vitest` 5.0.5, past advisories in the dev server and the test mocker.

## [0.5.1] — 2026-10-17

The first published release. Its installers carry the real updater key, so they can update in-app from 0.5.1 on.

### Fixed

- A skill selected by `/task` now sends its `SKILL.md` instructions to the model, in the system prompt and capped at 16,000 characters. Before, only its name was sent. `POST /context/preview` with `skillSlug` shows the same prompt.
- A managed chat session now sends its earlier turns to the model; each message used to be answered on its own. `POST /context/preview` with `sessionId` includes them.
- A file trigger fires once its file has been quiet for a second, instead of once per filesystem event. A cron or file trigger whose previous run is still going is skipped and logged rather than started again.
- A tagged release attaches its installers; the publish step looked one folder too high and found none. The update manifest names each bundle's architecture, where the Apple Silicon bundle was listed as Intel, and a tag that does not match the app version is refused.

### Security

- The desktop app's Rust dependencies are updated past advisories in `rustls`, `rustls-webpki`, `tar` and `quick-xml`.
- `proxy-addr` (used by Express in the gateway) and `source-map-js` (desktop build tooling) are pinned to their patched releases.
- The desktop updater is built without its `zip` feature, removing the `zip` crate and three advisories in its extraction code. Releases ship the `.msi` and setup `.exe` unzipped, which is all the updater now accepts on Windows.

## [0.5.0] — Execution — 2026-09-18

`packages/policy`, `packages/sandbox` and `packages/workspaces` ship as tested libraries. The
gateway does not call them yet; the 0.6 agent runtime is their first consumer.

### Added

- **Model providers.** A registry covering Anthropic, OpenAI, DeepSeek, Moonshot (Kimi), Z.ai (GLM), MiniMax, Ollama and LM Studio. Choose one with `CLERQ_LLM_PROVIDER`, or name a qualified model such as `deepseek/deepseek-chat`. Override the built-in registry with `~/.clerq/providers.yaml` or `CLERQ_PROVIDERS_FILE`. `GET /providers` lists providers and models.
- **Chat console** desktop module. Raw mode adds nothing to the conversation and shows the exact request body; managed mode runs the full `/task` pipeline; comparison sends one message to up to eight models, with latency, tokens and cost per answer. Answers stream and can be stopped. Endpoints under `/sessions`.
- **Run history.** Tasks, trigger firings, webhooks and chat messages are recorded as runs with their request and a step trace: `GET /runs`, `GET /runs/:id`.
- **Cost accounting.** Each model call records its tokens and cost against its run. A model with no registry price is reported as unknown cost rather than $0. `GET /metrics` adds `llm_cost_usd_total` and `llm_unpriced_calls_total`.
- **Cancellation.** `POST /runs/:id/cancel` stops a run; a streamed answer names its run first. Under Node, a client disconnecting also cancels its run — send `continueOnDisconnect: true` to let it finish.
- **Kill switch.** `POST /kill` refuses pending approvals, cancels running runs and pauses triggers. `POST /resume` restarts triggers; `GET /kill` reports the state.
- **Approvals** with risk tiers: `GET /approvals`, `POST /approvals/:id/approve|deny`. An approval nobody answers is refused.
- **Event stream** at `GET /events` (SSE): runs, model calls and approvals.
- **SQLite store** at `~/.clerq/clerq.db`, with migrations. `memory.json` and `triggers.json` are imported on first start and kept as `*.migrated`.
- **Vault key in the OS keychain** — macOS Keychain, libsecret or Windows DPAPI — generated on first use. `CLERQ_VAULT_KEY` still works; hosts without a keychain use `~/.clerq/vault.key` (mode 0600).
- `GET /memory/search?q=`.
- Libraries: `packages/policy` (tool rules, profiles, budgets), `packages/sandbox` (native, seatbelt and container isolation with an egress allowlist), `packages/workspaces` (a git worktree per run, draft pull requests).

### Changed

- The gateway calls models through `@clerq/providers`, and `@anthropic-ai/sdk` is removed. Every provider error answers `503 ai_unavailable`.
- Anthropic's default model is `claude-haiku-4-5`.
- Triggers are stored in SQLite and validated on save: an invalid cron schedule answers `400` with the reason. Webhook firings return the `runId`.
- Model responses are capped at 8 MiB (`CLERQ_MAX_RESPONSE_BYTES`). A stream over the limit is cut off and marked truncated.
- Development requires Node 24. The desktop app is unaffected.
- CI also runs on macOS, fails on moderate advisories, and checks that every package carries the same version.

### Fixed

- `~/.clerq` and the files in it holding keys, conversations and the vault are readable only by their owner (0700 and 0600), and existing installs are repaired on startup. `CLERQ_KEEP_PERMISSIONS=1` leaves deliberately shared paths alone.
- Saving the API key in the desktop app no longer overwrites other entries in `~/.clerq/.env`.
- Automatic persistent runs are scheduled by the gateway, instead of by a timer that ran only while the developer view was open.
- The Settings window authenticates to the gateway; its sections failed with `401`.
- `CLERQ_OLLAMA_URL` accepts the server root or its `/v1` path.
- A workflow file reported a failed run on every push, and release builds failed when signing secrets were not configured.
- Advisories in `qs` and `body-parser`.

### Removed

- `CLERQ_OPENAI_API_KEY`, an undocumented alias for `OPENAI_API_KEY`.

## [0.4.0] — Security foundation

**Breaking:** the gateway API now requires authentication.

### Security

- **Gateway authentication.** Every endpoint except `GET /health` requires `Authorization: Bearer <token>`, compared in constant time. The token is generated at `~/.clerq/gateway-token` (mode 0600) on first run, or supplied with `CLERQ_GATEWAY_TOKEN`. `CLERQ_DEV` no longer affects access.
- **Licensing no longer stands in for authentication.** The license middleware attaches entitlement information and never rejects.
- **Loopback binding.** The gateway binds `127.0.0.1` unless `CLERQ_HOST` is set, which logs a warning. It previously bound all interfaces.
- **Path containment.** `fs.read` resolves against the real path of its root and rejects traversal, sibling-prefix escapes, absolute and UNC paths, NUL bytes, escaping symlinks, non-regular files and reads over `fsMaxReadBytes`.
- **SSRF hardening.** `http.request` allows https only by default, refuses credentials in URLs, blocks loopback, private, CGNAT, link-local, multicast and cloud-metadata addresses (including IPv4-mapped forms), checks every redirect, and bounds redirects, time and response size.
- **CORS** reflects only allow-listed origins.
- **Request bodies** are capped at 1 MiB (`CLERQ_MAX_BODY`).

### Added

- `capabilities.json` options: `fsMaxReadBytes`, `httpAllowedSchemes`, `httpMaxBytes`, `httpTimeoutMs`, `httpAllowPrivateAddresses`.
- `setGatewayToken()` and `hasGatewayToken()` in `@clerq/gateway-client`; the desktop app loads the token before its first request.
- **Control Tower** with Builder and Operator modes.
- **Skill schema editing** — input and output JSON schemas and dependencies; `GET`/`PUT /skills/:slug`.
- **Context preview** — what would be sent to the model, without calling it (`POST /context/preview`).
- **Dry runs** — `dryRun: true` on `/task` shows the trace without calling a model or the calculation engine.
- **Step traces** with durations in `/task` responses.
- **Memory** — list, add and delete through `/memory` and the desktop app.
- **Metrics** — `/metrics` reports model calls, latency, tokens and failure rate.
- **Capabilities, reasoning and system prompt settings** — `GET`/`POST /capabilities`, `/reasoning`, `/system-prompt`.
- A standalone Settings window, keyboard shortcuts, and a retry button when models fail to load.
- macOS signing and notarization support, and the Tauri updater (see `docs/DISTRIBUTION.md`).
- CI: type checks, tests, Rust checks, dependency audits and a secret scan; macOS and Windows installer builds; tag-triggered releases.

### Changed

- One version across every package, the Tauri config and the version `/health` reports (`node scripts/sync-version.js [version]`).
- The documented `curl` examples send the bearer token.
- Settings moved from a modal to its own window.

### Fixed

- Dependency vulnerabilities (14 high, 1 critical). Unused `ws` and `zod` were removed, and `path-to-regexp` is pinned to a patched version.
- `SKILL.md` frontmatter in single quotes (`slug: 'my-skill'`) is parsed; the quotes used to become part of the value.

### Removed

- The `fsAllowWrite` capability flag, which no tool ever read.

### Documentation

- `ROADMAP.md`, `SECURITY.md` (threat model, rules, known gaps, release checklist), and corrections to `ARCHITECTURE.md` and `TOOLS.md`. `SAFETY_CHECKLIST.md` and `ERROR_RESPONSE_SHAPE.md` were folded into them.

## [0.1.0] - Initial release

- Open-source desktop agent (Tauri v2 + React)
- Local gateway and calculation engine (sidecars)
- Skills, explain, task APIs
- Config and API key management via ~/.clerq
