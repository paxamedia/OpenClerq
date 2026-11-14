import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_VERSION } from '@clerq/gateway-client/protocol';
import {
  describePermissions,
  diffPermissions,
  engineProblem,
  EMPTY_PERMISSIONS,
  hasManifestVersion,
  MEMORY_TYPES,
  readPermissions,
  validateManifest,
  type PluginManifestInput,
} from './manifest.js';

const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifestVersion: 1,
  id: 'my-plugin',
  name: 'My plugin',
  version: '1.2.3',
  description: 'Does one thing.',
  engines: { api: API_VERSION },
  entry: { server: 'dist/server.js', ui: 'dist/ui' },
  permissions: {},
  ...over,
});

const errorsOf = (raw: unknown): string[] => {
  const r = validateManifest(raw);
  return r.ok ? [] : r.errors;
};

describe('manifest v1', () => {
  it('accepts a minimal manifest and fills in what it leaves out', () => {
    const r = validateManifest(good({ entry: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toMatchObject({
      manifestVersion: 1,
      id: 'my-plugin',
      entry: {},
      config: {},
      services: [],
      permissions: EMPTY_PERMISSIONS,
    });
    expect(r.warnings).toEqual([]);
  });

  it('reads every field of a full manifest', () => {
    const r = validateManifest(
      good({
        skills: 'skills',
        config: { greeting: 'Hello' },
        services: ['org.example.worker', { label: 'org.example.other', name: 'Other' }],
        permissions: {
          exec: ['/usr/bin/git'],
          fs: { read: ['~/Documents'], write: ['~/Exports'] },
          net: ['api.example.com', '*.example.org'],
          secrets: ['token'],
          services: ['org.example.worker', 'org.example.other'],
          llm: true,
          api: ['GET /runs/:id', '* /records/*'],
          memory: { read: ['fact'], write: ['note'] },
        },
        extensions: { nav: [{ id: 'main', title: 'My plugin', path: '/' }] },
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.permissions).toEqual({
      exec: ['/usr/bin/git'],
      fs: { read: ['~/Documents'], write: ['~/Exports'] },
      net: ['api.example.com', '*.example.org'],
      secrets: ['token'],
      services: ['org.example.worker', 'org.example.other'],
      llm: true,
      api: ['GET /runs/:id', '* /records/*'],
      memory: { read: ['fact'], write: ['note'] },
    });
    expect(r.manifest.services.map((s) => s.label)).toEqual([
      'org.example.worker',
      'org.example.other',
    ]);
    expect(r.manifest.skills).toBe('skills');
    expect(r.manifest.extensions).toBeDefined();
    expect(r.warnings).toEqual([]);
  });

  it('types an author can write a manifest against', () => {
    const m: PluginManifestInput = {
      manifestVersion: 1,
      id: 'typed',
      name: 'Typed',
      version: '0.1.0',
      description: 'x',
      engines: { api: 1 },
      permissions: { net: ['example.com'] },
    };
    expect(validateManifest(m).ok).toBe(true);
  });

  it('tells a manifest of version 1 from a legacy module', () => {
    expect(hasManifestVersion({ manifestVersion: 1 })).toBe(true);
    expect(hasManifestVersion({ id: 'x', slug: 'x', name: 'X', version: '0.1' })).toBe(false);
    expect(hasManifestVersion(null)).toBe(false);
  });

  it.each([
    [{ id: 'My Plugin' }, '"id" must be lower-case words'],
    [{ id: 'a--b' }, '"id" must be lower-case words'],
    [{ id: 'trailing-' }, '"id" must be lower-case words'],
    [{ id: 'core' }, 'that name is kept for OpenClerq itself'],
    [{ id: 'x'.repeat(65) }, '"id" must be 64 characters or fewer'],
    [{ name: '' }, '"name" must be a sentence'],
    [{ description: undefined }, '"description" must be a sentence'],
    [{ version: '1.2' }, '"version" must be a semantic version'],
    [{ version: 'v1.2.3' }, '"version" must be a semantic version'],
    [{ version: '01.2.3' }, '"version" must be a semantic version'],
    [{ manifestVersion: 2 }, 'written for manifest version 2; this OpenClerq reads version 1'],
    [{ manifestVersion: '1' }, '"manifestVersion" must be 1'],
    [{ engines: undefined }, '"engines" is required'],
    [{ engines: { api: '1' } }, '"engines.api" must be a whole number'],
    [{ engines: { api: 0 } }, '"engines.api" must be a whole number'],
    [{ engines: { api: 1.5 } }, '"engines.api" must be a whole number'],
    [{ engines: { api: 1, gpu: true } }, '"engines.gpu" is not something this OpenClerq knows'],
    [{ entry: 'dist/server.js' }, '"entry" must be an object'],
    [{ entry: { server: '/etc/passwd' } }, '"entry.server" is not relative'],
    [{ entry: { server: '../x.js' } }, '"entry.server" leaves the plugin directory'],
    [{ entry: { ui: 'C:\\x' } }, '"entry.ui" is not relative'],
    [{ entry: { server: 3 } }, '"entry.server" is not a path'],
    [{ entry: { worker: 'x.js' } }, '"entry.worker" is not something this OpenClerq knows'],
    [{ skills: '../skills' }, '"skills" leaves the plugin directory'],
    [{ config: [] }, '"config" must be an object'],
    [{ services: 'x' }, '"services" must be a list'],
    [{ services: [{ name: 'no label' }] }, '"services" has an entry without a usable label'],
    [{ permissions: undefined }, '"permissions" is required'],
    [{ permissions: [] }, '"permissions" must be an object'],
    [{ permissions: { root: true } }, 'permissions.root is not a known permission.'],
    [{ permissions: { llm: 'yes' } }, 'permissions.llm should be true or false.'],
    [{ permissions: { net: 'api.example.com' } }, 'permissions.net should be a list of strings.'],
    [{ permissions: { exec: ['git', 7] } }, 'permissions.exec has entries that are not strings.'],
    [
      { permissions: { net: ['https://api.example.com/v1'] } },
      'permissions.net lists hosts, not addresses',
    ],
    [{ permissions: { api: ['GET runs'] } }, 'permissions.api "GET runs" is not a method and path'],
    [{ permissions: { api: ['GET /*'] } }, 'permissions.api "GET /*" is not a method and path'],
    [{ permissions: { api: ['GET /:x'] } }, 'permissions.api "GET /:x" is not a method and path'],
    [
      { permissions: { memory: { read: ['gossip'] } } },
      'permissions.memory.read names "gossip", which is not a memory type',
    ],
    [{ permissions: { memory: [] } }, 'permissions.memory should be'],
    [{ permissions: { memory: { delete: ['fact'] } } }, 'permissions.memory.delete is not a known'],
    [{ extensions: [] }, '"extensions" must be an object'],
  ])('refuses %j with a plain sentence', (over, text) => {
    const errors = errorsOf(good(over));
    expect(
      errors.some((e) => e.includes(text)),
      `${errors.join(' | ')} should say: ${text}`
    ).toBe(true);
  });

  it('refuses what is not an object, and reports every problem at once', () => {
    expect(errorsOf(null)).toEqual(['The manifest must be a JSON object.']);
    expect(errorsOf([])).toEqual(['The manifest must be a JSON object.']);
    const errors = errorsOf({ manifestVersion: 1 });
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it('writes errors with no line numbers and no JSON paths a person cannot read', () => {
    const errors = errorsOf(good({ id: 'BAD', version: 'x', engines: {}, permissions: 1 }));
    for (const e of errors) {
      expect(e).not.toMatch(/\bline \d|\bcolumn \d|\$\.|\[\d\]/);
      expect(e.endsWith('.')).toBe(true);
    }
  });

  it('warns about what it ignores and about services that do not match', () => {
    const r = validateManifest(
      good({
        homepage: 'https://example.com',
        nonsense: 1,
        services: ['org.example.a', 'org.example.b'],
        permissions: { services: ['org.example.b', 'org.example.c'] },
      })
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'permissions.services lists "org.example.c", which is not under "services", so it cannot be started or stopped.',
      '"services" lists "org.example.a", which permissions.services does not: with enforcement on it cannot be started or stopped.',
      '"nonsense" is not a field of manifest version 1 and is ignored.',
    ]);
  });

  it('says where coreEndpoints went', () => {
    const r = validateManifest(good({ coreEndpoints: ['GET /runs'] }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      '"coreEndpoints" belongs to the older manifest and is ignored here: list those endpoints under permissions.api.',
    ]);
  });

  it('checks the engine against what this OpenClerq serves, in plain words', () => {
    expect(engineProblem(API_VERSION)).toBeNull();
    expect(engineProblem(2, [1])).toBe(
      'This plugin needs OpenClerq API version 2, and this OpenClerq serves version 1. Update OpenClerq, or use an older release of the plugin.'
    );
    expect(engineProblem(1, [2, 3])).toContain('no longer serves');
    expect(engineProblem(2, [1, 2])).toBeNull();
    expect(engineProblem(5, [1, 2, 3])).toContain('versions 1, 2 and 3');
  });
});

describe('permissions', () => {
  it('reads a legacy permissions value with the messages it always had', () => {
    const { permissions, warnings } = readPermissions({
      exec: ['/usr/bin/git', 7, '/usr/bin/git'],
      fs: { read: ['~/Documents'] },
      net: 'api.example.com',
      llm: 'yes',
      root: true,
    });
    expect(permissions.exec).toEqual(['/usr/bin/git']);
    expect(permissions.fs).toEqual({ read: ['~/Documents'], write: [] });
    expect(warnings).toEqual([
      'permissions.root is not a known permission.',
      'permissions.llm should be true or false.',
      'permissions.exec has entries that are not strings.',
      'permissions.net should be a list of strings.',
    ]);
  });

  it('keeps the memory types in step with the policy package', () => {
    expect([...MEMORY_TYPES]).toEqual(['fact', 'preference', 'decision', 'procedure', 'note']);
  });

  it('says each permission in words, and nothing for what is not declared', () => {
    expect(describePermissions(EMPTY_PERMISSIONS)).toEqual([]);
    const lines = describePermissions({
      ...EMPTY_PERMISSIONS,
      exec: ['/usr/bin/git'],
      net: ['api.example.com'],
      llm: true,
      memory: { read: ['fact'], write: [] },
    });
    expect(lines.map((l) => [l.key, l.label, l.items])).toEqual([
      ['exec', 'Run programs', ['/usr/bin/git']],
      ['net', 'Use the network', ['api.example.com']],
      ['llm', 'Use AI models', []],
      ['memory.read', 'Read memory', ['fact']],
    ]);
    expect(lines[0].summary).toBe('Run these programs on this computer, as you.');
  });

  it('says what changed between two declarations', () => {
    const before = { ...EMPTY_PERMISSIONS, net: ['a.example.com'], secrets: ['token'] };
    const after = {
      ...EMPTY_PERMISSIONS,
      net: ['a.example.com', 'b.example.com'],
      llm: true,
      exec: ['/bin/ls'],
    };
    expect(diffPermissions(before, after).map((c) => c.text)).toEqual([
      'Can now run /bin/ls',
      'Can now connect to b.example.com',
      'Can no longer use the secret token',
      'Can now use AI models',
    ]);
    expect(diffPermissions(after, after)).toEqual([]);
  });
});

describe('the JSON Schema', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL('../../module-schema/plugin-manifest.schema.json', import.meta.url)),
      'utf8'
    )
  ) as {
    required: string[];
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };

  it('names the same fields the validator reads', () => {
    expect(schema.required).toEqual([
      'manifestVersion',
      'id',
      'name',
      'version',
      'description',
      'engines',
      'permissions',
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        '$schema',
        'manifestVersion',
        'id',
        'name',
        'version',
        'description',
        'engines',
        'entry',
        'skills',
        'config',
        'services',
        'permissions',
        'extensions',
      ].sort()
    );
    expect(Object.keys(schema.properties.permissions.properties ?? {}).sort()).toEqual(
      ['exec', 'fs', 'net', 'secrets', 'services', 'llm', 'api', 'memory'].sort()
    );
  });

  it('has patterns that compile and agree with the validator on ids and versions', () => {
    const props = schema.properties as unknown as Record<string, { pattern?: string }>;
    const id = new RegExp(props.id.pattern as string);
    const version = new RegExp(props.version.pattern as string);
    for (const ok of ['a', 'my-plugin', 'a1-b2']) expect(id.test(ok)).toBe(true);
    for (const bad of ['A', 'a--b', '1a', 'a-', '']) expect(id.test(bad)).toBe(false);
    for (const ok of ['0.0.0', '1.2.3', '1.0.0-rc.1', '1.0.0+build.5']) {
      expect(version.test(ok), ok).toBe(true);
      expect(validateManifest(good({ version: ok })).ok, ok).toBe(true);
    }
    for (const bad of ['1.2', '01.2.3', 'v1.2.3']) {
      expect(version.test(bad), bad).toBe(false);
      expect(validateManifest(good({ version: bad })).ok, bad).toBe(false);
    }
    const entry = schema.properties.entry.properties as Record<string, { pattern: string }>;
    const path = new RegExp(entry.server.pattern);
    for (const ok of ['dist/server.js', 'a/b.js']) expect(path.test(ok), ok).toBe(true);
    for (const bad of ['/abs', '../x', 'a/../x', 'C:\\x']) expect(path.test(bad), bad).toBe(false);
  });
});
