# Changelog

All notable changes to OpenClerq will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Release workflow: tag v* triggers GitHub Release with installers
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
