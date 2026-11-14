import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cli } from './test-harness.js';
import { COMMANDS } from './commands.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-cli-unit-')));

describe('help and version', () => {
  it('prints the version and the API version', async () => {
    for (const argv of [['--version'], ['-V'], ['status', '--version']]) {
      const r = await cli(argv, { home });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^clerq \d+\.\d+\.\d+ \(API version 1\)\n$/);
    }
  });

  it('lists every command, the connection rules and the exit codes', async () => {
    const r = await cli(['help'], { home });
    expect(r.code).toBe(0);
    for (const c of COMMANDS) expect(r.stdout, c.path.join(' ')).toContain(c.path.join(' '));
    expect(r.stdout).toContain('There is no --token option');
    expect(r.stdout).toContain('64  bad arguments');
    expect((await cli([], { home })).stdout).toBe(r.stdout);
  });

  it('explains one command, a group, and refuses a topic it does not know', async () => {
    const one = await cli(['help', 'automation', 'apply'], { home });
    expect(one.stdout).toContain('Usage: clerq automation apply [options]');
    expect(one.stdout).toContain('-f, --file <file>');
    expect(one.stdout).toContain('Examples:');
    expect((await cli(['automation', 'apply', '--help'], { home })).stdout).toBe(one.stdout);
    const group = await cli(['help', 'repo'], { home });
    expect(group.stdout).toContain('Usage: clerq repo <command> [options]');
    expect(group.stdout).toContain('add <target>');
    const unknown = await cli(['help', 'nothing'], { home });
    expect(unknown.code).toBe(64);
    expect(unknown.stdout).toContain('No help for "nothing"');
  });

  it('every command has a summary, an example that names it, and loads', async () => {
    for (const c of COMMANDS) {
      expect(c.summary.length, c.path.join(' ')).toBeGreaterThan(10);
      expect(
        c.examples.some((e) => e.startsWith(`clerq ${c.path.join(' ')}`)),
        c.path.join(' ')
      ).toBe(true);
      expect(typeof (await c.load()).run, c.path.join(' ')).toBe('function');
    }
  });
});
