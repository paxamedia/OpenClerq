#!/usr/bin/env node
/**
 * Verify minisign signatures, the format Tauri signs updater bundles in, against the public
 * key the desktop app trusts (`plugins.updater.pubkey` in tauri.conf.json), with nothing but
 * node:crypto.
 *
 *   node scripts/verify-signatures.js release/                  every <file>.sig in the folder
 *   node scripts/verify-signatures.js --require release/        ... and each updater bundle must have one
 *   node scripts/verify-signatures.js Clerq_1.0.0_x86_64.AppImage
 *   node scripts/verify-signatures.js --sig SHA256SUMS.minisig SHA256SUMS
 *   node scripts/verify-signatures.js --pubkey ~/.tauri/clerq-updater.key.pub release/
 *   node scripts/verify-signatures.js --print-key               the app's key, in minisign form
 *   node scripts/verify-signatures.js --key-line                just the line `minisign -P` takes
 *
 * A path is a folder (every `*.sig` in it, not below it, checked against the file next to it),
 * a `<name>.sig` (checked against `<name>`), or a file (checked against `<file>.sig`, or the
 * one --sig names). The public key is --pubkey (a file, or the text itself) or, by default, the
 * key this checkout's releases are signed with: the one in apps/desktop/src-tauri/tauri.conf.json,
 * the key the apps trust, except in the one release of a key rotation, the bridge, which is signed
 * with the previous key and says so by having apps/desktop/src-tauri/updater-bridge.pub and
 * updater-bridge.proof (docs/RELEASING.md). The proof is a signature, made with the NEW key, of a
 * statement that names this release's version, the previous key and the new key: without it nobody
 * has shown that anyone holds the key the apps are about to be told to trust, and the proof of
 * one version is no proof for the next, so a bridge left in place fails the release after it.
 *
 * --require, for a folder: there must be at least one signature, and every updater bundle in it
 * (`.app.tar.gz`, `.AppImage`, `.msi`, `-setup.exe`: what the app's updater uses) must have one. A release
 * with an unsigned bundle is one no installed app will update to.
 *
 * Exit status: 0 when every signature verified, 1 when one did not (or --require is not met),
 * 2 for a command line that cannot be used.
 *
 * What is checked, for each signature (the minisign format, https://jedisct1.github.io/minisign/):
 *   - the signature file has the four lines minisign writes, and the key id in it is the key's;
 *   - Ed25519 over the file ("Ed"), or over the file's BLAKE2b-512 hash ("ED", what Tauri writes);
 *   - the trusted comment, which is signed too: a second Ed25519 signature over the first
 *     signature and the comment's bytes. A file whose comment was edited does not verify.
 * Tauri keeps a whole minisign file base64-encoded in its public key and in each `.sig`; a
 * plain minisign file, and the bare key line `minisign -P` takes, are accepted as well.
 *
 * No secret key is ever read here, and nothing is written.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CONF = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
/** Exists only in a rotation's bridge release: the previous public key, which still signs that release. */
const BRIDGE_KEY = path.join(path.dirname(TAURI_CONF), 'updater-bridge.pub');
/** Its companion: a signature by the new key that the new key's holder agreed to this bridge. */
const BRIDGE_PROOF = path.join(path.dirname(TAURI_CONF), 'updater-bridge.proof');

const UNTRUSTED = 'untrusted comment:';
const TRUSTED = 'trusted comment: ';

/** A key or signature that is not usable, or does not verify; the message says which. */
export class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignatureError';
  }
}

function fail(message) {
  throw new SignatureError(message);
}

/** Text or bytes -> bytes. */
function bytesOf(input) {
  return Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
}

function decodeBase64(text, what) {
  const clean = text.replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) fail(`${what} is not base64.`);
  return Buffer.from(clean, 'base64');
}

/**
 * The minisign file inside `input`, as a latin1 string (so every byte survives a round trip):
 * the input itself when it is one, else its base64 decoding, which is how Tauri keeps it.
 * Returns null when it is neither.
 */
function minisignText(input) {
  const raw = bytesOf(input).toString('latin1').trim();
  if (raw.startsWith(UNTRUSTED)) return raw;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;
  try {
    const inner = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('latin1').trim();
    return inner.startsWith(UNTRUSTED) ? inner : null;
  } catch {
    return null;
  }
}

