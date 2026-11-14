import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureHome,
  envFilePath,
  isLoopback,
  loadEnvFile,
  readServerConfig,
  type Env,
} from './env.js';

let home: string;
let cwd: string;
let savedCwd: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-server-env-')));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-server-cwd-')));
  fs.mkdirSync(path.join(home, '.clerq'));
  savedCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(savedCwd);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('loadEnvFile', () => {
  it('reads ~/.clerq/.env and nothing from the working directory', () => {
    fs.writeFileSync(
      path.join(home, '.clerq', '.env'),
      'CLERQ_PORT=19001\nANTHROPIC_API_KEY="sk-from-home"\n# a comment\n'
    );
    fs.writeFileSync(
      path.join(cwd, '.env'),
      'CLERQ_PORT=19002\nCLERQ_GATEWAY_TOKEN=from-the-cwd\n'
    );
    const env: Env = {};
    expect(loadEnvFile(env, home)).toBe(path.join(home, '.clerq', '.env'));
    expect(env).toEqual({ CLERQ_PORT: '19001', ANTHROPIC_API_KEY: 'sk-from-home' });
  });

  it('does not read the working directory even when there is no home file', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'CLERQ_PORT=19002\n');
    const env: Env = {};
    expect(loadEnvFile(env, home)).toBeNull();
    expect(env).toEqual({});
  });

  it('leaves a variable that is already set alone, even an empty one', () => {
    fs.writeFileSync(path.join(home, '.clerq', '.env'), 'CLERQ_PORT=19001\nCLERQ_HOST=0.0.0.0\n');
    const env: Env = { CLERQ_PORT: '20000', CLERQ_HOST: '' };
    loadEnvFile(env, home);
    expect(env).toEqual({ CLERQ_PORT: '20000', CLERQ_HOST: '' });
  });

  it('is quiet about a missing file and says so about one it cannot read', () => {
    const said: string[] = [];
    expect(loadEnvFile({}, home, (m) => said.push(m))).toBeNull();
    expect(said).toEqual([]);
    // A directory where the file should be.
    fs.mkdirSync(path.join(home, '.clerq', '.env'));
    expect(loadEnvFile({}, home, (m) => said.push(m))).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(envFilePath(home));
  });
});

describe('ensureHome', () => {
  it('takes HOME, then USERPROFILE, as the gateway does', () => {
    expect(ensureHome({ HOME: '/srv/clerq' })).toBe('/srv/clerq');
    expect(ensureHome({ USERPROFILE: '/srv/win' })).toBe('/srv/win');
  });

  it('fills HOME from the account when it is missing, so no path can split', () => {
    const env: Env = {};
    expect(ensureHome(env, () => '/home/openclerq')).toBe('/home/openclerq');
    expect(env.HOME).toBe('/home/openclerq');
  });

  it('refuses when there is no home at all, and a relative one', () => {
    expect(() =>
      ensureHome({}, () => {
        throw new Error('no passwd entry');
      })
    ).toThrow(ConfigError);
    expect(() => ensureHome({}, () => '')).toThrow(/HOME is not set/);
    expect(() => ensureHome({ HOME: 'relative/dir' })).toThrow(/absolute path/);
  });
});

describe('readServerConfig', () => {
  it('defaults to loopback on 18790', () => {
    expect(readServerConfig({})).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PORT).toBe(18790);
  });

  it('reads the host and port, and treats empty values as unset', () => {
    expect(readServerConfig({ CLERQ_HOST: '0.0.0.0', CLERQ_PORT: '8080' })).toEqual({
      host: '0.0.0.0',
      port: 8080,
    });
    expect(readServerConfig({ CLERQ_HOST: ' ', CLERQ_PORT: '' })).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    });
  });

  it('refuses a port that is not a port', () => {
    for (const bad of ['0', '65536', '-1', '80.5', 'http', '1e3', '0x50']) {
      expect(() => readServerConfig({ CLERQ_PORT: bad })).toThrow(/CLERQ_PORT must be/);
    }
  });
});

describe('isLoopback', () => {
  it('knows the loopback names and nothing else', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) expect(isLoopback(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', 'example.com'])
      expect(isLoopback(h)).toBe(false);
  });
});
