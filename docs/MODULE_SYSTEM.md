# Module system — skills and modules in OpenClerq

This document explains how OpenClerq’s **skills and modules** are structured in the OSS core. It is intentionally **generic**: no built‑in roles, products, or countries.

---

## 1. Concepts

- **Skill** — A single capability described in a `SKILL.md` file (e.g. “process inbox”, “generate daily summary”, “prepare draft document”).
- **Module** — A coherent group of skills, tools, and configuration that extends the agent (e.g. “Inbox worker”, “Report generator”).
- **Tools** — Code that can perform side‑effects (filesystem, HTTP, numeric engine, etc.) and is called by the agent.

In OpenClerq OSS:

- The core ships **no jurisdiction‑specific or profession‑specific modules**.
- You are expected to define your own skills and modules for your use case.

---

## 2. Layout

A simple layout under your workspace might look like:

```text
skills/
  my-module/
    SKILL.md
    templates/
    rules/
```

You point the gateway at this directory using `CLERQ_SKILLS_DIR` or the config file; it will load all `SKILL.md` files it finds.

---

## 3. Minimal SKILL.md schema

Each skill/module is described by frontmatter at the top of its `SKILL.md`:

```yaml
---
name: "Inbox Worker"
slug: "inbox-worker"
version: "2026.1"

domains: ["admin"]          # Optional domain tags (admin, ops, hr, etc.)
jurisdiction: []            # Optional region codes if you choose to use them

moduleType: "calc"          # "calc" | "guidance" | "filing" | "compliance"
guardrails: []              # High‑level safety rules; see SECURITY.md

triggers: ["inbox", "email", "messages"]
---

Skill instructions go here in Markdown: what the agent should do,
what tools it can call, and how to structure outputs and progress.
```

The gateway uses:

- `name`, `slug`, `version`
- Optional `triggers` for routing from `/task`
- Optional `inputSchema`, `outputSchema` (JSON Schema objects) for structured inputs/outputs
- Optional `dependsOn` (array of skill slugs) for dependency mapping
- Optional `jurisdiction`/`domains` for your own use

You can edit schemas and dependencies via the desktop (Skills section) or `PUT /skills/:slug`. Everything else is for instructions and safety.

---

## 4. Routing from `/task`

When you call `POST /task`:

1. The gateway loads the skill list (frontmatter only) from your skills directory and each module’s `skills/` folder.
2. It selects the skill whose `triggers` appear in the message. A skill without `triggers` matches on its slug or name.
3. The selected skill’s instructions — the Markdown after the frontmatter — are appended to the system prompt in a `<skill_instructions>` block, capped at 16,000 characters. With no match, the plain system prompt is used.

You can test this behaviour by:

- Adding `triggers` to your skill frontmatter.
- Calling `/task` with messages that include those keywords.
- Calling `POST /context/preview` with `skillSlug` to see the prompt a task with that skill would send.

---

## 5. Server modules

