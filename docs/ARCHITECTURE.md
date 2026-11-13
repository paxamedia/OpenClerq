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
| Agent drivers    | `packages/drivers`  | Run a coding agent: a vendor CLI, or the builtin loop   |
| Interface        | `packages/web`      | Shell, screens, charts and components, for any host app |
| Calculation core | Rust (`clerq-calc`) | Deterministic numeric engine                            |
| Local state      | `~/.clerq`          | SQLite store, settings, encrypted secrets               |

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
  → getExplanation()     ONE LLM call: the skill's SKILL.md instructions in the system
                         prompt, the calculation result as context
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
public model API and is not a provider; it is an agent CLI driver, `cursor-agent`.

Base URLs, model ids and prices are data. To change them, copy the built-in registry to
`~/.clerq/providers.yaml` (or point `CLERQ_PROVIDERS_FILE` at a copy). The gateway reloads that
file when it changes. `CLERQ_LLM_BASE_URL` moves only the `openai` provider and
`CLERQ_OLLAMA_URL` only `ollama`, so a leftover value can never redirect another vendor's key.

Both adapters take tool definitions and return the model's tool calls in one shape
(`ToolDefinition`, `ContentBlock`, `ToolCall` and a normalised `stopReason` in
`@clerq/providers`), buffered or streamed: Anthropic's `tool_use` / `tool_result` blocks and
`input_json_delta` fragments, and the chat-completions `tools` / `tool_calls` / `role: "tool"`
messages and indexed argument fragments. Tool input that is not valid JSON is flagged, never
guessed at. Anthropic `thinking` blocks are kept opaque and handed back unchanged, as the API
requires in a tool round. An OpenAI-compatible server's `reasoning_content` is sent back only when
its registry entry sets `replayReasoning: true`; some servers need it, and DeepSeek's reasoner
refuses a request that carries it. Each call still carries its
tokens and cost, and an unpriced cloud model's cost is unknown, not zero. A server that refuses
`max_tokens` and names `max_completion_tokens` (OpenAI's reasoning models) is retried once with it.

`@clerq/providers` also manages context for a long conversation: a token estimate (the provider's
count once a call reports one; until then one token per four ASCII characters and one per other
character, which errs high), a budget from the model's context window in the registry less room
for the answer, pinned turns that are never compacted, compaction that folds older turns into a
summary written by the model (or drops them with a note when that fails) while keeping the latest
rounds whole, and tool-output truncation that keeps the start and end and says how to get the rest.

`GET /health` reports `llm.provider`, `llm.model`, and `llm.mode`: `local` when the model runs on
this machine, `api` when calls leave it. `GET /providers` lists every provider with its readiness
and qualified model references, but never its endpoint URL, which may carry credentials.

### Model routing and fallback

"Fallback" means using the next model when the one in use is **unavailable**: its provider answered
5xx, 429 or 408, did not answer (a connection failure or a timeout), refused the key (401, 403), or has
no key set. It is decided from what the provider adapter reports about the failed call
(`ProviderError.unavailable`, `isUnavailable()` in `@clerq/providers`), never from the text of an
answer, so an agent that writes "the endpoint returned 503" is not an outage. A request the provider
refused as malformed (400, 422), an unknown model id (404) and a cancel never fall back: another model
would hide a mistake. Fallback is not escalation: `agent.model.escalate` runs a stronger model when
a gate fails.

A model a person chose is used as chosen; anything else may fall back:

| Call                                                                                         | Falls back                                     |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/task`, `/explain`, a session or a comparison column that names a model                     | never: it fails plainly                        |
| A run started by hand with `{ "model": … }`                                                  | never                                          |
| Console raw mode (one request to one model, however it was picked)                           | never                                          |
| Managed chat, `/task`, `/explain` and gateway triggers with no model: the default model      | along the default chain (`GET`/`PUT /routing`) |
| An automation run, scheduled or started by hand without a model, with `agent.model.fallback` | along the spec's chain                         |

The default chain is a setting (`routing.fallback`, up to five `provider/model` entries), empty until
set. Each model is tried once, in order, and the default is not tried twice. A move happens before
any text of the answer was sent: a stream that has failed half way is not handed to another model.
Every move is a `model.fallback` event (`from`, `to`, `reason`, `scope`; with the run and the chat
session), a `model.fallback` step on the run, and one in `llm_fallbacks_total` in `GET /metrics`;
the call that failed is recorded as an error step before it. A fallback sends the prompt to another
provider, which is why the default chain is something you name, and why a run you pinned to a model is
never moved.

### Chat console

A chat message is a run with `trigger: 'manual'` in a session that has no schedule, using the
same providers, runs, steps and cost accounting as the automation runner.
Sessions and their transcripts live in the store.

| Mode        | What the gateway adds                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Raw**     | Nothing. No system prompt, no skill selection, no memory, no tools. The exact request body is kept and is inspectable.       |
| **Managed** | The full `/task` pipeline, with earlier turns: system prompt, skill routing, memory, calculation engine, durable transcript. |

Raw removes OpenClerq's additions, not the vendor's: both modes call the same endpoint under
the user's own key. Use it to tell whether an unexpected answer comes from the model or from
the pipeline's prompt assembly.

`POST /sessions/:id/send` streams by default, as SSE; pass `stream: false` for one JSON
response. `POST /sessions/:id/compare` sends one message to several models at once and returns
a column per model with its latency, tokens and cost; a model that fails becomes a column with
an error rather than failing the comparison. The first answer stands as the turn until
`/promote` chooses another, and the alternatives stay on the message.

The console ships as a first-party desktop module over the same slot contract third-party
modules use, so it can be removed without touching the gateway or the scheduler.

### Cancellation and the kill switch

Every run carries an abort signal, and a model call inside a run listens to it. When the
client that asked for a run hangs up before the answer is complete, the run is cancelled and
the provider call stopped.
A caller that wants the work finished regardless sends `continueOnDisconnect: true` and reads
the outcome from `GET /runs/:id` later. A cancelled run is recorded as `cancelled`, and the
request answers `409 run_cancelled`.

Hang-up detection works when the gateway runs under Node — the server and CLI installs. Under
Bun, which the desktop sidecar is compiled with, nothing signals a hang-up once the request body
has been read (verified on Bun 1.3.10). So a streamed answer names its run in its first event,
`{"type":"start","runId":…}`, and `POST /runs/:id/cancel` stops that run on any runtime. The
client library cancels by id when its caller aborts, and the chat console's **Stop** button uses
it.

`POST /kill` refuses every pending approval, cancels every run in flight, and pauses triggers so
nothing new starts on its own. Each part can be left out: `{ "triggers": false }` stops what is
running without touching the schedule. Triggers stay paused until `POST /resume` or a restart;
saving triggers while paused stores them without starting them, and webhooks answer
`503 triggers_paused`. A person can still run tasks by hand. `GET /kill` reports the state.

### Cost accounting

Every model call made inside a run is recorded as an `llm` step with its provider, model,
prompt, output, latency, tokens and cost, and is added to the run's totals in the same
transaction. Cost comes from registry prices, and **unknown is not reported as free**: a model
with no price records `costUsd: null` and marks the run `costKnown: false`, so its `costUsd` reads
as a lower bound. Keyless local providers cost nothing. `GET /metrics` reports
`llm_cost_usd_total` alongside `llm_unpriced_calls_total`.

### Memory

Memory is a store of **records**: a key, a value (any JSON), and a type, which is one of `fact`
(something true: a rate, a name, a deadline), `preference` (how you like things done), `decision`
(a choice and why), `procedure` (how to do something) and `note` (anything else). A key may hold any
number of records. Each has an id, an origin (`user`, `agent`, `import` for what 0.5 left behind,
`consolidation` for a summary), a source session, a confidence from 0 to 1, a status and `created_at`,
`updated_at` and `expires_at`; a record past its expiry is never read, and is removed at start and when
memory is read, at most hourly. A record holds at most 20,000 characters.

**Search** is SQLite FTS5, over each record's key and the text of its value, best match first with the
key counting three times a word in the value. Every word typed must be there, and the last one matches
as a prefix. FTS5 is in the SQLite of Node 24 and of Bun on macOS, and the gateway checks for it
rather than assuming: where it is missing, or nothing matches by word (a word inside a word; CJK text,
which the tokenizer does not split), search is by substring, newest first, and the answer says which
(`mode`). The index is derived data. It is built when the store opens, kept in step by the writes in
the same transaction (no triggers, so a SQLite without FTS5 still opens the file), and rebuilt when it
does not match the table.

**Summarising.** `POST /memory/consolidate { key, type?, model? }` has a model fold the records of
one key and type into one record (`origin: consolidation`, confidence the lowest of its sources). It
is a run of its own, so its cost is recorded, and an entry in the audit log names the model and the
records. Nothing is deleted: the records stay as `superseded`, pointing at the summary, and
`POST /memory/records/:id/unconsolidate` brings them back. It is refused for fewer than two records,
for several types without one named, for an empty summary, and when a record changed while the model
was writing. Deleting a summary deletes the records behind it.

**Retrieval is decided by policy.** Each type is its own tool in the `memory` group of
`packages/policy`: `memory.read.<type>` and `memory.write.<type>`. A reader may read the types its
rules allow (`readableMemoryTypes(rules)`: an outright allow, not one that needs approval, since nobody
can be asked while a prompt is built). Managed chat and `/task` read under the gateway's memory policy,
every type until `PUT /memory/policy { readTypes }` narrows it (an empty list turns memory off for
them). An automation reads memory only when its spec says so: `memory: { read: [preference, procedure] }`
adds `memory.read.<type>` for those types to the run's own policy rules, and the notes that bear on
the task (found once, and added to the prompt of every attempt, an escalation's too) come from those
types alone; what was read is a `memory.read` step. A sub-agent is given rules of its own the same way. What reaches the model is
a `<memory>` block in the system prompt, shown by `POST /context/preview` like everything else sent:
the reader's preferences (they apply whatever is asked, up to five) and up to five records that match
the message, ranked, at most eight in all and 600 characters each. The block says its contents are
information, not instructions, because a record may have been written from text an agent read.
**Raw mode reads no memory.** Memory that cannot be read is left out, never a failed answer.

The 0.5 `memory` table (one value per key) was rebuilt by store migration 16, which copies every row
across as a `fact` with its dates, so nothing is lost. `GET /memory`, `GET /memory/:key`,
`POST /memory` and `DELETE /memory/:key` answer as before with the record's other fields added:
`POST /memory` still sets one `fact` under a key, in place, and `DELETE /memory/:key` forgets every
record under it. The records themselves are under `/memory/records`.

### Automations

An automation is a YAML spec — a subset of [ROADMAP.md §4](ROADMAP.md#4-automations-as-code) —
that runs a coding agent against a local repository, on a schedule or on demand. Each state is
written before its work starts:

```text
queued → leased → preparing → executing → verifying → publishing → done
  ↑                              ↑            │            ↕
  │                              └─ escalate ─┘    awaiting_approval
  └─── retry after backoff: agent crashed, provider down, lease expired
```

- **queued** — a row in `runs`, waiting for a place: at most `CLERQ_MAX_CONCURRENT_RUNS` (default 2) automation runs at once, one per automation, and a retry waits out its backoff (`not_before`). Queued runs survive a restart.
- **leased** — a gateway takes the run: its pid and start time as owner, and `lease_until` a minute ahead, in one statement that only succeeds while the row is still queued. The lease is renewed every 20 seconds until the run ends.
- **preparing** — a new branch in a fresh `git worktree`, started from origin's copy of the base branch (fetched first; the local branch if the fetch fails). The user's checkout is never touched.
- **executing** — the spec's driver runs the agent in the worktree: a vendor CLI under the user's own sign-in, or the builtin loop in the gateway, with a minimal environment: no gateway token, and no API key unless the spec names a vault secret (handed over as the variable that CLI reads). Its tool calls become run steps, and the cost it reports goes on the run. The process it starts, and each gate's, is recorded with the run; see [Agent drivers](#agent-drivers).
- **verifying** — the agent's changes are committed, then each gate runs in the worktree, in order: a command (`run:`) must exit 0, and an assertion (`assert: diff.…`) is checked against the run's diff from its base. The first failure ends the run, unless the spec escalates (below).
- **publishing** — push, then a draft pull request on GitHub. The push waits in the approvals inbox unless the spec sets `approvals.push: auto`, and an automation's first push always waits.

`packages/policy` decides each action first: running the agent, a gate, committing, pushing,
opening the PR. Anything the spec does not ask to publish is denied. The diff and the agent's
output stay with the run, and the worktree is removed afterwards. New automations are saved
disabled. `max_usd_per_run` becomes the agent's own budget, and reaching `max_usd_per_month`
pauses the automation. The kill switch pauses automation schedules with the triggers, holds the
queue, and cancels queued runs as well as running ones. Its pause is kept in the store: a gateway
that starts while it is engaged starts no triggers, schedules or queued runs until `POST /resume`.

#### Queue, leases and schedules

When more runs are queued than the limit allows, the next one is picked fairly across
repositories: the repository with the fewest runs going, then the one served longest ago, and
within it the oldest run, so one repository with many automations cannot starve the others.
`targets` names one repository per automation in this release, so `targets.max_parallel` has
nothing to spread and is refused; the pick already groups by repository for when it does. A
scheduled firing while the automation is still running queues one run behind it (never a second);
starting a run by hand while one is queued or running is refused. Switching an automation off
cancels its queued runs, and a scheduled run of an automation that is off never starts.

A run nothing is working on any more is reclaimed. At startup that is every unfinished run whose
gateway is not running; while running, a run whose lease has expired and whose owning gateway is
gone (or, for this gateway's own runs, one it no longer holds). A run whose gateway is still
running is never touched, at startup or later; see [Agent drivers](#agent-drivers) for how a live
gateway is told from a reused pid. A gateway first claims an abandoned run, in one conditional
write that succeeds only while the run's state, owner and expired lease are as it read them, so two
gateways sharing a store cannot both settle it; then its leftover processes are stopped and its
worktree and branch removed. A run that was only leased goes back to the queue as the same
attempt, at most three times; one stopped while preparing, working or checking is retried when its
spec has retries left and its automation is still switched on; anything else (including a run
that was waiting for approval or publishing) is marked failed. Each of these writes, and the end of
a run, applies only from the state and owner expected.

One clock watches every schedule: at the next slot due, and at least every 15 seconds. Each
automation keeps `last_slot_at`, the latest slot dealt with. It is moved by compare-and-set in the
same transaction that writes the slot's run, so two gateways sharing a store cannot both fire a
slot, and a run that cannot be queued (one is already waiting, or the write failed) still uses up
its slots, which are recorded as missed (`already_queued`, `enqueue_failed`). A
slot at most two minutes old runs; older ones were missed (the machine slept, or the gateway was
down). With `on.catch_up: true` they are caught up by one run, however many there were, when they
are noticed, on wake or on start; without it they are skipped and recorded
(`automation.slots_missed` in the audit log, `schedule.missed` on the event bus, `missedSlots` in
the automation's summary). A sleep shows as the wall clock jumping ahead of the monotonic clock,
which stops while the machine sleeps (`schedule.woke`); the missed slots are found from
`last_slot_at` either way. Slots missed while the kill switch held schedules are skipped, never
caught up, and a schedule counts from when it is switched on or edited. Slots follow node-cron's
reading of local time: a time that does not exist when the clocks go forward is skipped, and a
repeated hour when they go back runs once.

#### Retries and escalation

`retry.max_retries` (default 0) tries a run again after a failure that says nothing about the
task: the agent's process crashed without reporting a result, the model provider answered 5xx or
429 or was unreachable, or the run's lease expired. Only what the driver itself reports counts (the
crash, the API error the CLI printed, the builtin's last model-call error), never the agent's own
final message, and a limit the CLI enforced (`error_max_turns`, `error_max_budget_usd`) never does. The wait is `retry.backoff` (default 1m),
doubled for each retry before, at most an hour; the run is back in the queue meanwhile, can be
cancelled there, and starts again from a fresh worktree. A run that failed a policy decision, a
budget, a time limit, a denial, a gate or a cancel is never retried, and neither is a run whose
automation is switched off (a run started by hand while it is off runs once). All attempts are one
run, so its steps and its cost cover every attempt, and `max_usd_per_run` limits what they
reported together. A crashed attempt that reported no cost is recorded as unaccounted, and the
run's cost then reads as a lower bound (`costKnown: false`).

`agent.model.escalate` lists models to try when the gates fail: the agent runs again with the
next one, once per model, in the same worktree. The earlier attempt's commit stays (whatever the
gates wrote is reset away), the prompt gains the failed check and its output, and the run ends with
one commit. Each attempt is recorded as an `agent.escalate` step and gets only what is left of
`max_usd_per_run`; an attempt the run or month budget cannot cover is not started. Every model is
checked before the run does any work, so a model that is unavailable, or unpriced while the spec
has a budget in dollars, is refused at the spec check and before the first attempt. The model is
handed to the driver as given: `provider/model` for the builtin agent, the CLI's `--model` value
for the others. Another model when one is _unavailable_ is a separate key, `agent.model.fallback`
(below).

#### Model fallback

`agent.model.fallback` (up to five models, distinct from the primary and from each other) lists the
models to use when the one in use is unavailable (see [Model routing and
fallback](#model-routing-and-fallback)). It is not for a gate failure and uses none of the retries.

- **The builtin agent** moves in the middle of its run, in the model-call step: the failed call is
  recorded, the next model that can be used takes over (one that has no key, or no price under a
  dollar budget, is passed over and the event says why), the conversation is fitted to its window
  (compacted first if it no longer fits), the old model's reasoning blocks are dropped from the
  history (a vendor may refuse reasoning another model wrote), the tool calls and results stay paired,
  and the turn lost to the outage does not count against the turn limit. It stays on the model it moved
  to for the rest of the attempt.
- **A CLI agent** is started again with the next model (`--model`) at once, in the same attempt: no
  backoff, none of `retry.max_retries` used. If the interrupted attempt changed files, the next model
  is told so. Only a provider fault the CLI itself reported (the same classification as retries)
  moves it on; a crash is a retry, and a refused sign-in is not helped by another model.
- **At the start of a run** a primary that cannot be used (no key, say) is replaced by the first
  fallback model that can, and the run says so. Every model of the chain is checked before any work,
  by one function the spec preview uses as well: an unavailable escalation model, and a fallback or
  primary model with no price when the spec has a dollar budget, are errors; a fallback model that
  merely cannot be used now is a warning and is skipped when its turn comes.
- When every model is unavailable the run fails with the last error, and with `retry.max_retries` it is
  tried again from the primary after the backoff. A model that failed the gates is not used as the
  fallback of a later escalation, and a model found unavailable is not tried again in the same run.
- **Budgets** keep applying: each attempt is held to what is left of `max_usd_per_run`, and a call
  that failed because the model was unavailable is recorded as it cost.
- **Strictness.** `POST /automations/:id/run` accepts `{ "model": "…" }`: the run uses it in place
  of the spec's primary model and never falls back (the choice is stored on the run, so a retry keeps
  it). Escalation remains the spec's own policy for a failed gate.
- **The spec's API key** (`agent.api_key_secret`) belongs to the provider of the spec's own primary
  model. A model of another provider (a fallback, an escalation, or one named for this run) uses that
  provider's usual key from the gateway's environment, and is not usable without one, so a key is
  never sent to a vendor it was not for.

`agent.model.strategy` (`cost_aware`, `quality_first`, `race`, `consensus`) is still refused, naming
the keys above; it is planned after 1.0.

#### Diff assertions

A gate can be `assert:` with a small expression, parsed when the spec is saved (no `eval`) and
refused with its line and column when it does not read:

| Assertion                                                                                       | Passes when                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| `diff.files_changed`, `diff.lines_added`, `diff.lines_removed` `<= < >= > == !=` a whole number | the count compares as written        |
| `diff.touches_none_of [glob, …]`                                                                | no changed path matches any glob     |
| `diff.touches_only [glob, …]`                                                                   | every changed path matches some glob |

The diff is the run's commit against its base (`git diff --numstat -M`): a renamed file counts once
in `files_changed` and both its paths count as touched; a binary file adds no lines. Globs match
paths from the repository root: `*` within one directory, `?` one character, `**` any number of
directories, and a trailing `/` everything below. `*.md` is a Markdown file at the root;
`**/*.md` is one anywhere. Each result is a gate step with what was measured and, for a set rule,
the paths that broke it.

#### Agent drivers

A driver runs one agent and reports what it did as the same stream of events, so the run view
does not care which agent produced a run. `agent.driver` takes one of four:

| Driver         | Runs                                               | Cost reported | Spend limit | `allowed_tools`      |
| -------------- | -------------------------------------------------- | ------------- | ----------- | -------------------- |
| `claude-code`  | `claude -p`, streaming JSON                        | yes           | yes         | yes                  |
| `codex`        | `codex exec --json`, JSONL events                  | no            | no          | no                   |
| `cursor-agent` | `cursor-agent --print --output-format stream-json` | no            | no          | no                   |
| `builtin`      | OpenClerq's own tool loop, in the gateway          | yes, per call | yes         | yes, as policy rules |

`agent.permission_mode` follows Claude Code's meaning. A CLI is never prompted: whatever the mode
does not grant is denied. The builtin driver can ask a person through the approvals inbox, and
does in `default` mode. Each driver maps the four modes to the nearest thing it has:

| `permission_mode`       | `claude-code`                   | `codex`                     | `cursor-agent`           | `builtin`                                    |
| ----------------------- | ------------------------------- | --------------------------- | ------------------------ | -------------------------------------------- |
| `acceptEdits` (default) | `--permission-mode acceptEdits` | `--sandbox workspace-write` | agent mode, no `--force` | every tool, without asking                   |
| `default`               | `--permission-mode default`     | `--sandbox read-only`       | `--mode ask` (read-only) | reads; writes and commands wait in the inbox |
| `dontAsk`               | `--permission-mode dontAsk`     | `--sandbox read-only`       | `--mode ask` (read-only) | reads only                                   |
| `plan`                  | `--permission-mode plan`        | `--sandbox read-only`       | `--mode plan`            | reads only                                   |

No CLI is ever started with its "run everything" switch. In Codex's `workspace-write`
sandbox the driver also passes `--config sandbox_workspace_write.network_access=true`, because
Codex turns the network off there by default and OpenClerq's default is full access: an agent
that cannot install packages or fetch what a test needs is of little use. Without network, the
sandbox keeps what `~/.codex/config.toml` says. In Cursor's agent mode, shell commands run only if
they are on the user's own allowlist.

Codex and Cursor report no cost and have no spend limit, so a spec that sets
`budget.max_usd_per_run` or `budget.max_usd_per_month` for them is refused when it is saved, as is
`agent.allowed_tools`, which neither CLI takes; a run's time limit (`sandbox.timeout`) is the
bound. `agent.api_key_secret` is handed to the CLI as `ANTHROPIC_API_KEY`, `CODEX_API_KEY` or
`CURSOR_API_KEY`. Install paths: `CLERQ_CLAUDE_BIN`, `CLERQ_CODEX_BIN`, `CLERQ_CURSOR_BIN`.

`GET /drivers` lists each driver with its version and, where the CLI says, whether it is signed in;
a spec that does not bring its own key needs it to be. For Codex and Cursor, `detect` also reads
the CLI's own `--help` and checks it lists every option a run of that mode and model will pass
(`--ephemeral`, `--trust`, `--mode` and so on). An older CLI that lacks one is reported as
unavailable, naming the option and its version, instead of failing every run. A help screen that
cannot be read is not held against the CLI.

##### The builtin driver

`builtin` runs the agent loop in the gateway's own process, over any model in the provider
registry: `agent.model` names it as `provider/model` (`anthropic/claude-sonnet-4-5`,
`deepseek/deepseek-chat`, `ollama/llama3.2`). Its key is the provider's usual variable, or
`agent.api_key_secret` from the vault, which is for the provider of the spec's own primary model
(another provider's model, as a fallback, an escalation or a model named for one run, uses its own
provider's usual key). The key is used for the model call and is not put in any
command's environment; under full access, though, a command runs as the gateway's user and can
read what that user can. Tool inputs and outputs are redacted of the vault values the run uses
before they are stored or shown to the model. Its tools work in the run's worktree: read, list and search files,
write and edit them, run a shell command, and `git status` / `git diff`; see
[TOOLS.md](TOOLS.md#5-agent-tools-builtin-driver). Every path goes through the same canonical
containment check as the gateway's `fs.read`, which follows links whose target does not exist yet,
files are written without following a link at the last step, and each command runs through `@clerq/sandbox` as a
process group that is stopped when it exits, with a time limit and an output cap.

Every tool call is decided by `packages/policy` first. Full access is the default: in
`acceptEdits` the agent reads, writes and runs commands in its worktree without asking. A command
that publishes (`git push`, `gh pr create`) is judged as `git.push` and waits in the approvals
inbox in every mode, as the run's own push does; this reads the command's words, so a script that
pushes without saying so is not caught. In `default` mode, writes and commands wait in the inbox,
the run shows `awaiting_approval` meanwhile, and a request nobody answers within
`approvals.timeout`, or before the agent's own time limit runs out, is refused and closed. `agent.allowed_tools` takes policy rules (`fs.read`, `fs.*`,
`group:fs`, `risk:read`) and narrows the tool set to what they name; a run makes at most 400 tool
calls.

The loop stops after 60 model turns, at `sandbox.timeout`, or when the next call, counted at its
full output limit, would pass `budget.max_usd_per_run`, measured from each call's recorded cost; a
summary call is checked the same way. When a reply stops at the output limit, its last tool call
is not run, and the model is asked to send it again. A turn that ends with no answer (only
reasoning, or a stop reason other than finishing) fails the run. A spec that sets a dollar
budget for a cloud model with no price in `providers.yaml` fails the spec check, saying so. Each
model call is a run step with its tokens and cost, and each tool call a step and a row in
`tool_calls` (name, input, output, status, duration and whether a person was asked). When the
conversation nears the model's context window, older turns are summarised by the model, unless
that would free too little to be worth it; the task stays pinned, a later drop never discards an
earlier summary, and each compaction is recorded as a `context.compact` step.

`GET /drivers` lists `builtin` with each provider and whether it has a key; with a model, `detect`
checks that model's key, its price when the spec sets a budget, and that a local server answers.

When an agent or a gate exits, anything it left running in its process group (a dev server, a
forked daemon) is stopped: asked to stop, then killed after a second. Otherwise it would outlive
the run, unseen.

Every agent and gate process also leads its own process group, so it would outlive a gateway that
crashed. The gateway records each one (pid, group, the OS's start time, command) in
`run_processes`, beside the run, and closes the record when the process exits. The start time is
asked of the OS without blocking and written when it answers. On the next start, before
interrupted runs are marked failed and their worktrees removed, it stops what is still running,
after checking it is what was recorded: the group's leader must still be there with the recorded
start time and, for an agent, a command line that still names the CLI. The leader is read again
just before the group is signalled. A group whose leader has gone is left alone, since its number
may belong to another group by now; so is a record with no start time. Runs carry the pid and
start time of the gateway that created them, and a run whose gateway is still running (this
process, or another instance on the same store) is not treated as interrupted: its processes,
approvals and worktree are left as they are. This needs `ps` with `lstart` (macOS, procps); where
there is none, nothing is stopped.

In this release the agent and the gates run with the `native` profile, without isolation, and a
spec must say so to run. See [SECURITY.md](SECURITY.md).

---

## 4. Gateway

The gateway is the control plane. Endpoints:

| Group       | Endpoints                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status      | `GET /health`, `GET /metrics`, `GET /logs/stream` (SSE)                                                                                                                                                             |
| Models      | `GET /models`, `GET /providers`                                                                                                                                                                                     |
| Agent       | `POST /task`, `POST /explain`, `POST /context/preview`                                                                                                                                                              |
| Skills      | `GET /skills`, `GET /skills/:slug`, `PUT /skills/:slug`                                                                                                                                                             |
| Tools       | `GET /tools`, `POST /tools/run`                                                                                                                                                                                     |
| Calculation | `POST /calculate/eval`, `POST /filing/prep`                                                                                                                                                                         |
| Memory      | `GET /memory`, `GET /memory/:key`, `POST /memory`, `DELETE /memory/:key`                                                                                                                                            |
| Memory 2.0  | `GET /memory/search`, `GET \| POST /memory/records`, `GET \| PATCH \| DELETE /memory/records/:id`, `POST /memory/consolidate`, `POST /memory/records/:id/unconsolidate`, `GET \| PUT /memory/policy`                |
| Runs        | `GET /runs?since=&limit=`, `GET /runs/:id`, `POST /runs/:id/cancel`                                                                                                                                                 |
| Chat        | `GET \| POST /sessions`, `GET \| DELETE /sessions/:id`, `POST /sessions/:id/send` (SSE), `/compare`, `/promote`, `/update`                                                                                          |
| Approvals   | `GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/deny`                                                                                                                                         |
| Events      | `GET /events` (SSE), `GET /events/stream` (SSE, resumable)                                                                                                                                                          |
| Kill switch | `GET \| POST /kill`, `POST /resume`                                                                                                                                                                                 |
| Config      | `GET \| POST /capabilities`, `GET \| POST /reasoning`, `GET \| POST /system-prompt`, `GET \| PUT /routing`                                                                                                          |
| Secrets     | `GET /secrets`, `POST /secrets`, `DELETE /secrets/:name`                                                                                                                                                            |
| Automations | `GET \| POST /automations`, `POST /automations/preview`, `GET \| PUT \| DELETE /automations/:id`, `POST /automations/:id/run\|enable\|disable`, `GET /drivers`, `GET /runs/:id/artifacts/:id`                       |
| Triggers    | `GET \| POST /triggers`, `POST /webhook/:id`                                                                                                                                                                        |
| Records     | `GET \| POST /records`, `POST /records/resolve`, `GET \| PATCH \| DELETE /records/:id`, `POST /records/:id/merge`, `GET /records/:id/activities`, `POST \| DELETE /records/links`, `GET /links`, `POST /activities` |
| Inbox       | `GET /inbox`, `POST /inbox/items`, `GET \| PATCH /inbox/items/:id`, `POST /inbox/items/:id/respond`                                                                                                                 |
| Remote      | `GET \| PUT /remote`, `POST /devices/pairing`, `POST /devices/pair` (no token), `GET /devices`, `DELETE /devices/:id`, `GET \| DELETE /devices/me`                                                                  |
| Search      | `GET /search`, `GET /extensions`                                                                                                                                                                                    |
| Modules     | `GET /modules`, `POST /modules/:id/token`, `DELETE /modules/:id/tokens`; module routes at `/api/modules/:id/*`, with `ui/`, `triggers/:id` and `services` reserved (see [MODULE_SYSTEM.md](MODULE_SYSTEM.md))       |

Responsibilities: loading skills from disk and normalising metadata (`inputSchema`,
`outputSchema`, `dependsOn`); hosting tools under capability restrictions; store-backed memory,
runs and triggers; running cron, file-watch and webhook triggers, each as a recorded run; LLM
observability (call counts, latency, tokens, cost, failure rates); and dynamic module loading.

### Authentication

Every endpoint except `GET /health` requires a bearer token:

```
Authorization: Bearer $(cat ~/.clerq/gateway-token)
```

The gateway generates that file (mode 0600) on first run, or uses `CLERQ_GATEWAY_TOKEN` when
set. There is no development bypass — `CLERQ_DEV` affects conveniences, never access.
`GET /logs/stream`, `GET /events` and `GET /events/stream` also accept `?token=`, because
`EventSource` cannot set headers.

### Event stream

`GET /events/stream` sends every event on the bus as SSE, with `id: <epoch>-<seq>`. A client that
reconnects with `Last-Event-ID` gets what it missed from the last 500 events; when that is not
possible (a restarted gateway, or a gap that is too old) it gets an `event: reset` frame and
should refetch. `?names=run.,approval.` filters by name prefix. A `: ping` comment goes out every
15 s (`CLERQ_SSE_HEARTBEAT_MS`). `GET /events` is the older form: the last 100 events, then live.

Licensing is a separate concern: `middleware/license.ts` attaches entitlement information and
never rejects in the OSS build. Conflating the two was the pre-0.4 design and is what left the
gateway open.

The listener binds `127.0.0.1` unless `CLERQ_HOST` says otherwise. Remote access (a phone) goes
through the user's own tunnel; see Remote mode in SECURITY.md. See [SECURITY.md](SECURITY.md).

### Error response shape

All errors use one shape, and carry no PII:

```json
{
  "error": "<code>",
  "message": "<human-readable message>",
  "requestId": "<optional>"
}
```

| Code                                                                                   | HTTP | Meaning                                                                     |
| -------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `unauthorized`                                                                         | 401  | Missing or invalid bearer token                                             |
| `question is required`                                                                 | 400  | `/explain` called without a question                                        |
| `message is required`                                                                  | 400  | `/task` called without a message                                            |
| `expression or spec.formulas required`                                                 | 400  | `/calculate/eval` needs one or the other                                    |
| `name is required`, `key required`, `slug required`, `tool_name_required`              | 400  | Missing required identifier                                                 |
| `invalid config`                                                                       | 400  | Malformed capabilities or reasoning payload                                 |
| `skill_not_found`, `memory_not_found`, `webhook not found`                             | 404  | No such resource                                                            |
| `ai_unavailable`                                                                       | 503  | Model provider unusable: no key, unreachable, or it returned an error       |
| `run_cancelled`                                                                        | 409  | The run was stopped by the kill switch or the client hanging up             |
| `run_not_active`                                                                       | 404  | `POST /runs/:id/cancel` on a run that is not running                        |
| `triggers_paused`                                                                      | 503  | A webhook fired while the kill switch holds triggers paused                 |
| `invalid_session`                                                                      | 400  | Bad chat request: unknown session, empty text, unknown mode, bad model list |
| `calculation_engine_unavailable`                                                       | 503  | Rust engine not built                                                       |
| `calculation_failed`, `explain_failed`, `task_failed`, `context_preview_failed`        | 500  | Handler error                                                               |
| `skills_load_failed`, `skill_load_failed`, `skill_save_failed`                         | 500  | Skill read or write error                                                   |
| `memory_list_failed`, `memory_get_failed`, `memory_set_failed`, `memory_delete_failed` | 500  | Memory store error                                                          |
| `invalid_memory`                                                                       | 400  | A memory request that cannot be stored (key, type, value, expiry)           |
| `cannot_consolidate`, `memory_changed`                                                 | 409  | Summarising refused, or the records changed while it ran                    |
| `invalid_routing`, `invalid_model`                                                     | 400  | A bad default chain, or a bad model for one run                             |
| `tools_list_failed`, `tool_run_failed`, `models_list_failed`, `providers_list_failed`  | 500  | Tool or model registry error                                                |

---

## 5. Desktop app

The interface lives in `packages/web` as `<OpenClerqApp client host modules />`. The desktop
(`apps/desktop`) passes the gateway client and a Tauri host: config file, API key, updater,
notifications and the dock badge. Another app can mount the same screens with its own client
and host.

- **Shell** — rail (bottom tabs at phone width), top bar with breadcrumb and actions, status bar,
  ⌘K palette over `/search`, and a hash router: every page is a route such as `#/runs/<id>`.
- **Core pages** — Home, Inbox (approvals and module items), Runs, Records, Developer, Settings.
- **Modules** — pages under `#/m/<id>/…`. Bundled modules (Automations, Chat) register through
  the slot contract; modules the gateway runs appear from `GET /modules` and their `nav`
  extensions, with their UI in a frame.
- **Live data** — one cache over the client, refetched from `GET /events/stream`, polled when the
  stream is down.

The desktop talks to `http://127.0.0.1:18790` by default. Its content security policy allows
connections and frames from the loopback gateway only.
It launches the gateway and calculation engine as Tauri sidecars; the Tauri capability
manifest permits executing exactly those two binaries and nothing else.

---

## 6. Local state

| Path                         | Contents                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| `~/.clerq/gateway-token`     | Bearer token for the local API (mode 0600)                      |
| `~/.clerq/clerq.db`          | SQLite: runs and steps, approvals, memory, triggers, audit log  |
| `~/.clerq/providers.yaml`    | Optional replacement for the built-in provider registry         |
| `~/.clerq/config.json`       | Gateway URL, module paths, UI settings                          |
| `~/.clerq/.env`              | Provider API key, if configured                                 |
| `~/.clerq/capabilities.json` | Filesystem root and HTTP allowlist                              |
| `~/.clerq/secrets.vault`     | AES-256-GCM encrypted secrets; the key lives in the OS keychain |
| `~/.clerq/vault.key`         | Master key, mode 0600 — only where there is no keychain         |
| `~/.clerq/secrets.audit.log` | Append-only vault access log                                    |
| `~/.clerq/workspaces/`       | Worktrees of automation runs in progress                        |

A pre-0.5 `memory.json` or `triggers.json` is imported into `clerq.db` on first start and kept as
`*.migrated`. The remaining JSON files are read-modify-write with no locking, so concurrent
writers can clobber each other; they move into the store as the rest of 0.5 lands.

---

## 7. Extending

1. Add skills or modules — see [MODULE_SYSTEM.md](MODULE_SYSTEM.md)
2. Add tools or calculation operations — see [TOOLS.md](TOOLS.md) and [ARITHMETIC_API.md](ARITHMETIC_API.md)
3. Wire them into your own workflows from the desktop or an external client

The core stays deliberately small. Domain- and country-specific logic belongs in separate
modules or private repositories.
