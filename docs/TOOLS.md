# Tools in OpenClerq OSS

This document describes the **generic tools** that the OpenClerq gateway exposes to skills and modules. Tools are **role‑agnostic**: they are not tied to any specific profession or country.

---

## 1. What is a tool?

A **tool** is a function the gateway can call that:

- Has a **structured input** (JSON),
- Performs some work (e.g. read a file, call HTTP, run a local binary),
- Returns a **structured output**.

Tools are registered on the gateway and can be invoked:

- Directly over HTTP (`GET /tools`, `POST /tools/run`),
- Indirectly from skills and `/task`.

---

## 2. Built‑in tools

OpenClerq OSS ships a small, safe default set:

### 2.1 `fs.read`

- Reads a **UTF‑8 text file** from a configured root directory.
- Input:

```json
{
  "relativePath": "path/inside/root/example.txt"
}
```

- Output:

```json
{
  "path": "/absolute/path/to/path/inside/root/example.txt",
  "content": "file contents as UTF-8 string"
}
```

- Output also includes `bytes`, the file size on disk.
- Safety — the path is resolved against a `realpath`'d root (`capabilities.fsRoot`) and refused if any of the following hold:
  - it traverses out of the root (`../../etc/passwd`);
  - it lands in a sibling directory that merely shares a prefix (`/srv/repo-secrets` against a root of `/srv/repo` — this passed the pre-0.4 check);
  - it is absolute, drive-qualified, or UNC;
  - it contains a NUL byte;
  - it passes through a symlink whose target leaves the root;
  - it is not a regular file, or exceeds `capabilities.fsMaxReadBytes` (default 1 MiB), checked by `stat` before any read.

### 2.2 `http.request`

- Makes an HTTP(S) request to a **configured allow‑list** of hostnames.
- Disabled by default; enabled only when `toolsConfig.httpAllowlist` is set.
- Input:

```json
{
  "method": "GET",
  "url": "https://example.com/api",
  "headers": {
    "Accept": "application/json"
  },
  "body": "optional request body as string"
}
```

- Output:

```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json; charset=utf-8"
  },
  "bodyText": "{\"ok\":true}"
}
```

Output also includes `truncated` (true when the body hit `httpMaxBytes`) and `chain`, every
URL visited including redirect hops.

Use this to call **your own APIs or services**, never arbitrary third‑party hosts.

Requests are refused when:

- the scheme is not in `httpAllowedSchemes` (default: https only);
- the host is not in `httpAllowlist` (`*.example.com` matches subdomains, not the apex);
- the URL carries credentials (`https://user:pass@host/`);
- the host resolves to a loopback, private, CGNAT, link-local, multicast or reserved address — including the cloud metadata endpoints `169.254.169.254` and `fd00:ec2::254`, and IPv4-mapped forms like `::ffff:127.0.0.1`. Override with `httpAllowPrivateAddresses` only when deliberately targeting your own network;
- the method is outside the allowed set (default: GET, HEAD, POST);
- a redirect hop fails any of the above — **every hop is revalidated**, not just the first;
- more than `maxRedirects` hops (default 3) are needed;
- the request exceeds `httpTimeoutMs` (default 10s).

Bodies over `httpMaxBytes` (default 256 KiB) are truncated rather than buffered whole.

> **Residual risk.** Addresses are checked after DNS resolution, but the connection resolves
> again, leaving a narrow DNS-rebinding window. Closing it needs a pinned-address dispatcher,
> tracked for release 0.5.

---

## 3. HTTP endpoints

The gateway exposes tools over HTTP:

- `GET /tools` — returns the list of registered tools:

```json
{
  "tools": [
    { "name": "fs.read", "description": "Read a UTF-8 file from a safe root" },
    { "name": "http.request", "description": "HTTP(S) request to an allow-listed host" }
  ]
}
```

- `POST /tools/run` — runs a specific tool:

```json
{
  "name": "fs.read",
  "input": { "relativePath": "README.md" }
}
```

Response:

```json
{
  "name": "fs.read",
  "result": {
    "path": "...",
    "content": "..."
  }
}
```

---

## 4. Extending tools

You can add your own tools by:

1. Implementing a function in the gateway that accepts `input: unknown` and returns a `Promise<unknown>`.
2. Registering it in the tool registry alongside `fs.read` and `http.request`.
3. Documenting the input/output shape so skills can call it safely.

Always:

- Restrict what the tool can access (paths, hosts, commands).
- Keep the interface small and auditable.
- Treat tools as **powerful local capabilities**: they are what makes OpenClerq an effective local MCS.

---

## 5. Agent tools (builtin driver)

