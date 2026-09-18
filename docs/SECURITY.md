# Security

**Status:** current as of release 0.5.0, 2026-09-18.

This document states what OpenClerq protects today, what it does **not** protect today, and
the rules that bind future work. It supersedes the previous `SAFETY_CHECKLIST.md`.

---

## 1. Threat model

OpenClerq takes natural language, hands it to a language model, and acts on the result. As
the roadmap adds shell execution, git push and a server install story, the honest description
becomes: **a program that executes model-generated instructions with local operating system
authority.**

That is a legitimate thing to build. It is not a thing to build casually.

### Assets

| Asset                             | Why an attacker wants it                                   |
| --------------------------------- | ---------------------------------------------------------- |
| Provider API keys                 | Direct financial cost; access to the user's model accounts |
| Git credentials / GitHub tokens   | Write access to source repositories                        |
| Source code and repo contents     | Exfiltration target                                        |
| The gateway's execution authority | Arbitrary code execution on the host                       |
| The secrets vault                 | Everything above, at once                                  |

### Adversaries

1. **A malicious or compromised dependency** in a repo OpenClerq operates on.
2. **Prompt injection via repo content** — a README, issue body, changelog or dependency description crafted to redirect the agent. This is the defining threat for this category: repo content is _untrusted input_, and the agent reads it by design.
3. **Prompt injection via pasted content** — the same threat through the chat console. Any text a user pastes to be summarised or explained is untrusted, and the console can create scheduled jobs. This is why a model-drafted automation always saves disabled and pushes manually on its first run.
4. **A network-local attacker** reaching an exposed gateway port.
5. **A malicious skill, module or plugin** installed by the user.
6. **A confused model** — not adversarial, simply wrong, and destructive at scale because it is on a schedule.

### Explicitly out of scope

- A local attacker who already has the user's OS account. If they can read `~/.clerq`, they have already won; no vault design changes that.
- Malicious model providers.
- Physical access.

---

## 2. What is protected today

- **The gateway is authenticated.** Every endpoint except `/health` requires a bearer token, compared in constant time. There is no development bypass. The token is generated on first run at `~/.clerq/gateway-token` (mode 0600), or supplied via `CLERQ_GATEWAY_TOKEN`.
- **The gateway binds loopback.** `127.0.0.1` unless `CLERQ_HOST` is set deliberately, which also logs a warning.
- **CORS is allow-listed.** Origins are reflected only when explicitly configured. There is no wildcard path in any mode.
- **Filesystem reads are canonically contained.** `fs.read` resolves against a `realpath`'d root and rejects traversal, prefix-sibling escapes, absolute paths, NUL bytes, and symlinks leaving the root. Reads are size-capped and refuse non-regular files.
- **Outbound HTTP is SSRF-hardened.** `http.request` is unregistered without an allowlist. When enabled it permits https only by default, refuses URL credentials, resolves DNS and rejects loopback, private, CGNAT, link-local and cloud-metadata addresses, revalidates every redirect hop, and bounds both time and response size.
- **Local state is private to its owner.** `~/.clerq` is 0700 and every file holding keys, conversations or secrets is 0600, repaired at startup on installs made before this was enforced. Transcripts and prompts are stored unencrypted inside it: the protection is the account boundary, not encryption at rest.
- **Request bodies are bounded.** JSON parsing is capped (default 1 MiB).
- **No write tools ship.** There is no `fs.write` and no `exec` tool. The current blast radius is bounded by that absence, not by a policy engine.
- **Secrets are encrypted at rest.** AES-256-GCM with per-entry IV and auth tag. Values are never returned by the listing endpoint; `GET /secrets` returns names only.
- **Vault access is audited.** Set and delete operations append to `~/.clerq/secrets.audit.log`.
- **API keys are not bundled or logged.** The desktop app does not ship keys and does not send them anywhere except the local gateway.
- **Numeric results are deterministic.** Calculations run in the Rust engine and return a `proof` object. The model never produces final numbers.
- **Runs are durable and accountable.** Every task and trigger firing writes a run record with its request, its steps, and the tokens and cost of each model call. A model with no known price records an unknown cost rather than zero.
- **Approvals fail closed.** An approval nobody answers within the timeout is refused, never granted.
- **The kill switch stops everything in flight.** `POST /kill` refuses pending approvals, cancels every running run mid-call, and pauses triggers until `POST /resume`. A run whose client hangs up is cancelled too, so nothing is spent on an answer nobody will read.
- **Responses are bounded.** A model response is capped (8 MiB by default, `CLERQ_MAX_RESPONSE_BYTES`): a streamed answer is cut off and marked truncated, a buffered one is refused.
- **The vault master key lives in the OS keychain.** Generated on first use and stored through the platform's own tool — `security` on macOS, libsecret on Linux, DPAPI on Windows — never in an environment variable. `CLERQ_VAULT_KEY` still works for containers that inject it, and warns that it is the weakest option. A host with no keychain falls back to `~/.clerq/vault.key` at mode 0600, and says so.
- **Sandboxed processes have no network by default,** and an egress allowlist is enforced at the boundary rather than inside the agent's own HTTP tool. See the limits below.

