import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig, type CliConfig } from './config.js';
import {
  DEFAULT_URL,
  assertTransport,
  checkToken,
  isLocalGateway,
  isLoopbackHost,
  normalizeUrl,
  resolveConnection,
  tokenWords,
  urlWords,
} from './connection.js';

let home: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-conn-')));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const writeLocalToken = (token = 'local-file-token-0123456789') => {
  fs.mkdirSync(path.join(home, '.clerq'), { recursive: true });
  fs.writeFileSync(path.join(home, '.clerq', 'gateway-token'), `${token}\n`);
  return token;
};
const writeProfiles = (profiles: CliConfig['profiles']) =>
  saveConfig(home, { version: 1, profiles });
const resolve = (flags = {}, env: Record<string, string> = {}) =>
  resolveConnection({ flags, env, home });

describe('the address', () => {
  it('is the gateway on this computer when nothing says otherwise', () => {
    const r = resolve();
    expect(r.url).toBe(DEFAULT_URL);
    expect(r.urlSource).toBe('local-default');
    expect(r.token).toBeNull();
  });

  it('takes --gateway first, then --profile, then the environment, then the default profile', () => {
    writeProfiles({
      default: { url: 'https://default.example', token: 'default-profile-token-1' },
      work: { url: 'https://work.example', token: 'work-profile-token-1234' },
    });
    const env = { CLERQ_GATEWAY_URL: 'https://env.example' };
    expect(resolve({ gateway: 'https://flag.example', profile: 'work' }, env).url).toBe(
      'https://flag.example'
    );
    expect(resolve({ profile: 'work' }, env)).toMatchObject({
      url: 'https://work.example',
      urlSource: 'profile',
    });
    expect(resolve({}, env)).toMatchObject({ url: 'https://env.example', urlSource: 'env' });
    expect(resolve({})).toMatchObject({
      url: 'https://default.example',
      urlSource: 'default-profile',
    });
  });

  it('refuses a profile that does not exist, and says which do', () => {
    writeProfiles({ default: { url: 'https://a.example', token: 'default-profile-token-1' } });
    expect(() => resolve({ profile: 'nope' })).toThrow(/no profile "nope".*it has: default/);
    // A name that is an Object.prototype member is not a profile either.
    expect(() => resolve({ profile: 'constructor' })).toThrow(/no profile "constructor"/);
  });
});

describe('the token', () => {
  it('is, in order: the named profile, the environment, the default profile, the local file', () => {
    const file = writeLocalToken();
    writeProfiles({
      default: { url: DEFAULT_URL, token: 'default-profile-token-1' },
      work: { url: DEFAULT_URL, token: 'work-profile-token-1234' },
    });
    const env = { CLERQ_GATEWAY_TOKEN: 'environment-token-0123456' };
    expect(resolve({ profile: 'work' }, env)).toMatchObject({
      token: 'work-profile-token-1234',
      tokenSource: 'profile',
    });
    expect(resolve({}, env)).toMatchObject({
      token: 'environment-token-0123456',
      tokenSource: 'env',
    });
    expect(resolve({})).toMatchObject({
      token: 'default-profile-token-1',
      tokenSource: 'default-profile',
    });
    fs.rmSync(path.join(home, '.clerq', 'cli.json'));
    expect(resolve({})).toMatchObject({ token: file, tokenSource: 'local-file' });
  });

  it('is the local file only for the gateway on this computer, not any loopback port', () => {
    writeLocalToken();
    for (const gateway of [
      'http://127.0.0.1:18790',
      'http://localhost:18790',
      'http://[::1]:18790',
    ]) {
      expect(resolve({ gateway }).tokenSource, gateway).toBe('local-file');
    }
    // Another port on this computer may be anyone's: the token is not handed to it.
    for (const gateway of [
      'http://127.0.0.1:19999',
      'http://localhost:8080',
      'https://clerq.example.com',
    ]) {
      expect(resolve({ gateway }), gateway).toMatchObject({ token: null, tokenSource: 'none' });
    }
    expect(resolve({}, { CLERQ_GATEWAY_URL: 'https://clerq.example.com' }).token).toBeNull();
    // Where this computer's gateway is, the file is its own.
    const moved = resolveConnection({
      flags: {},
      env: {},
      home,
      localUrl: 'http://127.0.0.1:19999',
    });
    expect(moved).toMatchObject({ url: 'http://127.0.0.1:19999', tokenSource: 'local-file' });
  });

  it('never sends a profile’s token to another address', () => {
    writeProfiles({ default: { url: 'https://home.example', token: 'default-profile-token-1' } });
    expect(resolve({ gateway: 'https://elsewhere.example' }).token).toBeNull();
    expect(resolve({}, { CLERQ_GATEWAY_URL: 'https://elsewhere.example' }).token).toBeNull();
    // The same address, spelled with a trailing slash and a different case in the host, is the same.
    expect(resolve({ gateway: 'https://HOME.example/' }).token).toBe('default-profile-token-1');
  });

  it('lets an environment token go to whatever address was chosen: the person set both', () => {
    const env = { CLERQ_GATEWAY_TOKEN: 'environment-token-0123456' };
    expect(resolve({ gateway: 'https://elsewhere.example' }, env).token).toBe(
      'environment-token-0123456'
    );
  });

  it('reads a token file named by a profile each time, and fails plainly when it is gone', () => {
    const tokenFile = path.join(home, 'my-token');
    fs.writeFileSync(tokenFile, 'token-in-its-own-file-0123\n');
    writeProfiles({ default: { url: 'https://home.example', tokenFile } });
    expect(resolve({})).toMatchObject({ token: 'token-in-its-own-file-0123', tokenFile });
    fs.writeFileSync(tokenFile, 'rotated-token-in-the-file-1\n');
    expect(resolve({}).token).toBe('rotated-token-in-the-file-1');
    fs.rmSync(tokenFile);
    expect(() => resolve({})).toThrow(/The token file .*my-token does not exist/);
  });

  it('describes where a token came from without saying it', () => {
    writeProfiles({ default: { url: 'https://home.example', token: 'default-profile-token-1' } });
    const r = resolve({});
    expect(tokenWords(r, home)).toBe('profile "default": stored in ~/.clerq/cli.json');
    expect(urlWords(r, home)).toBe('from the profile "default" in ~/.clerq/cli.json');
    expect(`${tokenWords(r, home)} ${urlWords(r, home)}`).not.toContain('default-profile-token');
  });
});

