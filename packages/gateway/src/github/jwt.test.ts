import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  decodeJwt,
  InvalidKeyError,
  JWT_BACKDATE_S,
  JWT_LIFETIME_S,
  parsePrivateKey,
  signAppJwt,
} from './jwt.js';

// A throwaway key made for this file; nothing is checked in.
const pair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const pkcs8 = crypto
  .createPrivateKey(pair.privateKey)
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

/** 2026-11-13T12:00:00Z, the instant the vector is made at. */
const NOW_MS = Date.UTC(2026, 10, 13, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

describe('the app JWT', () => {
  const jwt = signAppJwt({ issuer: 424242, privateKey: pair.privateKey, now: NOW_MS });
  const [h, c, s] = jwt.split('.');

  it('has the header and claims GitHub asks for, at a known instant', () => {
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iat: NOW_S - 60,
      exp: NOW_S + 9 * 60,
      iss: '424242',
    });
    expect(JWT_BACKDATE_S).toBe(60);
    expect(JWT_LIFETIME_S).toBe(540);
    // The exact text of the first two parts, so a change of key order or spacing is noticed.
    expect(Buffer.from(h, 'base64url').toString()).toBe('{"alg":"RS256","typ":"JWT"}');
    expect(Buffer.from(c, 'base64url').toString()).toBe(
      `{"iat":${NOW_S - 60},"exp":${NOW_S + 540},"iss":"424242"}`
    );
  });

  it('is signed with the app key, and the signature is the same one an independent signer makes', () => {
    expect(
      crypto
        .createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(pair.publicKey, Buffer.from(s, 'base64url'))
    ).toBe(true);
    // RSASSA-PKCS1-v1_5 is deterministic: signing the same bytes another way gives the same bytes.
    const again = crypto.sign('sha256', Buffer.from(`${h}.${c}`), {
      key: pair.privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    expect(s).toBe(again.toString('base64url'));
    // Another key does not verify it.
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(
      crypto
        .createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(other.publicKey, Buffer.from(s, 'base64url'))
    ).toBe(false);
  });

  it('uses base64url without padding', () => {
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('takes the app id as a number or a string, and a PKCS#8 key as well as a PKCS#1 one', () => {
    const a = signAppJwt({ issuer: '424242', privateKey: pkcs8, now: NOW_MS });
    expect(a).toBe(jwt);
    expect(decodeJwt(a).claims.iss).toBe('424242');
  });

  it('is made again at each call, from the clock it is given', () => {
    const later = signAppJwt({ issuer: 1, privateKey: pair.privateKey, now: NOW_MS + 600_000 });
    expect(decodeJwt(later).claims.iat).toBe(NOW_S + 540);
    // Without a clock it uses the current time.
    const live = decodeJwt(signAppJwt({ issuer: 1, privateKey: pair.privateKey }));
    expect(Math.abs((live.claims.iat as number) + 60 - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('the private key', () => {
  it('accepts an RSA key in either PEM form', () => {
    expect(parsePrivateKey(pair.privateKey).asymmetricKeyType).toBe('rsa');
    expect(parsePrivateKey(pkcs8).asymmetricKeyType).toBe('rsa');
  });

  it('refuses text that is not a key, without repeating it', () => {
    expect(() => parsePrivateKey('hunter2-not-a-key')).toThrow(InvalidKeyError);
    try {
      parsePrivateKey('hunter2-not-a-key');
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
      expect((e as Error).message).toContain('PEM');
    }
  });

  it('refuses a key that is not RSA', () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => parsePrivateKey(pem)).toThrow(/not RSA/);
  });

  it('refuses an RSA key shorter than 2048 bits', () => {
    const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = small.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    expect(() => parsePrivateKey(pem)).toThrow(/2048/);
  });

  it('refuses a public key', () => {
    expect(() => parsePrivateKey(pair.publicKey)).toThrow(InvalidKeyError);
  });
});