---

## 3. What is NOT protected today

These are live gaps, tracked as findings in [ROADMAP.md §2](ROADMAP.md#2-consolidated-audit).
They are listed here because a security document that omits them is worse than none.

| Gap                                        | Detail                                                                                                                                                                                                                                                                                                                                                                                                 | Roadmap |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **Config files are last-write-wins**       | `capabilities.json` and `config.json` are still read-modify-write with no locking. Memory, runs and triggers now live in SQLite.                                                                                                                                                                                                                                                                       | 0.6     |
| **No context management**                  | Tool output is capped per call, but nothing bounds total prompt assembly yet.                                                                                                                                                                                                                                                                                                                          | 0.6     |
| **Egress filtering is coarse on macOS**    | A host allowlist is enforced by a local proxy the sandbox forces traffic through, but SBPL can only filter by port, so a command that connects to an outside host on the proxy's own port is not stopped — and a client ignoring the proxy variables reaches nothing. Per-host enforcement needs a container on an internal network. Any profile that cannot enforce an allowlist refuses it outright. | 0.6     |
| **A hang-up goes unseen under Bun**        | The desktop sidecar is compiled with Bun, whose HTTP layer signals nothing when a client disconnects after sending its request. A model call there runs to completion unless it is cancelled by id (`POST /runs/:id/cancel`, the console's Stop button) or by the kill switch. Under Node the hang-up itself cancels it.                                                                               | 0.6     |
| **The Windows key path is untested**       | The DPAPI backend is implemented and falls back to the key file on any failure, but no Windows runner exercises it. macOS and the file fallback are covered by tests.                                                                                                                                                                                                                                  | 0.6     |
| **The sandbox is not wired to a tool yet** | `packages/sandbox` exists and is tested, but no `exec` tool ships, so nothing calls it in production. The container profile's arguments are unit-tested; container execution itself is untested.                                                                                                                                                                                                       | 0.6     |
| **DNS rebinding**                          | `http.request` resolves and checks addresses, but the connection re-resolves, leaving a TOCTOU window. Closing it needs a pinned-address dispatcher.                                                                                                                                                                                                                                                   | 0.5     |
| **Desktop CSP is disabled**                | `tauri.conf.json` sets `security.csp: null`.                                                                                                                                                                                                                                                                                                                                                           | 1.0     |
| **Updater public key is a placeholder**    | Signature verification cannot succeed, so updates fail closed — broken rather than exploitable, but it must be fixed before any release advertises in-app updates.                                                                                                                                                                                                                                     | 1.0     |

Release 0.4 closed the four S1 blockers (unauthenticated gateway, all-interface bind,
prefix-based path containment, licensing standing in for authentication) plus the SSRF and
CORS findings. The gateway is still intended for loopback use: remote exposure is a 1.0
feature and needs TLS and a reverse proxy in front of it.

**Treat the gateway token as a credential.** Anyone holding it can run tools on your machine.

---

## 4. Binding rules

These are not aspirations. A change that violates one of them does not merge.

1. **Localhost by default.** Network binding requires an explicit flag _and_ configured authentication. Never both defaults.
2. **No unauthenticated path, ever** — including in development. Generate a token on first run and hand it to the desktop app. `/health` is the only public endpoint, and it reveals no configuration.
3. **Authentication and licensing are separate concepts.** Licensing answers _is this install entitled to feature X_. Authentication answers _is this caller allowed to control this gateway_. Neither may substitute for the other.
4. **Sandbox by default wherever code executes.** A `native` profile is a developer convenience that must be chosen deliberately and shown as a warning in the UI. Application-layer allowlists are not a sandbox.
5. **Deny egress by default.** An automation reaches only the hosts its spec names, enforced at the sandbox boundary rather than in application code. This is the primary defence against a prompt-injected agent exfiltrating a repository.
6. **Repo content is untrusted input.** A README, issue or changelog can carry instructions aimed at the agent. Repo content may never widen a capability grant, and must be labelled as data in every prompt that carries it.
7. **Secrets never enter model context.** Injected into the sandbox as environment variables, redacted from logs, step traces, run artifacts and anything sent upstream.
8. **Push is not merge.** Draft pull requests by default. Auto-merge is opt-in per automation and conditional on gates passing.
9. **Every run is auditable.** Which model, which prompt, which commands, which files, what it cost, who approved it — retained, queryable and exportable.

Plus one operational requirement: **a kill switch** that stops every automation and revokes
every lease, reachable from desktop, web and CLI.

---

## 5. Capability configuration

Tool authority is configured in `~/.clerq/capabilities.json` and applied at gateway start
and on hot reload:

```json
{
  "fsRoot": "/absolute/path/you/choose",
  "fsMaxReadBytes": 1048576,
  "httpAllowlist": ["api.example.com"],
  "httpAllowedSchemes": ["https:"],
  "httpMaxBytes": 262144,
  "httpTimeoutMs": 10000,
  "httpAllowPrivateAddresses": false
}
```

| Key                         | Meaning                                                                                                                                | Default                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `fsRoot`                    | Root directory for `fs.read`                                                                                                           | the gateway's working directory |
| `fsMaxReadBytes`            | Largest file `fs.read` returns                                                                                                         | 1048576                         |
| `httpAllowlist`             | Hostnames `http.request` may reach. `*.example.com` matches subdomains but not the apex. Empty means the tool is not registered at all | _(empty)_                       |
| `httpAllowedSchemes`        | Permitted URL schemes                                                                                                                  | `["https:"]`                    |
| `httpMaxBytes`              | Response body retained before truncation                                                                                               | 262144                          |
| `httpTimeoutMs`             | Whole-request timeout                                                                                                                  | 10000                           |
| `httpAllowPrivateAddresses` | Permit loopback, private and link-local destinations                                                                                   | `false`                         |

Set the narrowest values that let your skills work. Do not point `fsRoot` at your home
directory, and turn on `httpAllowPrivateAddresses` only when you are deliberately targeting a
service on your own network — it disables the check that stops a redirected request reaching
your router or a cloud metadata endpoint.

> `fsAllowWrite` was removed in 0.4. It had been declared, parsed and stored since 0.1 while
> being read by no tool, so it implied a write capability that never existed.

---

## 6. Release checklist

Run before tagging any release.

### Secrets and keys

- [ ] No API keys in the frontend bundle, in logs, or in `config.json`
- [ ] Vault master key sourced from the OS keychain, not from the environment
- [ ] `GET /secrets` returns names only, never values
- [ ] Secret scan passes over the working tree and git history

### Gateway

- [ ] Binds `127.0.0.1` unless remote mode is explicitly configured
- [ ] All endpoints except `/health` require a bearer token
- [ ] No `CLERQ_DEV` code path disables authentication
- [ ] CORS restricted to known origins; no `*`
- [ ] Rate limits and body size limits on webhook endpoints

### Tools and execution

- [ ] Path validation uses `realpath` + `path.relative`, with tests for traversal, symlink and prefix-sibling cases
- [ ] `http.request` validates every redirect hop and blocks private, loopback, link-local and metadata addresses
- [ ] Every executing tool runs inside a sandbox profile; `native` emits a visible warning
- [ ] Tool output is truncated before entering model context

### Desktop and updates

- [ ] Restrictive CSP set; `null` is not shipped
- [ ] Real updater public key configured; artifacts signed; a test update verifies end to end
- [ ] Installer disclaimer and About screen state actual permissions — see [INSTALLER_DISCLAIMER.md](INSTALLER_DISCLAIMER.md)

### CI

- [ ] Typecheck, lint, Vitest, `cargo test` all pass and are required
- [ ] `pnpm audit` and `cargo audit` clean or triaged with written justification
- [ ] Build succeeds on every target platform

---

## 7. Reporting a vulnerability

Report security issues privately through GitHub's security advisory flow on
[paxamedia/OpenClerq](https://github.com/paxamedia/OpenClerq/security/advisories), not as a
public issue.

OpenClerq is MIT-licensed software provided without warranty. There is no service-level
commitment on response times, and no bounty programme. Reports are nonetheless welcome and
will be credited unless you ask otherwise.
