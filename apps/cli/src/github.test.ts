/**
 * `clerq github`: the parts that need no gateway (how the commands parse, what the
 * form page says, which addresses are followed, what a key file must be). The
 * commands against a real gateway and a fake GitHub are in github.e2e.test.ts.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './args.js';
import { COMMANDS } from './commands.js';
import { assertCallbackAddress, formPage, loginWaitMs, safeLink } from './cmd/github.js';
import { helpFor } from './help.js';
import { openerFor } from './open.js';
import { cli } from './test-harness.js';

const offer = {
  url: 'https://github.com/settings/apps/new?state=abc',
  manifest: {
    name: 'Clerq "<x>" & co',
    redirect_url: 'http://127.0.0.1:18790/v1/github/app/callback',
  },
  state: 'abc',
  expiresAt: '2026-11-14T10:00:00.000Z',
  redirectUrl: 'http://127.0.0.1:18790/v1/github/app/callback',
};

describe('the commands', () => {
  const parse = (words: string[]) => parseArgs(words, COMMANDS);

  it('are all listed, under github', () => {
    expect(COMMANDS.filter((c) => c.path[0] === 'github').map((c) => c.path[1])).toEqual([
      'connect',
      'import',
      'status',
      'disconnect',
      'login',
      'logout',
      'repos',
    ]);
    const help = helpFor(COMMANDS, ['github'], '1.0.0') as string;
    for (const word of ['connect', 'import', 'status', 'disconnect', 'login', 'logout', 'repos']) {
      expect(help).toContain(word);
    }
  });

  it('read their options', () => {
    const connect = parse([
      'github',
      'connect',
      '--org',
      'acme',
      '--name',
      'Acme Clerq',
      '--no-browser',
    ]);
    expect(connect).toMatchObject({
      kind: 'call',
      call: { opts: { org: 'acme', name: 'Acme Clerq', 'no-browser': true } },
    });
    const imp = parse([
      'github',
      'import',
      '--app-id',
      '12',
      '--client-id',
      'Iv23li',
      '--private-key-file',
      'k.pem',
      '--client-secret-file',
      's.txt',
    ]);
    expect(imp).toMatchObject({
      kind: 'call',
      call: {
        opts: {
          'app-id': '12',
          'client-id': 'Iv23li',
          'private-key-file': 'k.pem',
          'client-secret-file': 's.txt',
        },
      },
    });
    expect(parse(['github', 'repos', '--add', 'acme/app', '--json'])).toMatchObject({
      kind: 'call',
      call: { opts: { add: 'acme/app', json: true } },
    });
    expect(parse(['github', 'disconnect', '--yes'])).toMatchObject({ kind: 'call' });
    expect(parse(['github', 'status', '--refresh'])).toMatchObject({ kind: 'call' });
  });

  it('refuse a key or a secret on the command line: there is no such option', () => {
    for (const word of ['--private-key', '--client-secret', '--key', '--token']) {
      expect(parse(['github', 'import', word, 'x'])).toMatchObject({ kind: 'error' });
    }
  });

  it('leave the gateway login (`clerq login`) as it was', () => {
    expect(parse(['login'])).toMatchObject({
      kind: 'call',
      call: { command: { path: ['login'] } },
    });
    expect(parse(['github', 'login'])).toMatchObject({
      kind: 'call',
      call: { command: { path: ['github', 'login'] } },
    });
    expect(parse(['github'])).toMatchObject({ kind: 'error' });
  });
});

describe('the page that posts the app to GitHub', () => {
  it('posts one field, named manifest, to the address it was given', () => {
    const page = formPage(offer);
    expect(page).toContain('method="post"');
    expect(page).toContain('action="https://github.com/settings/apps/new?state=abc"');
    expect(page.match(/name="manifest"/g)).toHaveLength(1);
    expect(page.match(/<input/g)).toHaveLength(1);
    expect(page).toContain("document.getElementById('f').submit()");
  });

  it('escapes the manifest, so a name cannot break out of the page', () => {
    const page = formPage(offer);
    expect(page).not.toContain('"<x>"');
    expect(page).toContain('&#60;x&#62;');
    // What a browser would read back is the manifest as it was.
    const value = /name="manifest" value="([^"]*)"/.exec(page)?.[1] as string;
    const decoded = value.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    expect(JSON.parse(decoded)).toEqual(offer.manifest);
  });

  it('refuses to post anywhere but https, or this computer', () => {
    for (const url of [
      'http://github.com/settings/apps/new',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://u:p@github.com/x',
    ]) {
      expect(() => formPage({ ...offer, url })).toThrow('not an https address');
    }
    expect(() =>
      formPage({ ...offer, url: 'http://127.0.0.1:9/settings/apps/new?state=x' })
    ).not.toThrow();
  });
});

describe('addresses it follows', () => {
  it('are https, or http on this computer', () => {
    expect(safeLink('https://github.com/login/device')).toBe('https://github.com/login/device');
    expect(safeLink('http://127.0.0.1:5/login/device')).toBe('http://127.0.0.1:5/login/device');
    for (const bad of [
      'http://github.com/x',
      'javascript:alert(1)',
      'ftp://x',
      'https://u:p@github.com/',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(safeLink(bad as string)).toBeNull();
    }
  });

  it('for GitHub’s callback: a gateway elsewhere must be https', () => {
    expect(() => assertCallbackAddress('https://clerq.example.com')).not.toThrow();
    expect(() => assertCallbackAddress('http://127.0.0.1:18790')).not.toThrow();
    expect(() => assertCallbackAddress('http://localhost:18790')).not.toThrow();
    expect(() => assertCallbackAddress('http://clerq.example.com')).toThrow(
      'must not cross the network in the clear'
    );
  });
});

describe('how long login waits', () => {
  it('is as long as the code lasts, and a minute more for the gateway to say it ran out', () => {
    const now = Date.parse('2026-11-14T10:00:00Z');
    expect(loginWaitMs('2026-11-14T10:15:00.000Z', now)).toBe(15 * 60_000 + 60_000);
    expect(loginWaitMs('2026-11-14T10:00:30.000Z', now)).toBe(30_000 + 60_000);
    // A code that has already run out, or an address that is no time: a minute, not nothing and not for ever.
    expect(loginWaitMs('2026-11-14T09:00:00.000Z', now)).toBe(60_000);
    expect(loginWaitMs('soon', now)).toBe(60_000);
  });
});

describe('the system opener', () => {
  it('is one argument to the system’s own, never a shell line', () => {
    expect(openerFor('/tmp/a b.html', 'darwin')).toEqual({
      command: 'open',
      args: ['/tmp/a b.html'],
    });
    expect(openerFor('/tmp/a.html', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/a.html'],
    });
    expect(openerFor('https://x/?a=1&b=2', 'win32')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', 'https://x/?a=1&b=2'],
    });
  });
});

describe('import, before it asks anybody', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-github-'));
  const write = (name: string, text: string, mode: number) => {
    const file = path.join(home, name);
    fs.writeFileSync(file, text, { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const required = ['--app-id', '12', '--client-id', 'Iv23liTEST'];

  it('needs the app id, the client id and the key file, and says which is missing', async () => {
    const r = await cli(['github', 'import', '--app-id', '12'], { home });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('--client-id');
    expect(r.stderr).toContain('--private-key-file');
    expect(r.stderr).toContain('never from the command line');
  });

  it('refuses an app id that is not a number', async () => {
    const key = write('a.pem', 'x', 0o600);
    const r = await cli(
      ['github', 'import', '--app-id', 'abc', '--client-id', 'Iv', '--private-key-file', key],
      { home }
    );
    expect(r.code).toBe(64);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a key file every user can read, naming the fix',
    async () => {
      const key = write('wide.pem', 'not-read-at-all', 0o644);
      const r = await cli(['github', 'import', ...required, '--private-key-file', key], { home });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('can be read by every user');
      expect(r.stderr).toContain('chmod 600');
      expect(r.stderr).not.toContain('not-read-at-all');
    }
  );

  it.skipIf(process.platform === 'win32')('refuses a client secret file the same way', async () => {
    const key = write('ok.pem', 'x', 0o600);
    const secret = write('wide-secret.txt', 'shh', 0o604);
    const r = await cli(
      ['github', 'import', ...required, '--private-key-file', key, '--client-secret-file', secret],
      { home }
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('the client secret');
  });

  it('says a file is missing, or is not a file, or is empty', async () => {
    const dir = path.join(home, 'adir');
    fs.mkdirSync(dir, { recursive: true });
    const empty = write('empty.pem', '  \n', 0o600);
    for (const [file, words] of [
      [path.join(home, 'nope.pem'), 'no such file'],
      [dir, 'is not a file'],
      [empty, 'is empty'],
    ] as const) {
      const r = await cli(['github', 'import', ...required, '--private-key-file', file], { home });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(words);
    }
  });
});
