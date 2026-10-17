#!/usr/bin/env bash
# Generate the Tauri updater key pair once, outside the repository.
# See docs/DISTRIBUTION.md for where each half goes.
set -e
mkdir -p "$HOME/.tauri"
pnpm --dir "$(dirname "$0")/../apps/desktop" exec tauri signer generate -w "$HOME/.tauri/clerq-updater.key"
echo
echo "Public key:  $HOME/.tauri/clerq-updater.key.pub  -> tauri.conf.json plugins.updater.pubkey"
echo "Private key: $HOME/.tauri/clerq-updater.key      -> Actions secret TAURI_SIGNING_PRIVATE_KEY"
echo "Password                                          -> Actions secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