describe('the address is checked', () => {
  it('knows which hosts are this computer', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      'x.localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of [
      '192.168.1.5',
      '10.0.0.1',
      'example.com',
      '127.example.com',
      '0.0.0.0',
      'localhost.example.com',
    ]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('refuses plain http to another computer unless --insecure, and says why', () => {
    expect(() => assertTransport('http://nas.local:18790', false)).toThrow(
      /plain http to another computer.*readable by anyone/
    );
    expect(() => assertTransport('http://nas.local:18790', true)).not.toThrow();
    expect(() => assertTransport('https://nas.local', false)).not.toThrow();
    expect(() => assertTransport('http://127.0.0.1:18790', false)).not.toThrow();
    expect(() => assertTransport('http://[::1]:18790', false)).not.toThrow();
    expect(() => assertTransport('http://localhost:18790', false)).not.toThrow();
  });

  it('writes an address one way: no slash, no credentials, no query', () => {
    expect(normalizeUrl('https://Clerq.Example.com/')).toBe('https://clerq.example.com');
    expect(normalizeUrl('https://x.example/clerq/')).toBe('https://x.example/clerq');
    expect(normalizeUrl('127.0.0.1:18790')).toBe('http://127.0.0.1:18790');
    expect(normalizeUrl('https://x.example/?a=1#b')).toBe('https://x.example');
    expect(() => normalizeUrl('ftp://x.example')).toThrow(/must start with http/);
    expect(() => normalizeUrl('https://me:pw@x.example')).toThrow(/user name and password/);
    expect(() => normalizeUrl('http://')).toThrow(/not a gateway address/);
  });

  it('knows the gateway on this computer by its port as well as its host', () => {
    expect(isLocalGateway('http://127.0.0.1:18790')).toBe(true);
    expect(isLocalGateway('http://localhost:18790')).toBe(true);
    expect(isLocalGateway('http://127.0.0.1:18791')).toBe(false);
    expect(isLocalGateway('https://127.0.0.1:18790')).toBe(true);
    expect(isLocalGateway('http://nas.local:18790')).toBe(false);
    expect(isLocalGateway('http://127.0.0.1:5000', 'http://127.0.0.1:5000')).toBe(true);
    // No port written: the scheme's own.
    expect(isLocalGateway('http://localhost', 'http://127.0.0.1:80')).toBe(true);
  });

  it('accepts one line of visible characters as a token', () => {
    expect(checkToken('  abc123-token  ', 'x')).toBe('abc123-token');
    expect(() => checkToken('', 'The token')).toThrow(/is empty/);
    expect(() => checkToken('has a space', 'The token')).toThrow(/does not look like a token/);
    expect(() => checkToken('line1\nline2', 'The token')).toThrow(/does not look like a token/);
  });
});
