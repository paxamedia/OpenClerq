import { describe, expect, it } from 'vitest';
import { DEFAULT_HEALTHCHECK_TIMEOUT_MS, USAGE, parseArgs } from './args.js';

describe('parseArgs', () => {
  it('runs the server with no arguments, or with "run"', () => {
    expect(parseArgs([])).toEqual({ kind: 'run' });
    expect(parseArgs(['run'])).toEqual({ kind: 'run' });
  });

  it('refuses arguments "run" does not take', () => {
    expect(parseArgs(['run', '--port', '1'])).toMatchObject({ kind: 'error' });
  });

  it('answers --help, -h and help anywhere, without starting anything', () => {
    for (const argv of [['--help'], ['-h'], ['help'], ['healthcheck', '--help'], ['x', '-h']]) {
      expect(parseArgs(argv)).toEqual({ kind: 'help' });
    }
    expect(USAGE).toContain('healthcheck');
    expect(USAGE).toContain('CLERQ_PORT');
  });

  it('reads the version command in its three spellings, and --json', () => {
    for (const first of ['version', '--version', '-v']) {
      expect(parseArgs([first])).toEqual({ kind: 'version', json: false });
    }
    expect(parseArgs(['version', '--json'])).toEqual({ kind: 'version', json: true });
    expect(parseArgs(['version', '--yaml'])).toMatchObject({ kind: 'error' });
  });

  it('reads healthcheck with a default and an explicit timeout in seconds', () => {
    expect(parseArgs(['healthcheck'])).toEqual({
      kind: 'healthcheck',
      timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
    });
    expect(parseArgs(['healthcheck', '--timeout', '2.5'])).toEqual({
      kind: 'healthcheck',
      timeoutMs: 2_500,
    });
  });

  it('refuses a timeout that is not a positive number, and unknown arguments', () => {
    for (const argv of [
      ['healthcheck', '--timeout'],
      ['healthcheck', '--timeout', 'soon'],
      ['healthcheck', '--timeout', '0'],
      ['healthcheck', '--timeout', '-3'],
      ['healthcheck', '--timeout', '9999'],
      ['healthcheck', '--url', 'http://x'],
    ]) {
      expect(parseArgs(argv)).toMatchObject({ kind: 'error' });
    }
  });

  it('refuses an unknown command by name', () => {
    expect(parseArgs(['serve'])).toEqual({ kind: 'error', message: 'Unknown command "serve".' });
  });
});
