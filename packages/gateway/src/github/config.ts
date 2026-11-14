/**
 * The GitHub App connection: where GitHub is, and what is stored about the app.
 *
 * Each OpenClerq install brings its own GitHub App (see docs/GITHUB.md): the
 * app's id, slug, name, client id and owner are kept here, in `settings`, and
 * are not secret. The app's private key and client secret are only in the
 * vault, under the two fixed names below, and no route returns them.
 */

import { getStore, isStoreOpen } from '../store.js';

/**
 * Where GitHub's API and website are. Internal settings so tests can point the
 * gateway at a fake server; they are not a feature (a self-hosted GitHub
 * Enterprise is refused, as for remote repositories), so they are not
 * documented for users.
 */
const DEFAULT_API = 'https://api.github.com';
const DEFAULT_WEB = 'https://github.com';

function base(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    if (url.username || url.password) return fallback;
    return raw.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/** The API's base address, no trailing slash. `CLERQ_GITHUB_API`, default https://api.github.com. */
export function githubApiBase(): string {
  return base('CLERQ_GITHUB_API', DEFAULT_API);
}

/** The website's base address, no trailing slash. `CLERQ_GITHUB_WEB`, default https://github.com. */
export function githubWebBase(): string {
  return base('CLERQ_GITHUB_WEB', DEFAULT_WEB);
}

export {
  APP_CLIENT_SECRET_SECRET,
  APP_PRIVATE_KEY_SECRET,
  USER_TOKENS_SECRET,
  RESERVED_SECRETS,
  isReservedSecret,
  reservedInSpec,
  reservedInVault,
} from './names.js';

/** What is known about the connected app. Nothing in it is secret. */
export interface GithubAppConfig {
  /** GitHub's numeric id of the app: the JWT's issuer. */
  appId: number;
  slug: string;
  name: string;
  /** The app's client id: what the device flow signs a user in with. */
  clientId: string;
  /** Who owns the app on GitHub, when GitHub said. */
  owner: { login: string; type: string } | null;
  /** `<web>/apps/<slug>`: GitHub's own address for the app if it is on GitHub's website, else built from the slug. */
  htmlUrl: string;
  /** How it was connected. */
  source: 'manifest' | 'import';
  /** When OpenClerq connected it. */
  createdAt: string;
  /** Rotated by importing a new key, when. */
  keyUpdatedAt?: string;
  /** What was wrong in what GitHub sent (an address left out), in words. Absent when nothing. */
  warnings?: string[];
}

const KEY = 'github.app';

function isConfig(v: unknown): v is GithubAppConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.appId === 'number' &&
    Number.isInteger(c.appId) &&
    typeof c.slug === 'string' &&
    typeof c.name === 'string' &&
    typeof c.clientId === 'string' &&
    typeof c.htmlUrl === 'string' &&
    (c.source === 'manifest' || c.source === 'import') &&
    typeof c.createdAt === 'string'
  );
}

/** The stored connection, or null when none (or the store is not open, or the value is damaged). */
export function readAppConfig(): GithubAppConfig | null {
  if (!isStoreOpen()) return null;
  try {
    const row = getStore().prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    if (!row) return null;
    const parsed: unknown = JSON.parse(String(row.value));
    return isConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeAppConfig(config: GithubAppConfig): void {
  getStore()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(KEY, JSON.stringify(config), new Date().toISOString());
}

export function clearAppConfig(): void {
  getStore().prepare('DELETE FROM settings WHERE key = ?').run(KEY);
}

/** `owner/name` split and checked, or null. GitHub names: letters, digits, `.`, `_`, `-`. */
export function splitProject(project: string): { owner: string; name: string } | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/((?!\.{1,2}$)[A-Za-z0-9._-]{1,100})$/.exec(
    project
  );
  return m ? { owner: m[1], name: m[2] } : null;
}

/** The page on GitHub where the app is installed on accounts and repositories. */
export function installUrl(config: Pick<GithubAppConfig, 'slug'>): string {
  return `${githubWebBase()}/apps/${encodeURIComponent(config.slug)}/installations/new`;
}

/** The app's settings page on GitHub: where its keys are made and the app is deleted. */
export function settingsUrl(config: Pick<GithubAppConfig, 'slug' | 'owner'>): string {
  const slug = encodeURIComponent(config.slug);
  return config.owner?.type === 'Organization'
    ? `${githubWebBase()}/organizations/${encodeURIComponent(config.owner.login)}/settings/apps/${slug}`
    : `${githubWebBase()}/settings/apps/${slug}`;
}

/**
 * An address GitHub gave us, if it is safe to show and link: https on GitHub's
 * own website (`githubWebBase()`), with no user name or password. Anything else
 * (`javascript:`, another host, a look-alike) is null: nothing taken from GitHub
 * is passed on as a link unless it passes this.
 */
export function githubUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.origin === new URL(githubWebBase()).origin ? url.href : null;
  } catch {
    return null;
  }
}

/** The warning for an address that was left out. */
export const REJECTED_URL = (what: string) =>
  `GitHub gave an address for ${what} that is not on GitHub's website; it was left out.`;
