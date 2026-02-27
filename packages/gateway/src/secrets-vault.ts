/**
 * Encrypted secrets vault. Audit-ready: access logged, values never exposed.
 * Requires CLERQ_VAULT_KEY (32-byte hex) for encryption. Without it, vault is disabled.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function getVaultDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.clerq');
}

function getVaultPath(): string {
  return path.join(getVaultDir(), 'secrets.vault');
}

function getAuditPath(): string {
  return path.join(getVaultDir(), 'secrets.audit.log');
}

function getKey(): Buffer | null {
  const raw = process.env.CLERQ_VAULT_KEY?.trim();
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'hex');
    return buf.length === KEY_LEN ? buf : null;
  } catch {
    return null;
  }
}

function audit(action: string, name: string): void {
  try {
    const dir = getVaultDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()}\t${action}\t${name}\n`;
    fs.appendFileSync(getAuditPath(), line);
  } catch (_) {}
}

function ensureDir(): void {
  const dir = getVaultDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface VaultEntry {
  encrypted: string;
  iv: string;
  tag: string;
}

interface VaultFile {
  version: number;
  entries: Record<string, VaultEntry>;
}

function loadVault(): VaultFile {
  const p = getVaultPath();
  if (!fs.existsSync(p)) return { version: 1, entries: {} };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as VaultFile;
    return data.version === 1 ? data : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveVault(vault: VaultFile): void {
  ensureDir();
  fs.writeFileSync(getVaultPath(), JSON.stringify(vault), 'utf8');
}

export function listSecrets(): string[] | { error: string } {
  const key = getKey();
  if (!key) return { error: 'Vault disabled. Set CLERQ_VAULT_KEY (32-byte hex) to enable.' };
  const vault = loadVault();
  return Object.keys(vault.entries);
}

export function setSecret(name: string, value: string): { ok: boolean; error?: string } {
  const key = getKey();
  if (!key) return { ok: false, error: 'Vault disabled. Set CLERQ_VAULT_KEY.' };
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { ok: false, error: 'Invalid secret name. Use alphanumeric, underscore, hyphen.' };
  }
  try {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const vault = loadVault();
    vault.entries[name] = {
      encrypted: enc.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
    saveVault(vault);
    audit('set', name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export function deleteSecret(name: string): { ok: boolean; error?: string } {
  const key = getKey();
  if (!key) return { ok: false, error: 'Vault disabled. Set CLERQ_VAULT_KEY.' };
  const vault = loadVault();
  if (!(name in vault.entries)) return { ok: true };
  delete vault.entries[name];
  saveVault(vault);
  audit('delete', name);
  return { ok: true };
}

/**
 * Decrypt and return a secret. For internal use only (e.g. tools, LLM). Never expose over API.
 */
export function getSecret(name: string): string | null {
  const key = getKey();
  if (!key) return null;
  const vault = loadVault();
  const entry = vault.entries[name];
  if (!entry) return null;
  try {
    const decipher = crypto.createDecipheriv(
      ALG,
      key,
      Buffer.from(entry.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return decipher.update(entry.encrypted, 'base64', 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
