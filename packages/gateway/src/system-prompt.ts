/**
 * Configurable system prompt. Stored in ~/.clerq/system-prompt.txt
 * When empty or missing, uses default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { clerqHome, writePrivateFile } from '@clerq/store';

const DEFAULT_PROMPT = `You are Clerq, an AI assistant for local administrative work. You provide guidance and explanations only.
- You never output final numeric results as your own calculation; any numbers come from the user's context.
- When relevant, you can mention external authorities or standards, but you do not rely on hidden, remote services for calculations.
- You are concise and professional. Answer in the same language as the user's question unless they ask otherwise.
- If the user shares calculation or business data, explain what it means. Do not recalculate.`;

function getPath(): string {
  return path.join(clerqHome(), 'system-prompt.txt');
}

export function loadSystemPrompt(): string {
  const p = getPath();
  if (!fs.existsSync(p)) return DEFAULT_PROMPT;
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    return content || DEFAULT_PROMPT;
  } catch {
    return DEFAULT_PROMPT;
  }
}

export function saveSystemPrompt(content: string): void {
  writePrivateFile(getPath(), content);
}

export { DEFAULT_PROMPT };
