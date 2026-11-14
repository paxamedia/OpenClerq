/**
 * scripts/verify-signatures.js: the check that a release's signatures are ones the installed
 * apps will accept. The keys here are made by each test run (nothing secret is in the
 * repository), with a signer written below from the minisign format, and, when the Tauri CLI is
 * installed, with the CLI itself: that is the check against what Tauri really writes.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface PublicKey {
  keyId: Buffer;
  key: Buffer;
  line: string;
}
interface Script {
  parsePublicKey(input: string | Buffer): PublicKey;
  parseSignature(input: string | Buffer): { algorithm: string; trustedComment: Buffer };
  verifySignature(o: { publicKey: string | Buffer; signature: string | Buffer; message: Buffer }): {
    algorithm: string;
    keyId: string;
    trustedComment: string;
  };
  verifyFile(publicKey: string | Buffer, file: string, sigFile?: string): { keyId: string };
  pubkeyFromConfig(file?: string): string;
  keyIdText(id: Buffer): string;
  isUpdaterBundle(name: string): boolean;
  parseArgs(argv: string[]): { paths: string[]; require: boolean; sig?: string; pubkey?: string };
  run(
    o: { paths: string[]; require?: boolean; pubkey?: string; sig?: string; printKey?: boolean },
    out?: (l: string) => void,
    err?: (l: string) => void
  ): number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const script = (await import(
  /* @vite-ignore */ pathToFileURL(path.join(root, 'scripts', 'verify-signatures.js')).href
)) as Script;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-sig-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// A minisign signer, written from the format (nothing here is the code under test)
// ---------------------------------------------------------------------------

interface Signer {
  keyId: Buffer;
  raw: Buffer; // the 32-byte public key
  privateKey: crypto.KeyObject;
}

function newSigner(keyId: Buffer = crypto.randomBytes(8)): Signer {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { keyId, raw, privateKey };
}

/** minisign's public key file. */
function publicKeyFile(s: Signer): string {
  const body = Buffer.concat([Buffer.from('Ed'), s.keyId, s.raw]).toString('base64');
  return `untrusted comment: minisign public key: ${Buffer.from(s.keyId).reverse().toString('hex').toUpperCase()}\n${body}\n`;
}

/** minisign's signature file for `data`. */
function signFile(
  s: Signer,
  data: Buffer,
  { algorithm = 'ED', comment = 'timestamp:1\tfile:test.bin' } = {}
): string {
  const message = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  const sig = crypto.sign(null, message, s.privateKey);
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), s.privateKey);
  const body = Buffer.concat([Buffer.from(algorithm), s.keyId, sig]).toString('base64');
  return `untrusted comment: signature from a test key\n${body}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`;
}

/** What Tauri stores: the whole file, base64-encoded. */
const tauriWrap = (file: string) => Buffer.from(file).toString('base64');

const data = crypto.randomBytes(5000);
const signer = newSigner();

describe('a signature made as Tauri makes them', () => {
  it('verifies, in Tauri’s base64 form, as a plain minisign file, and against the bare key line', () => {
    const sig = signFile(signer, data);
    const pub = publicKeyFile(signer);
    const result = script.verifySignature({
      publicKey: tauriWrap(pub),
      signature: tauriWrap(sig),
      message: data,
    });
    expect(result.algorithm).toBe('ED');
    expect(result.trustedComment).toBe('timestamp:1\tfile:test.bin');
    expect(result.keyId).toBe(script.keyIdText(signer.keyId));
    // The same, plain, and with the line `minisign -P` takes.
    const bare = pub.split('\n')[1];
    for (const [k, s] of [
      [pub, sig],
      [bare, tauriWrap(sig)],
      [tauriWrap(pub), sig],
    ] as const) {
      expect(script.verifySignature({ publicKey: k, signature: s, message: data }).algorithm).toBe(
        'ED'
      );
    }
  });

  it('verifies the legacy "Ed" form, which signs the file itself and not its hash', () => {
    const sig = signFile(signer, data, { algorithm: 'Ed' });
    const r = script.verifySignature({
      publicKey: publicKeyFile(signer),
      signature: sig,
      message: data,
    });
    expect(r.algorithm).toBe('Ed');
  });

  it('prints the key id the way minisign does (the bytes reversed)', () => {
    const k = script.parsePublicKey(
      publicKeyFile(newSigner(Buffer.from('c5946ba24cf49411', 'hex')))
    );
    expect(script.keyIdText(k.keyId)).toBe('1194F44CA26B94C5');
  });
});

