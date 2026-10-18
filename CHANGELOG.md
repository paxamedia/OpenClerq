# Changelog

All notable changes to OpenClerq will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Automations.** A YAML spec (a subset of the format in `docs/ROADMAP.md` §4) runs a coding agent against a local repository, on a schedule or on demand: in a fresh git worktree started from origin's copy of the base branch, then the spec's gates, then a push and a draft pull request. New automations are saved disabled. Pushing waits in the approvals inbox unless the spec sets `approvals.push: auto`, and an automation's first push always waits. Endpoints under `/automations`, plus `GET /drivers` and `GET /runs/:id/artifacts/:id`.
- **`claude-code` driver** (`packages/drivers`). It runs Claude Code's CLI under the user's own sign-in, with no API key unless the spec names a vault secret.
- Budgets per run (passed to the CLI) and per month (pausing the automation), one run per automation at a time, and a global cap, `CLERQ_MAX_CONCURRENT_RUNS`.
- A run records the worktree, the agent's tool calls, each gate, the commit, the push and the PR as steps, and keeps the diff and the agent's output. A run interrupted by a restart is marked failed and its worktree removed.
- Desktop **Automations** module: a spec editor that checks a spec against this machine before saving, runs with their steps and diff, and the approvals inbox.
- `packages/web`, the start of the rebuilt desktop interface: design tokens for light and dark, bundled DM Sans and JetBrains Mono, an icon wrapper, and tests that fail on corners over 1px, inline styles, colours or fonts outside the tokens, and text contrast below WCAG AA.

### Changed

- `packages/sandbox` gives a command a minimal environment unless `inheritEnv` is set, streams output line by line, and stops on an abort signal.
- In this release automations run without isolation, and a spec must say `sandbox: { profile: native }` to run.

### Fixed

- Cron triggers with a weekday or day-of-month field, such as `0 8 * * 1`, could fail to fire: node-cron 4.2.1 miscalculated when they were next due. Upgraded to 4.6.0.
- A module list saved in the desktop settings hid modules bundled with later releases.

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
