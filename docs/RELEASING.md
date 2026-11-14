# Releasing OpenClerq

How a release is made, what is signed and with what, how to check a download, and what to do when
the signing key changes or is lost. [DISTRIBUTION.md](DISTRIBUTION.md) says what each platform
gets; this page is about the key and the checklist.

## The signing key

One Ed25519 key, in the [minisign](https://jedisct1.github.io/minisign/) format that Tauri uses,
signs two things:

- the **desktop updater bundles**, so that an installed app installs only an update the project
  made (the app has the public half built in);
- **`SHA256SUMS`** of the server files, as `SHA256SUMS.minisig`.

Its public half, which is `plugins.updater.pubkey` in
[`tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json) (there as Tauri keeps it, base64 of
the two-line file below) and `MINISIGN_KEY` in [`install.sh`](../apps/server/install.sh):

```text
untrusted comment: minisign public key: 1194F44CA26B94C5
RWTFlGuiTPSUETaZWif94VNcMaFH/nl43EDHam+1QGY7Vje8nOqAdMRG
```

`node scripts/verify-signatures.js --print-key` prints it from the config, and a test keeps the
config and `install.sh` on the same key.

### Where the private key lives

- **GitHub Actions secrets** of this repository: `TAURI_SIGNING_PRIVATE_KEY` (the contents of the
  key file Tauri wrote) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The release workflow passes them
  to the steps that sign, and to nothing else; they are not given to pull requests from forks.
- **An offline backup of the key and its password**, held by the repository owner. Making and
  keeping that backup is the owner's job: nothing in this repository creates it, checks it exists
  or can tell when it has been lost.

Whoever can change the workflows or the secrets of the repository can sign as the project: a
workflow that is allowed to see the secrets can sign any file. Protect the repository's admin
accounts and branch protection accordingly.

Neither the key nor the password is ever committed or printed. `scripts/setup-updater-keys.sh`
makes a new pair outside the repository; the public half goes in `tauri.conf.json`, the private
half and the password into the two secrets.

### Is the secret the key the apps trust?

On every push to `main`, the `updater-key` job of `build.yml` signs a small file with the secrets
and checks the signature against the public key in `tauri.conf.json` with
`scripts/verify-signatures.js`. If they differ, every update signed with that secret would be
refused by every installed app, and this is where that shows, before a tag. It does not run for
pull requests or forks, which have no secrets. A red `updater-key` is a reason not to tag.

## What is signed, and what is not

| File                                                       | Signature                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Clerq_<v>_<cpu>.app.tar.gz` (macOS), `.msi`, `-setup.exe` | `<file>.sig`, by the key above: this is what the app's updater verifies                 |
| `Clerq_<v>_x86_64.AppImage`, `_aarch64.AppImage` (Linux)   | `<file>.sig`, the same                                                                  |
| `.deb`, `.rpm` (Linux)                                     | `<file>.sig`, made by Tauri 2.10 and published, but **not in `latest.json`**: see below |
| `SHA256SUMS`                                               | `SHA256SUMS.minisig`, the same key. It lists the four server tarballs and `install.sh`  |
| `openclerq-server-*.tar.gz`, `install.sh`                  | by `SHA256SUMS`: their checksums are in it                                              |
| `latest.json`                                              | not signed itself; each platform entry carries the signature of the bundle it points to |
| `.dmg`                                                     | **not signed**: it is a download, not an update                                         |
| the macOS and Windows programs themselves                  | **not code-signed**: see below                                                          |

Before `publish` makes a release, it checks every `.sig` against the public key and refuses to go
on if an updater bundle has none or one does not verify
(`node scripts/verify-signatures.js --require release/`): nothing is released, and the failure
names the file. `publish-server` signs `SHA256SUMS`, then checks the signature with the same
script and with `minisign` itself before it uploads anything.

### The `.deb` and `.rpm` are signed and not offered as updates

Tauri 2.10 writes a `.sig` for the `.deb` and for the `.rpm` as well, with the key above, and the
release carries them (`publish` verifies them like the rest). The app's updater could install such
a package, but `latest.json` does not offer it: for a `.deb` or `.rpm` install, "Check for updates"
reports that no update is listed for it, and the package is updated by installing the new one.
That is a choice. The updater installs a package by running `dpkg -i` or `rpm -U` **as root**,
through `pkexec`, a `zenity` or `kdialog` password prompt or `sudo`; nobody has run that path, and
with it a stolen updater key would be root on those machines and not only the user's own account
(the AppImage replaces a file the user owns). To offer them, add the two keys in
`scripts/generate-updater-manifest.js` and the test that pins the choice.

### What is not signed: macOS and Windows code signing

Signing the updater bundles is not code signing. The operating systems check a different kind of
signature, made with a certificate this project does not have:

- **macOS** needs an Apple Developer ID certificate and notarization. Without them **Gatekeeper
  warns** when the `.dmg` or the app is opened for the first time (and refuses a program from a
  browser download until it is allowed in System Settings, Privacy & Security).
- **Windows** needs a code-signing certificate. Without one **SmartScreen warns** ("Windows
  protected your PC") on the `.msi` and the setup program.
- **Linux** has no equivalent for the packages we make: there is no apt or dnf repository and no
  distribution key, so `.deb` and `.rpm` are installed from a file you downloaded.

None of that is a bug in a release; it is what an unsigned release is. What is claimed is only what
the table says: a downloaded updater bundle or `SHA256SUMS` was signed by the holder of the
project's key. A signature made by the key shows who signed, and that the file is as signed.
It does not show the code is free of faults.

**When a certificate exists.** `release-macos-signed.yml` is the place for it: when the secrets
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `KEYCHAIN_PASSWORD` are set it imports the
certificate into a temporary keychain and builds with `APPLE_SIGNING_IDENTITY`, and Tauri
notarizes when `APPLE_ID` and `APPLE_PASSWORD` are there too. Today it runs on `workflow_dispatch`
and on tags, uploads its result as a workflow artifact and publishes nothing; the repository holds
none of those secrets. Making it the release means moving the certificate import into the macOS
leg of `release.yml` (which imports no certificate, so setting `APPLE_SIGNING_IDENTITY` there
alone cannot sign) so that the updater signature is made over the code-signed `.app.tar.gz`.
Windows would use `bundle.windows.certificateThumbprint` or `signCommand`
([Tauri's Windows signing](https://v2.tauri.app/distribute/sign/windows)); nothing in the
workflows sets that up.

## Checking a download

### The server files

```bash
v=1.0.0
base=https://github.com/paxamedia/OpenClerq/releases/download/v$v
curl -fsSLO "$base/SHA256SUMS" -O "$base/SHA256SUMS.minisig"
minisign -Vm SHA256SUMS -P RWTFlGuiTPSUETaZWif94VNcMaFH/nl43EDHam+1QGY7Vje8nOqAdMRG
```

`minisign -V` prints `Signature and comment signature verified` when it matches, and a message
and a non-zero status when it does not. Then check the files you downloaded against the signed
list, one file at a time as [SERVER.md](SERVER.md#check-a-download-by-hand) shows.

Without `minisign`, this repository's own checker does the same with Node alone:

```bash
node scripts/verify-signatures.js --sig SHA256SUMS.minisig SHA256SUMS
```

`install.sh` does the first check itself when `minisign` is installed, with the key it carries,
and says so (`Signature ok`). Without `minisign` it says it checked integrity only: the file is
the one the release lists, not proof of who made the release. `--no-signature` skips the
signature, for a release made before there was one.

### The desktop bundles

Each updater bundle has a `<name>.sig` next to it on the release. Download both into one folder
and:

```bash
node scripts/verify-signatures.js .          # every .sig in the folder, against the app's key
```

`minisign` cannot read Tauri's `.sig` directly, because Tauri stores the whole minisign file
base64-encoded; decode it first:
`base64 -d Clerq_1.0.0_x86_64.AppImage.sig > x.minisig && minisign -Vm Clerq_1.0.0_x86_64.AppImage -x x.minisig -P RWTFlGuiTPSUETaZWif94VNcMaFH/nl43EDHam+1QGY7Vje8nOqAdMRG`.

`scripts/verify-signatures.js` checks the two signatures of the minisign format (the file, hashed
with BLAKE2b-512 for the `ED` form Tauri writes, and the trusted comment) with `node:crypto`. Its
tests sign with the Tauri CLI itself, when it is installed, so what it accepts is what Tauri
writes.

## A release, step by step

1. **`main` is green**, for the commit you will tag: `CI`, and `Build desktop` with its
   `build-linux` (x64 and arm64) and `updater-key` jobs.
2. `node scripts/sync-version.js X.Y.Z`, move `[Unreleased]` in `CHANGELOG.md` under a new
   heading, commit.
3. Tag and push: `git tag -a vX.Y.Z -m "OpenClerq X.Y.Z"` and `git push origin main vX.Y.Z`. A tag
   with a `-` in it (`v1.0.0-rc.1`) is a pre-release, which the updater and the installer do not
   offer.
4. `release.yml` builds macOS, Windows and Linux (x64 and arm64), checks the signatures, writes
   `latest.json`, makes the release, then adds the server tarballs, `install.sh`, `SHA256SUMS` and
   its signature, and the container image. If `publish` stops at the signature check, **nothing was
   released**: read which file it names, fix the key or the build, and re-run.
5. **After the tag**, because none of this can be seen before it runs:
   - the release lists the desktop files (the `.dmg`, `.app.tar.gz`, `.msi`, setup `.exe`, two
     `.AppImage`, two `.deb`, two `.rpm`, each of those with its `.sig`), `latest.json`,
     the four server tarballs, `install.sh`, `SHA256SUMS` and `SHA256SUMS.minisig`;
   - `latest.json` names `darwin-aarch64`, `windows-x86_64` (and `-msi`, `-nsis`),
     `linux-x86_64-appimage` and `linux-aarch64-appimage`;
   - `minisign -Vm SHA256SUMS -P …` above passes on the released files;
   - the container image is public and pulls from a machine that is not signed in
     ([DISTRIBUTION.md](DISTRIBUTION.md#the-container-image));
   - an update works: install the previous release, use Check for updates in About (an update can
     only be tested across two releases).
6. If a job failed after the release was made (`publish-server`, the image), use **Re-run failed
   jobs**; the desktop release does not wait for them.

## Rotating the key

Installed apps trust only the public key they shipped with, so a new key cannot simply replace the
old one: an app would refuse an update signed with a key it has never seen. Rotation takes two
releases, and the first is signed with the **old** key.

1. **Make the new pair** outside the repository: `scripts/setup-updater-keys.sh`. Keep the old
   private key and its password; nothing can sign the bridge without them.
2. **The bridge release**, in one commit:
   - put the **new** public key in `plugins.updater.pubkey` of `tauri.conf.json`; apps built from
     it trust the new key from then on;
   - put the **old** public key, in the form `tauri.conf.json` keeps it, in
     `apps/desktop/src-tauri/updater-bridge.pub`. Its presence tells the scripts that this
     release is still signed with the old key, so the signature gate, the key check and
     `publish-server` check against that key instead of the config's. `install.sh` keeps the old
     key for this release (a test requires it to match the key signing the release);
   - leave the repository secrets as they are (the old key), then tag. Installed apps verify the
     bridge with the key they have and install it; the new key is inside it.
3. **Keep the bridge release available, and leave it as the latest release for a good while.** An
   app asks `releases/latest/download/latest.json` and installs only what that offers. An app that
   has not updated by the time a release signed with the new key is published finds a signature it
   cannot verify, and **cannot update in-app**: it must be reinstalled from the website or the
   release page. Do not delete the bridge: it is what a person who wants to move on the supported
   way installs, and it holds the evidence of what was published. How long to wait is a
   judgement: nothing in the project tells how many installs have not yet taken it.
4. **Switch to the new key**, in one more commit: replace the secrets
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the new pair, delete
   `updater-bridge.pub`, and put the new key in `install.sh` (`MINISIGN_KEY`) and in the table
   above. The `updater-key` job on `main` must be green before you tag: it proves the new secret
   is the key now in the config. (If the secrets were swapped before the file was deleted, or the
   other way round, it is red.)
5. **Destroy the old key** only when you decide no install still depends on it. Until then it is a
   key that can sign an update the stranded apps accept; the update must also be served from the
   project's release address, which is some protection and not a guarantee.

## When the key or its password is lost

In-app updates **end for every install** that trusts that key. Nothing can sign for them, and an
app never takes a key from anywhere but its own binary.

1. Say so: a notice on the release page, the README and the website, that in-app updates have
   stopped and why, and where to reinstall from.
2. Make a new pair (`scripts/setup-updater-keys.sh`), set the two secrets, put the new public key
   in `tauri.conf.json` and in `install.sh`, and release a new version. The `updater-key` job
   confirms the secret matches.
3. **Users reinstall** from the website or the release page: the apps they have cannot verify the
   new key. Their data in `~/.clerq` is kept. Apps installed from the new release update normally
   from then on.
4. If the key may have been **stolen** and not only lost, treat the old key as hostile: the same
   steps, and the notice must say so, because an attacker with the old key who can also serve a
   `latest.json` (that needs control of the release address or of the user's connection) could
   offer a signed update to every app that still trusts it. There is no revocation for those apps;
   the only protection is that they stop trusting the key by being reinstalled.

## What this does not do

- It does not make the macOS or Windows installers trusted by the operating system (above).
- It does not sign the `.dmg`, and it does not offer the signed `.deb` and `.rpm` as in-app
  updates (below).
- It cannot revoke a key from an app that has it.
- It does not check that the offline backup of the key exists.
- `SHA256SUMS.minisig` and `.sig` files come from the same release as the files they cover. They
  prove the signer, not that GitHub served you the right release: that you must check against the
  key above, which you can read in several places (this file, `tauri.conf.json`, `install.sh`).
