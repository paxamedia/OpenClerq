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

import { createGateway } from './gateway.js';

const port = parseInt(process.env.CLERQ_PORT ?? '18790', 10);

console.log('[Clerq] Starting gateway...');
createGateway({ port });
