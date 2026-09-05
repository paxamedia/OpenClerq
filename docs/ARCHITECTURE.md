# OpenClerq Architecture

This describes the **open-source OpenClerq core as it is built today** — desktop app,
gateway, skills, tools, and calculation engine. Hosted backends, billing, and commercial
modules are out of scope and live in separate projects.

For where this architecture is going, see [ROADMAP.md](ROADMAP.md).

---

## 1. Components

| Component | Tech | Role |
|---|---|---|
| Desktop app | Tauri v2 + React | Native UI on macOS and Windows |
| Gateway | Node.js + Express | HTTP API, request routing, skill and tool orchestration |
| Skills / modules | `SKILL.md` files | Describe behaviours, tools, and configuration |
| Calculation core | Rust (`clerq-calc`) | Deterministic numeric engine |
| Local state | Files in `~/.clerq` | Settings, triggers, memory, encrypted secrets |

```text
Desktop (Tauri + React)
   → Gateway (HTTP, port 18790)
   → Skill selection (SKILL.md frontmatter triggers)
   → Tools (filesystem, HTTP, calculation engine)
   → Calculation core (Rust) for deterministic numeric work
   → Back to gateway → desktop UI
```

---

## 2. Request path

The gateway's `/task` endpoint is a **prompt router, not an agent loop.** Understanding this
is the key to reading the codebase:

```text
POST /task
  → selectSkill()        match message against skill trigger keywords
  → parseCalculationIntent()   detect an arithmetic request
  → runEvalCalc()        (if detected) run the Rust engine
  → getExplanation()     ONE LLM call, with the result as context
  → return text + step trace
```

There is no tool-calling turn, no iteration, and no observation loop. The model cannot invoke
a tool; tools are called only by the gateway directly, or by a client through `POST /tools/run`.