A module is a directory with a `manifest.json` and a server entry (`dist/routes.js`, or the
manifest's `entryPoints.routes[0]`): one self-contained ES module. The gateway loads every module
under `CLERQ_MODULES_DIR` (or the single module there) at start, and lists them at `GET /modules`.

The entry exports `register(ctx)`, or a default `{ register }`. Types are in `@clerq/module-sdk`;
[`packages/module-sdk/examples/hello-world`](../packages/module-sdk/examples/hello-world) is a
complete example.

| `ctx.`      | What it is                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `routes`    | `get/post/put/patch/delete(path, handler)`, served at `/api/modules/<id>/<path>`                             |
| `store`     | the gateway's SQLite store; `table('x')` is `mod_<id>_x`                                                     |
| `secrets`   | vault entries named `<id>/<name>`                                                                            |
| `events`    | `emit('x', payload)` puts `module.<id>.x` on the bus (and `GET /events/stream`); `subscribe(prefix, fn)`     |
| `triggers`  | `register({ id, kind: 'cron' \| 'file' \| 'webhook', handler })`; each firing is a run                       |
| `notify`    | `notify({ title, body, level, link })` and `notify.badge('3/10')`: `notify.posted` and `notify.badge` events |
| `services`  | `status/start/stop(label)` for the launchd agents the manifest lists under `services` (macOS)                |
| `records`   | shared people, organisations and activities: `resolve`, `link`, `addActivity`, `ref(type, id)`               |
| `search`    | `register((q, { limit, types }) => results)` for global search                                               |
| `inbox`     | `add({ kind, title, ref, externalId })`, `resolve(id)`, `onRespond(handler)`                                 |
| `approvals` | `request({ action, reason })` into the approvals inbox, and `wait(id)`                                       |
| `audit`     | `append(action)`, recorded as `module.<id>.<action>`                                                         |
| `logger`    | the gateway log, tagged with the module id                                                                   |
| `config`    | the manifest's `config`, overlaid by `~/.clerq/modules/<id>.json`                                            |

**Triggers.** A firing is recorded as a run with `moduleId` and `triggerId`; the handler's return
value is stored on it, and a throw fails it. `POST /api/modules/<id>/triggers/<triggerId>` fires
any trigger (a webhook's JSON body becomes `payload`) and answers `202 { runId }`. A firing while
the last one is still running is skipped (`409` over HTTP); the kill switch pauses them (`503`).

**Services.** `"services": [{ "label": "org.example.worker", "plist": "~/Library/LaunchAgents/…" }]`
(the plist defaults to `~/Library/LaunchAgents/<label>.plist`). Start bootstraps the agent if
launchd does not have it and kickstarts it; stop boots it out. Over HTTP:
`GET /api/modules/<id>/services` and `POST /api/modules/<id>/services/<label>/start|stop`. Each
start and stop is audited and emits `service.changed`. Labels not in the manifest get `404`.

**Permissions.** A manifest may declare `permissions`: `exec` (exact commands), `fs.read` and
`fs.write` (paths), `net` (hosts), `secrets`, `services` and `llm`. They are parsed, shown at
`GET /modules` with any warnings, given to the module as `ctx.permissions`, and recorded; a change
since the last start goes in the audit log. **They are not enforced yet.**

**UI.** A module that ships `dist/ui/index.html` has it served at `/api/modules/<id>/ui/`, without
a token: these are static files with no data in them, and an iframe cannot send a header. The UI
gets a token from the desktop (below) and sends it on its API calls. Every path under `/ui` is
answered from the files, so a module cannot put a route there. `GET /modules` gives each `ui` URL.

**UI tokens.** `POST /modules/<id>/token` (gateway token only) issues a token for the module's UI:
15 minutes by default (`ttlSeconds`, at most 24 h). It reaches `/api/modules/<id>/*` and the core
endpoints the manifest lists in `coreEndpoints`, such as `"GET /runs/:id"`, and gets `403`
elsewhere. Token, device, remote and vault endpoints are never reachable with it.
`DELETE /modules/<id>/tokens` revokes them all.

**Tables.** SQL files in `<module>/migrations/`, named `0001_name.sql` and so on, run in order
before `register`, each once and in its own transaction. They may create, change or write only
objects named `mod_<id>_*` (hyphens in the id become underscores); anything else fails the module.
Like core migrations they are append-only: one edited after it ran is refused.

A module whose migrations or `register` throw is listed as `failed` and gets no routes. Module code runs in the
gateway process with the gateway's access: the context is a namespace, not a sandbox. Modules that
export a `routes` array (the earlier contract) still load.

---

## 6. Shared records

People, organisations and activities live in the core, so a contact exists once however many
modules know it. Everything is addressed by a ref, `<module>:<type>:<id>`; core records use
`core` (`core:person:per_…`). A module keeps its own types in its own tables and links them to
core records (`crm:deal:42` → `core:person:per_…`, kind `contact`).

- **Identity.** A person or organisation is found by email, phone or domain
  (`POST /records/resolve`). Emails are lower-cased, phones become `+digits`, domains lose their
  scheme, `www.` and path. One identity belongs to one record; identities that point at two
  answer `409 identity_conflict` with both, and `POST /records/:id/merge { from }` joins them.
- **Endpoints.** `GET|POST /records`, `POST /records/resolve`, `GET|PATCH|DELETE /records/:id`,
  `POST /records/:id/merge`, `GET /records/:id/activities`, `POST|DELETE /records/links`,
  `GET /links?ref=`, `POST /activities { kind, summary, refs }`.
- **Events.** `record.created|updated|merged|deleted|linked|unlinked`, `activity.added`.

## 7. Extension points, search and the inbox

A manifest's `extensions` say what the module adds to the shell. `GET /extensions` lists every
loaded module's, each item tagged with `moduleId`; malformed items are left out and named in
`GET /modules` (`extensionWarnings`).

| Point           | Item                                                              |
| --------------- | ----------------------------------------------------------------- |
| `nav`           | `{ id, title, path, icon?, order? }`                              |
| `home.tile`     | `{ id, title, path, size?: 's' \| 'm' \| 'l' }`                   |
| `record.panel`  | `{ id, title, types: ['core:person'], path }`                     |
| `record.action` | `{ id, title, types, path? \| trigger?, confirm? }`               |
| `search`        | `{ id, title?, types? }`                                          |
| `inbox.item`    | `{ id, kind: 'approval' \| 'reply' \| 'task' \| 'alert', title }` |
| `settings.page` | `{ id, title, path }`                                             |

A `path` is inside the module's UI; the shell opens it at `#/m/<module>/<path>`, and `{ref}`
stands for the record's ref. `types` are `<module>:<type>`.

**Search.** `GET /search?q=&types=&limit=` returns core people and organisations plus every module's
`ctx.search` results as `{ ref, moduleId, type, title, subtitle?, path?, score }`, best first. A
module that fails or takes over 1.5 s is listed under `errors`.

**Inbox.** `GET /inbox?status=&kind=&module=` lists pending approvals (`apr_<n>`, decided at
`/approvals/:id/approve|deny`) with every module's items. `POST /inbox/items`,
`PATCH /inbox/items/:id { status }` and `POST /inbox/items/:id/respond { text, data }`, which calls
the module's `onRespond` and closes the item. Events `inbox.item.created|updated|responded`.

---

## 8. Safety expectations

Modules and skills must respect the **safety guarantees** of the OSS core:

- Deterministic numeric work is delegated to the Rust engine.
- Tools should be **scoped** (filesystem roots, HTTP allow‑lists, etc.).
- Skills should describe any constraints, required approvals, and audit notes.

See `docs/SECURITY.md` for the binding rules and the checklist to run before you ship or share a module.
