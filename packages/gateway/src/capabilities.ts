/**
 * Capabilities config: filesystem allowlists, network restrictions.
 * Stored in ~/.clerq/capabilities.json. Audit-ready.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolConfig } from './tools.js';

export interface CapabilitiesConfig {
  /** Root directory for fs.read. Default: process.cwd() */
  fsRoot?: string;
  /** Allow fs write tools (future). Default: false */
  fsAllowWrite?: boolean;
  /** Allowed hostnames for http.request. Empty = disabled */
  httpAllowlist?: string[];
}

function getPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'capabilities.json');
}

function ensureDir(): void {
  const dir = path.dirname(getPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadCapabilities(): CapabilitiesConfig {
  const p = getPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const c: CapabilitiesConfig = {};
    if (typeof raw.fsRoot === 'string') c.fsRoot = raw.fsRoot;
    if (typeof raw.fsAllowWrite === 'boolean') c.fsAllowWrite = raw.fsAllowWrite;
    if (Array.isArray(raw.httpAllowlist)) {
      c.httpAllowlist = raw.httpAllowlist.filter((h): h is string => typeof h === 'string');
    }
    return c;
  } catch {
    return {};
  }
}

export function saveCapabilities(config: CapabilitiesConfig): void {
  ensureDir();
  fs.writeFileSync(getPath(), JSON.stringify(config, null, 2), 'utf8');
}

export function capabilitiesToToolConfig(c: CapabilitiesConfig): ToolConfig {
  return {
    fsRoot: c.fsRoot,
    fsAllowWrite: c.fsAllowWrite,
    httpAllowlist: c.httpAllowlist,
  };
}