Building the real agent runtime — session resolution, model resolution, policy-filtered tool
sets, bounded turns, observations, durable transcripts — is the principal open work item.
See [ROADMAP.md §1.2](ROADMAP.md#12-runtime-thesis).

---

## 3. Local-first design

- **Local-first.** Everything runs on the user's machine by default.
- **Explicit tools.** Every side effect goes through a registered tool with a declared input and output shape.
- **Deterministic numeric work.** Arithmetic runs in Rust via the `clerq-calc` CLI and returns an audit `proof` object. The model never produces final numbers.
- **Model as advisor.** LLMs provide structure, guidance and explanation.

### LLM modes

| Mode | Providers | Requirement |
|---|---|---|
| **API (cloud)** | Anthropic | `ANTHROPIC_API_KEY` |
| **Local** | Ollama, LM Studio, any OpenAI-compatible endpoint | None for Ollama; `CLERQ_LLM_BASE_URL` for others |

`GET /health` returns `llm.mode` (`api` or `local`) and `llm.provider` so clients can show
which is active.

---

## 4. Gateway

The gateway is the control plane. Endpoints:

| Group | Endpoints |
|---|---|
| Status | `GET /health`, `GET /metrics`, `GET /logs/stream` (SSE) |
| Models | `GET /models` |
| Agent | `POST /task`, `POST /explain`, `POST /context/preview` |
| Skills | `GET /skills`, `GET /skills/:slug`, `PUT /skills/:slug` |
| Tools | `GET /tools`, `POST /tools/run` |
| Calculation | `POST /calculate/eval`, `POST /filing/prep` |
| Memory | `GET /memory`, `GET /memory/:key`, `POST /memory`, `DELETE /memory/:key` |
| Config | `GET|POST /capabilities`, `GET|POST /reasoning`, `GET|POST /system-prompt` |
| Secrets | `GET /secrets`, `POST /secrets`, `DELETE /secrets/:name` |
| Automation | `GET|POST /triggers`, `POST /webhook/:id` |
| Modules | mounted at `/api/modules/:moduleId/*` |

Responsibilities: loading skills from disk and normalising metadata (`inputSchema`,
`outputSchema`, `dependsOn`); hosting tools under capability restrictions; file-backed memory;
cron, file-watch and webhook triggers; LLM observability (call counts, latency, token usage,
failure rates); and dynamic module loading.

### Authentication

Every endpoint except `GET /health` requires a bearer token:

```
Authorization: Bearer $(cat ~/.clerq/gateway-token)
```

The gateway generates that file (mode 0600) on first run, or uses `CLERQ_GATEWAY_TOKEN` when
set. There is no development bypass — `CLERQ_DEV` affects conveniences, never access.
`GET /logs/stream` additionally accepts `?token=` because `EventSource` cannot set headers.

Licensing is a separate concern: `middleware/license.ts` attaches entitlement information and
never rejects in the OSS build. Conflating the two was the pre-0.4 design and is what left the
gateway open.

The listener binds `127.0.0.1` unless `CLERQ_HOST` says otherwise. See [SECURITY.md](SECURITY.md).

### Error response shape

All errors use one shape, and carry no PII:

```json
{
  "error": "<code>",
  "message": "<human-readable message>",
  "requestId": "<optional>"
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid bearer token |
| `question is required` | 400 | `/explain` called without a question |
| `message is required` | 400 | `/task` called without a message |
| `expression or spec.formulas required` | 400 | `/calculate/eval` needs one or the other |
| `name is required`, `key required`, `slug required`, `tool_name_required` | 400 | Missing required identifier |
| `invalid config` | 400 | Malformed capabilities or reasoning payload |
| `skill_not_found`, `memory_not_found`, `webhook not found` | 404 | No such resource |
| `ai_unavailable` | 503 | No LLM configured — set an API key, or a local provider |
| `calculation_engine_unavailable` | 503 | Rust engine not built |
| `calculation_failed`, `explain_failed`, `task_failed`, `context_preview_failed` | 500 | Handler error |
| `skills_load_failed`, `skill_load_failed`, `skill_save_failed` | 500 | Skill read or write error |
| `memory_list_failed`, `memory_get_failed`, `memory_set_failed`, `memory_delete_failed` | 500 | Memory store error |
| `tools_list_failed`, `tool_run_failed`, `models_list_failed` | 500 | Tool or model registry error |

---

## 5. Desktop app

A control tower for configuring and running the agent, in Builder or Operator mode.

- **Agent core** — gateway health, system prompt editor, reasoning controls (temperature, max tokens)
- **Skills** — list, edit input/output schemas and dependencies
- **Tools** — inspect and run tools; capabilities restrict filesystem and network reach
- **Memory** — list, add, delete entries
- **Ask** — Explain or Task mode, with context preview (no API call) and dry run
- **Triggers** — cron, file watchers, webhooks
- **Secrets** — vault entries by name
- **Observability** — metrics, live log stream, step traces

The desktop stores only local configuration and talks to `http://127.0.0.1:18790` by default.
It launches the gateway and calculation engine as Tauri sidecars; the Tauri capability
manifest permits executing exactly those two binaries and nothing else.

---

## 6. Local state

| Path | Contents |
|---|---|
| `~/.clerq/gateway-token` | Bearer token for the local API (mode 0600) |
| `~/.clerq/config.json` | Gateway URL, module paths, UI settings |
| `~/.clerq/.env` | Provider API key, if configured |
| `~/.clerq/memory.json` | Key-value agent memory |
| `~/.clerq/triggers.json` | Cron, file-watch and webhook definitions |
| `~/.clerq/capabilities.json` | Filesystem root and HTTP allowlist |
| `~/.clerq/secrets.vault` | AES-256-GCM encrypted secrets |
| `~/.clerq/secrets.audit.log` | Append-only vault access log |

The JSON files are read-modify-write with no locking, so concurrent writers can clobber each
other. Migration to SQLite is release 0.5 work.

---

## 7. Extending

1. Add skills or modules — see [MODULE_SYSTEM.md](MODULE_SYSTEM.md)
2. Add tools or calculation operations — see [TOOLS.md](TOOLS.md) and [ARITHMETIC_API.md](ARITHMETIC_API.md)
3. Wire them into your own workflows from the desktop or an external client

The core stays deliberately small. Domain- and country-specific logic belongs in separate
modules or private repositories.