/** The key id as minisign prints it: the eight bytes in reverse, upper-case hex. */
export function keyIdText(keyId) {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

/**
 * A minisign public key: the file, Tauri's base64 of the file, or the bare line
 * ("RWT...", what `minisign -P` is given).
 * Returns { keyId: Buffer(8), key: Buffer(32), comment, line }, `line` being the bare form.
 */
export function parsePublicKey(input) {
  const text = minisignText(input);
  let line;
  let comment = '';
  if (text !== null) {
    const lines = text.split(/\r?\n/).filter((l, i) => i < 2 || l.trim() !== '');
    if (lines.length !== 2) fail('The public key file must have two lines: a comment and the key.');
    comment = lines[0].slice(UNTRUSTED.length).trim();
    line = lines[1].trim();
  } else {
    line = bytesOf(input).toString('latin1').trim();
  }
  const bytes = decodeBase64(line, 'The public key');
  if (bytes.length !== 42) {
    fail(`The public key is ${bytes.length} bytes; a minisign Ed25519 key is 42 (algorithm, key id, key).`);
  }
  if (bytes.subarray(0, 2).toString('latin1') !== 'Ed') {
    fail('The public key is not an Ed25519 minisign key (it must start "RW").');
  }
  return { keyId: bytes.subarray(2, 10), key: bytes.subarray(10, 42), comment, line };
}

/**
 * A minisign signature file, plain or in Tauri's base64. Returns
 * { algorithm: 'Ed' | 'ED', keyId, signature, trustedComment (a Buffer), globalSignature,
 *   untrustedComment }.
 */
export function parseSignature(input) {
  const text = minisignText(input);
  if (text === null) fail('The signature is not a minisign signature (nor Tauri’s base64 of one).');
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length !== 4) {
    fail(
      `The signature has ${lines.length} lines; minisign writes four (comment, signature, trusted comment, global signature).`
    );
  }
  if (!lines[0].startsWith(UNTRUSTED)) fail('The signature does not begin with its comment.');
  if (!lines[2].startsWith(TRUSTED)) fail('The signature has no trusted comment.');
  const body = decodeBase64(lines[1].trim(), 'The signature');
  if (body.length !== 74) {
    fail(`The signature is ${body.length} bytes; a minisign one is 74 (algorithm, key id, signature).`);
  }
  const algorithm = body.subarray(0, 2).toString('latin1');
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    fail(`The signature's algorithm is "${algorithm}"; only Ed and ED (prehashed) exist.`);
  }
  const globalSignature = decodeBase64(lines[3].trim(), 'The global signature');
  if (globalSignature.length !== 64) {
    fail(`The global signature is ${globalSignature.length} bytes; it must be 64.`);
  }
  return {
    algorithm,
    keyId: body.subarray(2, 10),
    signature: body.subarray(10, 74),
    trustedComment: Buffer.from(lines[2].slice(TRUSTED.length), 'latin1'),
    globalSignature,
    untrustedComment: lines[0].slice(UNTRUSTED.length).trim(),
  };
}

function nodeKey(raw32) {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw32.toString('base64url') },
    format: 'jwk',
  });
}

/** The BLAKE2b-512 hash of a file, read in pieces. */
export function blake2b512File(file) {
  const hash = crypto.createHash('blake2b512');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest();
}

/**
 * Check one signature. `message` is the file's bytes, or a function that returns what is
 * signed for a given algorithm (so a large file is hashed in pieces, not held in memory):
 * `(algorithm) => Buffer`. Throws SignatureError; otherwise returns
 * { algorithm, keyId (as text), trustedComment (as text) }.
 */
export function verifySignature({ publicKey, signature, message }) {
  const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey) ? parsePublicKey(publicKey) : publicKey;
  const sig =
    typeof signature === 'string' || Buffer.isBuffer(signature) ? parseSignature(signature) : signature;
  if (!crypto.timingSafeEqual(key.keyId, sig.keyId)) {
    fail(
      `It was signed with a different key (id ${keyIdText(sig.keyId)}); the key it is checked against is ${keyIdText(key.keyId)}.`
    );
  }
  const data =
    typeof message === 'function'
      ? message(sig.algorithm)
      : sig.algorithm === 'ED'
        ? crypto.createHash('blake2b512').update(message).digest()
        : message;
  const verifier = nodeKey(key.key);
  if (!crypto.verify(null, data, verifier, sig.signature)) {
    fail('The signature does not match the file: the file is not what was signed, or the key is not the signer’s.');
  }
  if (!crypto.verify(null, Buffer.concat([sig.signature, sig.trustedComment]), verifier, sig.globalSignature)) {
    fail('The trusted comment does not match its signature: the signature file was edited.');
  }
  return {
    algorithm: sig.algorithm,
    keyId: keyIdText(sig.keyId),
    trustedComment: sig.trustedComment.toString('utf8'),
  };
}

