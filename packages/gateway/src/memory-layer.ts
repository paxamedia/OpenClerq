/**
 * File-backed memory layer — simple key-value store for agent context.
 * Stored in ~/.clerq/memory.json. Inspect and prune via API.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MemoryEntry {
  key: string;
  value: unknown;
  createdAt: string;
}

function getPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'memory.json');
}

function loadRaw(): Record<string, { value: unknown; createdAt: string }> {
  const p = getPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, { value?: unknown; createdAt?: string }>;
    const out: Record<string, { value: unknown; createdAt: string }> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && typeof v.createdAt === 'string') {
        out[k] = { value: v.value, createdAt: v.createdAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveRaw(data: Record<string, { value: unknown; createdAt: string }>): void {
  const dir = path.dirname(getPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf8');
}

export function listMemory(): MemoryEntry[] {
  const raw = loadRaw();
  return Object.entries(raw).map(([key, { value, createdAt }]) => ({
    key,
    value,
    createdAt,
  }));
}

export function getMemory(key: string): MemoryEntry | null {
  const raw = loadRaw();
  const entry = raw[key];
  if (!entry) return null;
  return { key, value: entry.value, createdAt: entry.createdAt };
}

export function setMemory(key: string, value: unknown): void {
  const raw = loadRaw();
  raw[key] = { value, createdAt: new Date().toISOString() };
  saveRaw(raw);
}

export function deleteMemory(key: string): boolean {
  const raw = loadRaw();
  if (!(key in raw)) return false;
  delete raw[key];
  saveRaw(raw);
  return true;
}

export function clearMemory(): number {
  const raw = loadRaw();
  const count = Object.keys(raw).length;
  if (count === 0) return 0;
  saveRaw({});
  return count;
}
