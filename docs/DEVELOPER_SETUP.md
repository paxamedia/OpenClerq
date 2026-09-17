# Developer setup — run OpenClerq locally

This guide shows how to **install and run the OSS OpenClerq core** on your own machine (macOS or Windows), and how to hit the basic HTTP endpoints.

---

## 1. Prerequisites

- Node.js ≥ 24
- `pnpm`
- Rust (for the desktop shell and calculation engine)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
- An API key for your chosen LLM (e.g. Anthropic) if you want `/explain` and `/task` to work

---

## 2. Install dependencies

From the repo root (where `OpenClerq/package.json` lives), run:

```bash
cd OpenClerq
pnpm install
```

This installs all workspace packages, including the gateway, desktop app, and calculation core.

---

## 3. Environment and dev mode

Create a local `.env` file next to the gateway:

```bash
cp .env.example .env
```

Edit `.env` and set:

- your LLM provider (see `.env.example`). No token setup is needed — the gateway generates one on first run.
- **LLM provider** (pick one; `GET /health` reports which is active, `GET /providers` lists them all):
  - **Cloud:** `CLERQ_LLM_PROVIDER` set to `anthropic` (the default), `openai`, `deepseek`, `moonshot`, `zai` or `minimax`, plus that vendor's key, e.g. `DEEPSEEK_API_KEY`.
  - **Local (Ollama):** `CLERQ_LLM_PROVIDER=ollama`, `CLERQ_MODEL=llama3.2` — runs on your machine, no API key. Run `ollama run llama3.2` first.
  - **Local (LM Studio):** `CLERQ_LLM_PROVIDER=lmstudio`, `CLERQ_MODEL=<loaded model>` — runs on your machine.
  - **Any other OpenAI-compatible server:** `CLERQ_LLM_PROVIDER=openai`, `CLERQ_LLM_BASE_URL=http://localhost:8000/v1`.

You can also override:

- `CLERQ_PORT` (default `18790`)
- `CLERQ_SKILLS_DIR` (where skills are loaded from)
- `CLERQ_CALC_PATH` (path to `clerq-calc` if you build it elsewhere)

---

## 4. Build the gateway and calculation engine

```bash
pnpm build:gateway
pnpm build:core
```

This compiles:

- The **gateway** TypeScript into `packages/gateway/dist`.
- The **Rust calculation engine** (`clerq-calc`) into `packages/calculation-core/target/release/clerq-calc`.

---

## 5. Run the gateway

In one terminal:

```bash
cd OpenClerq
pnpm gateway
```

You should see something like:

```text
[Clerq] Gateway running on http://127.0.0.1:18790
```

---

## 6. Run the desktop app (macOS and Windows)

In a **second terminal**:

```bash
cd OpenClerq
pnpm desktop
```

This builds and launches the Tauri desktop shell (Control Tower UI), which talks to `http://127.0.0.1:18790` by default. The desktop offers Builder/Operator mode, skills schema editing, file-backed memory, context preview, dry-run for tasks, and observability metrics.

After you have a built desktop bundle, you can also use the launcher scripts:

- **macOS:** double‑click `OpenClerq/scripts/Start-Clerq-Mac.command`
- **Windows:** double‑click `OpenClerq\\scripts\\Start-Clerq-Win.bat`

These scripts start the gateway and then open the desktop app, so a non‑developer can just “download and run”.

---

## 7. Verify locally (optional but recommended)

With the gateway running, from the repo root:

```bash
cd OpenClerq
./scripts/verify-local.sh
```

This script checks:

- `GET /health`
- `GET /skills`
- Example numeric calculation endpoint
- `POST /task` (if your API key is configured)

You should see `Verification passed. Gateway is up and responding.` at the end.

---

## 8. Basic HTTP API (for scripts)

With the gateway running on `http://127.0.0.1:18790`.

Every endpoint except `/health` needs the bearer token the gateway wrote on first start:

```bash
export CLERQ_TOKEN=$(cat ~/.clerq/gateway-token)
```

```bash
curl http://127.0.0.1:18790/health                                   # public
curl -H "Authorization: Bearer $CLERQ_TOKEN" http://127.0.0.1:18790/skills
```

Without the header you get `401 {"error":"unauthorized"}`.

To call the arithmetic engine:

```bash
curl -X POST http://127.0.0.1:18790/calculate/eval \
  -H "Authorization: Bearer $CLERQ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expression":"a * 1.25","inputs":{"a":100}}'
```

To call the agent:

```bash
curl -X POST http://127.0.0.1:18790/task \
  -H "Authorization: Bearer $CLERQ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Calculate 25% on 100 units"}'
```

Dry-run (no LLM call):

```bash
curl -X POST http://127.0.0.1:18790/task \
  -H "Authorization: Bearer $CLERQ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Calculate 25% on 100","dryRun":true}'
```

Context preview (see what would be sent to the LLM):

```bash
curl -X POST http://127.0.0.1:18790/context/preview \
  -H "Authorization: Bearer $CLERQ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is VAT?"}'
```

Memory (list, add, delete):

```bash
curl -H "Authorization: Bearer $CLERQ_TOKEN" http://127.0.0.1:18790/memory
curl -X POST http://127.0.0.1:18790/memory \
  -H "Authorization: Bearer $CLERQ_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"test","value":{"note":"sample"}}'
```

These endpoints are meant as **examples**; you can add your own tools, skills, and calculation operations on top.
