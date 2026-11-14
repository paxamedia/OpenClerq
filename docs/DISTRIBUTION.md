# Distribution — Code Signing & Notarization

OpenClerq desktop app installers are unsigned by default. For public distribution, configure macOS code signing and notarization.

## macOS

### Prerequisites

- [Apple Developer](https://developer.apple.com/) account (paid, for distribution outside App Store)
- **Developer ID Application** certificate (not "Apple Distribution" — that's for App Store)
- App-specific password from [appleid.apple.com](https://appleid.apple.com) for notarization

### Local signing

1. Create and install the certificate (see [Apple’s CSR guide](https://developer.apple.com/help/account/create-certificates/create-a-certificate-signing-request)).
2. Find your signing identity:
   ```bash
   security find-identity -v -p codesigning
   ```
   Example: `Developer ID Application: Your Name (TEAMID)`
3. Build with identity:
   ```bash
   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" pnpm build:installers
   ```
   Or set `bundle.macOS.signingIdentity` in `apps/desktop/src-tauri/tauri.conf.json`.

### Notarization

After signing, submit the app/DMG for notarization. Set:

- `APPLE_ID` — Apple ID email
- `APPLE_PASSWORD` — App-specific password (or keychain profile name with `xcrun notarytool store-credentials`)

Tauri will notarize when these are set. For custom DMG notarization, use the keychain profile:

```bash
xcrun notarytool store-credentials "notary-profile" --apple-id "you@example.com" --team-id "TEAMID" --password "app-specific-password"
APPLE_SIGNING_IDENTITY="Developer ID Application: ..." NOTARIZE_PROFILE=notary-profile pnpm build:installers
```

(Tauri’s DMG bundler accepts `--notarize`; check Tauri 2 docs for exact env vars.)

### Ad-hoc signing (Apple Silicon)

For local testing without a Developer ID:

```json
"signingIdentity": "-"
```

This produces an ad-hoc signed app. It will not pass Gatekeeper on other machines.

---

## Windows

For Windows code signing, configure `bundle.windows.certificateThumbprint` and optionally `signCommand` in `tauri.conf.json`. See [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows).

---

## Server (Linux and macOS)

`clerq-server`, the gateway as a headless daemon, is compiled with Bun by `scripts/build-binary.js`,
one target at a time, into `apps/server/dist/<target>/` (with `clerq-calc` beside it when one is
built for that target):

```bash
cargo build --release --manifest-path packages/calculation-core/Cargo.toml
node scripts/build-binary.js --entry apps/server/src/main.ts --name clerq-server \
  --target bun-linux-x64 --require-calc
node apps/server/scripts/smoke.mjs apps/server/dist/bun-linux-x64/clerq-server
```

CI builds the `linux-x64` binary on every push and runs the smoke script and
`systemd-analyze verify` on the two units in `apps/server/systemd/`. The binaries are not signed,
and release archives, checksums and a container image are not published yet. Running it is covered
in [SERVER.md](SERVER.md).

The `clerq` command line is compiled the same way, with no `clerq-calc`, into `apps/cli/dist/<target>/`:

```bash
node scripts/build-binary.js --entry apps/cli/src/main.ts --name clerq --no-calc --target bun-linux-x64
```

It is not built in CI, signed or published yet; see [CLI.md](CLI.md).

---

## CI environment

GitHub Actions sets `CI=true` by default. On macOS, this triggers `--skip-jenkins` in the DMG bundler (headless mode). For local builds where `CI` is set (e.g. by an IDE), you can unset it:

```bash
CI= TAURI_CI=false pnpm build:installers
```

Or use `pnpm run build:installers:local` (sets `UNSET_CI=1`).

---

## Tauri updater (in-app updates)

The app checks `releases/latest/download/latest.json` on GitHub and installs an update only if
its signature verifies against the public key built into the app.

1. **Generate the key pair** once, outside the repository, and choose a password:
   ```bash
   pnpm --dir apps/desktop exec tauri signer generate -w ~/.tauri/clerq-updater.key
   ```
2. **Put the public key** (`~/.tauri/clerq-updater.key.pub`) in `tauri.conf.json` → `plugins.updater.pubkey`.
3. **Add two Actions secrets:** `TAURI_SIGNING_PRIVATE_KEY` (the contents of the `.key` file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. **Back up the private key and its password.** Lose either and installed apps can never update again; they only trust the key they shipped with.

## Releasing

1. `node scripts/sync-version.js X.Y.Z` and move `[Unreleased]` in `CHANGELOG.md` under a new heading.
2. Commit, then tag and push: `git tag -a vX.Y.Z -m "OpenClerq X.Y.Z"` and `git push origin main vX.Y.Z`.

`release.yml` refuses a tag that does not match the version, builds macOS (Apple Silicon) and
Windows, stages each platform's files with the architecture in their names
(`scripts/stage-release-files.js`), writes `latest.json` from the signed bundles
(`scripts/generate-updater-manifest.js`) and publishes the GitHub Release. Without the signing
secrets the installers still publish, but no `latest.json` is written and "Check for updates"
reports an error.

An update can only be tested across two releases: install one, publish the next, then use
"Check for updates" in the About screen.
