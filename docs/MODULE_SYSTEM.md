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

tools_required: [fs.read, fs.list]   # Optional: the tools the instructions use
network_domains: [api.example.com]   # Optional: hosts the instructions expect to reach
filesystem_scope: [inbox/, ~/Notes]  # Optional: paths the instructions expect to read or write
checksum: sha256:…                   # Optional: the author's checksum of the skill's folder
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
- Optional `tools_required`, `network_domains`, `filesystem_scope` and `checksum`: what the
  instructions expect to need, and the author's checksum of the skill's files. They are declarations,
  not permissions: you decide whether to trust a skill, and what the declarations do is up to the
  enforcement switch. [SKILLS.md](SKILLS.md) has the format, how the checksum is made, trust states
  and what enforcement does and does not do.

You can edit schemas and dependencies via the desktop (Skills section) or `PUT /skills/:slug`; saving
rewrites `SKILL.md`, so a skill you had trusted needs trusting again. Everything else is for
instructions and safety.

---

## 4. Routing from `/task`

When you call `POST /task`:

1. The gateway loads the skill list (frontmatter only) from your skills directory and each module’s `skills/` folder.
2. It selects the skill whose `triggers` appear in the message. A skill without `triggers` matches on its slug or name.
3. The selected skill’s instructions — the Markdown after the frontmatter — are appended to the system prompt in a fenced `<skill_instructions>` block with the skill's name, capped at 16,000 characters, introduced with its trust state. With no match, the plain system prompt is used.

Every skill has a trust state (`untrusted`, `trusted`, `modified`, `blocked`). A blocked skill is
never selected. With enforcement on (the switch Plugins has, `plugins.enforce`; off by default) only a
trusted skill is, and the next best match is used when the best is passed over; the trace names the
skill that was skipped and why. A managed chat narrows its tools to a trusted skill's
`tools_required` and limits its file tools and Sandboxed commands to its `filesystem_scope` and
`network_domains`; `/task` offers the model no tools, so there is nothing to narrow there. See
[SKILLS.md](SKILLS.md).

You can test this behaviour by:

- Adding `triggers` to your skill frontmatter.
- Calling `/task` with messages that include those keywords.
- Calling `POST /context/preview` with `skillSlug` to see the prompt a task with that skill would send.

---

## 5. Server modules

A module is a directory with a `manifest.json` and a server entry (`dist/routes.js`, or the
manifest's `entryPoints.routes[0]`): an ES module whose folder is the module's code. The gateway loads every module
under `CLERQ_MODULES_DIR` (or the single module there) at start, and lists them at `GET /modules`.

> **Plugins.** A manifest that says `"manifestVersion": 1` is a _plugin_, with a lifecycle
> (`upgrade`, `register`, `start`, `stop`), a validated manifest, an approval and optional
> enforcement of its declared permissions. That is documented in [PLUGINS.md](PLUGINS.md), and new
> work should start there. A module without `manifestVersion` is a **legacy module**: it loads as
> described below, is labelled "legacy" in the list, and `@clerq/module-sdk` (which now re-exports
> `@clerq/plugin-sdk`) keeps working through 1.x. The rest of this section is the legacy contract; the
> context table is the plugin context's too.

> **The page of a module that ships inside the app** (the slot contract: `PluginUI`, `PluginProps`, rail entries,
> palette commands) is defined in `@clerq/plugin-sdk/ui`, not in the app, so a package can type its UI without
> importing the app. The app's own pieces such a page may use are listed in `@clerq/web/plugin-ui`. The chat
> console is built that way: see [PLUGINS.md](PLUGINS.md#for-a-plugin-ui-in-the-app-itself).

The entry exports `register(ctx)`, or a default `{ register }`. Types are in `@clerq/module-sdk`;
[`packages/module-sdk/examples/hello-world`](../packages/module-sdk/examples/hello-world) is a
complete example.

| `ctx.`                      | What it is                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `routes`                    | `get/post/put/patch/delete(path, handler)`, served at `/api/modules/<id>/<path>`                                                       |
| `store`                     | the gateway's SQLite store; `table('x')` is `mod_<id>__x`. Raw SQL may name only the module's own tables when enforcement is on        |
| `secrets`                   | vault entries named `<id>/<name>`                                                                                                      |
| `events`                    | `emit('x', payload)` puts `module.<id>.x` on the bus (and `GET /events/stream`); `subscribe(prefix, fn)`                               |
| `triggers`                  | `register({ id, kind: 'cron' \| 'file' \| 'webhook', handler })`; each firing is a run                                                 |
| `notify`                    | `notify({ title, body, level, link })` and `notify.badge('3/10')`: `notify.posted` and `notify.badge` events                           |
| `services`                  | `status/start/stop(label)` for the launchd agents the manifest lists under `services` (macOS)                                          |
| `records`                   | shared people, organisations and activities: `resolve`, `link`, `addActivity`, `ref(type, id)`                                         |
| `search`                    | `register((q, { limit, types }) => results)` for global search                                                                         |
| `inbox`                     | `add({ kind, title, ref, externalId })`, `resolve(id)`, `onRespond(handler)`                                                           |
| `approvals`                 | `request({ action, reason })` into the approvals inbox, and `wait(id)`                                                                 |
| `audit`                     | `append(action)`, recorded as `module.<id>.<action>`                                                                                   |
| `logger`                    | the gateway log, tagged with the module id                                                                                             |
| `exec`, `fetch`, `fs`       | a command, an HTTP call and files, each checked against the declared permissions when enforcement is on (see [PLUGINS.md](PLUGINS.md)) |
| `setInterval`, `setTimeout` | timers the gateway cancels when the module stops                                                                                       |
| `tenant`                    | the current tenant (`default` on a single-tenant install); `withTenant(id, fn)`                                                        |
| `config`                    | the manifest's `config`, overlaid by `~/.clerq/modules/<id>.json`                                                                      |

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
`fs.write` (paths), `net` (hosts), `secrets`, `services`, `llm`, and `api` and `memory`. They are
parsed, shown at `GET /modules` (the first six) and `GET /plugins` (all) with any warnings, given to the
module as `ctx.permissions`, and recorded; a change since the last start goes in the audit log. They
are **checked only when the user turns on plugin enforcement** (Settings → Plugins; off by
default), and then only for what goes through the context: [PLUGINS.md](PLUGINS.md) says what is
and is not covered. **It is not a sandbox.**

**UI.** A module that ships `dist/ui/index.html` has it served at `/api/modules/<id>/ui/`, without
a token: these are static files with no data in them, and an iframe cannot send a header. The UI
gets a token from the desktop (below) and sends it on its API calls. Every path under `/ui` is
answered from the files, so a module cannot put a route there. `GET /modules` gives each `ui` URL.

**UI tokens.** `POST /modules/<id>/token` (gateway token only) issues a token for the module's UI:
15 minutes by default (`ttlSeconds`, at most 24 h). It reaches `/api/modules/<id>/*` and the core
endpoints the manifest lists in `coreEndpoints`, such as `"GET /runs/:id"`, and gets `403`
elsewhere. Token, device, remote and vault endpoints are never reachable with it.
`DELETE /modules/<id>/tokens` revokes them all. Module UI tokens are not isolated from each other:
all module frames share the gateway's origin, so one module's UI can read another's token, in line
with modules running with the owner's full trust.

**Tables.** SQL files in `<module>/migrations/`, named `0001_name.sql` and so on, run in order
before `register`, each once and in its own transaction. They may create, change or write only
objects named `mod_<id>__*` (hyphens in the id become underscores); anything else fails the module.
Like core migrations they are append-only: one edited after it ran is refused.

A module whose migrations or `register` throw is listed as `failed` and gets no routes. Module code runs in the
gateway process with the gateway's access: the context is a namespace, not a sandbox. Modules that
export a `routes` array (the earlier contract) still load. The gateway hashes the entry's folder (`dist/`
for `dist/routes.js`), `dist/ui`, `skills` and `migrations`, and runs and serves the module from a copy of
those files (see [PLUGINS.md](PLUGINS.md)): what it imports from outside them is not there.

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

**In the shell.** `nav` items become rail entries, `home.tile` cards sit on Home, `record.panel`
items are tabs on a record's page and `record.action` items its buttons (a `trigger` fires with
`{ ref }`, asking first when `confirm` is set), `settings.page` items join Settings, and
`inbox.item` paths draw an item in the inbox. Each is the module's UI in a frame. The frame
receives `{ type: 'clerq:token', token, expiresAt }` (renewed before it expires) and
`{ type: 'clerq:theme', theme }`, and may post `{ type: 'clerq:token-request' }`,
`{ type: 'clerq:navigate', path }` or `{ type: 'clerq:height', height }`.

