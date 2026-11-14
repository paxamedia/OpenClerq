import { describe, expect, it } from 'vitest';
import tauriConf from '../src-tauri/tauri.conf.json';
import { desktopGatewayUrl } from './gatewayUrl';

describe('the desktop gateway address', () => {
  it('uses localhost as 127.0.0.1, with the port and path it was saved with', () => {
    expect(desktopGatewayUrl('http://localhost:18790')).toBe('http://127.0.0.1:18790');
    expect(desktopGatewayUrl('http://localhost:18790/')).toBe('http://127.0.0.1:18790/');
    expect(desktopGatewayUrl('http://LocalHost:8080/base')).toBe('http://127.0.0.1:8080/base');
    expect(desktopGatewayUrl('  http://localhost')).toBe('  http://127.0.0.1');
    expect(desktopGatewayUrl('https://localhost:8443')).toBe('https://127.0.0.1:8443');
  });

  it('leaves everything else as it is: 127.0.0.1, an empty setting, other hosts, a host that only starts with localhost', () => {
    for (const same of [
      'http://127.0.0.1:18790',
      '',
      'https://clerq.example.com',
      'http://[::1]:18790',
      'http://localhost.example.com:18790',
      'http://localhostx:18790',
      'http://example.com/localhost',
      'not a url',
    ]) {
      expect(desktopGatewayUrl(same), same).toBe(same);
    }
  });

  it('gives an address the policy allows: what it makes of localhost is a 127.0.0.1 source', () => {
    const csp = tauriConf.app.security.csp as Record<string, string>;
    const sources = csp['connect-src'].split(/\s+/);
    const url = new URL(desktopGatewayUrl('http://localhost:18790'));
    expect(url.hostname).toBe('127.0.0.1');
    expect(sources).toContain(`http://${url.hostname}:*`);
    // and the policy has no localhost source for a saved address to need
    expect(sources.some((s) => /localhost:/.test(s))).toBe(false);
  });
});
