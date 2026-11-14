/**
 * The desktop host for the screens: links open in the browser, settings live
 * in ~/.clerq/config.json, the API key in ~/.clerq/.env, updates come from the
 * Tauri updater, and module notifications and the inbox count reach the system.
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { check } from '@tauri-apps/plugin-updater';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { relaunch } from '@tauri-apps/plugin-process';
import type { AppConfig, Host } from '@clerq/web';
import { setGatewayBaseUrl } from './gateway';
import { version } from '../package.json';

export async function readConfig(): Promise<AppConfig> {
  const raw = await invoke<string>('read_config');
  return raw ? (JSON.parse(raw) as AppConfig) : {};
}

/** Asked once, the first time a module notifies; the system remembers the answer. */
let allowed: Promise<boolean> | null = null;
function mayNotify(): Promise<boolean> {
  allowed ??= isPermissionGranted()
    .then((granted) => granted || requestPermission().then((p) => p === 'granted'))
    .catch(() => false);
  return allowed;
}

export const desktopHost: Host = {
  kind: 'desktop',
  version,
  openUrl: (url) => void open(url),
  // GitHub has to ask the person to confirm a new app in their own browser, not in this window.
  openForm: (url, fields) => invoke('open_form', { url, fields }),
  readConfig,
  writeConfig: (config) => invoke('write_config', { json: JSON.stringify(config, null, 2) }),
  setGatewayUrl: (url) => setGatewayBaseUrl(url),
  saveApiKey: (apiKey) => invoke('write_api_key', { apiKey }),
  async checkForUpdates() {
    const update = await check();
    if (!update) return 'up-to-date';
    await update.downloadAndInstall();
    await relaunch();
    return 'installing';
  },
  notify({ title, body }) {
    void mayNotify().then((ok) => ok && sendNotification({ title, body }));
  },
  setBadge(count) {
    // The dock or taskbar badge; undefined clears it.
    void getCurrentWindow()
      .setBadgeCount(count > 0 ? count : undefined)
      .catch(() => undefined);
  },
};