/** Check `file` against the signature in `sigFile`. Throws SignatureError. */
export function verifyFile(publicKey, file, sigFile = `${file}.sig`) {
  if (!fs.existsSync(file)) fail(`${file} does not exist.`);
  if (!fs.existsSync(sigFile)) fail(`${sigFile} does not exist.`);
  return verifySignature({
    publicKey,
    signature: fs.readFileSync(sigFile),
    message: (algorithm) =>
      algorithm === 'ED' ? blake2b512File(file) : fs.readFileSync(file),
  });
}

/** The public key the desktop app trusts: `plugins.updater.pubkey` of a tauri.conf.json. */
export function pubkeyFromConfig(configFile = TAURI_CONF) {
  const conf = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const key = conf?.plugins?.updater?.pubkey;
  if (typeof key !== 'string' || key.trim() === '') {
    fail(`${configFile} has no plugins.updater.pubkey.`);
  }
  return key;
}

/** The app's version, from a tauri.conf.json. */
export function versionFromConfig(configFile = TAURI_CONF) {
  const version = JSON.parse(fs.readFileSync(configFile, 'utf8'))?.version;
  if (typeof version !== 'string' || version.trim() === '') fail(`${configFile} has no version.`);
  return version.trim();
}

/**
 * What the new key signs to say "I hold this key, and this bridge is mine": the version it is for,
 * the key the apps trust now and the key they will trust. Both keys are in their bare form.
 */
export function bridgeStatement({ version, previous, next }) {
  return `OpenClerq updater key bridge\nversion: ${version}\nprevious: ${previous.line}\nnext: ${next.line}\n`;
}

/** The statement for this checkout's bridge (`updater-bridge.pub` and the config), to be signed with the new key. */
export function bridgeStatementFor(confFile = TAURI_CONF, bridgeFile = BRIDGE_KEY) {
  if (!fs.existsSync(bridgeFile)) fail(`${path.basename(bridgeFile)} does not exist: there is no bridge to make a proof for.`);
  return bridgeStatement({
    version: versionFromConfig(confFile),
    previous: parsePublicKey(fs.readFileSync(bridgeFile)),
    next: parsePublicKey(pubkeyFromConfig(confFile)),
  });
}

/**
 * The key a checkout's releases are signed with, as { pubkey, bridge, version }. Normally that is
 * the app's own key. In the bridge release of a key rotation, tauri.conf.json already holds the
 * new key (so the apps built from it trust that from then on) while the release is still signed
 * with the old one, which is what the installed apps trust and verify the bridge with: the old
 * key's public half is then in `updater-bridge.pub`.
 *
 * A bridge changes what every app that installs it will trust, so it is accepted only with
 * `updater-bridge.proof`: a signature by the new key (the one in the config) of the bridge's
 * statement, which names the version in the config. A missing proof, one made with another key
 * (nobody has shown they hold the new one: apps that took the bridge could never update again),
 * or one made for another version (a bridge left in place when a later release is made: apps that
 * took the bridge would refuse a release signed with the old key) is refused. A bridge file that
 * holds the app's own key is a mistake, and so is a proof with no bridge. `releaseVersion`, when
 * given (the tag's), must be the config's.
 */
