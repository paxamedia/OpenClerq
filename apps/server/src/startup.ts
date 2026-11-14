/**
 * What the server says about itself when it starts. Nothing here ever holds
 * the gateway token: it says where the token is, not what it is.
 */

import { isLoopback } from './env.js';

export interface StartupInfo {
  /** The release, e.g. "1.0.0". */
  gateway: string;
  api: { version: number; supported: readonly number[] };
  /** The newest store schema this build knows. */
  schema: number;
  host: string;
  port: number;
  dataDir: string;
  token: { source: 'env' | 'file' | 'generated'; file: string };
  /** `~/.clerq/.env` when it was read. */
  envFile: string | null;
  calc: { path: string; found: boolean; from: 'env' | 'next-to-executable' | 'default' };
}

export interface Line {
  level: 'INFO' | 'WARN';
  message: string;
}

export function startupLines(info: StartupInfo): Line[] {
  const lines: Line[] = [];
  const say = (message: string) => lines.push({ level: 'INFO', message });
  const warn = (message: string) => lines.push({ level: 'WARN', message });

  say(
    `OpenClerq server ${info.gateway} (API version ${info.api.version}, supported: ` +
      `${info.api.supported.join(', ')}; store schema ${info.schema})`
  );
  say(`Listening on http://${info.host.includes(':') ? `[${info.host}]` : info.host}:${info.port}`);
  say(`Data directory: ${info.dataDir}`);
  if (info.envFile) say(`Settings read from ${info.envFile} (the environment wins over it)`);

  if (info.token.source === 'env') say('Gateway token: from CLERQ_GATEWAY_TOKEN');
  else if (info.token.source === 'file') say(`Gateway token: in ${info.token.file}`);
  else say(`Gateway token: generated at ${info.token.file} (mode 0600); read it from there`);

  const from = {
    env: 'CLERQ_CALC_PATH',
    'next-to-executable': 'next to this program',
    default: 'default location',
  }[info.calc.from];
  if (info.calc.found) say(`Calculation engine: ${info.calc.path} (${from})`);
  else {
    warn(
      `Calculation engine not found at ${info.calc.path} (${from}); calculations will fail until ` +
        'CLERQ_CALC_PATH names a clerq-calc binary'
    );
  }

  if (!isLoopback(info.host)) {
    warn(
      `Bound to ${info.host}, which is not loopback: whatever can reach this port can try the API. ` +
        'Inside a container that is normal and the published port decides who can; anywhere else ' +
        'put TLS in front and keep the port closed to the network. Treat the gateway token as a ' +
        'production credential (docs/SERVER.md).'
    );
  }
  return lines;
}
