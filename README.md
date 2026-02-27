# OpenClerq — Local Administrative Agent & Model Context Server

**This is the open-source (OSS) distribution** of Clerq — a persistent local administrative agent and local model context server (MCS) for administrative and clerical work. Install, run, and extend it on your machine. The goal is to provide a **standard, for safe local MCS** for agentic automation: tools and context stay on your device; AI is an advisor, not a backend.

---

# Clerq — Local Administrative Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> *Open-source local MCS for agentic automation. Small desktop worker that runs on your machine, with knowledge, tools, and context kept locally.*

**Clerq** is a small, generic desktop automation platform: programmable by developers on their local machine (as is, use at your own risk, no responsibility), and also offered as a hosted service with accounts, subscriptions, and modules that bundle built-in skills.

📌 **Canonical description:** [About Clerq](docs/ABOUT_CLERQ.md) — attribution, two usage models (OSS vs hosted), and skills-by-module. See also [NOTICE](NOTICE).

## Two Ways to Use Clerq

| | **Open-source (developers)** | **Hosted (our clients)** |
|---|------------------------------|---------------------------|
| **Runs on** | Your local machine | Our servers |
| **API keys** | Your own | Ours |
| **Responsibility** | None from us — use at your own risk | Per our service terms |
| **Modules** | Build and load any module you want | Subscribe to modules with built-in skills |

**Skills are available by module. You can build and load your own modules (for different roles and countries) on top of the core engine. See [About Clerq](docs/ABOUT_CLERQ.md).

## Why Clerq?

- **Local-first calculations** — All numeric work runs locally on your machine (Rust-based calculation engine). AI provides guidance and explanations only.
- **Extensible skills** — You decide which domains and workflows to implement as skills or modules.
- **Open-source** — Use the code as is, program it, build your own modules. No warranty; use at your own risk.
- **Hosted option** — If you work with us commercially, we can build and host custom modules for your use case on our infrastructure. These are not part of the OSS distribution.

## Installing

