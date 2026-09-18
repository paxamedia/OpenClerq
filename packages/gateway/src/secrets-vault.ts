/**
 * Encrypted secrets vault. Audit-ready: access logged, values never exposed.
 *
 * The master key comes from the first of these that answers:
 *
 *   1. CLERQ_VAULT_KEY — honoured for compatibility and for containers that
 *      inject it, but it is the weakest option and says so once at startup.
 *   2. The OS keychain, which is where this belongs.
 *   3. ~/.clerq/vault.key, mode 0600 — the headless fallback, with a warning.
 *
 * A key is generated on first use rather than demanded up front, the way the
 * gateway token is. The alternative was a vault that silently did nothing until
 * the user found the right environment variable.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clerqHome, writePrivateFile, appendPrivateFile } from '@clerq/store';
import { logger } from './logger.js';
import { getPassword, setPassword, detectBackend, describeBackend } from './security/keychain.js';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function getVaultDir(): string {
  return clerqHome();
}

function getVaultPath(): string {
  return path.join(getVaultDir(), 'secrets.vault');
}

function getAuditPath(): string {
  return path.join(getVaultDir(), 'secrets.audit.log');
}

const KEYCHAIN_SERVICE = 'OpenClerq';
const KEYCHAIN_ACCOUNT = 'vault-master-key';

/** Where the current key came from, for the operator to see. */
export type KeySource = 'env' | 'keychain' | 'file' | 'none';

let keySource: KeySource = 'none';
let warned = false;
/**
 * The resolved key, cached for the life of the process: every vault operation
 * needs it, and on macOS each miss is a `security` invocation. Keyed by what
 * could change the answer, so a test or a reconfiguration is not served a
 * stale key.
 */
let cached: { fingerprint: string; key: Buffer } | undefined;

function keyFilePath(): string {
  return path.join(getVaultDir(), 'vault.key');
}

function parseHexKey(raw: string | undefined | null): Buffer | null {
  const text = raw?.trim();
  if (!text || !/^[0-9a-fA-F]+$/.test(text)) return null;
  const buf = Buffer.from(text, 'hex');
  return buf.length === KEY_LEN ? buf : null;
}

function warnOnce(message: string, detail?: Record<string, unknown>): void {
  if (warned) return;
  warned = true;
  logger.warn(message, detail);
}

/**
 * Resolve the master key, generating and storing one on first use.
 *
 * Returns null only when no key could be stored anywhere, which leaves the
 * vault disabled rather than encrypting under a key that will not survive.
 */
function getKey(): Buffer | null {
  const fingerprint = `${process.env.CLERQ_VAULT_KEY ?? ''}|${getVaultDir()}|${process.env.CLERQ_KEYCHAIN ?? ''}|${process.env.CLERQ_KEYCHAIN_PATH ?? ''}`;
  if (cached?.fingerprint === fingerprint) return cached.key;
  const key = resolveKey();
  cached = key ? { fingerprint, key } : undefined;
  return key;
}

function resolveKey(): Buffer | null {
  const fromEnv = parseHexKey(process.env.CLERQ_VAULT_KEY);
  if (fromEnv) {
    keySource = 'env';
    warnOnce(
      'The vault master key is coming from CLERQ_VAULT_KEY. Any process that can read this ' +
        'environment can read the key, and it tends to end up in shell history and CI logs. ' +
        'Unset it to move the key into the OS keychain.'
    );
    return fromEnv;
  }

  const backend = detectBackend();
  if (backend !== 'none') {
    const stored = parseHexKey(getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT));
    if (stored) {
      keySource = 'keychain';
      return stored;
    }
    const generated = crypto.randomBytes(KEY_LEN);
    try {
      setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, generated.toString('hex'));
      keySource = 'keychain';
      logger.info('Generated a vault master key and stored it in the keychain', {
        backend: describeBackend(backend),
      });
      return generated;
    } catch (e) {
      logger.warn('Could not store the vault key in the keychain; falling back to a file', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Headless fallback: a file only this account can read.
  const file = keyFilePath();
  const fromFile = parseHexKey(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  if (fromFile) {
    keySource = 'file';
    warnOnce(
      'The vault master key is in ~/.clerq/vault.key (mode 0600). No keychain is available here.'
    );
    return fromFile;
  }
  try {
    const generated = crypto.randomBytes(KEY_LEN);
    writePrivateFile(file, generated.toString('hex'));
    keySource = 'file';
    warnOnce(
      'Generated a vault master key at ~/.clerq/vault.key (mode 0600). No keychain is available here.'
    );
    return generated;
  } catch (e) {
    keySource = 'none';
    logger.error('Could not create a vault master key; the vault stays disabled', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Where the master key is kept, and which backend would hold it. */
export function vaultKeyStatus(): { source: KeySource; backend: string } {
  const key = getKey();
  return { source: key ? keySource : 'none', backend: describeBackend() };
}

function audit(action: string, name: string): void {
  try {
    appendPrivateFile(getAuditPath(), `${new Date().toISOString()}\t${action}\t${name}\n`);
  } catch {
    /* an audit failure must not fail the write it describes */
  }
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
  writePrivateFile(getVaultPath(), JSON.stringify(vault));
}

export function listSecrets(): string[] | { error: string } {
  const key = getKey();
  if (!key) return { error: 'Vault unavailable: no master key could be stored on this host.' };
  const vault = loadVault();
  return Object.keys(vault.entries);
}

export function setSecret(name: string, value: string): { ok: boolean; error?: string } {
  const key = getKey();
  if (!key) {
    return { ok: false, error: 'Vault unavailable: no master key could be stored on this host.' };
  }
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
  if (!key) {
    return { ok: false, error: 'Vault unavailable: no master key could be stored on this host.' };
  }
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
    const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return decipher.update(entry.encrypted, 'base64', 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
