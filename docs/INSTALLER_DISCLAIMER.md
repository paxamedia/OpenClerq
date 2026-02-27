# OpenClerq — Installer notice

By installing OpenClerq you agree to the following.

## Disclaimer

- **Use at your own risk. No warranty.** This software is provided as-is. The authors and contributors are not responsible for any loss, damage, or liability arising from the use of this software.

## What this app is allowed to do (permissions)

To provide local clerical and administrative assistance, OpenClerq needs and will use the following access:

1. **Config and secrets (local only)**  
   Read and write files under `~/.clerq` (or `%USERPROFILE%\.clerq` on Windows):  
   - `config.json` — your settings (gateway URL, module paths, etc.)  
   - `.env` — optional API key for an LLM provider, if you choose to use one  

2. **Module paths**  
   Read directories you configure as “skills” or “modules” and their manifest files. Only paths you explicitly set are accessed.

3. **Opening links**  
   Open URLs in your default browser when you click links (e.g. GitHub, documentation).

4. **Network (only if you configure it)**  
   The **gateway** (a separate process you run, or that is started by a launcher) may send requests to an LLM provider if you configure an API key. The desktop app itself only talks to your local gateway. Calculations are performed locally and are not sent to any server.

## Summary

- All **calculations** run on your machine (local Rust engine).  
- **Config and API keys** stay in `~/.clerq` and are not shipped or logged by the app.  
- **Network** is only used if you configure a cloud LLM; you can use a fully local model (e.g. Ollama) with no API key.

If you do not agree, do not install or use OpenClerq.
