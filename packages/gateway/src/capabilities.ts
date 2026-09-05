/**
 * Capabilities config: filesystem scope and outbound network policy.
 * Stored in ~/.clerq/capabilities.json. Audit-ready.
 *
 * These are grants, not hints. Set the narrowest values your skills need.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolConfig } from './tools.js';

export interface CapabilitiesConfig {
  /** Root directory for fs.read. Default: process.cwd() */
  fsRoot?: string;
  /** Largest file fs.read will return, in bytes. Default: 1048576 */
  fsMaxReadBytes?: number;
  /** Allowed hostnames for http.request. Empty = tool not registered */
  httpAllowlist?: string[];
  /** URL schemes http.request may use. Default: ["https:"] */
  httpAllowedSchemes?: string[];
  /** Largest response body retained, in bytes. Default: 262144 */
  httpMaxBytes?: number;
  /** Whole-request timeout in milliseconds. Default: 10000 */
  httpTimeoutMs?: number;
  /** Permit private/loopback/link-local destinations. Default: false */
  httpAllowPrivateAddresses?: boolean;
}

function getPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'capabilities.json');
}

function ensureDir(): void {
  const dir = path.dirname(getPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((h): h is string => typeof h === 'string') : undefined;
}

export function loadCapabilities(): CapabilitiesConfig {
  const p = getPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const c: CapabilitiesConfig = {};
    if (typeof raw.fsRoot === 'string') c.fsRoot = raw.fsRoot;
    const fsMax = positiveInt(raw.fsMaxReadBytes);
    if (fsMax !== undefined) c.fsMaxReadBytes = fsMax;
    const allowlist = stringArray(raw.httpAllowlist);
    if (allowlist) c.httpAllowlist = allowlist;
    const schemes = stringArray(raw.httpAllowedSchemes);
    if (schemes) c.httpAllowedSchemes = schemes;
    const httpMax = positiveInt(raw.httpMaxBytes);
    if (httpMax !== undefined) c.httpMaxBytes = httpMax;
    const timeout = positiveInt(raw.httpTimeoutMs);
    if (timeout !== undefined) c.httpTimeoutMs = timeout;
    if (typeof raw.httpAllowPrivateAddresses === 'boolean') {
      c.httpAllowPrivateAddresses = raw.httpAllowPrivateAddresses;
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
    fsMaxReadBytes: c.fsMaxReadBytes,
    httpAllowlist: c.httpAllowlist,
    httpAllowedSchemes: c.httpAllowedSchemes,
    httpMaxBytes: c.httpMaxBytes,
    httpTimeoutMs: c.httpTimeoutMs,
    httpAllowPrivateAddresses: c.httpAllowPrivateAddresses,
  };
}
