/**
 * What the chat console declares and what its code does, checked without running it: the
 * endpoints its source calls are the endpoints its manifest lists, it imports only what a
 * third-party plugin can import too, and its manifest is a valid one for the SDK.
 * (console.e2e.test.tsx drives the page itself.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayClient } from '@clerq/gateway-client';
import { declarableApi, engineProblem, validateManifest } from '@clerq/plugin-sdk/manifest';
import { chatManifest, chatPlugin, CHAT_ID } from './index';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
const DECLARED: string[] = chatManifest.permissions.api;

/** The console's own source: everything under src that is not a test. */
const sources = fs
  .readdirSync(SRC)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(SRC, f), 'utf8') }));

describe('the manifest', () => {
  it('is a valid version 1 manifest, for this API, that says what the plugin is', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const result = validateManifest(raw);
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
    expect(raw).toMatchObject({ manifestVersion: 1, id: 'chat', engines: { api: 1 } });
    expect(raw.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(engineProblem(raw.engines.api)).toBeNull();
    expect(raw.permissions.llm).toBe(true);
    // Its server side is the gateway's own code, so there is no server entry and no folder it serves.
    expect(raw.entry).toBeUndefined();
    // The console itself uses neither files nor commands: managed mode does, in a folder you attach, in the gateway.
    expect(raw.permissions.fs).toBeUndefined();
    expect(raw.permissions.exec).toBeUndefined();
    expect(raw.description).toContain('folder you attach');
  });

  it('is what the UI says it calls, and the UI is the one the manifest names', () => {
    expect(chatPlugin.api).toEqual(DECLARED);
    expect(chatPlugin.id).toBe(CHAT_ID);
    expect(chatPlugin.rail.map((r) => r.path)).toEqual([`/m/${CHAT_ID}`]);
    for (const scope of DECLARED) expect(declarableApi(scope), scope).toBe(true);
    expect(new Set(DECLARED).size).toBe(DECLARED.length);
  });

  it('ships nothing but the manifest for the gateway to hash', () => {
    // The app carries manifest.json alone; a folder the checksum covers here would not be there.
    for (const dir of ['dist', 'skills', 'migrations']) {
      expect(fs.existsSync(path.join(ROOT, dir)), dir).toBe(false);
    }
  });
});

describe('the calls the source makes', () => {
  const asked: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    asked.length = 0;
  });

  /** Every `client.name(` in the console's own source. */
  const called = new Set(
    sources.flatMap((s) =>
      [...s.text.matchAll(/\bclient\s*\.\s*([A-Za-z]+)\s*\(/g)].map((m) => m[1])
    )
  );

  /** What one method of the real client asks of the gateway, for the arguments a person's click would give it. */
  async function endpointsOf(method: string): Promise<string[]> {
    const seen = new Set<string>();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.add(
        `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname.replace(/^\/v1/, '')}`
      );
      return Response.json({ ok: true });
    });
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
    }) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    // What a click gives each call. A method whose address is built from more than ids says what from.
    const own: Record<string, unknown[][]> = {
      decideApproval: [
        [7, 'approve'],
        [7, 'deny'],
      ],
    };
    const tuples: unknown[][] = own[method] ?? [
      [],
      ['ses_1'],
      ['ses_1', 'drf_1'],
      ['ses_1', { text: 'x', models: ['a', 'b'] }],
      ['ses_1', 1, 0],
    ];
    for (const args of tuples) {
      try {
        await client[method](...args);
      } catch {
        /* only the first request matters */
      }
    }
    return [...seen];
  }

  /** Whether `METHOD /path/with/ids` is one `METHOD /path/:id` pattern admits. */
  const admits = (pattern: string, endpoint: string) => {
    const [pm, pp] = pattern.split(' ');
    const [m, p] = endpoint.split(' ');
    const want = pp.split('/').filter(Boolean);
    const got = p.split('/').filter(Boolean);
    return (
      pm === m &&
      want.length === got.length &&
      want.every((w, i) => w.startsWith(':') || w === got[i])
    );
  };

  it('finds the client calls the console makes', () => {
    // A guard on this test itself: if the scan found nothing, it would prove nothing.
    expect([...called]).toEqual(
      expect.arrayContaining([
        'session',
        'sessions',
        'createSession',
        'sendMessage',
        'decideApproval',
        'modeDiff',
      ])
    );
  });

  it('are all for endpoints the manifest declares', async () => {
    const stray: string[] = [];
    for (const method of called) {
      // Not a gateway call: the address, for instance.
      if (method === 'getUrl') continue;
      const endpoints = await endpointsOf(method);
      // A name that is not a client method at all (a local variable called `client`) makes no request.
      for (const e of endpoints)
        if (!DECLARED.some((d) => admits(d, e))) stray.push(`${method}: ${e}`);
    }
    expect(stray).toEqual([]);
  });

  it('cover every endpoint the manifest declares, so it does not ask for more than it uses', async () => {
    // Stopping a streamed answer cancels its run from inside sendMessage, a call this scan does not name.
    const reached = new Set<string>(['POST /runs/run_1/cancel']);
    for (const method of called) for (const e of await endpointsOf(method)) reached.add(e);
    const unused = DECLARED.filter((d) => ![...reached].some((e) => admits(d, e)));
    expect(unused).toEqual([]);
  });
});

