# Distribution — Code Signing & Notarization

OpenClerq desktop app installers are unsigned by default. For public distribution, configure macOS code signing and notarization.

There are two kinds of signature, and they are not the same thing. The **updater key** (below) signs
the update bundles and `SHA256SUMS`, so an installed app and the installer can tell a file the project
made; it is the project's own and is set up. **Code signing** (Apple, Windows) is what makes macOS
Gatekeeper and Windows SmartScreen stop warning; it needs a certificate the project does not hold.
[RELEASING.md](RELEASING.md) says exactly what is signed with what, how to check a download, how the
key is kept, rotated and recovered, and the release checklist.

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

## Linux

The release has the desktop app for Linux on x64 and arm64, in three forms, each built on Ubuntu 22.04
(`ubuntu-22.04` and `ubuntu-22.04-arm` in the workflows):

| File                                                                  | For                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Clerq_<version>_amd64.deb`, `Clerq_<version>_arm64.deb`              | Debian, Ubuntu and their relatives: `sudo apt install ./Clerq_1.0.0_amd64.deb`      |
| `Clerq-<version>-1.x86_64.rpm`, `Clerq-<version>-1.aarch64.rpm`       | Fedora, RHEL and relatives, openSUSE: `sudo dnf install ./Clerq-1.0.0-1.x86_64.rpm` |
| `Clerq_<version>_x86_64.AppImage`, `Clerq_<version>_aarch64.AppImage` | any other glibc distribution, and anywhere you do not want to install a package     |

Pick the package your distribution installs, else the AppImage. Each leaves the same app: the window,
the gateway and the calculation engine (`clerq-gateway` and `clerq-calc`, next to the program), and
the bundled chat plugin. Your data is in `~/.clerq`, as everywhere.

**The AppImage** is one file that needs no installation:

```bash
chmod +x Clerq_1.0.0_x86_64.AppImage       # a downloaded file is not executable
./Clerq_1.0.0_x86_64.AppImage
```

An AppImage needs FUSE 2 to start. Where it is missing (`dlopen(): error loading libfuse.so.2`; Ubuntu
22.04 and later do not install it) add it (`sudo apt install libfuse2`; on Ubuntu 24.04 the package is
`libfuse2t64`), or run it unpacked: `./Clerq_*.AppImage --appimage-extract-and-run`.

**What it needs.** The `.deb` and `.rpm` use the system's **WebKitGTK 4.1** (`libwebkit2gtk-4.1`) and
GTK 3, which Tauri lists as their dependencies, so the package manager pulls them in; a distribution
that does not have WebKitGTK 4.1 cannot install them. An AppImage brings its own copy of most
libraries, so it depends less on the distribution; it still uses the system's glibc and graphics
drivers. All three are built on Ubuntu 22.04 (glibc 2.35), so a distribution with an older glibc will
not run them. That is reasoning from how they are built, not a list of distributions anyone has
tried: CI builds the packages on every push and looks inside them (`build.yml`, `build-linux`), but
they have not been run on a range of Linux desktops.

**In-app updates work for the AppImage only.** The updater replaces the AppImage file with the new
one, after checking its signature. A `.deb` or `.rpm` is installed by your package manager. Tauri signs
both (the release has their `.sig`), but `latest.json` does not offer them, so "Check for updates"
reports an error that none of the platforms it looked for are listed: download the new package and
install it over the old one. That is a choice, not a limit: the updater would install them by
running `dpkg -i` or `rpm -U` as root, through a polkit, `zenity`, `kdialog` or `sudo` prompt, a path
nobody has run, and a stolen update key would then be root on those machines
([RELEASING.md](RELEASING.md#the-deb-and-rpm-are-signed-and-not-offered-as-updates)). `latest.json` lists `linux-x86_64-appimage` and `linux-aarch64-appimage` and
deliberately not the plain `linux-<cpu>` key: the updater would offer a `.deb` or `.rpm` install an
AppImage it cannot install over a package.

**Building it.** On Ubuntu or Debian (Tauri v2's prerequisites): `sudo apt install libwebkit2gtk-4.1-dev
build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`,
then Rust, Node 24 and pnpm, and `pnpm run build:installers`. `bundle.targets` is `all`, so Tauri writes
the three forms into `apps/desktop/src-tauri/target/release/bundle/{deb,rpm,appimage}/`. The AppImage
step downloads its tools (linuxdeploy) from GitHub, so it needs network access. The gateway sidecar is
Bun's baseline x64 build (see below), so the app runs on a CPU without AVX2. Fedora and others have
their own package names for the same libraries.

The arm64 build uses GitHub's `ubuntu-22.04-arm` runner, which GitHub lists as generally available.
If that label is ever retired, `ubuntu-24.04-arm` is the replacement; it links a newer glibc (2.39), so
the arm64 packages would then run on fewer distributions than the x64 ones.

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

The x64 targets are compiled for Bun's **baseline** build (`bun-linux-x64-baseline`,
`bun-darwin-x64-baseline`, so `apps/server/dist/bun-linux-x64-baseline/`), not the default one. The
default x64 build needs AVX2 and ends with SIGILL on a CPU without it: a `kvm64` virtual machine, an
older Xeon, a Mac from before Haswell. The tarball is still named `linux-x64` / `darwin-x64`, and
the container image's amd64 build is baseline too. arm64 has one build. The desktop app's gateway
sidecar (`scripts/build-sidecars.js`) is baseline for x64 on an Intel Mac and on Linux. Windows still uses Bun's default x64 build, so a Windows PC
without AVX2 cannot run the desktop app's gateway.

On a Mac, `CLERQ_TEST_PRETEND_LINUX=1 apps/server/scripts/test-install.sh <darwin tarball>` runs
the installer test's Linux branches too (the tarball is renamed as a Linux one and a `uname` that
says Linux goes first on the `PATH`); run it under `dash` as well as `sh`. It checks the shell
logic, not GNU tools.

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
| `SHA256SUMS.minisig`                             | its signature, by the updater key, in the minisign format: `minisign -Vm SHA256SUMS -P <key>` ([RELEASING.md](RELEASING.md))           |
| `install.sh`                                     | the installer, `curl -fsSL https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh \| sh`                           |

The Linux binaries are for glibc systems (the musl targets compile but have never run). They are
built on Ubuntu runners; no older distribution has been tried. The programs are **not code-signed or
notarized**. `SHA256SUMS` is signed with the updater key (`SHA256SUMS.minisig`), so a download that
matches it is the one the project released: `install.sh` checks that when `minisign` is installed and
otherwise says it checked integrity only, and [RELEASING.md](RELEASING.md) shows the command for doing
it by hand. `curl` and the installer do not mark a download as quarantined on macOS; a browser does,
and Gatekeeper then refuses an unsigned program until `xattr -d com.apple.quarantine <file>`.

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
  served on 127.0.0.1: the checksum and its signature with the real `minisign`, a tampered tarball,
  the installed programs talking to each other, `sudo` and `--system`) and has `systemd-analyze` read
  both units; `docker` builds the image on an amd64 and an arm64 runner without pushing and runs
  `test-image.sh`; `verify` also runs the desktop CSP check (`scripts/check-csp.mjs`, see
  [SECURITY.md](SECURITY.md)).
- **On every push to `main`, every pull request** (`build.yml`): the desktop app, unsigned, for macOS,
  Windows and Linux (`build-linux` on x64 and arm64, which also stages the release files from the real
  bundle folders and looks inside the `.deb` and the AppImage for the sidecars and the bundled plugin).
  On a **push to `main` only**, `updater-key` signs a file with the repository's signing secrets and
  checks it against the public key in `tauri.conf.json` ([RELEASING.md](RELEASING.md)).
- **On a `v*` tag** (`release.yml`):

  ```text
  version ─┬─ release (macOS, Windows, Linux x64 + arm64) ── publish (checks every signature, then the
           │                                         │   │      GitHub Release, latest.json)
           ├─ server (4 tarballs, in parallel) ──────┤   └─ publish-server (tarballs, install.sh,
           │                                         │         SHA256SUMS and its signature added
           │                                         │         to that release)
           └─ docker (one image per CPU) ────────────┴─ docker-manifest (ghcr.io/paxamedia/openclerq)
  ```

  The server and image jobs do not feed `publish`: the desktop release does not wait for them, and
  a failure in them does not undo it. `publish-server` runs only when the desktop release and all
  four tarballs succeeded; if one fails, fix the cause and use **Re-run failed jobs**.
  `docker-manifest` needs `publish` too, so the `<version>`, `<major>` and `latest` tags move only
  once the GitHub Release exists (the image jobs before it push untagged digests, which nobody
  can pull by name). Until
  `publish-server` has run, `releases/latest/download/install.sh` is a 404 and the installer says the
  server files may not be uploaded yet. Server tarballs are uploaded as `server-<target>` artifacts,
  deliberately not `*-build`, which is what `publish` collects.

- **A tag with a `-` in it** (`v1.0.0-rc.1`) is published as a **pre-release**: `publish` and
  `publish-server` set `prerelease` when the tag contains one, as `docker-manifest` already skips the
  `<major>` and `latest` tags for it. GitHub never serves a pre-release as `/releases/latest`, so
  neither `releases/latest/download/install.sh` nor the desktop updater's address
  `releases/latest/download/latest.json` finds it: installed apps are not offered the rc and stay on
  the last stable release (the rc's `latest.json` is on its own release, reachable by its tag's
  address, for a tester who points an app there), and the installer installs the last stable one
  unless `CLERQ_VERSION=1.0.0-rc.1` names it. Before this was set, `publish` left `prerelease` off,
  so an rc tag became "latest" and would have been offered to every installed app.

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
4. **Back up the private key and its password.** Lose either and installed apps can never update again; they only trust the key they shipped with. [RELEASING.md](RELEASING.md) has where the key lives, the key check that runs on `main`, how to rotate the key without stranding installs, and what to do when it is lost.

## Releasing

1. `node scripts/sync-version.js X.Y.Z` and move `[Unreleased]` in `CHANGELOG.md` under a new heading.
2. Commit, then tag and push: `git tag -a vX.Y.Z -m "OpenClerq X.Y.Z"` and `git push origin main vX.Y.Z`.

`release.yml` refuses a tag that does not match the version, builds macOS (Apple Silicon), Windows and
Linux (x64 and arm64), stages each platform's files with the architecture in their names
(`scripts/stage-release-files.js`), checks that every updater bundle has a signature and that every
signature verifies against the public key in `tauri.conf.json` (`scripts/verify-signatures.js`), writes
`latest.json` from the signed bundles (`scripts/generate-updater-manifest.js`) and publishes the GitHub
Release. A release whose signatures do not verify is not made: it would offer an update that every
installed app refuses. The check also fails a release built without the signing secrets, which used to
publish installers and no `latest.json`. In parallel it builds the server tarballs and the container
image, then adds the tarballs, `install.sh`, `SHA256SUMS` and `SHA256SUMS.minisig` to the release and
pushes the image (see [the server and image](#server-and-command-line-linux-and-macos)).

**Check after the tag**, because none of this can be seen before it runs: the release lists the four
server tarballs, `SHA256SUMS`, its signature and `install.sh` as well as the desktop files;
`minisign -Vm SHA256SUMS -P <key>` and `sha256sum --check
SHA256SUMS` pass on them ([RELEASING.md](RELEASING.md) has the full list); `docker pull ghcr.io/paxamedia/openclerq:<version>` works from a
machine that is not signed in to GitHub (make the package public first, as above), and `:1` and
`:latest` point at the same image; and `curl -fsSL
https://github.com/paxamedia/OpenClerq/releases/latest/download/install.sh | sh` installs into an
empty home folder and starts.

An update can only be tested across two releases: install one, publish the next, then use
"Check for updates" in the About screen.
