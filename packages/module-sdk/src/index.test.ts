import { describe, it, expect } from 'vitest';
import { defineModule, tablePrefix } from './index.js';

describe('module sdk', () => {
  it('prefixes tables with the module id, hyphens as underscores', () => {
    expect(tablePrefix('hello-world')).toBe('mod_hello_world__');
  });

  it('returns the module it is given', () => {
    const mod = { register: () => undefined };
    expect(defineModule(mod)).toBe(mod);
  });
});
