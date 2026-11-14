import { describe, expect, it } from 'vitest';
import { startupLines, type StartupInfo } from './startup.js';
import { makeLog } from './log.js';

const base: StartupInfo = {
  gateway: '1.2.3',
  api: { version: 1, supported: [1] },
  schema: 21,
  host: '127.0.0.1',
  port: 18790,
  dataDir: '/var/lib/openclerq/.clerq',
  token: { source: 'file', file: '/var/lib/openclerq/.clerq/gateway-token' },
  envFile: null,
  calc: { path: '/usr/local/bin/clerq-calc', found: true, from: 'next-to-executable' },
};

const text = (info: StartupInfo) =>
  startupLines(info)
    .map((l) => `${l.level} ${l.message}`)
    .join('\n');

describe('startupLines', () => {
  it('says the versions, the address, the data directory and where the token is', () => {
    const out = text(base);
    expect(out).toContain('OpenClerq server 1.2.3 (API version 1, supported: 1; store schema 21)');
    expect(out).toContain('Listening on http://127.0.0.1:18790');
    expect(out).toContain('Data directory: /var/lib/openclerq/.clerq');
    expect(out).toContain('Gateway token: in /var/lib/openclerq/.clerq/gateway-token');
    expect(out).toContain('Calculation engine: /usr/local/bin/clerq-calc (next to this program)');
  });

  it('names the three places a token can come from, and never a value', () => {
    expect(text({ ...base, token: { source: 'env', file: '/x/gateway-token' } })).toContain(
      'Gateway token: from CLERQ_GATEWAY_TOKEN'
    );
    const generated = text({ ...base, token: { source: 'generated', file: '/x/gateway-token' } });
    expect(generated).toContain('generated at /x/gateway-token (mode 0600)');
    // A token is 64 hex characters; nothing of that length can be in the lines.
    for (const source of ['env', 'file', 'generated'] as const) {
      expect(text({ ...base, token: { source, file: '/x/gateway-token' } })).not.toMatch(
        /[0-9a-f]{32}/
      );
    }
  });

  it('is quiet about warnings on loopback and warns beyond it', () => {
    expect(startupLines(base).some((l) => l.level === 'WARN')).toBe(false);
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      const warnings = startupLines({ ...base, host }).filter((l) => l.level === 'WARN');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain(`Bound to ${host}`);
      expect(warnings[0].message).toContain('container');
      expect(warnings[0].message).toContain('TLS');
    }
  });

  it('warns when the calculation engine is missing, and brackets an IPv6 address', () => {
    const out = startupLines({
      ...base,
      host: '::',
      calc: { path: '/nope/clerq-calc', found: false, from: 'default' },
    });
    expect(out.map((l) => l.message).join('\n')).toContain(
      'Calculation engine not found at /nope/clerq-calc'
    );
    expect(out.map((l) => l.message).join('\n')).toContain('Listening on http://[::]:18790');
  });

  it('mentions the settings file only when one was read', () => {
    expect(text(base)).not.toContain('Settings read');
    expect(text({ ...base, envFile: '/h/.clerq/.env' })).toContain(
      'Settings read from /h/.clerq/.env'
    );
  });
});

describe('makeLog', () => {
  const at = () => new Date('2026-11-13T12:00:00.000Z');

  it("writes the gateway's line format, errors to stderr", () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = makeLog({}, { out: (l) => out.push(l), err: (l) => err.push(l) }, at);
    log('INFO', 'hello');
    log('WARN', 'careful');
    log('ERROR', 'broken');
    expect(out).toEqual(['[2026-11-13T12:00:00.000Z] [INFO] hello']);
    expect(err).toEqual([
      '[2026-11-13T12:00:00.000Z] [WARN] careful',
      '[2026-11-13T12:00:00.000Z] [ERROR] broken',
    ]);
  });

  it('writes JSON lines with CLERQ_LOG_JSON=1', () => {
    const out: string[] = [];
    makeLog(
      { CLERQ_LOG_JSON: '1' },
      { out: (l) => out.push(l), err: () => undefined },
      at
    )('INFO', 'hello');
    expect(JSON.parse(out[0])).toEqual({
      ts: '2026-11-13T12:00:00.000Z',
      level: 'INFO',
      msg: 'hello',
    });
  });
});
