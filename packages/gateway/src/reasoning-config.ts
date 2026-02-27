/**
 * Reasoning controls: temperature, max tokens. Stored in ~/.clerq/reasoning.json
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ReasoningConfig {
  temperature?: number;
  maxTokens?: number;
}

function getPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq', 'reasoning.json');
}

function ensureDir(): void {
  const dir = path.dirname(getPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadReasoning(): ReasoningConfig {
  const p = getPath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const c: ReasoningConfig = {};
    if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) {
      c.temperature = raw.temperature;
    }
    if (typeof raw.maxTokens === 'number' && raw.maxTokens >= 1 && raw.maxTokens <= 128000) {
      c.maxTokens = raw.maxTokens;
    }
    return c;
  } catch {
    return {};
  }
}

export function saveReasoning(config: ReasoningConfig): void {
  ensureDir();
  fs.writeFileSync(getPath(), JSON.stringify(config, null, 2), 'utf8');
}
