import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, buildCodexArgs, buildCursorArgs } from './index.js';
import { flagsOf } from './cli.js';

describe('flagsOf', () => {
  it('lists the long options before the prompt, once each', () => {
    expect(
      flagsOf(['exec', '--json', '-s', 'x', '--json', '--model', 'm', '--', '--not-a-flag'])
    ).toEqual(['--json', '--model']);
    expect(flagsOf(['-p'])).toEqual([]);
  });

  it('reads the options each driver passes from its own command line', () => {
    const prompt = '--looks-like-an-option';
    expect(flagsOf(buildCodexArgs({ prompt, cwd: '/x', model: 'm' }))).toEqual([
      '--json',
      '--sandbox',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      '--config',
      '--model',
    ]);
    expect(flagsOf(buildCursorArgs({ prompt, cwd: '/x', permissionMode: 'plan' }))).toEqual([
      '--print',
      '--output-format',
      '--trust',
      '--mode',
    ]);
    expect(flagsOf(buildClaudeArgs({ prompt, cwd: '/x' }))).not.toContain(prompt);
  });
});