export function signingKey(
  confFile = TAURI_CONF,
  bridgeFile = BRIDGE_KEY,
  proofFile = path.join(path.dirname(bridgeFile), 'updater-bridge.proof'),
  releaseVersion = undefined
) {
  const app = pubkeyFromConfig(confFile);
  const version = versionFromConfig(confFile);
  if (releaseVersion !== undefined && releaseVersion !== version) {
    fail(`The release is ${releaseVersion} and ${path.basename(confFile)} says ${version}.`);
  }
  const bridgeName = path.basename(bridgeFile);
  const proofName = path.basename(proofFile);
  if (!fs.existsSync(bridgeFile)) {
    if (fs.existsSync(proofFile)) {
      fail(`${proofName} is here and ${bridgeName} is not: delete the proof too, or put the bridge back.`);
    }
    return { pubkey: app, bridge: false, version };
  }
  const previous = fs.readFileSync(bridgeFile);
  const old = parsePublicKey(previous);
  const current = parsePublicKey(app);
  if (old.key.equals(current.key)) {
    fail(
      `${bridgeName} holds the same key as ${path.basename(confFile)}: a bridge release changes the key. Delete the file if the rotation is over.`
    );
  }
  if (!fs.existsSync(proofFile)) {
    fail(
      `${bridgeName} is here and ${proofName} is not. A bridge tells every app that installs it to trust ${keyIdText(current.keyId)} from then on, so the holder of that key must sign a proof (node scripts/verify-signatures.js --bridge-statement <file>, signed with the new private key: docs/RELEASING.md). If the rotation is over, delete ${bridgeName}.`
    );
  }
  try {
    verifySignature({
      publicKey: current,
      signature: fs.readFileSync(proofFile),
      message: Buffer.from(bridgeStatement({ version, previous: old, next: current })),
    });
  } catch (e) {
    fail(
      `${proofName} does not prove this bridge: it must be a signature, made with the new private key (${keyIdText(current.keyId)}), of the statement for version ${version}, the previous key ${keyIdText(old.keyId)} and the new key. It was made with another key (if nobody holds the new key, the apps that install this release could never update in-app again), or for another version (a bridge belongs to one release: after it, delete both bridge files), or for other keys. (${e.message})`
    );
  }
  return { pubkey: previous, bridge: true, version };
}

/** The bundles the app's updater uses, by name: `--require` wants a signature for each. (Tauri 2.10 signs the .deb and .rpm too, which the updater is not offered, so they are verified when they have one and not required to.) */
export function isUpdaterBundle(name) {
  return (
    name.endsWith('.app.tar.gz') ||
    name.endsWith('.AppImage') ||
    name.endsWith('.msi') ||
    name.endsWith('-setup.exe')
  );
}

/** Make a trusted comment safe to print. */
function printable(text) {
  return text.replace(/[^\x20-\x7e\t]/g, '?').replace(/\t/g, '  ');
}

const USAGE = `Usage: node scripts/verify-signatures.js [options] <folder | file | file.sig>...
  --pubkey <file|text>   The public key to check against (default: the key releases are signed
                         with: plugins.updater.pubkey of apps/desktop/src-tauri/tauri.conf.json,
                         or, in a key rotation's bridge release, updater-bridge.pub beside it,
                         accepted only with a valid updater-bridge.proof)
  --config <file>        Read the key, the version and the bridge files beside this tauri.conf.json
  --version <x.y.z>      The version being released (the tag's); it must be the config's
  --bridge-statement <file>
                         Write the statement the NEW key must sign for this bridge, and exit
  --sig <file>           The signature of the one file given (default: <file>.sig)
  --require              For a folder: at least one signature, and one for every updater bundle
  --print-key            Print the public key in minisign form and exit
  --key-line             Print only the key line (what minisign -P takes) and exit
  -h, --help             This text`;

/** Parse argv; throws an Error whose message says what is wrong. */
export function parseArgs(argv) {
  const o = { paths: [], require: false, printKey: false, keyLine: false, help: false };
  const args = [...argv];
  const take = (flag) => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  while (args.length > 0) {
    const a = args.shift();
    if (a === '--pubkey') o.pubkey = take(a);
    else if (a === '--sig') o.sig = take(a);
    else if (a === '--config') o.config = take(a);
    else if (a === '--version') o.version = take(a).replace(/^v/, '');
    else if (a === '--bridge-statement') o.bridgeStatement = take(a);
    else if (a === '--require') o.require = true;
    else if (a === '--print-key') o.printKey = true;
    else if (a === '--key-line') o.keyLine = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else o.paths.push(a);
  }
  if (o.sig && o.paths.length !== 1) throw new Error('--sig goes with exactly one file.');
  return o;
}

/** The public key for the options: a file named by --pubkey, the text, or the one releases are signed with. */
function loadPublicKey(o) {
  if (o.pubkey === undefined) {
    const conf = o.config ? path.resolve(o.config) : TAURI_CONF;
    const bridge = path.join(path.dirname(conf), 'updater-bridge.pub');
    return signingKey(conf, bridge, path.join(path.dirname(conf), 'updater-bridge.proof'), o.version);
  }
  if (fs.existsSync(o.pubkey) && fs.statSync(o.pubkey).isFile()) {
    return { pubkey: fs.readFileSync(o.pubkey), bridge: false };
  }
  return { pubkey: o.pubkey, bridge: false };
}

