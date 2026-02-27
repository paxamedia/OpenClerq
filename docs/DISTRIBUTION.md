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

## CI environment

GitHub Actions sets `CI=true` by default. On macOS, this triggers `--skip-jenkins` in the DMG bundler (headless mode). For local builds where `CI` is set (e.g. by an IDE), you can unset it:

```bash
CI= TAURI_CI=false pnpm build:installers
```

Or use `pnpm run build:installers:local` (sets `UNSET_CI=1`).

---

## Tauri updater (in-app updates)

The app includes an updater that checks GitHub Releases for new versions. To enable it:

1. **Generate signing keys** (run once):
   ```bash
   cd apps/desktop && pnpm exec tauri signer generate -w ../../.tauri/clerq.key
   ```
2. **Add the public key** to `tauri.conf.json` → `plugins.updater.pubkey` (replace `PLACEHOLDER_REPLACE_WITH_TAURI_SIGNER_PUBKEY`).
3. **Store the private key** securely. For CI: add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as secrets.
4. **Build with signing**: set `TAURI_SIGNING_PRIVATE_KEY` when running `tauri build`. The release workflow generates `latest.json` when `TAURI_SIGNING_PRIVATE_KEY` is set.

Without valid keys, the "Check for updates" button will show an error. The app runs normally.
