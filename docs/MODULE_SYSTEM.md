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
guardrails: []              # High‑level safety rules; see SAFETY_CHECKLIST

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

1. The gateway loads the list of skills (metadata only).
2. It runs a simple matcher that:
   - Checks `triggers` against the message text.
   - Optionally boosts a skill if its jurisdiction matches the request.
3. If a suitable skill is found, the agent uses that skill’s instructions; otherwise it falls back to a generic explain path.

You can test this behaviour by:

- Adding `triggers` to your skill frontmatter.
- Calling `/task` with messages that include those keywords.

---

## 5. Safety expectations

Modules and skills must respect the **safety guarantees** of the OSS core:

- Deterministic numeric work is delegated to the Rust engine.
- Tools should be **scoped** (filesystem roots, HTTP allow‑lists, etc.).
- Skills should describe any constraints, required approvals, and audit notes.

See `docs/SAFETY_CHECKLIST.md` for a short checklist before you ship or share a module.

