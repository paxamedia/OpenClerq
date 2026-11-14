import { describe, expect, it } from 'vitest';
import { Output, colorFor } from './output.js';
import { capture } from './test-harness.js';

describe('colour', () => {
  const tty = { write: () => true, isTTY: true };
  const pipe = { write: () => true };

  it('is for a terminal, and only when nobody said no', () => {
    expect(colorFor(tty, {}, false)).toBe(true);
    expect(colorFor(pipe, {}, false)).toBe(false);
    expect(colorFor(tty, { NO_COLOR: '1' }, false)).toBe(false);
    // NO_COLOR counts when it is present and not empty.
    expect(colorFor(tty, { NO_COLOR: '' }, false)).toBe(true);
    expect(colorFor(tty, { TERM: 'dumb' }, false)).toBe(false);
    expect(colorFor(tty, {}, true)).toBe(false);
  });

  it('puts escape codes in a terminal’s output and none in a pipe’s', () => {
    const t = capture(undefined, true);
    const colored = new Output(t.io, false, {});
    colored.say(colored.bold('hello'));
    expect(t.stdout()).toBe('\u001b[1mhello\u001b[22m\n');

    const p = capture(undefined, false);
    const plain = new Output(p.io, false, {});
    plain.say(plain.bold('hello'));
    plain.error('bad');
    expect(p.stdout()).toBe('hello\n');
    expect(p.stderr()).toBe('clerq: bad\n');
  });
});

describe('where words go', () => {
  it('writes results and notes to stdout, warnings and errors to stderr', () => {
    const c = capture();
    const out = new Output(c.io, false, {});
    out.say('result');
    out.note('note');
    out.warn('careful');
    out.error('broken');
    out.data({ ignored: true });
    expect(c.stdout()).toBe('result\nnote\n');
    expect(c.stderr()).toBe('Warning: careful\nclerq: broken\n');
  });

  it('under --json writes data to stdout and every message to stderr', () => {
    const c = capture();
    const out = new Output(c.io, true, {});
    out.say('not for a script');
    out.note('a note');
    out.warn('careful');
    out.data({ ok: true, n: 1 });
    expect(c.stdout()).toBe('{"ok":true,"n":1}\n');
    expect(c.stderr()).toBe('a note\nWarning: careful\n');
  });
});

describe('a hidden secret', () => {
  it('is never written, in any stream or mode', () => {
    const secret = 'super-secret-token-0123456789';
    for (const json of [false, true]) {
      const c = capture();
      const out = new Output(c.io, json, {});
      out.hide(secret);
      out.say(`token ${secret}`);
      out.note(`token ${secret}`);
      out.warn(`token ${secret}`);
      out.error(`token ${secret}`);
      out.data({ t: secret });
      out.raw(`token ${secret}`);
      expect(c.stdout() + c.stderr()).not.toContain(secret);
      expect(c.stdout() + c.stderr()).toContain('***');
    }
  });

  it('ignores a short value, which would blot out ordinary words', () => {
    const c = capture();
    const out = new Output(c.io, false, {});
    out.hide('run');
    out.say('run it');
    expect(c.stdout()).toBe('run it\n');
  });
});
