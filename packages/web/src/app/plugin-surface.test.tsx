import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureClient } from '../fixtures';
import { EnvironmentContext, useClient, type Host } from './client';
import { LiveProvider, LiveStore, useResource } from './live';
import { PluginSurface, reducedHost } from './plugin-surface';

/** A host with everything a host can do, each of it a spy. */
function fullHost() {
  const host = {
    kind: 'desktop' as const,
    version: '1.2.3',
    openUrl: vi.fn(),
    openForm: vi.fn(async () => undefined),
    readConfig: vi.fn(async () => ({})),
    writeConfig: vi.fn(async () => undefined),
    setGatewayUrl: vi.fn(),
    saveApiKey: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(async () => 'up-to-date' as const),
    notify: vi.fn(),
    setBadge: vi.fn(),
  };
  return host satisfies Host;
}

describe('the host a plugin’s page is given', () => {
  it('is its kind, its version and a way to open an address, and nothing that changes the app', () => {
    const host = fullHost();
    const reduced = reducedHost(host);
    expect(Object.keys(reduced).sort()).toEqual(['kind', 'openUrl', 'version']);
    expect(reduced.kind).toBe('desktop');
    expect(reduced.version).toBe('1.2.3');
    for (const name of [
      'setGatewayUrl',
      'writeConfig',
      'readConfig',
      'saveApiKey',
      'openForm',
      'checkForUpdates',
      'notify',
      'setBadge',
    ]) {
      expect((reduced as unknown as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });

  it('opens an https address, and refuses every other kind', () => {
    const host = fullHost();
    const { openUrl } = reducedHost(host);
    openUrl('https://example.com/docs?x=1');
    expect(host.openUrl).toHaveBeenCalledTimes(1);
    expect(host.openUrl).toHaveBeenCalledWith('https://example.com/docs?x=1');
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'tauri://localhost/x',
      '//example.com/x',
      '/relative',
      'example.com',
      '',
      'https//broken',
    ]) {
      openUrl(url);
    }
    expect(host.openUrl).toHaveBeenCalledTimes(1);
  });
});

describe('what a plugin’s page is drawn inside', () => {
  const client = createFixtureClient();
  const scoped = createFixtureClient();

  /** A page that says what it reads with `useResource('sessions')` and which client it holds. */
  function Page() {
    const sessions = useResource('sessions', async () => 'fetched-by-the-plugin');
    return (
      <p>
        {String(sessions.data)}|{useClient() === scoped ? 'scoped' : 'app'}
      </p>
    );
  }

  it('reads and writes a live store that is the plugin’s, not the one the shell holds', () => {
    const shell = new LiveStore();
    shell.write('sessions', () => 'held-by-the-shell');
    const own = new LiveStore();
    own.write('sessions', () => 'held-by-the-plugin');
    const html = renderToStaticMarkup(
      <EnvironmentContext.Provider value={{ client, host: reducedHost(fullHost()) }}>
        <LiveProvider client={client} store={shell}>
          <PluginSurface store={own} client={scoped} host={reducedHost(fullHost())}>
            <Page />
          </PluginSurface>
        </LiveProvider>
      </EnvironmentContext.Provider>
    );
    expect(html).toContain('held-by-the-plugin');
    expect(html).not.toContain('held-by-the-shell');
    // And the client the page reads is the one it was given.
    expect(html).toContain('|scoped');
  });
});