The `builtin` agent driver (see [ARCHITECTURE.md](ARCHITECTURE.md#agent-drivers)) gives the model
its own tool set for repository work. These are separate from the gateway tools above: they act
only in the automation run's worktree and are not reachable over HTTP. The model sees the name in
the second column; policy rules, run steps, `tool_calls` rows and `agent.allowed_tools` use the
first.

| Policy name      | Model sees     | Risk      | Does                                                                                       |
| ---------------- | -------------- | --------- | ------------------------------------------------------------------------------------------ |
| `fs.read`        | `read_file`    | `read`    | A text file with line numbers, 400 lines at a time; `offset` and `limit` page through it   |
| `fs.list`        | `list_files`   | `read`    | A directory, up to four levels deep, without `.git`; at most 1,000 entries                 |
| `fs.search`      | `search_files` | `read`    | `git grep -E` over tracked and untracked files, skipping ignored ones                      |
| `fs.write`       | `write_file`   | `write`   | Creates or replaces a file, with its directories                                           |
| `fs.edit`        | `edit_file`    | `write`   | Replaces exact text, once unless `replace_all`                                             |
| `runtime.shell`  | `run_shell`    | `execute` | `/bin/sh -c` in the worktree; 120 s by default, up to 30 min; exit code, stdout and stderr |
| `git.status`     | `git_status`   | `read`    | `git status --short --branch`                                                              |
| `git.diff`       | `git_diff`     | `read`    | `git diff HEAD`, for one path or as a `--stat` summary                                     |
| `sessions.spawn` | `spawn_agent`  | `write`   | Starts a sub-agent on a task and returns its final answer; see below                       |

- Every path is resolved inside the worktree by the same check as `fs.read` above: no absolute
  paths, no `..` out of it, no symlink that leads outside, including one whose target does not
  exist yet. Files are written without following a link at the last step, and a new file is
  created exclusively.
- Commands get the sandbox's minimal environment (`PATH`, `HOME`, the user and locale), without the
  gateway token or the model's API key. Under full access a command runs as the gateway's user and
  can read what that user can; inputs and outputs are redacted of the vault values the run uses
  before they are stored or returned to the model. Anything a command leaves running in its process group is stopped when it exits.
- `read_file` pages by whole lines, up to 30,000 characters, and says which offset to read on from.
- A result longer than 30,000 characters keeps its start and end, with a marker in the middle
  saying how much was cut and how to get the rest (read with `offset`, narrow the search).
- A `run_shell` command that publishes (`git push`, `gh pr create|merge`, `gh release create`,
  `gh repo create`) is judged as `git.push` (risk `external`) and waits for approval.

### 5.1 Sub-agents (`sessions.spawn`)

An automation run's builtin agent can start sub-agents when its spec turns them on: `spawn_agent`
with a `task` (everything the sub-agent needs; it does not see the conversation), optionally
`tools` (policy names or rules) and `model` (`provider/model`). The result is the sub-agent's final
answer and a line on what it did (its run id, tool calls, turns, cost).

They are off by default. A spec turns them on with

```yaml
agent:
  driver: builtin
  subagents:
    enabled: true
    max_concurrent: 2 # optional, 1 to 4, default 4
    models: [openai/gpt-5-mini] # optional, models a spawn call may name besides the spec's own
```

or by naming `sessions.spawn` itself in `agent.allowed_tools`; `*`, `risk:write` or
`group:sessions` there does not turn them on. With `enabled: true` and an `allowed_tools` list,
the list must name `sessions.spawn` too. Only the builtin driver takes the key.

- **Its own run.** Each sub-agent is a run (trigger `subagent`, `parentRunId` set) with a session
  holding its task and answer, recorded like any builtin run: steps, `tool_calls`, cost. It is
  listed in `GET /runs`; `GET /runs/:id` of the parent lists its `children` and `childCostUsd`.
  Its run events (`run.*`, `model.*`, `tool.*`, `approval.requested`) carry `parentRunId`.
- **Narrower policy, never wider.** Its rules are the parent's cut down to what the call asks for,
  tool by tool the stricter of the two; without `tools` it gets the read-only tools. A tool the
  parent may not use, or may use only with approval, stays refused or waits for approval. It is
  never given `sessions.spawn`: sub-agents are one level deep, enforced in code (its run gets no
  way to spawn and its policy denies the tool), not by the prompt. It reads at most the memory types the parent's spec reads, matched
  to its own task.
- **Four at once.** Several `spawn_agent` calls in one reply run at the same time, at most four per
  parent run (or `max_concurrent`); one more waits until one ends. Each call's result is recorded
  when that sub-agent ends; the model gets them all, in call order, once all have. Other tool calls
  run one at a time, as before.
- **Same worktree.** Sub-agents work in the parent's worktree. Writes need both the parent's
  policy and the call to allow them; sub-agents writing at the same time can overwrite each
  other's changes (nothing locks a file), so the tool tells the model to give them separate files.
  The parent's commit includes whatever they changed.
- **Shared budget.** What is left of the run's `budget.max_usd_per_run` (with only
  `max_usd_per_month`, what is left of the month) is shared by the parent and its sub-agents:
  before each model call an agent checks its own spend, the others' spend, what calls in flight
  hold (each call holds the most it may cost) and the call's own maximum. A call the provider
  refused with an error status counts as free; one cut off (cancelled, timed out, connection lost)
  keeps what it held, since nobody reports its cost. Sub-agents' cost also counts toward the run's
  cost across attempts and the automation's month.
- **Stops with the parent.** Cancelling the parent, its time limit, or the kill switch cancels its
  sub-agents (they end as cancelled). A sub-agent's own time limit is set 5 seconds past the
  parent's, only as a backstop: the parent's deadline is what stops it.
- **Approvals.** A call that needs approval waits in the same inbox, on the sub-agent's run and
  naming the parent (`parentRunId`). The parent shows `awaiting_approval` while any approval of
  its own or of a sub-agent is undecided, and goes back to `executing` when none is.
- **Model.** A sub-agent may be given by name only a model of the spec's own chain (`primary`,
  `fallback`, `escalate`), a model a person chose for the run, or one in `agent.subagents.models`;
  any other is refused as a failed tool call, before a run starts, so a steered agent cannot send
  the repository to a provider the spec does not name. A named model is used as named, with no
  fallback, and the call fails if it cannot be used now (no key, no price under a budget). One that names none uses the model the parent is on and may fall back along
  the parent's remaining chain.
- In `default` permission mode starting a sub-agent waits for approval, as a write does; `plan` and
  `dontAsk` cannot start one.
- Only the builtin driver. The `claude-code`, `codex` and `cursor-agent` CLIs have sub-agent features
  of their own, which run inside the CLI: OpenClerq does not see them as runs and its policy does
  not apply to them; the CLI's own settings and the run's budget (where the CLI takes one) do.
