# OpenClerq Architecture (OSS Core)

This document describes the **open‑source OpenClerq core** — the parts that run on a user’s machine (desktop app, gateway, skills, tools, and calculation engine). Hosted backends, billing, and commercial modules are **out of scope** and live in separate/private projects.

---

## 1. Components

| Component        | Tech                 | Role                                                   |
|-----------------|----------------------|--------------------------------------------------------|
| Desktop app     | Tauri v2 + React     | Native UI on Windows and macOS                         |
| Gateway         | Node.js + Express    | HTTP API, agent loop, skill/tool orchestration         |
| Skills / modules| `SKILL.md` files     | Describe behaviours, tools, and configuration          |
| Calculation core| Rust (`clerq-calc`)  | Deterministic numeric engine (example operations)      |
| Local config    | Files in `~/.clerq`  | Settings and API keys (never shipped in binaries)      |

High‑level flow:

```text
Desktop (Tauri + React)
   → Gateway (HTTP on 127.0.0.1:18790)
   → Skills / Modules (SKILL.md)
   → Tools (filesystem, HTTP, calculation engine, etc.)
   → Calculation core (Rust) for deterministic numeric work
   → Back to gateway → desktop UI (results + explanations)
```

---

## 2. Local‑First, World‑Standard MCS

OpenClerq is intended to be a **world‑standard reference implementation** of a safe local MCS:

- **Local‑first:** Everything runs on the user’s machine by default.
- **Explicit tools:** Every side effect (filesystem, HTTP, numeric engine) goes through a registered tool.
- **Deterministic numeric work:** Simple engines (percentage operations, gross/net, depreciation‑style logic) live in Rust and are run via a small CLI (`clerq-calc`).
- **Agent as advisor:** LLMs provide structure, guidance, and orchestration — never hidden remote calculations.

**LLM modes:** The gateway supports two modes for the language model:
- **API (cloud):** Calls Anthropic API (Claude). Requires `ANTHROPIC_API_KEY`.
- **Local:** Runs on your machine (Ollama, LM Studio, or any OpenAI-compatible endpoint). No API key needed for Ollama.

`GET /health` returns `llm.mode` (`api` or `local`) and `llm.provider` so clients can show which mode is active.

---

## 3. Gateway Responsibilities

The gateway is the **control plane**:

- Exposes HTTP endpoints: `/health`, `/skills`, `/skills/:slug` (GET/PUT), `/task`, `/explain`, `/calculate/*`, `/tools`, `/tools/run`, `/context/preview`, `/memory`, `/capabilities`, `/reasoning`, `/system-prompt`, `/metrics`.
- Loads skills from disk and normalises metadata (including `inputSchema`, `outputSchema`, `dependsOn`).
- Routes `/task` with optional dry-run (parse intent, no LLM call).
- File-backed memory at `~/.clerq/memory.json` for inspect-and-prune.
- Observability: LLM call counts, latency, token usage, failure rates.
- Hosts generic tools with capability restrictions (see `docs/TOOLS.md`).

In OSS mode (`CLERQ_DEV=1`) no license checks are enforced; the gateway is just a local service.

---

## 4. Desktop Responsibilities

The desktop app is a **Control Tower** for configuring and running the agent:

- **Builder vs Operator mode** — Builder: full configuration, schema editing, capability tuning. Operator: streamlined view for day-to-day use.
- Configures gateway URL, skills directory, run settings, API key (stored in `~/.clerq/.env`).
- **Agent core:** Gateway health, system prompt editor, reasoning controls (temperature, max tokens).
- **Skills:** List, load, edit input/output schemas and dependencies (PUT `/skills/:slug`).
- **Tools:** Inspect and run tools (Ctrl+Enter shortcut). Capabilities restrict fs/network.
- **Memory:** File-backed memory — list, add, delete entries.
- **Ask:** Explain or Task mode; context preview (no API call); dry-run for task.
- **Observability:** Metrics (LLM calls, latency, tokens). Real-time logs, step traces.
- **Help:** Keyboard shortcuts (Enter send, Ctrl+Enter run tool).

Stores only local configuration (no remote state). Talks to the gateway over `http://127.0.0.1:18790` by default.
---

## 5. Extensibility

To extend OpenClerq you typically:

1. Add one or more **skills/modules** (see `docs/MODULE_SYSTEM.md`).
2. Optionally add new **tools** or calculation operations (see `docs/TOOLS.md`).
3. Wire these into your own workflows (desktop or external clients).

The OSS core deliberately stays small; domain‑ and country‑specific logic should live in separate modules or private repositories.

