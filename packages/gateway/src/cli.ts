#!/usr/bin/env node
/**
 * Clerq Gateway CLI — start the agent control plane
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env: user config first (desktop writes here), then cwd, then repo root. So "download and run" works with Settings API key.
const homedir = process.env.HOME || process.env.USERPROFILE || '';
const userEnv = path.join(homedir, '.clerq', '.env');
if (homedir && fs.existsSync(userEnv)) {
  dotenv.config({ path: userEnv });
}
dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import { secureClerqHome } from '@clerq/store';
import { createGateway } from './gateway.js';

import { resolveGatewayToken } from './security/auth.js';

// ~/.clerq holds API keys, conversations and the vault. Earlier builds could
// leave it readable by other accounts; repair that before anything is served.
try {
  const tightened = secureClerqHome();
  if (tightened.length > 0) {
    console.log(`[Clerq] Restricted ${tightened.length} path(s) under ~/.clerq to this account.`);
  }
} catch (e) {
  console.warn(
    `[Clerq] Could not restrict ~/.clerq permissions: ${e instanceof Error ? e.message : e}`
  );
}

const port = parseInt(process.env.CLERQ_PORT ?? '18790', 10);
const host = process.env.CLERQ_HOST ?? '127.0.0.1';

const { token, source } = resolveGatewayToken();

console.log('[Clerq] Starting gateway...');
console.log(`[Clerq] Listening on http://${host}:${port}`);

if (source === 'generated') {
  console.log('[Clerq] Generated a gateway token at ~/.clerq/gateway-token (mode 0600).');
}
if (source !== 'env') {
  console.log('[Clerq] Authenticate with: Authorization: Bearer $(cat ~/.clerq/gateway-token)');
}
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.warn(
    `[Clerq] WARNING: bound to ${host}, which is reachable from the network. ` +
      'Put TLS in front of it and treat the gateway token as a production credential.'
  );
}

createGateway({ port, host, authToken: token });
