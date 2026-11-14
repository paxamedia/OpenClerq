/**
 * The desktop's Content-Security-Policy (apps/desktop/src-tauri/tauri.conf.json): what it may
 * never contain, and that it still lets the app reach its gateway. That the app really runs
 * under it, screen by screen, is `pnpm csp:check` (scripts/check-csp.mjs), which drives it in
 * headless Chrome and needs a built workspace and a browser; this is the part that is checked
 * on every test run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const conf = JSON.parse(
  fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
) as { app: { security: Record<string, unknown> } };
const check = (await import(
  /* @vite-ignore */ pathToFileURL(path.join(root, 'scripts', 'check-csp.mjs')).href
)) as {
  parsePolicy(csp: unknown): Record<string, string[]> | null;
  policyHeader(csp: unknown): string;
  SCREENS: [string, string | null, string][];
};

const csp = conf.app.security.csp;
const policy = check.parsePolicy(csp)!;
const all = Object.entries(policy);

/** Loopback by address, never by name: http://127.0.0.1, with a port or `*` for any. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1(?::(\d{1,5}|\*))?$/;

/** What each directive may hold. A directive or source that is not here fails until it is added on purpose. */
const ALLOWED: Record<string, (source: string) => boolean> = {
  'default-src': (s) => s === "'self'",
  'script-src': (s) => s === "'self'",
  'style-src': (s) => s === "'self'",
  'img-src': (s) => s === "'self'",
  'font-src': (s) => s === "'self'" || s === 'data:',
  'connect-src': (s) =>
    s === "'self'" || s === 'ipc:' || s === 'http://ipc.localhost' || LOOPBACK.test(s),
  'frame-src': (s) => LOOPBACK.test(s),
  'object-src': (s) => s === "'none'",
  'base-uri': (s) => s === "'none'",
  'form-action': (s) => s === "'none'",
};

/** Does a CSP source admit http://127.0.0.1:<port>? */
function admits(source: string, port: number): boolean {
  const m = LOOPBACK.exec(source);
  return m !== null && (m[1] === undefined ? port === 80 : m[1] === '*' || Number(m[1]) === port);
}

describe('the desktop policy', () => {
  it('is a policy at all, not null', () => {
    expect(csp).toBeTruthy();
    expect(typeof csp === 'object' || typeof csp === 'string').toBe(true);
    expect(all.length).toBeGreaterThan(5);
  });

  it('allows no unsafe-inline, unsafe-eval, unsafe-hashes or wasm-unsafe-eval anywhere', () => {
    for (const [name, sources] of all) {
      for (const source of sources) expect(source, `${name} ${source}`).not.toMatch(/unsafe/i);
    }
  });

  it('forbids plugins, a base address and forms outright', () => {
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'none'"]);
    expect(policy['form-action']).toEqual(["'none'"]);
  });

  it('runs scripts from the app’s own files only: no nonce, no hash, no address, no data:', () => {
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['default-src']).toEqual(["'self'"]);
    for (const name of ['script-src-elem', 'script-src-attr', 'worker-src']) {
      expect(policy[name] ?? ["'self'"], name).toEqual(["'self'"]);
    }
    expect(policy['style-src']).toEqual(["'self'"]);
  });

  it('has no source but the ones listed above: no wildcard host, no scheme alone, no localhost, no remote address', () => {
    for (const [name, sources] of all) {
      const allowed = ALLOWED[name];
      expect(allowed, `the directive ${name} is not one this test knows`).toBeDefined();
      for (const source of sources) {
        expect(allowed(source), `${name} may not hold ${source}`).toBe(true);
      }
    }
    // Spelled out, for what a loosened ALLOWED above would let through.
    const everySource = all.flatMap(([, sources]) => sources);
    for (const source of everySource) {
      expect(source).not.toBe('*');
      expect(source).not.toMatch(
        /^\*\.|\/\/\*|localhost:|https?:$|^wss?:|^blob:|^filesystem:|^https:/
      );
    }
    expect(everySource.filter((s) => /localhost/.test(s))).toEqual(['http://ipc.localhost']);
  });

  it('takes data: for fonts alone (the bundle inlines a small font), not for images, scripts, frames or requests', () => {
    for (const [name, sources] of all) {
      if (name !== 'font-src') expect(sources, name).not.toContain('data:');
    }
  });

  it('lets the app reach the gateway it starts and frame the module pages it serves, on loopback only', () => {
    const rust = fs.readFileSync(path.join(root, 'apps/desktop/src-tauri/src/main.rs'), 'utf8');
    const port = Number(/const GATEWAY_PORT: u16 = (\d+);/.exec(rust)?.[1]);
    expect(port).toBe(18790);
    expect(policy['connect-src'].some((s) => admits(s, port))).toBe(true);
    expect(policy['frame-src'].some((s) => admits(s, port))).toBe(true);
    // And only loopback: a frame source naming a host that is not 127.0.0.1 is not here.
    expect(policy['frame-src'].every((s) => LOOPBACK.test(s))).toBe(true);
    expect(
      policy['connect-src'].filter((s) => /^https?:\/\//.test(s) && !/ipc\.localhost/.test(s))
    ).toEqual(policy['connect-src'].filter((s) => LOOPBACK.test(s)));
  });

  it('is not weakened by the settings around it', () => {
    expect(conf.app.security).not.toHaveProperty('dangerousDisableAssetCspModification');
    expect(conf.app.security).not.toHaveProperty('devCsp');
    expect(conf.app.security).not.toHaveProperty('freezePrototype', false);
  });

  it('is written as the header Tauri sends, one directive after another', () => {
    const header = check.policyHeader(csp);
    expect(header.split('; ')).toHaveLength(all.length);
    expect(header).toContain("script-src 'self'");
    expect(header).toContain("object-src 'none'");
    // The string form of the same policy parses back to the same directives.
    expect(check.parsePolicy(header)).toEqual(policy);
  });
});

describe('the app’s page needs nothing the policy withholds', () => {
  const html = fs.readFileSync(path.join(root, 'apps/desktop/index.html'), 'utf8');
  it('has no inline script, no inline style, no style attribute and no event handler in index.html', () => {
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(script[1], 'a script must be a file').toMatch(/\bsrc=/);
      expect(script[2].trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("keeps the theme script a file of its own, which is what lets script-src stay 'self'", () => {
    expect(html).toContain('src="/theme.js"');
    expect(fs.existsSync(path.join(root, 'apps/desktop/public/theme.js'))).toBe(true);
  });
});

describe('the check that runs the app under it (scripts/check-csp.mjs)', () => {
  it('visits chat, a module’s own page in a frame, and the Settings pages', () => {
    const routes = check.SCREENS.map(([route]) => route);
    expect(routes).toContain('/m/chat');
    expect(
      routes.some((r) => r.startsWith('/m/') && r !== '/m/chat' && r !== '/m/automations')
    ).toBe(true);
    expect(routes.filter((r) => r.startsWith('/settings/')).length).toBeGreaterThanOrEqual(7);
    expect(routes).toContain('/developer/log');
  });
});
