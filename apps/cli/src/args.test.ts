import { describe, expect, it } from 'vitest';
import { parseArgs, type Parsed } from './args.js';
import { COMMANDS } from './commands.js';

const parse = (...argv: string[]) => parseArgs(argv, COMMANDS);
const call = (...argv: string[]) => {
  const p = parse(...argv);
  if (p.kind !== 'call') throw new Error(`expected a call, got ${JSON.stringify(p)}`);
  return p.call;
};
const message = (p: Parsed) => (p.kind === 'error' ? p.message : '');

describe('which command', () => {
  it('finds one-word and two-word commands, with options before or after', () => {
    expect(call('status').command.path).toEqual(['status']);
    expect(call('repo', 'add', '.').command.path).toEqual(['repo', 'add']);
    expect(call('--json', 'repo', 'list').command.path).toEqual(['repo', 'list']);
    expect(call('--profile', 'work', 'run', 'x').command.path).toEqual(['run']);
    expect(call('run', 'x', '--profile=work').opts.profile).toBe('work');
  });

  it('takes the positional arguments after the command words', () => {
    expect(call('repo', 'add', 'github:acme/app').args).toEqual(['github:acme/app']);
    expect(call('approve', '7').args).toEqual(['7']);
    expect(call('run', 'nightly-tidy', '--follow').args).toEqual(['nightly-tidy']);
  });

  it('says what a group needs, and suggests a near command for a typo', () => {
    expect(message(parse('repo'))).toBe('"clerq repo" needs one of: add, list, show.');
    expect(message(parse('automation'))).toContain('apply, list, show, enable, disable');
    expect(message(parse('runn', 'x'))).toBe('Unknown command "runn". Did you mean "run"?');
    expect(message(parse('xyzzy'))).toBe('Unknown command "xyzzy".');
  });

  it('answers help and version without a command', () => {
    expect(parse()).toEqual({ kind: 'help', topic: [] });
    expect(parse('help')).toEqual({ kind: 'help', topic: [] });
    expect(parse('help', 'repo', 'add')).toEqual({ kind: 'help', topic: ['repo', 'add'] });
    expect(parse('--help')).toEqual({ kind: 'help', topic: [] });
    expect(parse('repo', 'add', '--help')).toEqual({ kind: 'help', topic: ['repo', 'add'] });
    expect(parse('repo', '--help')).toEqual({ kind: 'help', topic: ['repo'] });
    expect(parse('--version')).toEqual({ kind: 'version' });
    expect(parse('-V')).toEqual({ kind: 'version' });
  });
});

describe('options', () => {
  it('reads booleans, values after a space or =, and short forms', () => {
    const c = call('automation', 'apply', '-f', 'nightly.yaml', '--enable', '--dry-run', '--json');
    expect(c.opts).toEqual({ file: 'nightly.yaml', enable: true, 'dry-run': true, json: true });
    expect(call('run', 'x', '-f').opts.follow).toBe(true);
    expect(call('run', 'x', '--model=openai/gpt-5').opts.model).toBe('openai/gpt-5');
    expect(call('deny', '3', '--reason', '-not now').opts.reason).toBe('-not now');
  });

  it('takes - as a value or an argument, and everything after -- as arguments', () => {
    expect(call('automation', 'apply', '-f', '-').opts.file).toBe('-');
    expect(call('automation', 'show', '--', '--odd-name').args).toEqual(['--odd-name']);
  });

  it('refuses an unknown option, a missing value, and a value for a flag', () => {
    expect(message(parse('status', '--nope'))).toBe('Unknown option "--nope" for "clerq status".');
    expect(message(parse('run', 'x', '--model'))).toBe(
      '"--model" needs a value (<provider/model>).'
    );
    expect(message(parse('status', '--json=yes'))).toBe('"--json" takes no value.');
    // There is no --token option on purpose: it would sit in shell history.
    expect(message(parse('login', '--token', 'abc'))).toContain('Unknown option "--token"');
  });

  it('counts the arguments', () => {
    expect(message(parse('run'))).toBe('"clerq run" needs <automation>.');
    expect(message(parse('repo', 'add'))).toBe('"clerq repo add" needs <target>.');
    expect(message(parse('status', 'extra'))).toBe('"clerq status" does not take "extra".');
    expect(call('login').args).toEqual([]);
    expect(call('login', 'https://x.example').args).toEqual(['https://x.example']);
  });
});
