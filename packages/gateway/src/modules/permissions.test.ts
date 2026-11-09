import { describe, it, expect } from 'vitest';
import { parsePermissions, NO_PERMISSIONS } from './permissions.js';

describe('manifest permissions', () => {
  it('default to nothing', () => {
    expect(parsePermissions({})).toEqual({ permissions: NO_PERMISSIONS, warnings: [] });
  });

  it('keep what is well-formed and name what is not', () => {
    const { permissions, warnings } = parsePermissions({
      permissions: {
        exec: ['/usr/bin/git', 7, '/usr/bin/git'],
        fs: { read: ['~/Documents'] },
        net: 'api.example.com',
        llm: 'yes',
        root: true,
      },
    });
    expect(permissions).toEqual({
      ...NO_PERMISSIONS,
      exec: ['/usr/bin/git'],
      fs: { read: ['~/Documents'], write: [] },
    });
    expect(warnings).toEqual([
      'permissions.root is not a known permission.',
      'permissions.llm should be true or false.',
      'permissions.exec has entries that are not strings.',
      'permissions.net should be a list of strings.',
    ]);
  });
});
