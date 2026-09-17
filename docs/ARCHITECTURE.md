# OpenClerq Architecture

This describes the **open-source OpenClerq core as it is built today** — desktop app,
gateway, skills, tools, and calculation engine. Hosted backends, billing, and commercial
modules are out of scope and live in separate projects.

For where this architecture is going, see [ROADMAP.md](ROADMAP.md).

---

## 1. Components

| Component        | Tech                | Role                                                    |
| ---------------- | ------------------- | ------------------------------------------------------- |
| Desktop app      | Tauri v2 + React    | Native UI on macOS and Windows                          |
| Gateway          | Node.js + Express   | HTTP API, request routing, skill and tool orchestration |
| Skills / modules | `SKILL.md` files    | Describe behaviours, tools, and configuration           |
| Calculation core | Rust (`clerq-calc`) | Deterministic numeric engine                            |
| Local state      | Files in `~/.clerq` | Settings, triggers, memory, encrypted secrets           |

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

### Model providers

Models are reached through the registry in `packages/providers`: one adapter for Anthropic, and
one for every vendor that speaks `/chat/completions`.

| Provider id | Vendor                                                                | Key                                         |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `anthropic` | Anthropic (Claude)                                                    | `ANTHROPIC_API_KEY`                         |
| `openai`    | OpenAI, or any OpenAI-compatible server named by `CLERQ_LLM_BASE_URL` | `OPENAI_API_KEY` (optional with a base URL) |
| `deepseek`  | DeepSeek                                                              | `DEEPSEEK_API_KEY`                          |
| `moonshot`  | Moonshot (Kimi)                                                       | `MOONSHOT_API_KEY`                          |
| `zai`       | Z.ai (GLM)                                                            | `ZAI_API_KEY`                               |
| `minimax`   | MiniMax                                                               | `MINIMAX_API_KEY`                           |
| `ollama`    | Ollama, on this machine or at `CLERQ_OLLAMA_URL`                      | none                                        |
| `lmstudio`  | LM Studio                                                             | none                                        |

Choose one with `CLERQ_LLM_PROVIDER`, or name a qualified model such as
`CLERQ_MODEL=deepseek/deepseek-chat`. The `model` field on `/task` and `/explain` takes either a
bare model id for the configured provider or a qualified reference to any other. Cursor has no
public model API and is not a provider; it arrives in 0.6 as an agent CLI driver.

Base URLs, model ids and prices are data. To change them, copy the built-in registry to
`~/.clerq/providers.yaml` (or point `CLERQ_PROVIDERS_FILE` at a copy). The gateway reloads that
file when it changes. `CLERQ_LLM_BASE_URL` moves only the `openai` provider and
`CLERQ_OLLAMA_URL` only `ollama`, so a leftover value can never redirect another vendor's key.

`GET /health` reports `llm.provider`, `llm.model`, and `llm.mode`: `local` when the model runs on
this machine, `api` when calls leave it. `GET /providers` lists every provider with its readiness
and qualified model references, but never its endpoint URL, which may carry credentials.

### Cost accounting

Every model call made inside a run is recorded as an `llm` step with its provider, model,
prompt, output, latency, tokens and cost, and is added to the run's totals in the same
transaction. Cost comes from registry prices, and **unknown is not reported as free**: a model
with no price records `costUsd: null` and marks the run `costKnown: false`, so its `costUsd` reads
as a lower bound. Keyless local providers cost nothing. `GET /metrics` reports
`llm_cost_usd_total` alongside `llm_unpriced_calls_total`.

---

## 4. Gateway

The gateway is the control plane. Endpoints:

