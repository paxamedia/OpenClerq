/**
 * The client's public surface, pinned for API version 1.
 *
 * A plugin or the CLI calls these names. Within a version they may be added
 * to and never removed or renamed: that needs the next API version (see
 * docs/API.md). A removal fails this test. An addition fails it too, until it
 * is recorded on purpose:
 *
 *   CLERQ_UPDATE_API_SURFACE=1 pnpm --filter @clerq/gateway-client exec vitest run src/surface.test.ts
 *
 * which rewrites src/api-surface.v1.json (and refuses to if anything was removed).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as client from './index.js';
import { API_VERSION, SUPPORTED_API_VERSIONS } from './protocol.js';

interface Surface {
  /** Runtime exports of the package: functions, classes and constants. */
  exports: string[];
  /** Methods of the `gateway` object. */
  gateway: string[];
}

const fileFor = (version: number) =>
  fileURLToPath(new URL(`./api-surface.v${version}.json`, import.meta.url));

const current: Surface = {
  exports: Object.keys(client).sort(),
  gateway: Object.keys(client.gateway).sort(),
};

function read(version: number): Surface {
  const file = fileFor(version);
  if (!fs.existsSync(file)) {
    throw new Error(
      `There is no ${file}. API version ${version} needs one: copy the previous version's file, ` +
        'then record the surface with CLERQ_UPDATE_API_SURFACE=1.'
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Surface;
}

const missingFrom = (pinned: string[], now: string[]) => pinned.filter((n) => !now.includes(n));

describe('the client surface', () => {
  it('still has every name an earlier supported API version had', () => {
    // Recording the first snapshot: there is nothing yet to compare with.
    if (process.env.CLERQ_UPDATE_API_SURFACE === '1' && !fs.existsSync(fileFor(API_VERSION)))
      return;
    for (const version of SUPPORTED_API_VERSIONS) {
      const pinned = read(version);
      const removed = [
        ...missingFrom(pinned.exports, current.exports).map((n) => `export ${n}`),
        ...missingFrom(pinned.gateway, current.gateway).map((n) => `gateway.${n}`),
      ];
      expect(
        removed,
        `Removed or renamed since API version ${version}: ${removed.join(', ')}. ` +
          'Code that calls them would break, so this needs API version 2 (see docs/API.md).'
      ).toEqual([]);
    }
  });

  it('records every addition on purpose', () => {
    const update = process.env.CLERQ_UPDATE_API_SURFACE === '1';
    const file = fileFor(API_VERSION);
    const pinned =
      update && !fs.existsSync(file) ? { exports: [], gateway: [] } : read(API_VERSION);
    const added = [
      ...missingFrom(current.exports, pinned.exports).map((n) => `export ${n}`),
      ...missingFrom(current.gateway, pinned.gateway).map((n) => `gateway.${n}`),
    ];
    const removed = [
      ...missingFrom(pinned.exports, current.exports),
      ...missingFrom(pinned.gateway, current.gateway),
    ];
    if (update && removed.length === 0) {
      fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    expect(
      added,
      `New in the client: ${added.join(', ')}. Additions are allowed within API version ${API_VERSION}, ` +
        'but they are recorded on purpose: run CLERQ_UPDATE_API_SURFACE=1 pnpm --filter @clerq/gateway-client ' +
        `exec vitest run src/surface.test.ts, then commit src/api-surface.v${API_VERSION}.json.`
    ).toEqual([]);
  });
});