describe('the imports', () => {
  /** What a third-party plugin can import as well: the SDK, the client, the UI surface, React and the icons. */
  const ALLOWED = [
    /^react$/,
    /^lucide-react$/,
    /^@clerq\/plugin-sdk\/ui$/,
    /^@clerq\/gateway-client$/,
    /^@clerq\/web\/plugin-ui$/,
    /^\.\.?\//,
    /^\.\/[A-Za-z]+\.css$/,
    /^\.\.\/manifest\.json$/,
  ];

  it('are the ones a third-party plugin has too', () => {
    const stray: string[] = [];
    for (const { file, text } of sources) {
      const froms = [
        ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g),
        ...text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g),
      ].map((m) => m[1]);
      for (const from of froms)
        if (!ALLOWED.some((re) => re.test(from))) stray.push(`${file}: ${from}`);
    }
    expect(stray).toEqual([]);
  });

  it('take nothing from the client but types and words: not the app’s own client, nor a way to set its token', () => {
    // The client module also exports the shared `gateway`, on which the desktop sets the gateway's own token
    // (`setGatewayToken`). Code built into the app runs in the app's JavaScript context, so this is a rule the
    // console keeps and this test holds it to, not a wall: see "What the scoped client does and does not do".
    const FROM_CLIENT = /import\s+(type\s+)?([^;]*?)\s+from\s+['"]@clerq\/gateway-client['"]/g;
    const stray: string[] = [];
    for (const { file, text } of sources) {
      for (const m of text.matchAll(FROM_CLIENT)) {
        const clause = m[2].trim();
        if (m[1]) continue; // `import type { … }`: no value comes with it
        if (/^\*\s+as\b/.test(clause) || !clause.startsWith('{')) {
          stray.push(`${file}: ${clause} (a namespace or default import takes everything)`);
          continue;
        }
        const names = clause
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith('type '));
        for (const name of names) {
          const value = name.split(/\s+as\s+/)[0];
          if (/^(gateway|setGateway\w*|hasGatewayToken|createGatewayClient)$/.test(value)) {
            stray.push(`${file}: ${value}`);
          }
        }
      }
      // A re-export would pass it on.
      expect(text, file).not.toMatch(
        /export\s+\{[^}]*\bgateway\b[^}]*\}\s+from\s+['"]@clerq\/gateway-client['"]/
      );
    }
    expect(stray).toEqual([]);
  });

  it('reach nothing in the app by a path', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/from\s+['"]\.\.\/\.\.\//);
      expect(text, file).not.toMatch(/@clerq\/web['"]/);
    }
  });
});