| Group       | Endpoints                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Status      | `GET /health`, `GET /metrics`, `GET /logs/stream` (SSE)                                           |
| Models      | `GET /models`, `GET /providers`                                                                   |
| Agent       | `POST /task`, `POST /explain`, `POST /context/preview`                                            |
| Skills      | `GET /skills`, `GET /skills/:slug`, `PUT /skills/:slug`                                           |
| Tools       | `GET /tools`, `POST /tools/run`                                                                   |
| Calculation | `POST /calculate/eval`, `POST /filing/prep`                                                       |
| Memory      | `GET /memory`, `GET /memory/search?q=`, `GET /memory/:key`, `POST /memory`, `DELETE /memory/:key` |
| Runs        | `GET /runs`, `GET /runs/:id`                                                                      |
| Approvals   | `GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/deny`                       |
| Events      | `GET /events` (SSE)                                                                               |
| Kill switch | `POST /kill`                                                                                      |
| Config      | `GET \| POST /capabilities`, `GET \| POST /reasoning`, `GET \| POST /system-prompt`               |
| Secrets     | `GET /secrets`, `POST /secrets`, `DELETE /secrets/:name`                                          |
| Automation  | `GET \| POST /triggers`, `POST /webhook/:id`                                                      |
| Modules     | mounted at `/api/modules/:moduleId/*`                                                             |

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

| Code                                                                                   | HTTP | Meaning                                                               |
| -------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------- |
| `unauthorized`                                                                         | 401  | Missing or invalid bearer token                                       |
| `question is required`                                                                 | 400  | `/explain` called without a question                                  |
| `message is required`                                                                  | 400  | `/task` called without a message                                      |
| `expression or spec.formulas required`                                                 | 400  | `/calculate/eval` needs one or the other                              |
| `name is required`, `key required`, `slug required`, `tool_name_required`              | 400  | Missing required identifier                                           |
| `invalid config`                                                                       | 400  | Malformed capabilities or reasoning payload                           |
| `skill_not_found`, `memory_not_found`, `webhook not found`                             | 404  | No such resource                                                      |
| `ai_unavailable`                                                                       | 503  | Model provider unusable: no key, unreachable, or it returned an error |
| `calculation_engine_unavailable`                                                       | 503  | Rust engine not built                                                 |
| `calculation_failed`, `explain_failed`, `task_failed`, `context_preview_failed`        | 500  | Handler error                                                         |
| `skills_load_failed`, `skill_load_failed`, `skill_save_failed`                         | 500  | Skill read or write error                                             |
| `memory_list_failed`, `memory_get_failed`, `memory_set_failed`, `memory_delete_failed` | 500  | Memory store error                                                    |
| `tools_list_failed`, `tool_run_failed`, `models_list_failed`, `providers_list_failed`  | 500  | Tool or model registry error                                          |

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

| Path                         | Contents                                                |
| ---------------------------- | ------------------------------------------------------- |
| `~/.clerq/gateway-token`     | Bearer token for the local API (mode 0600)              |
| `~/.clerq/clerq.db`          | SQLite: runs and steps, approvals, memory, audit log    |
| `~/.clerq/providers.yaml`    | Optional replacement for the built-in provider registry |
| `~/.clerq/config.json`       | Gateway URL, module paths, UI settings                  |
| `~/.clerq/.env`              | Provider API key, if configured                         |
| `~/.clerq/triggers.json`     | Cron, file-watch and webhook definitions                |
| `~/.clerq/capabilities.json` | Filesystem root and HTTP allowlist                      |
| `~/.clerq/secrets.vault`     | AES-256-GCM encrypted secrets                           |
| `~/.clerq/secrets.audit.log` | Append-only vault access log                            |

A pre-0.5 `memory.json` is imported into `clerq.db` on first start and kept as
`memory.json.migrated`. The remaining JSON files are read-modify-write with no locking, so
concurrent writers can clobber each other; they move into the store as the rest of 0.5 lands.

---

## 7. Extending

1. Add skills or modules — see [MODULE_SYSTEM.md](MODULE_SYSTEM.md)
2. Add tools or calculation operations — see [TOOLS.md](TOOLS.md) and [ARITHMETIC_API.md](ARITHMETIC_API.md)
3. Wire them into your own workflows from the desktop or an external client

The core stays deliberately small. Domain- and country-specific logic belongs in separate
modules or private repositories.
