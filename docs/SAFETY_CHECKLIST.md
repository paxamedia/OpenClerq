# Safety checklist

Use this before release and for security-sensitive changes.

## Secrets and API keys

- **No API keys in the frontend bundle.** The desktop app does not ship or log API keys. The gateway reads them from `.env` or `~/.clerq/.env` at startup.
- **No API keys in config.json.** User settings (`~/.clerq/config.json`) store gateway URL, jurisdiction, module paths — not API keys.
- **API key save:** When the user saves an API key in the desktop, it is written to `~/.clerq/.env`; the gateway loads it at startup. The key is not sent over the network by the desktop (the desktop talks to the local gateway; the gateway calls the configured LLM — **API (cloud)** or **local** (Ollama, LM Studio)).

## Gateway

- **License check:** When `CLERQ_DEV=0`, requests require a valid `CLERQ_LICENSE` header; otherwise 403.
- **CORS:** In non-dev mode, `CLERQ_CORS_ORIGINS` must be set for browser origins; otherwise no CORS header (server-to-server only).

## Audit and calculations

- **Deterministic math:** All numeric results (for example percentage-based adjustments, payroll-style calculations, depreciation) are computed by the Rust engine only. No AI is used for numeric results.
- **Proof objects:** Calculation responses include a `proof` object for audit.

## Installer and packaging

- **Bundle description:** `tauri.conf.json` `longDescription` and `shortDescription` include the “use at your own risk” disclaimer and a short summary of what the app is allowed to do (local config, optional API key, module paths, network only if user configures API).
- **In-app:** About modal shows full “Warnings and disclaimer” and “Access and permissions” so users see what access the app has before and after install.
- **Doc:** [INSTALLER_DISCLAIMER](INSTALLER_DISCLAIMER.md) — full text for install flow and distribution.

## References

- [ERROR_RESPONSE_SHAPE](ERROR_RESPONSE_SHAPE.md) — Error response format (no PII)
- [DEVELOPER_SETUP](DEVELOPER_SETUP.md) — Env vars and local data
- [INSTALLER_DISCLAIMER](INSTALLER_DISCLAIMER.md) — Permissions and disclaimer for installers
