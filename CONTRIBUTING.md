# Contributing to Clerq

Thank you for your interest in Clerq. This document explains how to get set up, run the project locally, and submit changes.

## Prerequisites

- **Node.js** ≥ 22
- **pnpm**
- **Rust** (for the calculation engine and desktop app)
- **Tauri prerequisites** for your OS: [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

## Clone and install

```bash
git clone <repository-url>
cd clerq
pnpm install
```

## Environment

```bash
cp .env.example .env
```

Edit `.env`:

- Set an **LLM provider**: **API (cloud)** via `ANTHROPIC_API_KEY`, or **local** via `CLERQ_LLM_PROVIDER=ollama` (see `.env.example`).
- Keep **`CLERQ_DEV=1`** for local development (no subscription).

## Build and run locally

1. **Build the gateway:** `pnpm build:gateway`
2. **Build the Rust engine (optional, for calculations):** `pnpm build:core`
3. **Start the gateway:** `CLERQ_DEV=1 pnpm gateway` (leave running)
4. **Start the desktop:** In a second terminal, `pnpm desktop`

Full steps and troubleshooting: **[Developer setup](docs/DEVELOPER_SETUP.md)**.

## Running a quick verification (E2E-style)

With the gateway running, you can verify endpoints:

```bash
./scripts/verify-local.sh
```

This checks: GET /health, GET /skills, POST /calculate/eval, POST /filing/prep, POST /task (task requires ANTHROPIC_API_KEY). Numeric calc and task are skipped if the Rust engine or API key is missing.

Or manually: `curl http://127.0.0.1:18790/health` and `curl http://127.0.0.1:18790/skills`.

## Running tests

```bash
pnpm --filter @clerq/gateway test   # Gateway unit tests (skill selector, etc.)
pnpm test:rust                      # Rust calculation-core tests (cargo test)
```

Full project build: `pnpm build`. We do not require tests for the first OSS release; manual verification is the bar.

## Submitting changes

1. **Fork** the repository (or work in a branch if you have write access).
2. **Make your changes** in a branch. Keep the scope focused.
3. **Ensure** the gateway and desktop still run and the local flow works (see [Developer setup](docs/DEVELOPER_SETUP.md)).
4. **Commit** with clear messages. We do not enforce a strict format; descriptive is enough.
5. **Open a pull request** against the default branch. Describe what you changed and why.
6. **Respond** to any review feedback.

We do not require a test suite for the first OSS release; manual local verification is the bar. If you add tests, they are welcome.

## Code and docs

- **Gateway:** TypeScript/Node in `packages/gateway/`.
- **Desktop:** Tauri v2 + React in `apps/desktop/`.
- **Rust engine:** `packages/calculation-core/`.
- **Skills:** Markdown with YAML frontmatter in `skills/`; see [Module system](docs/MODULE_SYSTEM.md) and [Developer setup – Developing your own module](docs/DEVELOPER_SETUP.md#9-developing-your-own-module-skill).

No formal code style guide yet; match the existing style in the file you edit.

## References

- [Developer setup](docs/DEVELOPER_SETUP.md) — Run locally, API summary, add skills
- [About Clerq](docs/ABOUT_CLERQ.md) — Attribution, OSS vs hosted
- [Safety checklist](docs/SAFETY_CHECKLIST.md) — Secrets, API keys, audit
- [NOTICE](NOTICE) — Attribution and license

## License

By contributing, you agree that your contributions will be licensed under the same terms as the project (MIT). See [LICENSE](LICENSE).
