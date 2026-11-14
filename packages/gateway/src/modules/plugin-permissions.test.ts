import { describe, expect, it } from 'vitest';
import {
  declaredPermissions,
  legacyView,
  parsePermissions,
  coreEndpointsOf,
} from './permissions.js';
import { moduleScopes } from './routes.js';

describe('what a manifest declares, in full', () => {
  it('reads `api` together with a legacy module’s coreEndpoints, once each', () => {
    const { permissions, warnings } = declaredPermissions({
      coreEndpoints: ['GET /runs', 'GET /runs/:id', '* /nothing-bad', 'nope', '* /*', 7],
      permissions: { api: ['GET /runs/:id', 'POST /records/resolve'] },
    });
    expect(warnings).toEqual([]);
    // `* /*` and `nope` are not endpoints a manifest may declare; `* /nothing-bad` is.
    expect(permissions.api).toEqual([
      'GET /runs/:id',
      'POST /records/resolve',
      'GET /runs',
      '* /nothing-bad',
    ]);
  });

  it('names a malformed api or memory entry and keeps the rest', () => {
    const { permissions, warnings } = declaredPermissions({
      permissions: {
        api: ['GET /runs', 'GET /*', 'runs'],
        memory: { read: ['fact', 'gossip'], write: 'note' },
      },
    });
    expect(permissions.api).toEqual(['GET /runs']);
    expect(permissions.memory).toEqual({ read: ['fact'], write: [] });
    expect(warnings).toEqual([
      'permissions.api "GET /*" is not a method and path with a fixed first segment, like "GET /runs/:id".',
      'permissions.api "runs" is not a method and path with a fixed first segment, like "GET /runs/:id".',
      'permissions.memory.read names "gossip", which is not a memory type (fact, preference, decision, procedure, note).',
      'permissions.memory.write should be a list of strings.',
    ]);
  });

  it('still shows a legacy module its first six permissions and nothing more', () => {
    const { permissions } = declaredPermissions({
      permissions: { secrets: ['token'], api: ['GET /runs'], memory: { read: ['fact'] } },
    });
    expect(legacyView(permissions)).toEqual({
      exec: [],
      fs: { read: [], write: [] },
      net: [],
      secrets: ['token'],
      services: [],
      llm: false,
    });
    expect(
      parsePermissions({ permissions: { secrets: ['token'], api: ['GET /runs'] } }).permissions
    ).toEqual(legacyView(permissions));
  });

  it('gives a UI token its own routes and the declared endpoints', () => {
    expect(moduleScopes('x', ['GET /runs'])).toEqual(['* /api/modules/x/*', 'GET /runs']);
    expect(coreEndpointsOf({ coreEndpoints: ['GET /runs'] })).toEqual(['GET /runs']);
  });
});
