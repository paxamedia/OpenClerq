# Plugins

A plugin is code that extends OpenClerq: server routes, triggers, background work, a page in the
app, skills. It is a folder with a `manifest.json`, and it is treated as **code, not prompt text**:
what it declares it needs is shown to you, you approve exactly that, a change needs a new approval,
and you can turn on checks on what it does.

Read [Enforcement and its limits](#enforcement-and-its-limits) before you rely on any of it. A
plugin runs **inside the OpenClerq service, with its access**. The checks cover what a plugin does
_through its context_. They are not a sandbox.

| You want to…                                              | Read                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| write one                                                 | [Writing a plugin](#writing-a-plugin), then the example below |
| know every field of `manifest.json`                       | [Manifest version 1](#manifest-version-1)                     |
| know when your code is called, and what is cleaned up     | [Lifecycle](#lifecycle)                                       |
| know what an approval is, and what changes need a new one | [Trust and approval](#trust-and-approval)                     |
| know what turning enforcement on does and does not do     | [Enforcement and its limits](#enforcement-and-its-limits)     |
| keep a module written before 1.0 working                  | [Legacy modules](#legacy-modules)                             |

Plugins are not skills. A **skill** is a `SKILL.md` that adds instructions to a prompt (see
[MODULE_SYSTEM.md](MODULE_SYSTEM.md) §1–4). A plugin may ship skills, and its approval covers
them, but a skill by itself runs no code. A skill that is not part of a plugin has trust states and a
manifest of its own: see [SKILLS.md](SKILLS.md). A plugin's skills are read from the copy that was
approved and are `trusted` while the plugin that runs is the approved one; with enforcement on, a
plugin waiting for approval contributes no skills.

## Writing a plugin

```
my-plugin/
  manifest.json          what it is, what it needs, what it adds to the app
  dist/server.js         the server entry; everything in dist/ is the plugin's code
  dist/ui/index.html     optional: a page, shown in a frame in the app
  skills/…               optional: SKILL.md files
  migrations/0001_x.sql  optional: tables, named mod_<id>__*
```

The server entry exports `definePlugin({ … })` as its default:

```ts
import { definePlugin } from '@clerq/plugin-sdk';

export default definePlugin({
  // Once at every start, after the plugin's migrations: routes, triggers, handlers.
  register(ctx) {
    ctx.routes.get('/hello', (_req, res) => res.json({ hello: ctx.id }));
  },
  // After register succeeded: begin work. Timers made with ctx.setInterval stop with the plugin.
  start(ctx) {
    ctx.setInterval(() => ctx.logger.info('still here'), 60_000);
  },
  // When the plugin is disabled or the gateway closes.
  stop(ctx) {},
  // Before register, when the version changed since the last start.
  upgrade(ctx, { from }) {},
});
```

Everything is typed in **`@clerq/plugin-sdk`**:

| Import                       | What                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@clerq/plugin-sdk`          | `definePlugin`, `PluginContext`, `PluginPermissions`, `PluginPermissionError`, `tablePrefix` and the types of every `ctx` part   |
| `@clerq/plugin-sdk/manifest` | `validateManifest`, `engineProblem`, `describePermissions`, `diffPermissions`; pure, runs in a browser too                       |
| `@clerq/plugin-sdk/node`     | `pluginChecksum(dir)`, `permissionsHash(p)`, `readManifestFile(dir)`: what an approval names                                     |
| `@clerq/plugin-sdk/ui`       | `PluginUI`, `PluginProps`, `RailEntry`, `PaletteCommand`, `GatewayClient`, `Host`, `AppConfig`: for a UI that is part of the app |

**What the plugin is, for the approval, is a set of folders:** the whole folder the server entry is in
(`dist/` for `dist/server.js`), the UI folder, the skills folder and `migrations/`, with the manifest.
They are hashed, and the gateway runs and serves the plugin from a copy of exactly those files (see
[Checksums and what runs](#checksums-and-what-runs)). So the entry may import other files from its own
folder (`import './lib/util.js'`), and nothing it imports from outside those folders is there to
import: a path to a sibling of its folder fails to load. **A bare package name (`import 'express'`) and an
absolute path are outside the approval.** Node finds a bare name by walking up from the copy to
`~/node_modules`, and an absolute path is whatever is there, in or out of the plugin's own folder, so
that code is never hashed or approved. Bundle what you need into the entry's folder. An entry that sits
at the plugin's root (`server.js`) is its own folder of one file: put it in a folder (`dist/`) to ship more.

`ctx.dir` is the copy: read-only, and holding only what was hashed. Read your own assets from it, not
from `import.meta.url` or from where the plugin was installed. A relative folder in `permissions.fs`
(`"write": ["data"]`) is relative to the plugin's folder on disk, which is where a plugin keeps data
that must outlast an update.

### The example

[`packages/plugin-sdk/examples/hello-plugin`](../packages/plugin-sdk/examples/hello-plugin) is a
complete plugin: a route, a trigger, a declared secret, a call with `ctx.fetch` to a declared host,
a page, and `upgrade`, `start` and `stop`. A test loads it the way you would install it. To try it:

1. Copy the folder into the modules folder: the one `CLERQ_MODULES_DIR` names (a folder of plugin
   folders, or one plugin), and restart OpenClerq. Folders added while it runs are found at the next start.
2. **Settings → Plugins** shows it as _Enabled_ and _Not approved_. Review it and approve it.
3. `GET /api/modules/hello-plugin/hello?name=Ada` answers `{ "message": "Hello, Ada" }`.
4. Turn on **Enforce plugin permissions**. `GET /api/modules/hello-plugin/undeclared` now fails
   (it reads a secret the manifest does not declare), and the refusal is in the audit log.

## Manifest version 1

A manifest with `"manifestVersion": 1` is a plugin. One without is a [legacy module](#legacy-modules).

```json
{
  "manifestVersion": 1,
  "id": "hello-plugin",
  "name": "Hello plugin",
  "version": "1.0.0",
  "description": "What it does, in a sentence.",
  "engines": { "api": 1 },
  "entry": { "server": "dist/server.js", "ui": "dist/ui" },
  "skills": "skills",
  "config": { "greeting": "Hello" },
  "services": [{ "label": "org.example.worker" }],
  "permissions": {
    "exec": ["/usr/bin/git"],
    "fs": { "read": ["~/Documents"], "write": ["data"] },
    "net": ["api.example.com", "*.cdn.example.org", "host.example.com:8443"],
    "secrets": ["token"],
    "services": ["org.example.worker"],
    "llm": false,
    "api": ["GET /runs/:id"],
    "memory": { "read": ["fact"], "write": [] }
  },
  "extensions": { "nav": [{ "id": "main", "title": "Hello plugin", "path": "/" }] }
}
```

| Field             | Required | What it is                                                                                                                                                                                                             |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | yes      | `1`.                                                                                                                                                                                                                   |
| `id`              | yes      | Lower-case words joined by single hyphens, at most 64 characters, starting with a letter. It is a URL segment (`/api/modules/<id>/`), a table prefix (`mod_<id>__`) and the prefix of its secrets. `core` is reserved. |
| `name`            | yes      | A name for people, at most 100 characters.                                                                                                                                                                             |
| `version`         | yes      | A semantic version, `1.2.3`. A change of it makes `upgrade` run at the next start.                                                                                                                                     |
| `description`     | yes      | A sentence, at most 500 characters.                                                                                                                                                                                    |
| `engines.api`     | yes      | The OpenClerq API version it needs. See [API compatibility](#api-compatibility).                                                                                                                                       |
| `entry.server`    | no       | The server entry, relative to the plugin folder. Without it the plugin has no server code.                                                                                                                             |
| `entry.ui`        | no       | A folder with an `index.html`, served at `/api/modules/<id>/ui/` and drawn in a frame. Default `dist/ui`.                                                                                                              |
| `skills`          | no       | A folder of `SKILL.md` files. Default `skills`.                                                                                                                                                                        |
| `config`          | no       | Defaults for `ctx.config`, overlaid with `~/.clerq/modules/<id>.json`.                                                                                                                                                 |
| `services`        | no       | launchd agents it may start and stop, as labels or `{ label, name?, plist? }`.                                                                                                                                         |
| `permissions`     | yes      | What it needs. Required even when empty: write `{}` to say it needs nothing.                                                                                                                                           |
| `extensions`      | no       | What it adds to the app: `nav`, `home.tile`, `record.panel`, `record.action`, `search`, `inbox.item`, `settings.page`. See [MODULE_SYSTEM.md](MODULE_SYSTEM.md) §7.                                                    |

Paths (`entry.*`, `skills`) must stay inside the plugin folder: no leading `/`, no `..`.

### Permissions

Every list is optional. A permission that is not listed is not asked for.

| Key        | Value                                                    | What it lets the plugin do through its context                                                                                        |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `exec`     | commands, written exactly as they are run                | `ctx.exec(cmd, args)`; `cmd` must be one of these strings. **Arguments are not checked**: see below                                   |
| `fs.read`  | folders (`~/…`, absolute, or relative to the plugin)     | `ctx.fs.readFile(path)` for a path inside one                                                                                         |
| `fs.write` | folders                                                  | `ctx.fs.writeFile(path, data)` for a path inside one                                                                                  |
| `net`      | hosts: `host`, `*.host`, `host:port`                     | `ctx.fetch(url)` to one. `host` allows any port; `*.host` allows subdomains, not `host` itself; `host:port` only that port            |
| `secrets`  | vault names, without the `<id>/` prefix                  | `ctx.secrets.get/set/delete/list` for those names                                                                                     |
| `services` | launchd labels                                           | `ctx.services.status/start/stop` for those labels (they must also be under `services`)                                                |
| `llm`      | `true` or `false`                                        | **Declared and recorded only.** The context has no model helper in this release                                                       |
| `api`      | `METHOD /path` patterns, `GET /runs/:id`, `* /records/*` | The core endpoints its UI token may call. This replaces the legacy `coreEndpoints`. The first path segment is fixed                   |
| `memory`   | `{ read?: types, write?: types }`                        | **Declared and recorded only.** The types are `fact`, `preference`, `decision`, `procedure`, `note`; the context has no memory helper |

**Declaring `exec` is a serious thing to ask for.** Only the command is checked, not its arguments or
its working directory, so a command that can run code from its arguments amounts to allowing any
command: `sh`, `bash`, `node`, `python`, `perl`, `env`, `xargs`, `find -exec`, and `git` (`git -c
alias.x='!…' x`, a hook or `core.fsmonitor` in the repository it is run in). Declare a command only
if you would let the plugin run anything with it, and tell the person why. The command is looked up once,
on the gateway's own `PATH`, and that file is run, so a `PATH` in the plugin's environment cannot point it at
the plugin's own script; with enforcement on, `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `GIT_EXEC_PATH`,
`GIT_CONFIG_*`, `BASH_ENV`, `ENV` and a few like them (`NODE_PATH`, `PYTHONPATH`, `GIT_SSH`, …) cannot be
set at all.

Validation is strict because what is declared is what you approve. An unknown key under
`permissions`, `engines` or `entry` is an error (a newer plugin may need a newer OpenClerq), and so
is a malformed entry. Anything else the manifest carries that this OpenClerq does not know
(`author`, `license`, `homepage`, `repository`, `keywords` and `$schema` are fine) is ignored with a
warning. Errors are plain sentences with no line numbers, for example
`"version" must be a semantic version such as "1.2.3".`

A JSON Schema is in
[`packages/module-schema/plugin-manifest.schema.json`](../packages/module-schema/plugin-manifest.schema.json).
`validateManifest` from `@clerq/plugin-sdk/manifest` is the reference: it also checks what a schema
cannot (that `net` holds hosts and not addresses, that `api` patterns name part of the API).

### API compatibility

`engines.api` is the API version the plugin was written for. `API_VERSION` in
`@clerq/gateway-client` is the one this OpenClerq prefers, and `SUPPORTED_API_VERSIONS` the ones it
serves (see [API.md](API.md)). A plugin whose `engines.api` is not served is **refused**: it is
listed with the reason, and none of its code is imported.

> This plugin needs OpenClerq API version 2, and this OpenClerq serves version 1. Update OpenClerq,
> or use an older release of the plugin.

The plugin's own routes (`/api/modules/<id>/…`) are the plugin's contract and are outside API 1. The
SDK follows the 1.x rule: additions only. `@clerq/module-sdk` re-exports it under the names it had
(`ModuleContext`, `defineModule`, `ClerqModule`, `ModulePermissions`) and keeps working through 1.x.

## Lifecycle

A plugin is in one of five states, kept with its last start in the store (`plugin_state`,
migration 22):

| State               | Meaning                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `enabled`           | Loaded and started; its routes answer.                                                          |
| `disabled`          | You turned it off. None of its code is imported. It stays off across restarts.                  |
| `awaiting_approval` | Enforcement is on and the plugin is not approved, or changed since you approved it. Not loaded. |
| `failed`            | A hook threw, the manifest is not valid, or its entry cannot be loaded. The reason is shown.    |
| `refused`           | Its `engines.api` is not served here.                                                           |

**At start** (and when you enable a plugin, or approve one that was waiting) the host:

1. reads the manifest and validates it (a bad manifest is `failed`);
2. checks the engine (`refused`);
3. checks your choice (`disabled`) and, with enforcement on, the approval (`awaiting_approval`);
4. copies the files that were hashed to `~/.clerq/plugin-cache/<id>/<hash>/` (a file that is not what was approved means the decision is made again) and imports the entry from the copy;
5. runs the copy's `migrations/` (as for any module: only `mod_<id>__*` objects, append-only);
6. calls `upgrade(ctx, { from })` if the version differs from the last one that started;
7. calls `register(ctx)`;
8. calls `start(ctx)`;
9. mounts its routes, and its UI from the copy. The plugin is `enabled`.

Each of `upgrade`, `register` and `start` has 30 seconds. `upgrade` can run again if a later step
failed, so write it to be safe to repeat.

**At stop** (you disable it, the gateway's `close()`, or enforcement is turned on for a plugin
nobody approved) the host stops sending it requests, revokes its UI tokens, calls `stop(ctx)`
(5 seconds when you disable it, 2 at close), and then takes away **everything the plugin set up
through its context**:

- its routes, and its reserved trigger and service routes;
- its triggers (a firing in progress finishes; no new one starts);
- its event subscriptions, search handler and inbox response handler;
- its `ctx.setInterval` and `ctx.setTimeout` timers;
- commands it started with `ctx.exec` and requests it made with `ctx.fetch`, which are killed and aborted.

After that the context refuses new registrations (`The plugin "x" is stopped`), so a task that
outlives the plugin cannot add more. `stop` is called only for a plugin whose `start` finished.
At close the plugins stop after the requests in flight finish and before the store closes.

**A hook that throws** puts the plugin in `failed` with the error (`start() failed: …`) and removes
what it had registered. That includes `stop`: the plugin is cleaned up and shown as failed. It is
still switched off if you had switched it off. Enabling a failed plugin tries it again.

**Enabling and disabling need no restart.** Routes are served by one handler that looks the plugin
up on every request, so a plugin can be stopped and started again while the gateway runs. What
cannot be done without a restart: **finding a new plugin folder**. Folders are read at start.

A plugin's own files can change while it runs: the list then shows **needs restart**, and says it
changed since you approved it. **The running plugin, its UI and its skills keep running from the copy
that was approved; an edit on disk is not served.** The new files take effect when the plugin is
turned off and on again (with enforcement on, only once you have approved them), or when you approve
them, which restarts the plugin on them.

Timers: `ctx.setInterval` and `ctx.setTimeout` never keep the process alive, log (and survive) a
callback that throws or rejects, and an interval skips a call when the last one is still running.

## Trust and approval

When a plugin is first seen, or when its declared permissions or its code differ from what you
approved, it needs approval. Two values name what you reviewed:

- **`permissionsHash`**: a SHA-256 of what the manifest declares, with every list sorted and free of
  repeats, so the same permissions in another order are the same.
- **`checksum`**: see [Checksums](#checksums-and-what-runs).

`POST /v1/plugins/:id/approve { permissionsHash, checksum }` records an approval. **Both values must
match what is on disk now.** If the plugin changed since the list you reviewed, the answer is
`409 approval_stale` and nothing is approved, so an approval cannot cover a later change. Approving
a plugin that is running other code than what is on disk restarts it on the code you approved.

What the person sees in **Settings → Plugins**: each plugin with its state; _Not approved_ or
_Changed since you approved it_ with what changed (the version, the code, and each permission as
"Can now connect to …" or "Can no longer …"); and a review dialog that puts each permission in
plain words ("Run these programs on this computer, as you."), with the hashes' first characters.

| Enforcement       | A plugin that is not approved, or changed                                                       | Anything else       |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| **Off** (default) | **Loads anyway.** The list shows it as not approved or changed. The change is in the audit log. | Nothing is blocked. |
| **On**            | **Not loaded** (`awaiting_approval`) until approved. Its code is not imported.                  | See below.          |

Turning enforcement on or off applies at once, to plugins that are running too: a running plugin
that was never approved is stopped and waits; one that was approved keeps running; turning it off
starts the ones that were waiting. The setting is `plugins.enforce` (`GET|PUT /v1/plugins/settings`),
and it is audited.

**First-party plugins that ship with OpenClerq** are approved when they are installed, by their
bundled checksum: a plugin whose id is in `BUNDLED_PLUGINS`
([`packages/gateway/src/modules/bundled-plugins.ts`](../packages/gateway/src/modules/bundled-plugins.ts))
and whose checksum is exactly the listed one is approved when it is first seen, recorded as
approved by `bundled`. **No plugin is bundled yet: the list is empty.** The examples are not bundled
and need approval like any other. The chat console, which moves onto this contract next, is the first
planned. A bundled plugin with a file changed is treated like any other.

## Enforcement and its limits

> **Plugin code runs inside the gateway process.** Enforcement covers what a plugin does **through
> its context**. Direct Node APIs (`child_process`, `fs`, `fetch`, `process`, `import`) are **not
> blocked**. Enforcement makes the declarations true for a plugin that behaves, and it catches
> mistakes. **It is not a sandbox.** Do not run a plugin you do not trust because enforcement is on.

The switch is **Settings → Plugins → Enforce plugin permissions**. It is off by default. With it
**off**, declarations are shown, recorded and audited, and nothing is blocked. With it **on**:

| Through the context                   | Checked against                                           | Refused when                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.secrets.get/set/delete`          | `permissions.secrets`                                     | the name is not declared. `list()` shows only declared names                                                                                                                                                                                                                                                                                                      |
| `ctx.services.status/start/stop`      | `permissions.services`                                    | the label is not declared there. `list()` shows only declared labels                                                                                                                                                                                                                                                                                              |
| `ctx.exec(cmd, args, opts)`           | `permissions.exec`                                        | `cmd` is not a declared string, written exactly (`echo` is not `/bin/echo`), or `opts.env` sets `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `GIT_EXEC_PATH`, `GIT_CONFIG_*`, `BASH_ENV` or `ENV`. The file is looked up once on the gateway's `PATH`. **Arguments and what the command does are not checked**                                                       |
| `ctx.store.exec`, `ctx.store.prepare` | its own tables, `mod_<id>__*` (nothing to declare)        | the statement names any other table, view, index or trigger (a core one, another module's), `sqlite_master`, creates, drops, re-indexes or changes an object that is not the plugin's own (`DROP INDEX IF EXISTS x`, `REINDEX`, `CREATE INDEX … ON <core>`), or uses `ATTACH`, `DETACH`, `PRAGMA` or `VACUUM`. This is a check of the statement's text: see below |
| `ctx.fetch(url, init)`                | `permissions.net`                                         | the host (and port, when declared with one) of the URL, or of any redirect it follows, is not declared. `http` and `https` only. Only standard `RequestInit` fields are passed on: a runtime option such as `dispatcher` is dropped                                                                                                                               |
| `ctx.fs.readFile`, `ctx.fs.writeFile` | `permissions.fs.read`, `fs.write`                         | the path, after `..` and symbolic links are resolved, is not inside a declared folder. Reading is not writing                                                                                                                                                                                                                                                     |
| a module UI's token                   | `permissions.api` (and a legacy module's `coreEndpoints`) | the endpoint is not declared. This holds whether or not enforcement is on                                                                                                                                                                                                                                                                                         |

A refusal throws `PluginPermissionError` (`code: 'plugin_permission_denied'`, with `permission` and
`subject`) and writes an audit row. With enforcement **off** the same call goes ahead and writes an
audit row of its own (`plugin.permission.undeclared`); for `ctx.store` that is a statement that
changes an object that is not the plugin's own (a read of a core table is not audited when
enforcement is off), or `ATTACH`, `DETACH`, `PRAGMA` and `VACUUM`. `ctx.exec`, `ctx.fetch` and `ctx.fs` work
the same way in both modes. A command gets a small environment (`PATH`, `HOME`, `LANG`, `TMPDIR`,
`USER`, …) and not the gateway's own, so tokens and keys do not pass to it by accident.

**What is not covered, plainly:**

- Anything a plugin does without the context: its own `child_process`, `fs`, `fetch`, `net`, `process`,
  an `import` of any module (a bare package name or an absolute path is not part of the approval). It can read `~/.clerq`,
  the vault key and the gateway token, and write the database file or the settings directly.
- **`ctx.store` is a check of statement text, not a database permission system.** The plugin runs its SQL
  through the gateway's own database handle, which can reach every table, index and trigger; the check reads
  the words of the statement and refuses one that names an object that is not the plugin's own. Every table,
  view, index and trigger in the database that is not `mod_<id>__*` counts, as does anything called
  `sqlite_*`. A name counts however it is written (bare, `"quoted"`, `[bracketed]`, `` `backticked` ``,
  any case, with `main.` in front, a comment in between). A `'string'` counts **only where SQLite reads a
  string as a name** (right after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `EXISTS`, a `.`, in a `FROM`
  list): so `UPDATE 'settings' SET …` is refused and `VALUES ('messages')` is not. A bare word that is
  a column or an alias but equals a core table's name (`memory`, `runs`, `messages`) is refused: the check
  is over-eager on purpose, and the plugin renames it. Separately, what a statement creates, drops,
  re-indexes, alters or writes must be the plugin's own whatever the name is, as in a module's migrations
  (so `DROP INDEX IF EXISTS x` and a bare `REINDEX` are refused). The check does not see inside a function the
  plugin calls itself, and `ctx.store.transaction(fn)` runs whatever `fn` does. It keeps the settings, the
  approvals, the schema and the audit log out of reach of a plugin that goes through the context; it does not
  keep them out of reach of one that does not.
- **A plugin's migrations are checked, by the same kind of reading, before they run.** A migration is raw SQL
  run by the gateway. It may not create, change or write an object that is not the plugin's own (as before),
  and, by where names stand in the text (after `FROM`, `JOIN`, `INTO`, `UPDATE`, `REFERENCES`, in a `FROM`
  list, after `main.` or `temp.`), it may not **read** one either: a view over `settings`
  (`CREATE VIEW mod_x__v AS SELECT … FROM settings`), a trigger that selects from a core table, or a copy of
  `messages` into its own table is refused, and nothing of that migration, nor of the ones before it in the
  same start, runs. A column called `memory` is not a reference. It is a text check: a form of SQL it does
  not recognise as a reference can slip past it, and a migration that already ran is not looked at again.
- `llm` and `memory`: the context offers no model call or memory helper in this release, so these
  are declared, shown, hashed into the approval, and enforced on nothing.
- What an allowed command does with its arguments or in its working directory (see `exec` above), and
  what an allowed host does with a request.
- **The list of variables a command may not be given cannot be complete.** `PATH`, `LD_*`, `DYLD_*`,
  `NODE_OPTIONS`, `GIT_EXEC_PATH`, `GIT_CONFIG_*` and the rest of the list are refused, and others that change
  what a program does are not: `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `EDITOR`, `VISUAL`, `PAGER`, and `HOME` (which
  points `git` and many programs at another `.gitconfig` or rc file) are examples. A declared command that
  reads its environment to run something is exposed to all of them. Only the gateway's own `PATH` is used to
  find a command, and a relative entry in it (`.`, `bin`) is skipped.
- DNS: a declared host that resolves to a private address is reached.
- The plugin's own routes: a plugin that sends a request to the gateway's own address with
  `ctx.fetch` needs that address declared like any host, but a request it makes some other way is not checked.
- Time of check and time of use for files: the path is resolved and checked, then opened; a link
  swapped in between is possible.
- Code the `checksum` does not cover (see below): a bare or absolute import.

These are rows in the audit log (the `audit_log` table of `~/.clerq/clerq.db`; no route reads it
yet). Each has the actor `plugin:<id>`, `gateway` or `operator`:

| Action                                                        | When                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `plugin.permission.denied`                                    | enforcement on and a call was refused. `detail`: `permission`, `subject`, `enforced: true` |
| `plugin.permission.undeclared`                                | enforcement off and a call went beyond the declaration                                     |
| `plugin.approved`                                             | an approval (`operator`, or `gateway` with `bundled: true`)                                |
| `plugin.changed`                                              | the plugin's checksum or declarations differ from the last start                           |
| `plugin.enabled`, `plugin.disabled`                           | you did it                                                                                 |
| `plugin.awaiting_approval`, `plugin.refused`, `plugin.failed` | the host put it there; `detail.reason` says why                                            |
| `plugins.enforce.changed`                                     | the switch                                                                                 |
| `module.installed`, `module.permissions.changed`              | as before: first seen, and the first six permissions changed                               |

The same refusal or undeclared use is written once a minute, with the number of repeats since in
`repeatedBefore`, so a loop cannot fill the log.

## Checksums and what runs

The `checksum` is a SHA-256 over the plugin's `manifest.json` and **every file under the folders that
are its code**, sorted by path:

- the **whole folder the server entry is in** (`dist/` for `dist/server.js`, so what the entry imports from
  its own folder is covered; an entry at the plugin's root covers only itself),
- `entry.ui`, `skills`, and `migrations/`, which run against the store.

For a legacy module the entry is `entryPoints.routes` or the default `dist/routes.js`, `dist/routes.cjs` and
`build/routes.js`, the UI is `dist/ui` and the skills `skills`. Each file counts by its path and its bytes, so
renaming, adding, removing or editing one changes it. Files the system adds on its own (`.DS_Store`,
`Thumbs.db`, `._*`) do not count. A link is followed and its target counted.

The host computes it when it loads the plugin. An author can too:

```ts
import { pluginChecksum } from '@clerq/plugin-sdk/node';
console.log(pluginChecksum('./my-plugin'));
```

**What the checksum does not cover:** files outside those folders, and code that is not in the copy: a
bare package name, which Node resolves by walking up to `~/node_modules`, and an absolute path.

**What runs is what was approved, and it runs from a copy.** The host reads each of the files that were
hashed, checks it against the hash recorded when the decision was made, and writes exactly those bytes (the
manifest as it was validated) to `~/.clerq/plugin-cache/<id>/<first 32 hex of the checksum>/` (owner only).
The server entry is imported from there, the UI is served from there, the skills are read from there, the
migrations come from there, and `ctx.dir` is there. A file that is not what was approved (edited since,
gone) means the decision is made again; an edit on disk shows as _changed since you approved it_ and takes
effect only when you approve it (with enforcement on) and the plugin is started again. With enforcement off
behaviour is as it was, except that it is served from the copy, which is refreshed when the hash changes
(when the plugin is enabled again). A new version is a new path, so a new module for both Node and Bun,
neither of which will import a changed file from the same path. Copies of other versions are removed, and a
copy that was altered is written again.

A file the checksum does not cover is not copied, so it cannot be imported from the copy. A **legacy module**
is staged the same way, so a legacy module that imports a package from its own `node_modules`, or reads a file
beside its folder by a relative path, must bundle it into its entry folder.

## Legacy modules

A module whose manifest has no `manifestVersion` is a **legacy module** (see
[MODULE_SYSTEM.md](MODULE_SYSTEM.md) §5). It loads exactly as it did, through `register` only, and
is labelled "Legacy" in the list. `@clerq/module-sdk` keeps working through 1.x.

What changes for a legacy module is only what you turn on. It appears in the same list with the same
states and approval; with enforcement off nothing is blocked; with it on, it is not loaded until
approved, and what it does through its context is checked like a plugin's. Its `permissions` are
read as before, with `api` and `memory` added; a legacy `coreEndpoints` list is read together
with `permissions.api`. Its `start`, `stop` and `upgrade` exports, if it has any, are not called.
It is run and served from a staged copy like a plugin (its entry's folder, `dist/ui`, `skills` and
`migrations` are what is hashed and copied), but `ctx.dir` stays its own folder on disk.

## Routes

All under `/v1`, for the **gateway token only** (a module's UI token, a paired phone's token and a
token of another tenant get `403`, whatever scopes they carry).

| Route                       | What                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /plugins`              | `{ plugins, enforce }`: each with `kind` (`plugin` or `legacy`), `state`, `reason`, `permissions`, `permissionsHash`, `checksum`, `approval` (`status`, `changes`, `permissionChanges`), `warnings`, `needsRestart`, `engine` |
| `POST /plugins/:id/enable`  | Turn it on. With enforcement on and no approval it waits for one.                                                                                                                                                             |
| `POST /plugins/:id/disable` | Turn it off: `stop`, then cleanup.                                                                                                                                                                                            |
| `POST /plugins/:id/approve` | `{ permissionsHash, checksum }`. `409 approval_stale` when they are not what is on disk; `409 not_approvable` for a plugin that cannot run.                                                                                   |
| `GET /plugins/settings`     | `{ enforce }`.                                                                                                                                                                                                                |
| `PUT /plugins/settings`     | `{ enforce: boolean }`.                                                                                                                                                                                                       |

`GET /modules` keeps working: it lists the modules that run or failed, with `kind` and `state` added.
A plugin that is off, waiting or refused is in `/plugins` only. The event `plugin.changed` tells the
app to reload the list.

## For a plugin UI in the app itself

A page can reach the app two ways. A plugin that ships `entry.ui` is drawn in a frame, and the frame
is given a token limited to its own routes and `permissions.api`. A UI that is part of the app's own
bundle (the Automations page, the chat console) uses the slot contract in `@clerq/plugin-sdk/ui`:
`PluginUI` has an id, rail entries, one component that draws every route under `#/m/<id>/…`,
optional palette commands, and optional `api`, the endpoints it calls. `GatewayClient`, `Host` and
`AppConfig` are defined there too, so a plugin package types its UI without importing the app. The
app's `ModuleUI`, `ModuleProps` and `ModuleContext` remain as aliases (the last is now
`PluginUIContext`, since `ModuleContext` names the server's).

## Not in this release

- Running plugins out of process, which is what would make enforcement a boundary.
- A model or memory helper on the context (so `llm` and `memory` are enforced on nothing).
- The chat console as a plugin.
- Finding a plugin folder added while the gateway runs.
