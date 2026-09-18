# Changelog

All notable changes to OpenClerq will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.5 Execution

### Added

- **`packages/store`** — SQLite-backed durable store with WAL, a migration runner, and the full roadmap §4.4 schema: sessions, messages, repos, automations, automation_targets, runs, run_steps, artifacts, approvals, memory, triggers and an append-only audit log. Runs are constrained to the documented state machine at the database level.
- **Runtime-adaptive SQLite driver.** The gateway runs under Node (development) and Bun (the compiled desktop sidecar), so the driver selects `node:sqlite` or `bun:sqlite` at runtime through a computed import specifier. No native addon is involved — `better-sqlite3` cannot be embedded by `bun build --compile` and would break the desktop installer build.
- **Legacy JSON importer.** `memory.json` and `triggers.json` are imported into SQLite on start, idempotently, and archived as `*.migrated` rather than deleted. A corrupt file is skipped and left in place instead of blocking startup.
- **`packages/policy`** — deny-by-default capability rules over tool groups, with four profiles (`minimal`, `research`, `coding`, `trusted`), wildcard and `group:`/`risk:` matching, per-run call and runtime budgets, and a `guard()` that fails closed when a call needs approval and no approver is wired.
- **`packages/sandbox`** — process isolation with three profiles: `native` (development only, warns), `seatbelt` (macOS `sandbox-exec`, writes confined to the run's workspace and a private temp directory), and `container` (Docker/Podman, `--cap-drop ALL --read-only --network none`). Wall-clock kill through the whole process group, output caps, and secret redaction on the way back. Policy says what an agent may ask for; the sandbox decides what a process can physically do — permitting `exec` in an allowlist and then handing the command to `child_process` is not isolation.
- **`packages/workspaces`** — register local repositories, clone remotes into a content-addressed cache, and give each run its own `git worktree`. Publishing branches, commits with a `Generated-by: OpenClerq` trailer, pushes with `--force-with-lease`, and opens a **draft** pull request on GitHub or GitLab. Git is always invoked argv-only with `GIT_TERMINAL_PROMPT=0`, so no input can become a shell fragment or a credential prompt.
- **`packages/providers`** — model registry carrying each vendor's base URL, auth variable, models, context windows and prices, with one adapter for Anthropic and one shared by every `/chat/completions` vendor. Cursor is absent by design: it has no public model API and enters later as an agent CLI driver.
- **Approval system.** Risky calls raise an approval that is a row in the store, so a decision survives a restart and stays auditable. `GET /approvals`, `POST /approvals/:id/approve|deny`. **Waiting fails closed**: an approval nobody answers is refused, never granted.
- **Kill switch.** `POST /kill` denies every pending approval at once.
- **Egress allowlist, enforced at the boundary.** `network` on a sandbox spec takes `'none'` (default), `'all'`, or a host allowlist (`example.com`, `example.com:443`, `*.example.com`). An allowlist starts a loopback proxy that enforces it, and the seatbelt profile then denies every other outbound port, so the process cannot route around it; refused attempts are recorded on the result. A profile that cannot enforce an allowlist now **refuses** it instead of silently granting full network access, which is what `native` and `container` previously did. macOS can filter only by port, so one residual gap remains and is documented in SECURITY.md.
- **Chat console.** Conversations with any configured provider, as a first-party desktop module over the same slot contract third-party modules use — remove it and the gateway, scheduler and automations are unchanged. New endpoints: `GET|POST /sessions`, `GET|DELETE /sessions/:id`, `POST /sessions/:id/send`, `/compare`, `/promote`, `/update`.
  - **Raw mode** adds nothing to the conversation — no system prompt, no skill selection, no memory, no tools — and keeps the exact request body for inspection, so a misbehaving managed answer can be traced to the model or to our prompt assembly.
  - **Managed mode** runs the full `/task` pipeline.
  - **Comparison mode** sends one message to up to eight models in parallel, each column carrying its latency, tokens and cost. A model that fails becomes a column with an error rather than failing the comparison; the first answer stands as the turn until another is promoted, and the alternatives are kept.
  - Every message is a run with `trigger: 'manual'`, so a conversation leaves the same durable, costed trace an automation does.
- **Streaming model calls.** `callStream` in `@clerq/providers` parses both SSE dialects, including frames split across network reads. `stream_options: {include_usage: true}` is requested so a streamed call still reports its tokens, and dropped automatically for servers that reject the field.
- **The vault master key moved to the OS keychain.** Generated on first use and stored through the platform's own tool (macOS `security`, libsecret, Windows DPAPI), so it is no longer read from an environment variable that any process can see. `CLERQ_VAULT_KEY` still works and warns; a host with no keychain falls back to `~/.clerq/vault.key` at mode 0600. `GET /secrets` reports where the key is kept. The vault used to be disabled entirely until the user found the right environment variable.
- **Typed event bus** with correlation ids (run, session, request, tool call), streamed at `GET /events` (SSE). A subscriber that throws is logged and skipped rather than taking down the emitter.
- **Run history.** Every task and every trigger firing now writes a durable run record with a step trace, replacing the fire-and-forget path where results were logged and discarded. New endpoints `GET /runs` and `GET /runs/:id`.
- **`GET /memory/search?q=`** — substring search across memory keys and values.
- **Per-call token and cost accounting.** Every model call inside a run is recorded as an `llm` step with its tokens, latency and cost, and added to the run's totals in one transaction. A model with no registry price records its cost as unknown (`null`, and `costKnown: false` on the run) instead of $0. `GET /metrics` adds `llm_cost_usd_total` and `llm_unpriced_calls_total`; the desktop shows spend.
- **Every registry vendor is usable from the gateway.** `CLERQ_LLM_PROVIDER` accepts any registry id — `openai`, `deepseek`, `moonshot`, `zai`, `minimax`, `lmstudio` as well as `anthropic` and `ollama` — and `model` accepts qualified references such as `deepseek/deepseek-chat`. New `GET /providers` lists providers, readiness and models, without endpoint URLs.
- **Runs record their request** (`input`), so a run that fails before its first step still shows what it was asked to do. Store migration 2.
- Run lifecycle and model calls are published on the event bus (`run.started`, `run.completed`, `run.failed`, `model.called`).

### Changed

- **The gateway calls models through `@clerq/providers`** instead of its own client, removing the `@anthropic-ai/sdk` dependency. Provider failures of every kind — missing key, unreachable endpoint, vendor error — now answer `503 ai_unavailable` rather than some of them `500`.
- The built-in provider registry is compiled in rather than read from a `providers.yaml` beside the build. The desktop sidecar is a single binary with nowhere to read it from, and the copy step would have failed on Windows. Override it with `~/.clerq/providers.yaml` or `CLERQ_PROVIDERS_FILE`.
- `CLERQ_OLLAMA_URL` accepts the server root or its `/v1` root; one form previously broke model calls and the other broke model listing.
- A response that reports no usage is now priced as unknown rather than $0, and `CallResult` carries `usageReported` to say which it is.
- Anthropic's default model is now `claude-haiku-4-5`, set in the registry (was `claude-3-5-haiku-20241022`, hardcoded).
- **Memory is store-backed.** `~/.clerq/memory.json` was read-modify-write with no locking, so concurrent writers silently clobbered each other. Writes are now a single upsert.
- **Node 24 is now the development requirement** (was 22). `node:sqlite` needs `--experimental-sqlite` on Node 22. End users are unaffected: the desktop app ships the Bun-compiled sidecar and needs no Node at all.
- `build:gateway` builds the gateway's workspace dependencies first, so a pristine checkout can resolve `@clerq/store` types.
- CI builds all packages topologically and runs every package's tests, not just the gateway's.
- The desktop app has unit tests (`vitest`), so `pnpm -r test` covers it too.

### Fixed

- **Triggers no longer vanish after the first restart.** The store imported `~/.clerq/triggers.json` and archived it as `triggers.json.migrated`, while `triggers.ts` went on reading that file — so every cron, file-watch and webhook trigger disappeared on the next start. Triggers are now read from and written to the store, which also recovers any already imported.
- **Webhook firings are recorded as runs** (`trigger: 'webhook'`), and the response carries the `runId`. They previously executed with no trace at all.
- **A file-watch firing is recorded as `trigger: 'event'`**, not `'schedule'`.
- `POST /triggers` validates the config and answers `400` with the reason — an unparseable cron schedule was accepted and then silently never fired. Ids must be unique across all three kinds, which share one table.
- **Automatic persistent runs are scheduled by the gateway.** The desktop's Persistent run setting (N runs per hour, day, week or month) was only written to `~/.clerq/config.json`. The one thing that acted on it was a timer in the main window's developer view: it ran only while that view was open, started counting again every time the view loaded, and at one run per month fired continuously, because the interval overflowed `setInterval`'s 32-bit delay. Saving now stores a gateway cron trigger, `desktop-persistent-run`, and leaves every other trigger as it was; switching to Manual removes it. Runs are spread evenly (hourly from minute 0, daily and longer from 09:00), and the form shows the cron schedule before you save. Settings saved as Automatic by an earlier version are not scheduled until they are saved again: Settings says so whenever the gateway's schedule does not match the saved one, which also catches a save the gateway missed and an edit made under Triggers.
- **The Settings window authenticates to the gateway.** It runs in its own webview and never loaded the gateway token, so its Triggers, Secrets vault, System prompt, Reasoning and Capabilities sections, and Run now, were all refused with `401`. The Run now button reports how the run ended and is disabled while one is in progress; it used to fail silently.

### Removed

- `CLERQ_OPENAI_API_KEY`, an undocumented alias for `OPENAI_API_KEY`.

## [0.4.0] — Security foundation

Closes the four S1 blockers from [docs/ROADMAP.md](docs/ROADMAP.md). **Breaking:** the gateway
API now requires authentication.

### Security

- **Gateway authentication.** Every endpoint except `GET /health` requires `Authorization: Bearer <token>`, compared in constant time. The token is generated on first run at `~/.clerq/gateway-token` (mode 0600) or supplied via `CLERQ_GATEWAY_TOKEN`. There is no development bypass — `CLERQ_DEV` no longer affects access.
- **Authentication separated from licensing.** `middleware/license.ts` now attaches entitlement information and never rejects; it had been the only thing standing between the network and the tool registry.
- **Loopback binding.** The listener binds `127.0.0.1` unless `CLERQ_HOST` is set, which also logs a warning. It previously bound all interfaces while logging `127.0.0.1`.
- **Canonical path containment.** `fs.read` resolves against a `realpath`'d root and rejects traversal, prefix-sibling escapes (`/srv/repo-secrets` against `/srv/repo`), absolute/UNC paths, NUL bytes, escaping symlinks, non-regular files, and reads over `fsMaxReadBytes`. Replaces a `startsWith` prefix comparison.
- **SSRF hardening.** `http.request` now enforces a scheme allowlist (https by default), refuses URL credentials, resolves DNS and blocks loopback, private, CGNAT, link-local, multicast, reserved and cloud-metadata addresses (including IPv4-mapped forms), revalidates **every** redirect hop, and bounds redirects, time and response size.
- **CORS lockdown.** Origins are reflected only from an allowlist. The `*` development path is gone.
- **Request body limit.** JSON parsing capped at 1 MiB (`CLERQ_MAX_BODY`).

### Added

- `packages/gateway/src/security/` — `auth.ts`, `paths.ts`, `network.ts`
- `capabilities.json` gains `fsMaxReadBytes`, `httpAllowedSchemes`, `httpMaxBytes`, `httpTimeoutMs`, `httpAllowPrivateAddresses`
- `gateway_token` Tauri command; the desktop loads the token before its first API call
- `setGatewayToken()` / `hasGatewayToken()` in `@clerq/gateway-client`
- `.github/workflows/ci.yml` — typecheck, tests, Rust fmt/clippy/test, `pnpm audit`, `cargo audit`, secret scan. CI previously ran no tests at all.
- `.prettierrc.json` and `.prettierignore` pinning the repo's existing style (single quotes, 100 columns); the codebase had no Prettier config, so `format:check` had never passed
- 49 new tests covering the auth boundary, path containment and network policy (29 → 78)
- **Control Tower UI** — Builder/Operator mode; Control Tower for agent configuration and monitoring
- **Skills schema editing** — Input/output JSON schemas and dependency mapping; GET/PUT `/skills/:slug`
- **Context window preview** — Inspect what would be sent to the LLM before calling (POST `/context/preview`)
- **Dry-run mode** — Task mode: parse intent, show trace, no LLM or calculation (body: `dryRun: true`)
- **Step traces** — `/task` response includes step-by-step trace with durations
- **File-backed memory** — `~/.clerq/memory.json`; list, add, delete via `/memory` and desktop UI
- **Observability** — `/metrics` with LLM calls, latency, token usage, failure rates
- **Capabilities** — Filesystem root, HTTP allowlist; hot-reload of tool registry (GET/POST `/capabilities`)
- **Reasoning controls** — Temperature, max tokens (GET/POST `/reasoning`)
- **System prompt editor** — Editable via Settings and GET/POST `/system-prompt`
- **Help modal** — Keyboard shortcuts (Enter send, Ctrl+Enter run tool)
- **Models retry** — Retry button when model fetch fails
- Standalone Settings window (separate Tauri window)
- Round eyeglasses app icon (clerk aesthetic)
- Redesigned About modal (champagne theme)
- macOS code signing and notarization support (see docs/DISTRIBUTION.md)
- Tauri updater plugin (requires signing keys, see scripts/setup-updater-keys.sh)
- CI: macOS and Windows build verification
- Release workflow: tag v\* triggers GitHub Release with installers
- Version sync script: `node scripts/sync-version.js [version]`

### Changed

- Version unified at 0.4.0 across root, gateway, client, schema, desktop, `tauri.conf.json`, `Cargo.toml` and the `/health` and `/metrics` payloads; `sync-version.js` now covers all of them
- `scripts/verify-local.sh` and the documented `curl` examples send the bearer token
- Settings moved from modal to dedicated window
- About modal styling aligned with champagne theme
- Desktop: skills panel shows schema/dependency editor; Ask adds Preview context, Dry run, Help

### Fixed

- **Dependency vulnerabilities: 14 high + 1 critical → 0.** Removed `ws` and `zod` from the gateway (both declared since 0.1, imported nowhere) plus `@types/ws`; pinned `path-to-regexp >= 8.4.0` via a pnpm override, since `express@5 > router@2` still resolves the vulnerable 8.3.0; upgraded `vitest` 2 → 5, `vite` 6 → 8 and `@vitejs/plugin-react` 4 → 6, clearing the remaining dev-tree advisories.
- **Vitest collected stale compiled tests.** With no config, vitest's default include matched `dist/**` as well as `src/**`, so a prior `pnpm build:gateway` left duplicate compiled tests that ran against outdated fixtures. Added `vitest.config.ts` scoping collection to `src/`.
- **Single-quoted YAML frontmatter in `SKILL.md` is now parsed.** The parser stripped double quotes only, so `slug: 'my-skill'` kept its quotes and silently failed every lookup — valid YAML that produced a skill the router could never select.

### Removed

- `fsAllowWrite` capability flag — declared and stored since 0.1, read by no tool, implying a write capability that never existed

### Documentation

- **ROADMAP.md** — consolidated roadmap merging two independent architecture reviews: 18-finding audit, target architecture, release trains 0.4 → 1.0, automations-as-code spec, provider/driver model
- **ROADMAP.md §8 — Chat console.** Raw and managed pipeline modes, multi-model comparison, conversational automation authoring (draft → preview → dry run → save disabled), shipped as a removable first-party module over the existing module slot contract
- **SECURITY.md** — threat model, nine binding rules, honest inventory of unprotected surfaces, release checklist (supersedes `SAFETY_CHECKLIST.md`)
- **ARCHITECTURE.md** — corrected: the `/task` path is a prompt router, not an agent loop; error response shape absorbed from `ERROR_RESPONSE_SHAPE.md`; endpoint table and local-state table added
- **TOOLS.md** — documented the actual limits of `fs.read` path containment and `http.request` allowlisting, replacing an overstated safety claim
- Removed `SAFETY_CHECKLIST.md` and `ERROR_RESPONSE_SHAPE.md` (content absorbed above)

## [0.1.0] - Initial release

- Open-source desktop agent (Tauri v2 + React)
- Local gateway and calculation engine (sidecars)
- Skills, explain, task APIs
- Config and API key management via ~/.clerq
