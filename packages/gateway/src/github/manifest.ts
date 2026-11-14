/**
 * Creating the app through GitHub's app manifest flow.
 *
 * The gateway builds a manifest (the app's name, permissions and where GitHub
 * sends the browser back to). The person's browser posts it to GitHub with a
 * `state`; GitHub asks them to confirm, creates the app under their account (or
 * an organisation's), and redirects the browser to `redirect_url` with a
 * one-time `code` and the same `state`. The gateway swaps the code for the
 * app's private key and client secret.
 *
 * The `state` is the only thing that lets an unauthenticated browser request
 * connect an app, so it is single use, random (32 bytes), valid for ten
 * minutes, held in memory only, and tied to what asked for it: the address the
 * browser must come back to, the account the app was asked for, and the
 * permissions the manifest named, all checked again when the code comes back.
 */

import crypto from 'node:crypto';

export const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;

/** The most the app asks for. `metadata: read` is GitHub's own floor. */
export const MANIFEST_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
} as const;

/** Shown on GitHub as the app's home page, and nothing else. */
const HOMEPAGE = 'https://github.com/paxamedia/OpenClerq';

/** A 400 with a code a client can read. */
export class ManifestRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ManifestRequestError';
  }
}

export interface ManifestInput {
  /** The organisation that should own the app. Absent: the signed-in user's own account. */
  owner?: string;
  /** The app's name, 34 characters at most. Default `OpenClerq-<6 hex digits>`. */
  name?: string;
  /** The address the person's browser reaches this gateway at: where GitHub sends it back. */
  baseUrl: string;
}

export interface PendingFlow {
  createdAt: number;
  expiresAt: number;
  org: string | null;
  name: string;
  redirectUrl: string;
  /** The host (with port) the callback must arrive at. */
  host: string;
}

export interface ManifestOffer {
  /** Where the browser posts the manifest (a form field named `manifest`). */
  url: string;
  manifest: Record<string, unknown>;
  state: string;
  expiresAt: string;
  redirectUrl: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The callback address for a base address, or a `ManifestRequestError`. */
export function callbackUrl(baseUrl: unknown): URL {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new ManifestRequestError(
      'invalid_base_url',
      '"baseUrl" is required: the address your browser uses to reach this gateway, such as http://127.0.0.1:18790.'
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new ManifestRequestError(
      'invalid_base_url',
      `"${baseUrl.slice(0, 80)}" is not an address.`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ManifestRequestError(
      'invalid_base_url',
      '"baseUrl" must be an http or https address.'
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ManifestRequestError(
      'invalid_base_url',
      '"baseUrl" must be just an address: no user name, query or fragment.'
    );
  }
  // GitHub sends a code that anyone holding it can exchange for the app's private key.
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new ManifestRequestError(
      'invalid_base_url',
      'A gateway reached over plain http can only be named by 127.0.0.1, localhost or [::1]: GitHub sends a one-time code back to this address, so it must be https anywhere else.'
    );
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  return new URL(`${url.origin}${prefix}/v1/github/app/callback`);
}

/** The host a request must have arrived at, with a default port left off. */
export function hostOf(host: string | undefined): string {
  return (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/:(80|443)$/, '');
}

export function buildManifest(
  name: string,
  redirectUrl: string,
  permissions: Record<string, string> = MANIFEST_PERMISSIONS
): Record<string, unknown> {
  return {
    name,
    url: HOMEPAGE,
    description:
      'Lets OpenClerq push branches and open pull requests on the repositories this app is installed on. ' +
      'Its tokens last at most an hour and each covers one repository.',
    // No webhook: GitHub never calls this address; it is only a value the form wants.
    hook_attributes: { url: HOMEPAGE, active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: permissions,
    default_events: [],
    request_oauth_on_install: false,
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,33}$/;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class ManifestFlows {
  private readonly pending = new Map<string, PendingFlow>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly web: () => string = () => 'https://github.com'
  ) {}

  private key(state: string): string {
    return crypto.createHash('sha256').update(state).digest('hex');
  }

  /** Make a manifest and its state. Throws `ManifestRequestError` for a bad request. */
  start(input: ManifestInput): ManifestOffer {
    const redirect = callbackUrl(input.baseUrl);
    let org: string | null = null;
    if (input.owner !== undefined) {
      if (typeof input.owner !== 'string' || !ORG.test(input.owner.trim())) {
        throw new ManifestRequestError(
          'invalid_owner',
          '"owner" must be the login of a GitHub organisation, or left out to create the app under your own account.'
        );
      }
      org = input.owner.trim();
    }
    let name: string;
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !NAME.test(input.name.trim())) {
        throw new ManifestRequestError(
          'invalid_name',
          '"name" must be 1 to 34 letters, digits, spaces, hyphens, dots or underscores.'
        );
      }
      name = input.name.trim();
    } else {
      name = `OpenClerq-${crypto.randomBytes(3).toString('hex')}`;
    }

    this.purge();
    if (this.pending.size >= MAX_PENDING) {
      // The oldest goes: a person starting again is the likelier of the two.
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      this.pending.delete(oldest[0]);
    }
    const state = crypto.randomBytes(32).toString('hex');
    const createdAt = this.now();
    this.pending.set(this.key(state), {
      createdAt,
      expiresAt: createdAt + STATE_TTL_MS,
      org,
      name,
      redirectUrl: redirect.toString(),
      host: hostOf(redirect.host),
    });

    const web = this.web();
    const target = org
      ? `${web}/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : `${web}/settings/apps/new`;
    return {
      url: `${target}?state=${state}`,
      manifest: buildManifest(name, redirect.toString()),
      state,
      expiresAt: new Date(createdAt + STATE_TTL_MS).toISOString(),
      redirectUrl: redirect.toString(),
    };
  }

  /**
   * Use a state, once. Whatever the answer, it cannot be used again: a state
   * that arrives twice, late or wrong is spent.
   */
  take(state: unknown): { flow: PendingFlow } | { error: 'unknown' | 'expired' } {
    if (typeof state !== 'string' || !/^[0-9a-f]{64}$/.test(state)) return { error: 'unknown' };
    const k = this.key(state);
    const flow = this.pending.get(k);
    if (!flow) return { error: 'unknown' };
    this.pending.delete(k);
    return flow.expiresAt <= this.now() ? { error: 'expired' } : { flow };
  }

  /** Forget every waiting state (an app was connected another way). */
  clear(): void {
    this.pending.clear();
  }

  /** Whether any manifest is waiting for its callback. */
  get waiting(): number {
    this.purge();
    return this.pending.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [k, f] of this.pending) if (f.expiresAt <= now) this.pending.delete(k);
  }
}
