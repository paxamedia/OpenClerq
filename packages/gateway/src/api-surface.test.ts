/**
 * The routes the gateway serves, pinned for API version 1.
 *
 * Clients of version 1 (the desktop app, a phone, the CLI, plugins) call these
 * routes. Within a version they may be added to and never removed or renamed:
 * that needs API version 2 (see docs/API.md). So:
 *
 *   - a route that is gone or renamed fails this test, update flag or not;
 *   - a new route fails it too, until it is recorded on purpose with
 *       CLERQ_UPDATE_API_SURFACE=1 pnpm --filter @clerq/gateway exec vitest run src/api-surface.test.ts
 *     which rewrites src/api-surface.v1.json (and refuses to if a route was removed).
 *
 * The list comes from the Express app itself, not from a hand-kept table.
 * Routes a module adds under /api/modules/<id> belong to that module and are
 * not core API; none is loaded here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { API_VERSION, SUPPORTED_API_VERSIONS } from '@clerq/gateway-client/protocol';
import { createGateway } from './gateway.js';

interface Layer {
  route?: { path: unknown; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: unknown };
}

/** Every `METHOD /path` the app routes, sorted. Throws on a layer it cannot read. */
export function listRoutes(app: Express): string[] {
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  const out = new Set<string>();
  for (const layer of stack) {
    if (layer.route) {
      const { path: p, methods } = layer.route;
      if (typeof p !== 'string') {
        throw new Error(`A route is registered with a path this test cannot list: ${String(p)}`);
      }
      for (const method of Object.keys(methods)) {
        out.add(`${method === '_all' ? 'ALL' : method.toUpperCase()} ${p}`);
      }
    } else if (layer.handle?.stack) {
      // `app.use(path, router)` hides its path in Express 5; core registers none.
      throw new Error(
        'A router is mounted on the app. List its routes here, or add it to the pinned surface by hand.'
      );
    }
  }
  return [...out].sort();
}

const fileFor = (version: number) =>
  fileURLToPath(new URL(`./api-surface.v${version}.json`, import.meta.url));

/** Parameter names are not part of the contract: `/runs/:id` is `/runs/:runId`. */
const shape = (route: string) => route.replace(/:[A-Za-z0-9_]+/g, ':_');

function pinnedRoutes(version: number): string[] {
  const file = fileFor(version);
  if (!fs.existsSync(file)) {
    throw new Error(
      `There is no ${file}. API version ${version} needs one: copy the previous version's file, ` +
        'then record the routes with CLERQ_UPDATE_API_SURFACE=1.'
    );
  }
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { routes: string[] }).routes;
}

const without = (list: string[], other: string[]) => {
  const have = new Set(other.map(shape));
  return list.filter((r) => !have.has(shape(r)));
};

let app: Express;
let close: () => Promise<void>;
let home: string;
let savedHome: string | undefined;

beforeAll(async () => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-surface-'));
  process.env.HOME = home;
  const gw = createGateway({
    port: 0,
    authToken: 'api-surface-test-token-0123456789',
    dbPath: ':memory:',
    modulesDir: '/nonexistent-modules-dir-xyz',
  });
  app = gw.app;
  await gw.ready;
  close = () => new Promise<void>((resolve) => gw.server.close(() => resolve()));
}, 20_000);

afterAll(async () => {
  await close();
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe('the gateway routes', () => {
  it('lists real routes, so the comparisons below mean something', () => {
    const routes = listRoutes(app);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toContain('GET /health');
    expect(routes).toContain('GET /version');
    expect(routes).toContain('POST /sessions/:id/send');
  });

  it('still serve every route an earlier supported API version had', () => {
    // Recording the first snapshot: there is nothing yet to compare with.
    if (process.env.CLERQ_UPDATE_API_SURFACE === '1' && !fs.existsSync(fileFor(API_VERSION)))
      return;
    const now = listRoutes(app);
    for (const version of SUPPORTED_API_VERSIONS) {
      const removed = without(pinnedRoutes(version), now);
      expect(
        removed,
        `Removed or renamed since API version ${version}: ${removed.join(', ')}. ` +
          'Clients of that version call these, so this needs API version 2 (see docs/API.md).'
      ).toEqual([]);
    }
  });

  it('record every new route on purpose', () => {
    const update = process.env.CLERQ_UPDATE_API_SURFACE === '1';
    const file = fileFor(API_VERSION);
    const now = listRoutes(app);
    const pinned = update && !fs.existsSync(file) ? [] : pinnedRoutes(API_VERSION);
    if (update && without(pinned, now).length === 0) {
      fs.writeFileSync(file, `${JSON.stringify({ version: API_VERSION, routes: now }, null, 2)}\n`);
      return;
    }
    const added = without(now, pinned);
    expect(
      added,
      `New routes: ${added.join(', ')}. Adding a route is allowed within API version ${API_VERSION}, ` +
        'but it is recorded on purpose: run CLERQ_UPDATE_API_SURFACE=1 pnpm --filter @clerq/gateway ' +
        `exec vitest run src/api-surface.test.ts, then commit src/api-surface.v${API_VERSION}.json.`
    ).toEqual([]);
  });
});
