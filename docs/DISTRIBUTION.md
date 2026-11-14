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

## Server and command line (Linux and macOS)

`clerq-server` (the gateway as a headless daemon), `clerq` (the command line) and `clerq-calc`
(the calculation engine) are compiled by `scripts/build-binary.js`, one target at a time, and
packed by `scripts/package-server.js` into one tarball per platform:

```bash
cargo build --release --manifest-path packages/calculation-core/Cargo.toml     # clerq-calc; add --target <triple> for another CPU
node scripts/package-server.js --target linux-x64        # linux-x64, linux-arm64, darwin-arm64 or darwin-x64
node apps/server/scripts/smoke.mjs apps/server/dist/bun-linux-x64/clerq-server
apps/server/scripts/test-install.sh dist/server/openclerq-server-*-linux-x64.tar.gz
```

`package-server.js` prints the tarball's path and its SHA-256. The programs stay in
`apps/server/dist/<bun target>/` and `apps/cli/dist/<bun target>/`. Running the server is covered
in [SERVER.md](SERVER.md) and the command line in [CLI.md](CLI.md).

### Release files

Besides the desktop installers and `latest.json`, a release holds:

| File                                             | What it is                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `openclerq-server-<version>-linux-x64.tar.gz`    | `clerq-server`, `clerq`, `clerq-calc`, `LICENSE`, `NOTICE`, the two systemd units under `systemd/` and `README.txt`, in one top folder |
| `openclerq-server-<version>-linux-arm64.tar.gz`  | the same for arm64                                                                                                                     |
| `openclerq-server-<version>-darwin-arm64.tar.gz` | the same for Apple Silicon                                                                                                             |
| `openclerq-server-<version>-darwin-x64.tar.gz`   | the same for Intel Macs                                                                                                                |
| `SHA256SUMS`                                     | the SHA-256 of the four tarballs and of `install.sh`, one `<hash>  <file>` line each, in `sha256sum` format                            |
| `install.sh`                                     | the installer, `curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh \| sh`                           |

The Linux binaries are for glibc systems (the musl targets compile but have never run). They are
built on Ubuntu runners; no older distribution has been tried. The files are **not signed or
notarized**: `SHA256SUMS` shows a download is the one that was released, not who released it
(the Tauri updater key above is for the desktop app's update check, not these files). `curl` and
the installer do not mark a download as quarantined on macOS; a browser does, and Gatekeeper then
refuses an unsigned program until `xattr -d com.apple.quarantine <file>`.

The tarball is made to be reproducible as far as is cheap: `package-server.js` writes the archive
itself (not the machine's `tar`, whose flavour differs between macOS and Linux), sorts the entries,
gives every one owner `root:root` (ids 0) and the commit's time (`SOURCE_DATE_EPOCH`, else
`git log -1 --format=%ct`) as its mtime, and writes a gzip header with no file name or time (what
`gzip -n` leaves out). Two builds of the same commit on the same machine, with the same Node, give
the same bytes in the archive; the compressed stream comes from the zlib of the Node that runs the
script, so a different Node build can compress differently. Whether the three compiled programs are
byte-identical between two builds was checked for linux-x64 only (T9a) and is not enforced.

### The container image

`ghcr.io/paxamedia/openclerq`, for `linux/amd64` and `linux/arm64`, from
`apps/server/Dockerfile` (build context: the repository root, trimmed by `.dockerignore`):

- Tags: `<version>` (for example `1.0.0`), `<major>` (`1`) and `latest`. A pre-release tag
  (`v1.0.0-rc.1`) publishes only `<version>`.
- Labels: `org.opencontainers.image.source` (this repository), `version`, `revision`, `licenses`
  (`MIT`), `title`, `description`, `documentation`. The multi-architecture index carries the first
  four as annotations.
- Each architecture is built on a native runner (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for
  arm64), so nothing is emulated. Before it is pushed, the image is loaded and
  `apps/server/scripts/test-image.sh` runs against it. It is then pushed by digest, and a last job
  joins the two digests into one image under the tags.
- The binaries inside are compiled by the same `build-binary.js` the tarballs use, in the Dockerfile's
  own stages (Rust for the engine, Node and Bun for the programs).

**GHCR visibility is a manual step.** The first push of a package to `ghcr.io` may create it as
**private**, whatever the repository's visibility is, and a private package cannot be pulled
without logging in. The workflow does not change that and nothing in this repository can. After the
first release that pushes the image, the owner of the `paxamedia` account (or organization) opens
the package (GitHub, the account's **Packages**, `openclerq`, **Package settings**) and sets its
visibility to **Public** once; later releases keep the setting. Check it from a machine that is not
signed in to GitHub: `docker logout ghcr.io; docker pull ghcr.io/paxamedia/openclerq:latest`.

### What runs when

- **On every push to `main` and every pull request** (`ci.yml`): `server-linux` packages the
  tarball on x64 and arm64 Ubuntu, runs `smoke.mjs`, runs `test-install.sh` (a fake release folder
  served on 127.0.0.1: the checksum, a tampered tarball, the installed programs talking to each
  other, `sudo` and `--system`) and has `systemd-analyze` read both units; `docker` builds the image
  on an amd64 and an arm64 runner without pushing and runs `test-image.sh`.
- **On a `v*` tag** (`release.yml`):

  ```text
  version ─┬─ release (macOS, Windows installers) ── publish (the GitHub Release, latest.json)
           ├─ server (4 tarballs, in parallel) ──────────────┴─ publish-server (tarballs, SHA256SUMS,
           │                                                     install.sh added to that release)
           └─ docker (one image per CPU) ── docker-manifest (ghcr.io/paxamedia/openclerq)
  ```

  The server and image jobs do not feed `publish`: the desktop release does not wait for them, and
  a failure in them does not undo it. `publish-server` runs only when the desktop release and all
  four tarballs succeeded; if one fails, fix the cause and use **Re-run failed jobs**. Until
  `publish-server` has run, `releases/latest/download/install.sh` is a 404 and the installer says the
  server files may not be uploaded yet. Server tarballs are uploaded as `server-<target>` artifacts,
  deliberately not `*-build`, which is what `publish` collects.

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
reports an error. In parallel it builds the server tarballs and the container image, then adds the
tarballs, `SHA256SUMS` and `install.sh` to the release and pushes the image (see
[the server and image](#server-and-command-line-linux-and-macos)).

**Check after the tag**, because none of this can be seen before it runs: the release lists the four
server tarballs, `SHA256SUMS` and `install.sh` as well as the desktop files; `sha256sum --check
SHA256SUMS` passes on them; `docker pull ghcr.io/paxamedia/openclerq:<version>` works from a
machine that is not signed in to GitHub (make the package public first, as above), and `:1` and
`:latest` point at the same image; and `curl -fsSL
https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh` installs into an
empty home folder and starts.

An update can only be tested across two releases: install one, publish the next, then use
"Check for updates" in the About screen.