**Search.** `GET /search?q=&types=&limit=` returns core people and organisations plus every module's
`ctx.search` results as `{ ref, moduleId, type, title, subtitle?, path?, score }`, best first. A
module that fails or takes over 1.5 s is listed under `errors`.

**Inbox.** `GET /inbox?status=&kind=&module=` lists pending approvals (`apr_<n>`, decided at
`/approvals/:id/approve|deny`) with every module's items. `POST /inbox/items`,
`PATCH /inbox/items/:id { status }` and `POST /inbox/items/:id/respond { text, data }`, which calls
the module's `onRespond` and closes the item. Events `inbox.item.created|updated|responded`.

## 8. Tenants

One gateway can serve several tenants (a hosted multi-tenant app) or one (a gateway per client).
A single-tenant install only ever sees the tenant `default` and needs to do nothing.

- A request runs in one tenant: a scoped token's own, or for the gateway token the one named by
  `X-Clerq-Tenant` (else `default`). A scoped token naming another tenant gets `403`.
- Shared records, links, activities and inbox items are per tenant. Identity resolution never
  matches across tenants: the same email is a different person in each.
- Every `mod_<id>__*` table gets a `tenant_id` column (default `default`) and an index, added by the
  store after each module migration. `ctx.store.rows('items')` reads and writes only the current
  tenant's rows; raw SQL through `ctx.store.prepare` must filter on `tenant_id = ctx.tenant` itself.
- `ctx.tenant` is the current tenant: the request's, or `default` for triggers and timers.
  `ctx.withTenant(id, fn)` runs work as another tenant.
- Events from a tenant other than `default` carry `context.tenantId`; a scoped token's event stream
  shows only its tenant's.
- Not per tenant yet: runs, approvals, automations, secrets and module config. A scoped token of a
  tenant other than `default` therefore reaches only module routes, records, links, activities,
  the inbox, search, extensions, its event stream and `/devices/me`.

---

## 9. Safety expectations

Modules and skills must respect the **safety guarantees** of the OSS core:

- Deterministic numeric work is delegated to the Rust engine.
- Tools should be **scoped** (filesystem roots, HTTP allow‑lists, etc.).
- Skills should describe any constraints, required approvals, and audit notes.

See `docs/SECURITY.md` for the binding rules and the checklist to run before you ship or share a module,
and [PLUGINS.md](PLUGINS.md) for the manifest, approval and enforcement a plugin goes through.