describe('what must not verify', () => {
  const pub = publicKeyFile(signer);
  const sig = signFile(signer, data);
  const check = (o: { publicKey?: string; signature?: string; message?: Buffer }) => () =>
    script.verifySignature({
      publicKey: o.publicKey ?? pub,
      signature: o.signature ?? sig,
      message: o.message ?? data,
    });

  it('a file that changed by one byte', () => {
    const changed = Buffer.from(data);
    changed[2500] ^= 1;
    expect(check({ message: changed })).toThrow(/does not match the file/);
    expect(check({ message: Buffer.concat([data, Buffer.from('x')]) })).toThrow(
      /does not match the file/
    );
    expect(check({ message: data.subarray(0, 4999) })).toThrow(/does not match the file/);
  });

  it('a key that is not the signer’s, whether it says so with its id or not', () => {
    const other = newSigner();
    expect(check({ publicKey: publicKeyFile(other) })).toThrow(/different key/);
    // Another key under the signer's id: the id matches, the signature does not.
    const impostor = newSigner(signer.keyId);
    expect(check({ publicKey: publicKeyFile(impostor) })).toThrow(/does not match the file/);
  });

  it('a trusted comment that was edited, though the signature over the file is intact', () => {
    const edited = sig.replace('file:test.bin', 'file:other.bin');
    expect(edited).not.toBe(sig);
    expect(check({ signature: edited })).toThrow(/trusted comment/);
    // And a global signature taken from another signature.
    const lines = sig.split('\n');
    const foreign = signFile(signer, data, { comment: 'timestamp:2' }).split('\n');
    lines[3] = foreign[3];
    expect(check({ signature: lines.join('\n') })).toThrow(/trusted comment/);
  });

  it('a signature with a bit flipped, a hash used as if it were the file, and the other algorithm', () => {
    const lines = sig.split('\n');
    const body = Buffer.from(lines[1], 'base64');
    body[40] ^= 1;
    lines[1] = body.toString('base64');
    expect(check({ signature: lines.join('\n') })).toThrow(/does not match the file/);
    // Relabelled "Ed": the signature was over the BLAKE2b hash, not the file.
    const relabelled = sig.split('\n');
    const rb = Buffer.from(relabelled[1], 'base64');
    rb.write('Ed', 0, 'latin1');
    relabelled[1] = rb.toString('base64');
    expect(check({ signature: relabelled.join('\n') })).toThrow(/does not match the file/);
  });

  it('a signature whose key id was changed', () => {
    const lines = sig.split('\n');
    const body = Buffer.from(lines[1], 'base64');
    body[3] ^= 1;
    lines[1] = body.toString('base64');
    expect(check({ signature: lines.join('\n') })).toThrow(/different key/);
  });

  it('files that are not keys or signatures at all', () => {
    expect(() => script.parsePublicKey('hello')).toThrow();
    expect(() => script.parsePublicKey('')).toThrow();
    expect(() => script.parsePublicKey(`untrusted comment: x\n${'A'.repeat(56)}\n`)).toThrow(
      /Ed25519/
    );
    expect(() => script.parsePublicKey(`${pub}\nextra\n`)).toThrow(/two lines/);
    expect(() => script.parseSignature('not a signature')).toThrow(/not a minisign signature/);
    expect(() => script.parseSignature(sig.split('\n').slice(0, 3).join('\n'))).toThrow(/four/);
    expect(() => script.parseSignature(sig.replace(/^trusted comment:/m, 'other:'))).toThrow(
      /no trusted comment/
    );
    expect(() => script.parseSignature(tauriWrap(sig).slice(0, 80))).toThrow();
    const lines = sig.split('\n');
    lines[1] = Buffer.concat([Buffer.from('XX'), Buffer.alloc(72)]).toString('base64');
    expect(() => script.parseSignature(lines.join('\n'))).toThrow(/algorithm/);
    lines[1] = Buffer.alloc(10).toString('base64');
    expect(() => script.parseSignature(lines.join('\n'))).toThrow(/74/);
  });
});

