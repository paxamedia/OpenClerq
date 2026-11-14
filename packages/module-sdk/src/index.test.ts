import { describe, it, expect } from 'vitest';
import {
  defineModule,
  tablePrefix,
  type ClerqModule,
  type ModuleContext,
  type ModulePermissions,
} from './index.js';

describe('module sdk', () => {
  it('prefixes tables with the module id, hyphens as underscores', () => {
    expect(tablePrefix('hello-world')).toBe('mod_hello_world__');
  });

  it('returns the module it is given', () => {
    const mod = { register: () => undefined };
    expect(defineModule(mod)).toBe(mod);
  });
});

// Compile-time: what a module written before 1.0 wrote still type-checks (this file is checked by
// `tsc -p tsconfig.test.json`, which `pnpm test` runs first).
describe('a module written against the old types', () => {
  it('still compiles: the six permissions it knew, as a literal, and a register(ctx: ModuleContext)', () => {
    const permissions: ModulePermissions = {
      exec: [],
      fs: { read: [], write: [] },
      net: [],
      secrets: ['token'],
      services: [],
      llm: false,
    };
    const old: ClerqModule = {
      register(ctx: ModuleContext) {
        ctx.routes.get('/x', (_req, res) => res.json({ id: ctx.id, secrets: permissions.secrets }));
        const declared: ModulePermissions = ctx.permissions;
        void declared;
      },
    };
    expect(typeof old.register).toBe('function');
    expect(permissions.api).toBeUndefined();
  });
});
