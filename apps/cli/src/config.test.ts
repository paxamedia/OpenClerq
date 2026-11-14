import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configPath,
  deleteConfigIfEmpty,
  loadConfig,
  modeWarning,
  saveConfig,
  tildePath,
} from './config.js';

let home: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-config-')));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('the file’s modes', () => {
  it('is written 0600 in a 0700 directory it made', () => {
    const file = saveConfig(home, {
      version: 1,
      profiles: { default: { url: 'https://a.example', token: 'secret-token-0123456' } },
    });
    expect(file).toBe(configPath(home));
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
  });

  it('does not loosen or tighten a directory that was already there', () => {
    fs.mkdirSync(path.join(home, '.clerq'), { mode: 0o755 });
    fs.chmodSync(path.join(home, '.clerq'), 0o755);
    saveConfig(home, { version: 1, profiles: {} });
    expect(mode(path.join(home, '.clerq'))).toBe(0o755);
    expect(mode(configPath(home))).toBe(0o600);
  });

  it('replaces an old file that was readable by others with a 0600 one', () => {
    fs.mkdirSync(path.join(home, '.clerq'), { recursive: true });
    fs.writeFileSync(configPath(home), '{"version":1,"profiles":{}}', { mode: 0o644 });
    fs.chmodSync(configPath(home), 0o644);
    saveConfig(home, { version: 1, profiles: {} });
    expect(mode(configPath(home))).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    saveConfig(home, { version: 1, profiles: {} });
    expect(fs.readdirSync(path.join(home, '.clerq'))).toEqual(['cli.json']);
  });

  it('warns about a file with a token that others can read, and about nothing else', () => {
    const config = {
      version: 1 as const,
      profiles: { default: { url: 'https://a.example', token: 'secret-token-0123456' } },
    };
    const file = saveConfig(home, config);
    expect(modeWarning(file, config, home)).toBeNull();
    fs.chmodSync(file, 0o644);
    const warning = modeWarning(file, config, home) as string;
    expect(warning).toContain(
      '~/.clerq/cli.json holds a token and can be read by other users (mode 644)'
    );
    expect(warning).toContain('chmod 600 ~/.clerq/cli.json');
    expect(warning).not.toContain('secret-token');
    // No token in it (only a path): nothing to warn about.
    const noToken = {
      version: 1 as const,
      profiles: { default: { url: 'https://a.example', tokenFile: '/x/t' } },
    };
    expect(modeWarning(file, noToken, home)).toBeNull();
  });
});

describe('reading it', () => {
  it('treats a missing file as no profiles', () => {
    expect(loadConfig(home)).toMatchObject({ exists: false, config: { version: 1, profiles: {} } });
  });

  it('round trips profiles, keeping a token or a token file', () => {
    saveConfig(home, {
      version: 1,
      profiles: {
        default: { url: 'https://a.example', token: 'secret-token-0123456' },
        work: { url: 'https://b.example', tokenFile: '/etc/clerq/token' },
      },
    });
    const { config, exists } = loadConfig(home);
    expect(exists).toBe(true);
    expect(config.profiles.default).toEqual({
      url: 'https://a.example',
      token: 'secret-token-0123456',
    });
    expect(config.profiles.work).toEqual({
      url: 'https://b.example',
      tokenFile: '/etc/clerq/token',
    });
  });

  it('refuses a file it cannot trust, naming it and what to do', () => {
    const file = configPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cases: Array<[string, RegExp]> = [
      ['{not json', /is not valid JSON/],
      ['[]', /does not hold a JSON object/],
      ['{"version":2,"profiles":{}}', /is version 2; this clerq reads version 1/],
      ['{"version":1}', /has no "profiles" object/],
      ['{"version":1,"profiles":{"a":{}}}', /profile "a" without a url/],
      ['{"version":1,"profiles":{"a":{"url":"x","token":5}}}', /token is not text/],
      ['{"version":1,"profiles":{"__proto__x":{"url":"x"}}}', /not a plain name/],
    ];
    for (const [text, message] of cases) {
      fs.writeFileSync(file, text);
      expect(() => loadConfig(home), text).toThrow(message);
      expect(() => loadConfig(home), text).toThrow(/cli\.json/);
    }
  });

  it('removes the file when the last profile goes, and only then', () => {
    const one = {
      version: 1 as const,
      profiles: { a: { url: 'https://a.example', token: 'secret-token-0123456' } },
    };
    saveConfig(home, one);
    deleteConfigIfEmpty(home, one);
    expect(fs.existsSync(configPath(home))).toBe(true);
    deleteConfigIfEmpty(home, { version: 1, profiles: {} });
    expect(fs.existsSync(configPath(home))).toBe(false);
  });

  it('writes a path with the home as ~', () => {
    expect(tildePath(path.join(home, '.clerq', 'cli.json'), home)).toBe(
      '~/.clerq/cli.json'.replace(/\//g, path.sep)
    );
    expect(tildePath('/etc/x', home)).toBe('/etc/x');
  });
});