describe('files on disk', () => {
  it('checks a file against its .sig, and a large one without holding it in memory', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'f-'));
    const file = path.join(dir, 'Clerq_1.0.0_x86_64.AppImage');
    fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024 + 17, 7));
    fs.writeFileSync(`${file}.sig`, tauriWrap(signFile(signer, fs.readFileSync(file))));
    expect(script.verifyFile(tauriWrap(publicKeyFile(signer)), file).keyId).toBe(
      script.keyIdText(signer.keyId)
    );
    fs.appendFileSync(file, 'x');
    expect(() => script.verifyFile(publicKeyFile(signer), file)).toThrow(/does not match the file/);
    expect(() => script.verifyFile(publicKeyFile(signer), path.join(dir, 'missing'))).toThrow(
      /does not exist/
    );
  });

  it('reads the app’s own key from tauri.conf.json, which has the shape of a minisign key', () => {
    const key = script.parsePublicKey(script.pubkeyFromConfig());
    expect(key.key).toHaveLength(32);
    expect(key.keyId).toHaveLength(8);
    expect(key.line).toMatch(/^RW[A-Za-z0-9+/]{54}$/);
    // The comment Tauri wrote says the same id the key's bytes do.
    const wrapped = Buffer.from(script.pubkeyFromConfig(), 'base64').toString();
    expect(wrapped).toContain(`minisign public key: ${script.keyIdText(key.keyId)}`);
  });
});

