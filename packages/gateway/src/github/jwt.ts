/**
 * The token a GitHub App proves itself with: a JSON Web Token signed RS256
 * with the app's private key, made with `node:crypto` (which Bun also has),
 * with no library.
 *
 * GitHub's rules: `iss` names the app, `iat` may be at most a little in the
 * past (60 s early absorbs clock drift), and `exp` at most 10 minutes ahead.
 * Ours is 9 minutes. The `iss` claim is the numeric App ID: GitHub also takes
 * the client ID, but the App ID has always been accepted and an imported app
 * is given both.
 */

import crypto from 'node:crypto';

/** The key could not be used: not a PEM, not RSA, too small. Never carries key text. */
export class InvalidKeyError extends Error {
  readonly code = 'invalid_private_key';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

/** How far back `iat` is set, in seconds. */
export const JWT_BACKDATE_S = 60;
/** How long a token lives, in seconds. GitHub's limit is 600. */
export const JWT_LIFETIME_S = 9 * 60;

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/**
 * A private key as PEM text, checked: RSA, at least 2048 bits (what GitHub
 * issues). Throws `InvalidKeyError` in plain words, without the key.
 */
export function parsePrivateKey(pem: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new InvalidKeyError(
      'That is not a private key in PEM form (it should start with -----BEGIN RSA PRIVATE KEY-----, and have no passphrase).'
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new InvalidKeyError('A GitHub App signs with an RSA key; this one is not RSA.');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits !== undefined && bits < 2048) {
    throw new InvalidKeyError(
      'The RSA key is shorter than 2048 bits; GitHub issues 2048-bit keys.'
    );
  }
  return key;
}

/**
 * Sign the app's JWT. `now` is in milliseconds. A PEM string is parsed each
 * time (a few hundred microseconds), so nothing key-shaped is held beyond the call.
 */
export function signAppJwt(options: {
  issuer: string | number;
  privateKey: string | crypto.KeyObject;
  now?: number;
}): string {
  const key =
    typeof options.privateKey === 'string'
      ? parsePrivateKey(options.privateKey)
      : options.privateKey;
  const seconds = Math.floor((options.now ?? Date.now()) / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iat: seconds - JWT_BACKDATE_S,
    exp: seconds + JWT_LIFETIME_S,
    iss: String(options.issuer),
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256').update(input).sign(key);
  return `${input}.${base64url(signature)}`;
}

/** What a token says, without checking it: for tests and for the status page. */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [h, c] = token.split('.');
  const read = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header: read(h), claims: read(c) };
}
