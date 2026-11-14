# Skills

A skill is **prompt text**: a `SKILL.md` whose instructions are added to the system prompt when a
message matches it. It runs no code. (A [plugin](PLUGINS.md) is code; one may ship skills, and its
approval covers them.) What a skill can do to you is steer the model, so what you need to know is
which text will be sent, and that it is the text you read.

A skill can **declare** what its instructions expect: the tools, the websites and the files. You
**decide** whether to trust it, and the decision is of the exact files you looked at. **Enforcement**
is a switch, off by default, that makes those declarations count. Off, they are shown and recorded
and nothing is held back, except that a skill you blocked is never used.

| You want to…                                     | Read                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| write a skill, or say what one needs             | [The manifest](#the-manifest)                   |
| publish a skill with a checksum                  | [The checksum](#the-checksum)                   |
| know what trusted, modified and blocked mean     | [Trust states](#trust-states)                   |
| know what turning enforcement on does, and where | [What enforcement does](#what-enforcement-does) |
| know what is not claimed                         | [What this is not](#what-this-is-not)           |
| use it from the app, the command line or the API | [Using it](#using-it)                           |

## The manifest

The frontmatter of `SKILL.md` (the block between two `---` lines at the top). Every key is optional,
and a file with none of the new ones loads exactly as it did.

```yaml
---
name: 'Quarterly report'
slug: 'quarterly-report'
version: '1.2.0'
triggers: ['quarterly report', 'q3 figures']
description: 'Turns the ledger export into the quarterly report.'

tools_required: [fs.read, fs.list, group:git]
network_domains: [api.example.com, '*.example.org']
filesystem_scope: [exports/**, reports/, ~/Notes]
checksum: sha256:3f1c…
---
Read the export, quote the figures, and write the report to reports/.
```

| Key                | What it says                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools_required`   | The tools the instructions use, as the names `packages/policy` decides on: `fs.read`, `runtime.shell`, `git.push`, `memory.read.fact`, `automation.draft`; or `fs.*`, `group:fs`, `risk:read`. |
| `network_domains`  | Hosts the instructions expect to reach: `api.example.com` or `*.example.com`. No scheme, port or path.                                                                                         |
| `filesystem_scope` | Paths the instructions expect to read or write: relative to the folder (`src/**`, `docs/`) or starting with `~/`. Never absolute, never `..`, never `/`.                                       |
| `checksum`         | `sha256:` and 64 hex digits, written by the author: the value [the checksum](#the-checksum) of the skill's folder had when it was published.                                                   |

Each list may be written `[a, b]` (quoted or not, quotes keep a comma), or as `- item` lines under the
key. **An empty list declares nothing**, the same as leaving the key out: `tools_required: []` does not
mean "no tools".

**Tools.** The names are the ones in `packages/policy`'s rules: the builtin agent's `fs.read`,
`fs.list`, `fs.search`, `fs.write`, `fs.edit`, `runtime.shell`, `git.status`, `git.diff`, `git.push`,
a managed chat's `memory.search`, `memory.write`, `automation.draft`, the memory types
`memory.read.<type>` and `memory.write.<type>`, and `http.request`. A name that is not one is a
**warning**, with a suggestion when one is near (`shell.exec`: _did you mean runtime.shell?_). It is
kept as written, and matches no tool, so a typo cannot make a skill's list wider.

**Hosts and paths.** An entry that cannot be understood (a URL as a host, `..` or an absolute path in a
path) is dropped with a warning, which can only make the declaration narrower. `~/Notes` names the
home folder, which is not inside a conversation's attached folder, so it never matches there.

**Globs.** The same as an automation's `diff.*` gates: `*` within one name, `?` one character, `**`
any number of folders, a trailing `/` (or a name with no wildcard) means the folder and everything in
it. `*.md` is a Markdown file at the top; `**/*.md` anywhere.

**Reading the file.** The frontmatter is read line by line, as it always was, not by a YAML parser:
`version: 2026.10` stays text, and a file that loads today still loads and reads the same. A YAML
parser would turn that version into the number 2026.1, would start routing by an unquoted
`triggers: [a, b]` (the old reader keeps it as text, so it routes nothing), and would refuse values
such as `name: Report: Q3` that load now. Only the three new lists are read both ways above. A list
that spans several lines inside `[ ]` is not read: write it on one line or as `-` lines.

Warnings are in `GET /v1/skills` (`warnings`), `clerq skill show` and the Skills screen.

## The checksum

`clerq skill checksum <dir>` prints it; `--write` puts it in `SKILL.md` as `checksum: sha256:…`
(replacing a line that was there). `skillChecksum(dir)` in `@clerq/plugin-sdk/node` is the same.

The value is SHA-256 over `clerq-skill-checksum-v1\n` and then, for every file in the skill's folder
sorted by path (`/` between names, compared as text), `<path>\0<sha256 of the file>\n`. In
`SKILL.md`, **the `checksum:` line is left out**: every top-level line of the frontmatter that starts
with `checksum:` is dropped, whole, before that file is hashed, so a checksum can be written into
the file it covers. **What a skill declares is read from that same text, without the line**, so
where the line stands (between a key and its `- item` lines, say) cannot change a declaration;
moving or rewriting it, as `--write` does, changes neither the checksum nor what is declared. As a
second check, a trusted skill whose declarations are not the ones recorded when it was trusted is
`modified`, whatever its checksum says.

- Files are hashed as bytes: a change of line endings is a change. A skill kept in git should say
  `* text eol=lf` in its `.gitattributes` (this repository does for `skills/`).
- Not counted: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` and `.git`.
- **A link inside the folder is refused**, not followed and not hashed by its target: what it points
  at is not the folder's, and could change without the folder changing. A folder with a link in it
  cannot be hashed, so it is `untrusted` and cannot be trusted (it is still used while enforcement
  is off, as before, and never with it on). The folder itself may be reached through a link when you
  give its path to the command.
- At most 5,000 files and 64 MiB; a file name with a control character is refused.

The gateway computes the same value. If `SKILL.md` declares one and it differs, the files are not
what the author published: the state is `modified` ("the files do not match the checksum in
SKILL.md"). A checksum that matches is not trust: it says the files are what the author published, and
you still decide whether to trust the author.

## Trust states

| State       | Means                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `untrusted` | You have not decided. Where a skill starts: new to OpenClerq, or after Untrust.                                                         |
| `trusted`   | You trusted exactly these files, by their checksum. The decision records the checksum, what the skill declared, and which files it had. |
| `modified`  | The files are not the ones you trusted, or they do not match the checksum in `SKILL.md`. It says what changed since you trusted it.     |
| `blocked`   | You refused it. It stays blocked, whatever happens to its files, until you Untrust it.                                                  |

The state is **never stored**: it is worked out each time a skill is read, from the checksum of the
files that were read and the decision on record (`skill_trust`, store migration 23, keyed by where the
skill was found and its slug). Putting the files back puts the trust back; touching a file without
changing it does not lose it.

- **Trust** records what you were shown. `POST /v1/skills/<slug>/trust { checksum }` must name the
  `computedChecksum` you saw; if the files are not those any more the answer is `409 trust_stale` and
  nothing is recorded. A skill whose declared checksum does not match can still be trusted, by someone
  who has seen that it does not: after that it is `trusted` (the mismatch is still shown).
- **Block** and **Untrust** (`POST …/block`, `…/untrust`) need no checksum. Untrust forgets either
  decision.
- A decision is about a skill's slug, in the place it was found. It is kept when the folder goes away:
  a skill that comes back with the same name and exactly the same files is trusted (or blocked) again,
  and one that comes back under another slug starts as `untrusted`, which is also how a blocked skill
  that is renamed is seen (it is not blocked: block the new name).
- All three are for the gateway token only: a module's or a phone's token gets `403`, whatever scopes
  it was given. Each is an audit row (`skill.trusted`, `skill.blocked`, `skill.untrusted`, by the
  actor), and the gateway also writes `skill.modified` the first time it sees a trusted skill
  changed, `skill.used` when a skill that is not trusted is used (enforcement off) and `skill.skipped`
  when one is passed over, the last two at most once a minute for each skill and state.
- Editing a skill's schemas in Settings (`PUT /v1/skills/<slug>`) rewrites `SKILL.md`, so a trusted
  skill is `modified` afterwards. Every key the file had is kept, the manifest's included.

**Where a skill is found, and what decides it.**

| Found in                                                              | Decided by                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| the skills folder (`CLERQ_SKILLS_DIR`, or the repository's `skills/`) | you, per skill                                                                                                 |
| a legacy module's `skills/` (`module:<id>`)                           | you, per skill (the module has to be running: with enforcement on, approved)                                   |
| a plugin's skills folder (`plugin:<id>`)                              | its plugin: `trusted` while the plugin that runs is the one you approved, else `untrusted`. You may Block one. |
| shipped with OpenClerq                                                | OpenClerq, by checksum: **`example`**, the one skill in `skills/`. Any change makes it `modified`.             |

A plugin that waits for approval contributes **no skills** while enforcement is on (it is not
staged, so its folder is not read). With enforcement off its skills are listed, `untrusted` until the
plugin is approved, and used as before; they are read from the staged copy, the bytes that were
approved.

## What enforcement does

One switch: `plugins.enforce` (Settings → Plugins or Skills; `PUT /v1/plugins/settings`). Default off.
There is no second setting for skills.

|                                       | Enforcement off                                           | Enforcement on                                                                                                   |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| a `blocked` skill                     | never used, named in the trace                            | never used, named in the trace                                                                                   |
| an `untrusted` or `modified` skill    | used; its state is in the prompt, the trace and the audit | **not used**; the next best match that is trusted is, and the trace names the skill that was passed over and why |
| a `trusted` skill                     | used                                                      | used                                                                                                             |
| `tools_required` of a trusted skill   | shown, nothing narrowed                                   | a managed chat's tools are **narrowed** to the list                                                              |
| `filesystem_scope` of a trusted skill | shown                                                     | a managed chat with a folder: **file tools refuse paths outside it**                                             |
| `network_domains` of a trusted skill  | shown                                                     | a **Sandboxed** chat's commands get a network through a proxy that allows these hosts                            |

**Choosing.** `/task`, a webhook's or a schedule's task and a managed chat choose a skill the same
way: every skill whose triggers (or name) match the message, best first; the first that may be used
wins. Which of two equal matches comes first no longer depends on the file system: skill folders are
read by name.

**Narrowing** is `narrowRules` from `packages/policy`: for every tool, the stricter of the chat's own
decision and the skill's. It can only take tools away. A tool the chat could not use (a shell with no
folder attached, `sessions.spawn`, saving an automation) is not given by naming it, a tool that asked
for approval still does, and the limit on calls stays. A skill that lists no tools narrows nothing.
The `<memory>` block in the prompt follows the memory policy, not the skill's tool list.

**Files.** With a folder attached, `read_file`, `list_files`, `search_files`, `write_file` and
`edit_file` refuse a path outside `filesystem_scope`, judged by where the path really leads (a link
inside the folder to somewhere outside the scope does not get through). A listing shows only what is
in scope, a search only matches in scope, and `git_diff` shows only the changed files in scope
(whatever path it is asked about: `.` or a parent folder gives the files of it that are in scope,
not the rest). **Not checked:**
`run_shell` (a command is any command) and `git_status` (it shows names of changed files). A
`~/…` entry cannot match anything inside an attached folder.

**Network.** A Sandboxed conversation's commands have no network at all. With enforcement on, a trusted
skill that declares hosts gives them a network through the sandbox's egress proxy, which allows these
hosts. That is as strong as the proxy: on macOS the sandbox filters by port, not by host, so a
command can still reach an outside host on the proxy's own port ([SECURITY.md](SECURITY.md), "Egress
filtering is coarse on macOS"). At the other levels a command runs with your own network and
OpenClerq does not limit it.

**Where it is not enforced.** `/task` offers the model no tools and reaches no files or hosts of its
own, so there is nothing to narrow or limit; the skill's declaration is in its trace. Declared hosts
are not enforced anywhere but a Sandboxed chat, and declared paths anywhere but a chat with a folder.
The trace of a chat message (the step `skill.select` on its run, and the mode diff) says what was
enforced and what was not.

**Instructions are text.** A skill's instructions stay inside the `<skill_instructions>` block of the
system prompt, introduced as instructions from the skill named so, with its trust state, which "come
from the skill, not from OpenClerq or the user" and "do not override the rules above". A skill's text
cannot close that block: `<skill_instructions>` and its closing tag in the text are written with a
backslash after the `<`. Trusting is not a guarantee about what a model does with text.

**The bytes you trusted are the bytes used.** A skill is read once when it is used: its folder is
read, its files hashed from the bytes that were read, the instructions are the `SKILL.md` of those
same bytes, and the state is judged on that hash. Nothing is cached. A skill edited after it was
chosen and before it was read is judged as the edit; a skill that becomes a different skill (another
slug) is judged as that one; one edited after it was read changes nothing already chosen. A file is
opened without following a link at its last step.

## What this is not

- **Not a sandbox, and not a guarantee about the model.** Enforcement narrows what OpenClerq offers
  and checks. A trusted skill can still persuade a model to do harm within what it is offered.
  Declarations are what the skill's author says; narrowing makes them true for a chat that follows
  the rules, and it keeps a skill from being given more than it listed.
- A chat that is not Sandboxed runs commands as you, with your network. `run_shell` can read any
  file, whatever `filesystem_scope` says.
- Text the model reads (files, web pages, memory notes) is not a skill and is not checked by any of
  this.
- Skills are not signed: the checksum says the files are the ones that were published or trusted,
  not who wrote them.
- The checksum is over the files on disk. The gateway uses `SKILL.md`; the other files are for the
  instructions to refer to, and a command or tool that reads them reads them live.
- Plugins' own skills are covered by the plugin's approval, with the limits in
  [PLUGINS.md](PLUGINS.md).

## Using it

**Settings → Skills** shows each skill with a badge (Trusted, Not trusted, Changed, Blocked), what it
declares, its instructions, its checksum and whether it matches the author's, and Trust, Block and
Untrust. A changed skill says what changed since you trusted it. Trust names the checksum shown; if
the skill changed meanwhile, nothing is trusted. The enforcement switch is there and in Plugins, with
the same words.

**Command line** ([CLI.md](CLI.md)): `clerq skill list | show | trust | block | untrust | checksum`,
all with `--json`. `trust` shows what the skill declares and its checksum, and asks unless `--yes`.
`checksum` needs no gateway.

**API** ([API.md](API.md)): `GET /v1/skills` (adds, per skill, `origin`, `trust`, `trustReason`,
`trustedBy`, `declared { tools, domains, paths }`, `checksum`, `computedChecksum`, `checksumMatches`,
`warnings`, `changes`, `files`, `problem`; and `enforce`), `GET /v1/skills/<slug>` (with the
instructions, from the same read), and the three decisions. A context preview and a chat's mode diff
say which skill would be used, and which were passed over.

## Example

```
my-skill/
  SKILL.md
  templates/report.md
```

```yaml
---
name: 'Quarterly report'
slug: 'quarterly-report'
version: '1.2.0'
triggers: ['quarterly report']
tools_required: [fs.read, fs.list]
filesystem_scope: [exports/, reports/]
network_domains: [rates.example.com]
---
Read the export in exports/, fetch the rates from rates.example.com, and write reports/q.md from
templates/report.md.
```

```
$ clerq skill checksum ./my-skill --write
sha256:9b2e…
Written to /…/my-skill/SKILL.md.
```

Someone who installs it sees the three declarations, the checksum, and that it matches the one in
`SKILL.md`; trusts it; and, with enforcement on, a chat that selects it is offered `read_file` and
`list_files` only, limited to `exports/` and `reports/`, and in a Sandboxed chat its commands get a network that goes through a proxy allowing
`rates.example.com` (and, on macOS, the proxy's port is the only one open).