describe('the command', () => {
  /** A folder like the release's: bundles with signatures, some without. */
  function release(files: Record<string, { sign?: Signer | false; data?: string }>) {
    const dir = fs.mkdtempSync(path.join(tmp, 'rel-'));
    for (const [name, o] of Object.entries(files)) {
      const body = Buffer.from(o.data ?? `contents of ${name}`);
      fs.writeFileSync(path.join(dir, name), body);
      if (o.sign)
        fs.writeFileSync(`${path.join(dir, name)}.sig`, tauriWrap(signFile(o.sign, body)));
    }
    return dir;
  }
  const pub = publicKeyFile(signer);
  const go = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const status = script.run(
      script.parseArgs(argv),
      (l) => out.push(l),
      (l) => err.push(l)
    );
    return { status, out: out.join('\n'), err: err.join('\n') };
  };

  it('passes a folder whose signatures all verify, and says which key', () => {
    const dir = release({
      'Clerq_1.0.0_aarch64.app.tar.gz': { sign: signer },
      'Clerq_1.0.0_x64-setup.exe': { sign: signer },
      'Clerq_1.0.0_aarch64.dmg': {},
    });
    const r = go(['--pubkey', pub, '--require', dir]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ok       Clerq_1.0.0_aarch64.app.tar.gz');
    expect(r.out).toContain('2 signatures verified');
    expect(r.out).toContain(script.keyIdText(signer.keyId));
  });

  it('fails a folder with one bad signature, and names the file; the others are still checked', () => {
    const dir = release({
      'a.msi': { sign: signer },
      'b.AppImage': { sign: newSigner() },
      'c.AppImage': { sign: signer },
    });
    const r = go(['--pubkey', pub, dir]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('FAILED   b.AppImage');
    expect(r.out).toContain('ok       a.msi');
    expect(r.out).toContain('ok       c.AppImage');
  });

  it('a changed bundle fails; with --require so does an updater bundle that has no signature', () => {
    const dir = release({ 'a.msi': { sign: signer }, 'b.AppImage': { sign: signer }, 'c.dmg': {} });
    fs.appendFileSync(path.join(dir, 'a.msi'), 'tampered');
    expect(go(['--pubkey', pub, dir]).status).toBe(1);
    const unsigned = release({ 'a.msi': { sign: signer }, 'b.AppImage': {} });
    const lenient = go(['--pubkey', pub, unsigned]);
    expect(lenient.status).toBe(0);
    expect(lenient.err).toContain('b.AppImage has no .sig');
    const strict = go(['--pubkey', pub, '--require', unsigned]);
    expect(strict.status).toBe(1);
    expect(strict.err).toContain('UNSIGNED');
    expect(strict.err).toContain('b.AppImage');
  });

  it('--require refuses a folder with no signatures at all; without it that is a warning', () => {
    const dir = release({ 'Clerq.dmg': {}, 'notes.txt': {} });
    expect(go(['--pubkey', pub, '--require', dir]).status).toBe(1);
    const lenient = go(['--pubkey', pub, dir]);
    expect(lenient.status).toBe(0);
    expect(lenient.err).toContain('Nothing was checked');
  });

  it('takes one file and a signature of another name (a SHA256SUMS.minisig)', () => {
    const dir = release({ SHA256SUMS: { sign: false, data: 'abc  file\n' } });
    fs.writeFileSync(
      path.join(dir, 'SHA256SUMS.minisig'),
      signFile(signer, fs.readFileSync(path.join(dir, 'SHA256SUMS')))
    );
    const sums = path.join(dir, 'SHA256SUMS');
    expect(go(['--pubkey', pub, '--sig', `${sums}.minisig`, sums]).status).toBe(0);
    fs.writeFileSync(sums, 'abd  file\n');
    expect(go(['--pubkey', pub, '--sig', `${sums}.minisig`, sums]).status).toBe(1);
    // a <name>.sig path stands for <name>
    const bundle = release({ 'x.msi': { sign: signer } });
    expect(go(['--pubkey', pub, `${path.join(bundle, 'x.msi')}.sig`]).status).toBe(0);
  });

  it('uses the app’s key by default, so a signature from any other key is refused', () => {
    const dir = release({ 'x.msi': { sign: signer } });
    const r = go([dir]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('different key');
  });

  it('exits 2 for a command line or key it cannot use, and prints the key in minisign form', () => {
    expect(go(['--pubkey', 'not a key', tmp]).status).toBe(2);
    expect(go([path.join(tmp, 'nothing-here')]).status).toBe(2);
    expect(() => script.parseArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => script.parseArgs(['--sig'])).toThrow(/needs a value/);
    expect(() => script.parseArgs(['--sig', 'a', 'b', 'c'])).toThrow(/exactly one/);
    const printed = go(['--print-key']);
    expect(printed.status).toBe(0);
    expect(printed.out).toMatch(/minisign -P: {3}RW[A-Za-z0-9+/]{54}/);
  });

  it('knows which files Tauri signs', () => {
    for (const n of ['a.app.tar.gz', 'a.AppImage', 'a.msi', 'a-setup.exe']) {
      expect(script.isUpdaterBundle(n)).toBe(true);
    }
    for (const n of ['a.dmg', 'a.deb', 'a.rpm', 'latest.json', 'a.exe', 'SHA256SUMS']) {
      expect(script.isUpdaterBundle(n)).toBe(false);
    }
  });
});

describe('against what the Tauri CLI writes', () => {
  const cli = path.join(root, 'apps', 'desktop', 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const present = fs.existsSync(cli);
  const tauri = (args: string[], env: Record<string, string> = {}) =>
    execFileSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

  it.skipIf(!present)(
    'verifies a file `tauri signer sign` signed, and refuses it changed, with another key, or edited',
    () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'tauri-'));
      // A password made for this run, which also proves the key is not one of ours.
      const password = crypto.randomBytes(12).toString('hex');
      const make = (name: string) => {
        const key = path.join(dir, `${name}.key`);
        tauri(['signer', 'generate', '--ci', '-p', password, '-w', key]);
        return { key, pub: fs.readFileSync(`${key}.pub`, 'utf8').trim() };
      };
      const a = make('a');
      const b = make('b');
      const file = path.join(dir, 'Clerq_1.0.0_x86_64.AppImage');
      fs.writeFileSync(file, crypto.randomBytes(100_000));
      tauri(['signer', 'sign', '-f', a.key, '-p', password, file]);

      // Tauri's own public key and signature are base64 of the minisign files.
      const ok = script.verifyFile(a.pub, file);
      expect(script.parseSignature(fs.readFileSync(`${file}.sig`)).algorithm).toBe('ED');
      expect(ok.keyId).toBe(script.keyIdText(script.parsePublicKey(a.pub).keyId));
      expect(() => script.verifyFile(b.pub, file)).toThrow(/different key/);

      // The key and password as the release job passes them: in the environment.
      fs.writeFileSync(`${file}.2`, 'second');
      tauri(['signer', 'sign', `${file}.2`], {
        TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(a.key, 'utf8'),
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
      });
      expect(script.verifyFile(a.pub, `${file}.2`).keyId).toBe(ok.keyId);

      const changed = fs.readFileSync(file);
      changed[10] ^= 1;
      fs.writeFileSync(file, changed);
      expect(() => script.verifyFile(a.pub, file)).toThrow(/does not match the file/);
      fs.writeFileSync(
        file,
        Buffer.concat([
          changed.subarray(0, 10),
          Buffer.from([changed[10] ^ 1]),
          changed.subarray(11),
        ])
      );
      expect(script.verifyFile(a.pub, file).keyId).toBe(ok.keyId);

      // Its trusted comment names the file; rewriting it breaks the global signature.
      const sigText = Buffer.from(fs.readFileSync(`${file}.sig`, 'utf8'), 'base64').toString();
      const edited = sigText.replace(
        'file:Clerq_1.0.0_x86_64.AppImage',
        'file:Clerq_9.9.9_x86_64.AppImage'
      );
      expect(edited).not.toBe(sigText);
      fs.writeFileSync(`${file}.sig`, Buffer.from(edited).toString('base64'));
      expect(() => script.verifyFile(a.pub, file)).toThrow(/trusted comment/);
    }
  );
});