You can run **OpenClerq** from source on **macOS** or **Windows**. For prebuilt installers of the commercial **Clerq** product (scalable MCS for teams and administrations), see [openclerq.com](https://openclerq.com).

### Download installers (download and run)

Prebuilt **macOS** (.dmg) and **Windows** (.msi or .exe) installers give users a **download-and-run** experience: install, launch the app, and the **gateway and calculation engine start automatically** — no separate terminal or Node setup needed.

The bundle description and the in-app **About** screen state clearly:

- **Use at your own risk. No warranty.**
- **What the app is allowed to do:** read/write config and optional API key under `~/.clerq`, read paths you choose for modules, open links in your browser; if you configure a cloud LLM, the gateway sends requests to that provider. Calculations run locally.

Full text: [Installer disclaimer](docs/INSTALLER_DISCLAIMER.md).

To **build installers** from this repo: `pnpm build:installers` (requires [Bun](https://bun.sh) — `pnpm add -D bun -w`; if Bun fails, run `cd node_modules/bun && node install.js`). Outputs: macOS → `apps/desktop/src-tauri/target/release/bundle/dmg/`; Windows → `apps/desktop/src-tauri/target/release/bundle/msi/` or `nsis/`.

**Releases:** Tagging `v*` (e.g. `v0.1.0`) triggers a [GitHub Actions release workflow](.github/workflows/release.yml) that builds macOS and Windows installers and publishes them to [GitHub Releases](https://github.com/paxamedia/OpenClerq/releases). For signed macOS builds and in-app updates, see [Distribution](docs/DISTRIBUTION.md).

### macOS

**Prerequisites**

- Node.js ≥ 22 ([nodejs.org](https://nodejs.org) or Homebrew: `brew install node`)
- pnpm: `npm install -g pnpm`
- Rust: [rustup.rs](https://rustup.rs)
- Xcode Command Line Tools (or full Xcode): `xcode-select --install`
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for macOS

**Install and build (first time)**

```bash
git clone https://github.com/paxamedia/OpenClerq.git
cd OpenClerq
pnpm install
cp .env.example .env
# Edit .env: set CLERQ_DEV=1 and your LLM (ANTHROPIC_API_KEY or CLERQ_LLM_PROVIDER=ollama)
pnpm build:gateway
pnpm build:core
```

**Run (choose one)**

- **Two terminals:**  
  Terminal 1: `CLERQ_DEV=1 pnpm gateway`  
  Terminal 2: `pnpm desktop`

- **Easy run (after building the app once):**  
  Build the desktop app: `cd apps/desktop && pnpm exec tauri build && cd ../..`  
  Then double‑click `scripts/Start-Clerq-Mac.command`.  
  First time: **Right‑click → Open** to allow the unsigned script.

### Windows

**Prerequisites**

- Node.js ≥ 22 ([nodejs.org](https://nodejs.org))
- pnpm: `npm install -g pnpm`
- Rust: [rustup.rs](https://rustup.rs)
- Visual Studio Build Tools with the “Desktop development with C++” workload
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for Windows

**Install and build (first time)**

```powershell
git clone https://github.com/paxamedia/OpenClerq.git
cd OpenClerq
pnpm install
copy .env.example .env
REM Edit .env: set CLERQ_DEV=1 and your LLM (ANTHROPIC_API_KEY or CLERQ_LLM_PROVIDER=ollama)
pnpm build:gateway
pnpm build:core
```

**Run (choose one)**

- **Two terminals:**  
  Terminal 1: `set CLERQ_DEV=1 && pnpm gateway`  
  Terminal 2: `pnpm desktop`

- **Easy run (after building the app once):**  
  Build the desktop app: `cd apps\desktop && pnpm exec tauri build && cd ..\..`  
  Then double‑click `scripts\Start-Clerq-Win.bat`.

---

## Vision

**Replace repetitive clerical work by 2030** — AI handles routine, rule-based office work; humans stay in control of decisions and filings.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│           Tauri Desktop (Windows + Mac)                 │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Control Tower — Builder | Operator mode        │   │
│  │  Gateway | Skills | Tools | Memory | Ask (explain/task) │
│  └──────────────────────┬──────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │  Gateway — Agent loop, Skills, Capabilities      │   │
│  └──────────────────────┬──────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │  Skills (SKILL.md) — schemas, dependencies      │   │
│  └──────────────────────┬──────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │  Rust Calculation Engine — Deterministic math    │   │
│  └──────────────────────┬──────────────────────────┘   │
│                          │                                │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │  File-backed memory (~/.clerq/memory.json)      │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

*Desktop UI (Control Tower):* Gateway health, skills (with schema/dependency editing), tools, calculator, file-backed memory, Ask (explain/task) with context preview and dry-run, observability metrics. Builder mode for configuration; Operator mode for day-to-day use.

## Quick Start

After [Installing](#installing) (macOS or Windows), from the repo root:

1. **Copy env:** `cp .env.example .env` (macOS/Linux) or `copy .env.example .env` (Windows). Set `CLERQ_DEV=1` and your LLM: **API (cloud)** via `ANTHROPIC_API_KEY`, or **local** via `CLERQ_LLM_PROVIDER=ollama`.
2. **Build:** `pnpm build:gateway` and (for rate calc) `pnpm build:core`.
3. **Start gateway:** `CLERQ_DEV=1 pnpm gateway` (leave running).
4. **Start desktop:** `pnpm desktop` in a second terminal.

The desktop **Control Tower** lets you check gateway health, load and edit skills (schemas, dependencies), run tools, manage file-backed memory, and **Ask** (explain or task). Task mode supports dry-run (no LLM call) and context preview. Builder/Operator modes toggle between full configuration and streamlined use. Full steps: **[Developer setup](docs/DEVELOPER_SETUP.md)**.

**Settings:** In the app you can save your API key to `~/.clerq/.env` (optional); the gateway loads it when it starts.

For one-click run after building the app, see [Installing](#installing) (macOS: `scripts/Start-Clerq-Mac.command`; Windows: `scripts/Start-Clerq-Win.bat`).

### API (gateway on :18790)

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health; includes `llm.mode` (`api` or `local`) and `llm.provider` |
| GET | /skills | List skills (from disk or fallback) |
| GET | /skills/:slug | Get skill detail (meta, body). PUT to update schemas/dependencies. |
| GET | /metrics | Observability: uptime, LLM calls, latency, token usage |
| POST | /context/preview | Preview what would be sent to the LLM (no API call). Body: `question`, optional `context`, `skillSlug` |
| GET | /memory | List file-backed memory entries. POST to add; DELETE /memory/:key to remove |
| GET | /capabilities | Filesystem/network restrictions. POST to save. |
| GET/POST | /reasoning | Temperature, max tokens. POST to save. |
| GET/POST | /system-prompt | System prompt editor. POST to save. |
| POST | /calculate/eval | Arithmetic engine (body: expression or spec+inputs). Deterministic, auditable. |
| POST | /explain | AI explanation (body: question, optional context). Uses configured LLM. |
| POST | /task | Parse intent, run calculation if applicable, then AI explain. Body: `message`, optional `dryRun: true`. |

## Project Structure

```
clerq/
├── apps/
│   └── desktop/          # Tauri v2 + React (Windows, Mac)
├── packages/
│   ├── gateway/          # OpenClerq agent runtime
│   └── calculation-core/ # Rust — advanced arithmetic engine (deterministic, auditable)
├── docs/                # ABOUT_CLERQ, PRD, ARCHITECTURE, MODULE_SYSTEM, etc.
└── package.json
```

## Pricing (SaaS)

| Tier | Price | Entities | Users |
|------|-------|----------|-------|
| Starter | $49/mo | 1 | 1 |
| Professional | $79/mo | 3 | 2 |
| Business | $199/mo | 10+ | 5 |
| Enterprise | Custom | Unlimited | Unlimited |


## Documentation

| Doc | Purpose |
|-----|---------|
| [**ABOUT_CLERQ**](docs/ABOUT_CLERQ.md) | What OpenClerq is; attribution; OSS vs hosted scope |
| [**DEVELOPER_SETUP**](docs/DEVELOPER_SETUP.md) | Install, run, and verify OpenClerq locally (macOS + Windows) |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components and local data flow |
| [ARITHMETIC_API](docs/ARITHMETIC_API.md) | Calculation engine: operators, functions, examples |
| [MODULE_SYSTEM](docs/MODULE_SYSTEM.md) | How skills and modules are structured (schemas, dependencies) |
| [TOOLS](docs/TOOLS.md) | Built‑in tools (filesystem, HTTP) and how to extend them |
| [SAFETY_CHECKLIST](docs/SAFETY_CHECKLIST.md) | Quick safety checks before shipping changes |
| [INSTALLER_DISCLAIMER](docs/INSTALLER_DISCLAIMER.md) | Permissions and disclaimer for installers and distribution |

## License

- **Core (gateway, desktop, calculation-core, skills):** MIT

## Acknowledgments

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) (gateway, skills, local-first). Core is MIT-licensed. Use at your own risk. See [NOTICE](NOTICE) and [About Clerq](docs/ABOUT_CLERQ.md).
