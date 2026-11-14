import { describe, expect, it } from 'vitest';
import { EXIT } from './errors.js';
import { readSecret, readStdin } from './prompt.js';
import { FakeStdin, capture } from './test-harness.js';

describe('readStdin', () => {
  it('reads everything up to the end', async () => {
    expect(await readStdin(new FakeStdin('abc\ndef\n'))).toBe('abc\ndef\n');
  });

  it('refuses something far longer than a token', async () => {
    await expect(readStdin(new FakeStdin('x'.repeat(70_000)))).rejects.toThrow(
      /far longer than a token/
    );
  });
});

describe('readSecret', () => {
  it('asks on stderr, shows nothing of what is typed, and honours backspace', async () => {
    const stdin = new FakeStdin('', true);
    const c = capture(stdin, true);
    const pending = readSecret(c.io, 'Token: ');
    expect(stdin.raw).toBe(true);
    stdin.type('abcd');
    stdin.type('\u007fe');
    stdin.type('f\r');
    await expect(pending).resolves.toBe('abcef');
    expect(stdin.raw).toBe(false);
    expect(c.stderr()).toBe('Token: \n');
    expect(c.stdout()).toBe('');
  });

  it('ends on Ctrl-C with the interrupted exit code, and restores the terminal', async () => {
    const stdin = new FakeStdin('', true);
    const c = capture(stdin, true);
    const pending = readSecret(c.io, 'Token: ');
    stdin.type('ab\u0003');
    await expect(pending).rejects.toMatchObject({ exitCode: EXIT.interrupted });
    expect(stdin.raw).toBe(false);
  });

  it('needs a terminal, and says to use --token-stdin without one', async () => {
    const c = capture(new FakeStdin('x'));
    await expect(readSecret(c.io, 'Token: ')).rejects.toThrow(/Pass --token-stdin/);
  });
});