describe('the key a release is signed with', () => {
  interface Signing {
    signingKey(
      conf?: string,
      bridge?: string,
      proof?: string,
      releaseVersion?: string
    ): { pubkey: string | Buffer; bridge: boolean; version: string };
    bridgeStatementFor(conf?: string, bridge?: string): string;
  }
  const keys = script as unknown as Signing;

  /** A checkout in a temporary folder: a config for `version` trusting `next`, and its bridge files, if any. */
  function checkout(version: string, next: Signer) {
    const dir = fs.mkdtempSync(path.join(tmp, 'conf-'));
    const conf = path.join(dir, 'tauri.conf.json');
    fs.writeFileSync(
      conf,
      JSON.stringify({ version, plugins: { updater: { pubkey: tauriWrap(publicKeyFile(next)) } } })
    );
    return {
      dir,
      conf,
      bridge: path.join(dir, 'updater-bridge.pub'),
      proof: path.join(dir, 'updater-bridge.proof'),
    };
  }
  /** A whole rotation's bridge: the old key in the bridge file, and a proof signed by `prover`. */
  function bridgeOf(version = '1.0.1', prover?: (next: Signer) => Signer) {
    const old = newSigner();
    const next = newSigner();
    const c = checkout(version, next);
    fs.writeFileSync(c.bridge, publicKeyFile(old));
    const statement = keys.bridgeStatementFor(c.conf, c.bridge);
    fs.writeFileSync(
      c.proof,
      tauriWrap(signFile(prover ? prover(next) : next, Buffer.from(statement)))
    );
    return { ...c, old, next };
  }
  const signing = (c: { conf: string; bridge: string; proof: string }, v?: string) =>
    keys.signingKey(c.conf, c.bridge, c.proof, v);

  it('is the app’s own key when there is no bridge', () => {
    const c = checkout('1.0.0', newSigner());
    const k = signing(c);
    expect(k).toMatchObject({ bridge: false, version: '1.0.0' });
    expect(script.parsePublicKey(k.pubkey).line).toBe(
      script.parsePublicKey(fs.readFileSync(c.conf, 'utf8').match(/"pubkey":"([^"]+)"/)![1]).line
    );
  });

  it('is the previous key in a bridge release, when the holder of the new key has signed for this version', () => {
    const b = bridgeOf('1.0.1');
    const k = signing(b);
    expect(k).toMatchObject({ bridge: true, version: '1.0.1' });
    // The key that signs the release is the OLD one, which the installed apps trust now.
    expect(script.parsePublicKey(k.pubkey).key).toEqual(
      script.parsePublicKey(publicKeyFile(b.old)).key
    );
    // The proof may as well be the plain file; the tag may be given with the version.
    fs.writeFileSync(
      b.proof,
      signFile(b.next, Buffer.from(keys.bridgeStatementFor(b.conf, b.bridge)))
    );
    expect(signing(b, '1.0.1').bridge).toBe(true);
  });

  it('refuses a bridge to a key nobody has shown they hold: no proof, or a proof by any other key', () => {
    const b = bridgeOf();
    fs.rmSync(b.proof);
    expect(() => signing(b)).toThrow(/updater-bridge\.proof is not/);
    // Someone sets the config to key X and signs a "proof" with the old key, a third key, or X's
    // public half: only a signature made with X's private key counts.
    for (const who of [b.old, newSigner(), newSigner(b.next.keyId)]) {
      fs.writeFileSync(
        b.proof,
        tauriWrap(signFile(who, Buffer.from(keys.bridgeStatementFor(b.conf, b.bridge))))
      );
      expect(() => signing(b), 'a proof by another key').toThrow(/does not prove this bridge/);
    }
    // Garbage, and a proof of something else, made with the right key.
    fs.writeFileSync(b.proof, 'nothing');
    expect(() => signing(b)).toThrow(/does not prove this bridge/);
    fs.writeFileSync(b.proof, tauriWrap(signFile(b.next, Buffer.from('I agree\n'))));
    expect(() => signing(b)).toThrow(/does not prove this bridge/);
  });

  it('refuses a bridge left in place for the next release: the proof is for one version', () => {
    const b = bridgeOf('1.0.1');
    expect(signing(b).bridge).toBe(true);
    // The hotfix: the same files, the next version in the config (and the tag).
    fs.writeFileSync(
      b.conf,
      fs.readFileSync(b.conf, 'utf8').replace('"version":"1.0.1"', '"version":"1.0.2"')
    );
    expect(() => signing(b)).toThrow(/for version 1\.0\.2.*after it, delete both bridge files/);
  });

  it('refuses a proof for other keys: another previous key under the same new key, or another new key', () => {
    const b = bridgeOf();
    fs.writeFileSync(b.bridge, publicKeyFile(newSigner()));
    expect(() => signing(b)).toThrow(/does not prove this bridge/);
    const c = bridgeOf();
    fs.writeFileSync(
      c.conf,
      JSON.stringify({
        version: '1.0.1',
        plugins: { updater: { pubkey: tauriWrap(publicKeyFile(newSigner())) } },
      })
    );
    expect(() => signing(c)).toThrow(/does not prove this bridge/);
  });

  it('refuses a bridge file that holds the app’s own key, a proof with no bridge, a tag that is not the config’s version', () => {
    const own = newSigner();
    const c = checkout('1.0.1', own);
    fs.writeFileSync(c.bridge, publicKeyFile(own));
    expect(() => signing(c)).toThrow(/same key/);
    fs.writeFileSync(c.bridge, 'not a key');
    expect(() => signing(c)).toThrow();
    fs.rmSync(c.bridge);
    fs.writeFileSync(c.proof, 'left over');
    expect(() => signing(c)).toThrow(/is here and updater-bridge\.pub is not/);
    fs.rmSync(c.proof);
    expect(() => signing(c, '1.0.2')).toThrow(
      /The release is 1\.0\.2 and tauri\.conf\.json says 1\.0\.1/
    );
    expect(signing(c, '1.0.1').bridge).toBe(false);
  });

  it('is what the command checks releases against, and says plainly that this is a bridge', () => {
    const b = bridgeOf('1.0.1');
    const dir = fs.mkdtempSync(path.join(tmp, 'rel-'));
    const body = Buffer.from('bundle');
    fs.writeFileSync(path.join(dir, 'x.msi'), body);
    fs.writeFileSync(path.join(dir, 'x.msi.sig'), tauriWrap(signFile(b.old, body)));
    const go = (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const status = script.run(
        script.parseArgs(argv),
        (l) => out.push(l),
        (l) => err.push(l)
      );
      return { status, out: out.join('\n'), err: err.join('\n') };
    };
    const ok = go(['--config', b.conf, '--version', 'v1.0.1', '--require', dir]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('BRIDGE RELEASE 1.0.1');
    expect(ok.out).toContain('PREVIOUS key');
    expect(ok.out).toContain(`key ${script.keyIdText(b.old.keyId)}`);
    // Signed with the new key, the bundle is one the installed apps would refuse.
    fs.writeFileSync(path.join(dir, 'x.msi.sig'), tauriWrap(signFile(b.next, body)));
    expect(go(['--config', b.conf, dir]).status).toBe(1);
    // A tag that is not the bridge's version, and a bridge with no proof, stop the check itself.
    const wrongTag = go(['--config', b.conf, '--version', '1.0.2', dir]);
    expect(wrongTag.status).toBe(2);
    expect(wrongTag.err).toContain('The release is 1.0.2');
    fs.rmSync(b.proof);
    const noProof = go(['--config', b.conf, '--key-line']);
    expect(noProof.status).toBe(2);
    expect(noProof.err).toContain('Cannot tell which key signs this release');
  });

  it('writes the statement for the new key to sign, which is the one the check recomputes', () => {
    const b = bridgeOf('1.0.1');
    const file = path.join(b.dir, 'statement.txt');
    const out: string[] = [];
    expect(
      script.run(script.parseArgs(['--config', b.conf, '--bridge-statement', file]), (l) =>
        out.push(l)
      )
    ).toBe(0);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toBe(keys.bridgeStatementFor(b.conf, b.bridge));
    expect(text).toContain('version: 1.0.1\n');
    expect(text).toContain(`previous: ${script.parsePublicKey(publicKeyFile(b.old)).line}\n`);
    expect(text).toContain(`next: ${script.parsePublicKey(publicKeyFile(b.next)).line}\n`);
    expect(out.join('\n')).toContain('NEW private key');
    // No bridge, no statement.
    const none = checkout('1.0.1', newSigner());
    expect(
      script.run(
        script.parseArgs(['--config', none.conf, '--bridge-statement', file]),
        undefined,
        () => {}
      )
    ).toBe(2);
  });

  const cli = path.join(root, 'apps', 'desktop', 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  it.skipIf(!fs.existsSync(cli))(
    'accepts a proof the Tauri CLI signed with a key it generated, which is how an owner makes one',
    () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'tauri-bridge-'));
      const password = crypto.randomBytes(12).toString('hex');
      const keyFile = path.join(dir, 'new.key');
      const tauri = (args: string[], env: Record<string, string> = {}) =>
        execFileSync(process.execPath, [cli, ...args], {
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        });
      tauri(['signer', 'generate', '--ci', '-p', password, '-w', keyFile]);
      const old = newSigner();
      const c = checkout('2.0.0', newSigner());
      fs.writeFileSync(
        c.conf,
        JSON.stringify({
          version: '2.0.0',
          plugins: { updater: { pubkey: fs.readFileSync(`${keyFile}.pub`, 'utf8').trim() } },
        })
      );
      fs.writeFileSync(c.bridge, publicKeyFile(old));
      const statement = path.join(dir, 'statement.txt');
      expect(
        script.run(
          script.parseArgs(['--config', c.conf, '--bridge-statement', statement]),
          () => {}
        )
      ).toBe(0);
      tauri(['signer', 'sign', '-f', keyFile, '-p', password, statement]);
      fs.copyFileSync(`${statement}.sig`, c.proof);
      expect(signing(c, '2.0.0')).toMatchObject({ bridge: true, version: '2.0.0' });
      // The next release with the same files: refused.
      fs.writeFileSync(c.conf, fs.readFileSync(c.conf, 'utf8').replace('2.0.0', '2.0.1'));
      expect(() => signing(c)).toThrow(/does not prove this bridge/);
    }
  );

  it('is the one the installer carries, so that SHA256SUMS is checked with what signs it', () => {
    const installer = fs.readFileSync(path.join(root, 'apps/server/install.sh'), 'utf8');
    const embedded = /^MINISIGN_KEY="(RW[A-Za-z0-9+/]{54})"$/m.exec(installer)?.[1];
    expect(embedded).toBeDefined();
    const k = keys.signingKey();
    expect(script.parsePublicKey(embedded as string).key).toEqual(
      script.parsePublicKey(k.pubkey).key
    );
    expect(script.parsePublicKey(embedded as string).keyId).toEqual(
      script.parsePublicKey(k.pubkey).keyId
    );
  });
});
