# OpenClerq — Installer notice

By installing OpenClerq you agree to the following.

## Disclaimer

- **Use at your own risk. No warranty.** This software is provided as-is. The authors and contributors are not responsible for any loss, damage, or liability arising from the use of this software.

## What this app is allowed to do (permissions)

To provide local clerical and administrative assistance, OpenClerq needs and will use the following access:

1. **Config and secrets (local only)**  
   Read and write files under `~/.clerq` (or `%USERPROFILE%\.clerq` on Windows; on Linux too it is `~/.clerq`, whichever of the `.deb`, `.rpm` or AppImage you use):
   - `config.json` — your settings (gateway URL, module paths, etc.)
   - `.env` — optional API key for an LLM provider, if you choose to use one

2. **Module paths**  
   Read directories you configure as “skills” or “modules” and their manifest files. Only paths you explicitly set are accessed.

3. **Opening links**  
   Open URLs in your default browser when you click links (e.g. GitHub, documentation).

4. **Network (only if you configure it)**  
   The **gateway** (a separate process you run, or that is started by a launcher) may send requests to an LLM provider if you configure an API key. The desktop app itself only talks to your local gateway. Calculations are performed locally and are not sent to any server.

## The installers, and what is signed

- **macOS and Windows installers are not code-signed.** The project holds no Apple Developer ID or Windows code-signing certificate, so Gatekeeper (macOS) and SmartScreen (Windows) will warn the first time you open the app. That is expected; it is not a sign the file was changed.
- **Linux packages (`.deb`, `.rpm`, AppImage)** are plain files you install yourself; there is no package repository and no distribution key. Installing a `.deb` or `.rpm` runs your package manager as root, as any package does, and installs the app and its two helper programs (`clerq-gateway`, `clerq-calc`) under `/usr`. An AppImage installs nothing: you run the file.
- The update bundles of the app, and the checksum list of the server files, are signed with the project's own key, so an installed app only accepts an update the project made. See [RELEASING](RELEASING.md) for how to check a download.

## Summary

- All **calculations** run on your machine (local Rust engine).
- **Config and API keys** stay in `~/.clerq` and are not shipped or logged by the app.
- **Network** is only used if you configure a cloud LLM; you can use a fully local model (e.g. Ollama) with no API key.

If you do not agree, do not install or use OpenClerq.