/** The (file, signature) pairs a path stands for, and the bundles that lack a signature. */
function pairsFor(p, o) {
  if (!fs.existsSync(p)) throw new Error(`${p} does not exist.`);
  if (fs.statSync(p).isDirectory()) {
    const names = fs.readdirSync(p).sort();
    const pairs = [];
    const missing = [];
    for (const name of names) {
      const full = path.join(p, name);
      if (!fs.statSync(full).isFile()) continue;
      if (name.endsWith('.sig')) {
        pairs.push({ file: path.join(p, name.slice(0, -4)), sig: full });
      } else if (isUpdaterBundle(name) && !names.includes(`${name}.sig`)) {
        missing.push(full);
      }
    }
    return { pairs, missing, folder: true };
  }
  if (p.endsWith('.sig') && !o.sig) return { pairs: [{ file: p.slice(0, -4), sig: p }], missing: [] };
  return { pairs: [{ file: p, sig: o.sig ?? `${p}.sig` }], missing: [] };
}

/** Run with parsed options; returns the exit status. `out` and `err` write a line. */
export function run(o, out = console.log, err = console.error) {
  if (o.help) {
    out(USAGE);
    return 0;
  }
  if (o.bridgeStatement) {
    try {
      const conf = o.config ? path.resolve(o.config) : TAURI_CONF;
      const text = bridgeStatementFor(conf, path.join(path.dirname(conf), 'updater-bridge.pub'));
      fs.writeFileSync(o.bridgeStatement, text);
      out(
        `Wrote ${o.bridgeStatement}. Sign it with the NEW private key (pnpm --dir apps/desktop exec tauri signer sign <that file>) and keep the signature as updater-bridge.proof beside tauri.conf.json.`
      );
      return 0;
    } catch (e) {
      err(e.message);
      return 2;
    }
  }
  let publicKey;
  try {
    const chosen = loadPublicKey(o);
    publicKey = parsePublicKey(chosen.pubkey);
    if (chosen.bridge && !o.keyLine) {
      out(
        `BRIDGE RELEASE ${chosen.version}: checking against the PREVIOUS key (updater-bridge.pub), the one installed apps trust now. The holder of the key in tauri.conf.json signed updater-bridge.proof for this version only; apps that install this release will trust that key from then on. The bridge belongs to this release: delete both bridge files before any other release.`
      );
    }
  } catch (e) {
    err(`Cannot tell which key signs this release: ${e.message}`);
    return 2;
  }
  if (o.keyLine) {
    out(publicKey.line);
    return 0;
  }
  if (o.printKey) {
    out(`key id:        ${keyIdText(publicKey.keyId)}`);
    out(`minisign -P:   ${publicKey.line}`);
    out('minisign file:');
    out(`untrusted comment: minisign public key: ${keyIdText(publicKey.keyId)}`);
    out(publicKey.line);
    return 0;
  }
  if (o.paths.length === 0) {
    err(USAGE);
    return 2;
  }
  let failed = 0;
  let checked = 0;
  for (const p of o.paths) {
    let found;
    try {
      found = pairsFor(p, o);
    } catch (e) {
      err(e.message);
      return 2;
    }
    for (const file of found.missing) {
      if (o.require) {
        err(`UNSIGNED  ${file}: an updater bundle with no ${path.basename(file)}.sig`);
        failed++;
      } else {
        err(`warning: ${file} has no .sig; the app would refuse it as an update.`);
      }
    }
    if (o.require && found.folder && found.pairs.length === 0) {
      err(`NO SIGNATURES in ${p}: a release must carry signed updater bundles.`);
      failed++;
    }
    for (const { file, sig } of found.pairs) {
      try {
        const r = verifyFile(publicKey, file, sig);
        checked++;
        out(`ok       ${path.basename(file)}  (key ${r.keyId}, ${r.algorithm}; ${printable(r.trustedComment)})`);
      } catch (e) {
        failed++;
        err(`FAILED   ${path.basename(file)}: ${e.message}`);
      }
    }
  }
  if (failed > 0) {
    err(`${failed} problem${failed === 1 ? '' : 's'}; ${checked} signature${checked === 1 ? '' : 's'} verified.`);
    return 1;
  }
  if (checked === 0) {
    err('Nothing was checked: no signatures found.');
    return o.require ? 1 : 0;
  }
  out(`${checked} signature${checked === 1 ? '' : 's'} verified against key ${keyIdText(publicKey.keyId)}.`);
  return 0;
}

/** Was this file started as the program, and not imported? (Real paths, so case and links do not matter.) */
function isMain() {
  try {
    return (
      fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  process.exit(run(options));
}
