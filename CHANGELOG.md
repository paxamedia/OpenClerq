# Changelog

All notable changes to OpenClerq will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.5 Execution

### Added

- **`packages/store`** — SQLite-backed durable store with WAL, a migration runner, and the full roadmap §4.4 schema: sessions, messages, repos, automations, automation_targets, runs, run_steps, artifacts, approvals, memory, triggers and an append-only audit log. Runs are constrained to the documented state machine at the database level.
- **Runtime-adaptive SQLite driver.** The gateway runs under Node (development) and Bun (the compiled desktop sidecar), so the driver selects `node:sqlite` or `bun:sqlite` at runtime through a computed import specifier. No native addon is involved — `better-sqlite3` cannot be embedded by `bun build --compile` and would break the desktop installer build.
- **Legacy JSON importer.** `memory.json` and `triggers.json` are imported into SQLite on start, idempotently, and archived as `*.migrated` rather than deleted. A corrupt file is skipped and left in place instead of blocking startup.

- **Run history.** Every task and every trigger firing now writes a durable run record with a step trace, replacing the fire-and-forget path where results were logged and discarded. New endpoints `GET /runs` and `GET /runs/:id`.
- **`GET /memory/search?q=`** — substring search across memory keys and values.

### Changed

- **Memory is store-backed.** `~/.clerq/memory.json` was read-modify-write with no locking, so concurrent writers silently clobbered each other. Writes are now a single upsert.
- **Node 24 is now the development requirement** (was 22). `node:sqlite` needs `--experimental-sqlite` on Node 22. End users are unaffected: the desktop app ships the Bun-compiled sidecar and needs no Node at all.
- `build:gateway` builds the gateway's workspace dependencies first, so a pristine checkout can resolve `@clerq/store` types.
- CI builds all packages topologically and runs every package's tests, not just the gateway's.

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

### Changed

- Version unified at 0.4.0 across root, gateway, client, schema, desktop, `tauri.conf.json`, `Cargo.toml` and the `/health` and `/metrics` payloads; `sync-version.js` now covers all of them
- `scripts/verify-local.sh` and the documented `curl` examples send the bearer token

### Fixed

- **Dependency vulnerabilities: 14 high + 1 critical → 0.** Removed `ws` and `zod` from the gateway (both declared since 0.1, imported nowhere) plus `@types/ws`; pinned `path-to-regexp >= 8.4.0` via a pnpm override, since `express@5 > router@2` still resolves the vulnerable 8.3.0; upgraded `vitest` 2 → 5, `vite` 6 → 8 and `@vitejs/plugin-react` 4 → 6, clearing the remaining dev-tree advisories.
- **Vitest collected stale compiled tests.** With no config, vitest's default include matched `dist/**` as well as `src/**`, so a prior `pnpm build:gateway` left duplicate compiled tests that ran against outdated fixtures. Added `vitest.config.ts` scoping collection to `src/`.
- **Single-quoted YAML frontmatter in `SKILL.md` is now parsed.** The parser stripped double quotes only, so `slug: 'my-skill'` kept its quotes and silently failed every lookup — valid YAML that produced a skill the router could never select.

### Removed

- `fsAllowWrite` capability flag — declared and stored since 0.1, read by no tool, implying a write capability that never existed

## [Unreleased]

### Documentation

- **ROADMAP.md** — consolidated roadmap merging two independent architecture reviews: 18-finding audit, target architecture, release trains 0.4 → 1.0, automations-as-code spec, provider/driver model
- **ROADMAP.md §8 — Chat console.** Raw and managed pipeline modes, multi-model comparison, conversational automation authoring (draft → preview → dry run → save disabled), shipped as a removable first-party module over the existing module slot contract
- **SECURITY.md** — threat model, nine binding rules, honest inventory of unprotected surfaces, release checklist (supersedes `SAFETY_CHECKLIST.md`)
- **ARCHITECTURE.md** — corrected: the `/task` path is a prompt router, not an agent loop; error response shape absorbed from `ERROR_RESPONSE_SHAPE.md`; endpoint table and local-state table added
- **TOOLS.md** — documented the actual limits of `fs.read` path containment and `http.request` allowlisting, replacing an overstated safety claim
- Removed `SAFETY_CHECKLIST.md` and `ERROR_RESPONSE_SHAPE.md` (content absorbed above)

### Added

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

- Settings moved from modal to dedicated window
- About modal styling aligned with champagne theme
- Desktop: skills panel shows schema/dependency editor; Ask adds Preview context, Dry run, Help

## [0.1.0] - Initial release

- Open-source desktop agent (Tauri v2 + React)
- Local gateway and calculation engine (sidecars)
- Skills, explain, task APIs
- Config and API key management via ~/.clerq
