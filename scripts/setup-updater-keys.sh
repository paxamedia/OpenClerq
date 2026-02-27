#!/usr/bin/env bash
# Generate Tauri updater signing keys. Run once before releasing.
# Store the private key (.key file) securely; add TAURI_SIGNING_PRIVATE_KEY to CI secrets.
# The public key is printed — add it to apps/desktop/src-tauri/tauri.conf.json under plugins.updater.pubkey
set -e
mkdir -p .tauri
echo "Run: cd apps/desktop && pnpm exec tauri signer generate -w ../../.tauri/clerq.key"
echo "Then copy the public key (between ---BEGIN and ---END) into tauri.conf.json plugins.updater.pubkey"
echo "Add .tauri/ to .gitignore. Store the private key in CI as TAURI_SIGNING_PRIVATE_KEY secret."
