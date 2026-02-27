# About OpenClerq — Attribution & Scope

OpenClerq is the **open‑source, local model context server (MCS)** and desktop worker maintained in this repository. It is designed as a **world‑standard, safe local MCS for agentic automation**: models, tools, and context are orchestrated on your own machine; remote services are optional add‑ons, not the default.

---

## 1. Attribution

OpenClerq was inspired by [OpenClaw](https://github.com/openclaw/openclaw) (gateway, skills, local‑first pattern).

- **This repo:** Contains the **OpenClerq core** — desktop app, gateway, calculation engine, and module system.
- **License:** MIT. You run it at your own risk; there is **no warranty and no responsibility** from the authors.

See also `NOTICE` and `LICENSE` in the repo root.

---

## 2. What OpenClerq Is

- A **desktop program** that runs on Windows and macOS.
- A **local MCS**: keeps tools, skills, configuration, and recent context on your machine.
- A **generic agent host**: you decide which domains you use it for (admin, HR, ops, internal tools, etc.).
- **Deterministic numeric work** (simple engines) runs in Rust; large‑language‑model work is used only for guidance and orchestration.

You talk to OpenClerq through:

- The **desktop UI** (Tauri + React).
- The **gateway HTTP API** (for scripts and other programs).

---

## 3. How it helps clerical work

OpenClerq is designed to make routine clerical work **faster**, **more accurate**, and **more automated**, while keeping control on your machine:

- **Speed (example: recurring calculations):**  
  A clerk who re-computes adjustments (for example “add 25% to these 200 amounts”) can instead send one message (“Calculate 25% on 100 units” or use the Arithmetic panel). The Rust engine evaluates all expressions locally in milliseconds, and the agent explains the result in plain language.

- **Accuracy (example: rules captured once):**  
  Instead of copying formulas between spreadsheets, you define them once in the arithmetic engine (for example `net = gross / 1.25`, `tax = gross - net`). Every run uses the same formulas and returns an audit‑ready proof object, so repeated jobs (reports, reimbursements, simple payroll-style adjustments) stay consistent.

- **Automation (example: scheduled checks with explanations):**  
  With the desktop’s persistent run and the gateway’s `/task` endpoint, you can have OpenClerq regularly run the same instruction (for example “Check for mismatched totals in yesterday’s imports and explain any issues”). The engine does the numeric work; the agent summarizes what changed and what a clerk should review.

OpenClerq itself stays **generic**: it does not ship country‑specific or profession‑specific rules. Those live in your own skills and modules on top of this core.

---

## 4. Two Usage Models

1. **OpenClerq OSS (this repository)**
   - Runs entirely on your machine.
   - You configure API keys for any models you use.
   - You build and load your own skills and modules.
   - The maintainers provide no hosted service or guarantees; you own the risk.

2. **Commercial / hosted products (separate)**
   - Built **on top of** OpenClerq in a private repository.
   - May include role‑ or country‑specific modules, billing, and a control plane.
   - Not part of this codebase or its license.


---

## 5. Related Documents in This Repo

- `README.md` — high‑level overview, quick start, and API summary.
- `docs/DEVELOPER_SETUP.md` — how to install, run, and test OpenClerq locally.
- `docs/ARCHITECTURE.md` — components and data flow.
- `docs/MODULE_SYSTEM.md` — how modules and skills are structured.
- `docs/TOOLS.md` — generic gateway tools (filesystem, HTTP) and how to extend them.
- `docs/SAFETY_CHECKLIST.md` — prompts and checks before releasing changes.

