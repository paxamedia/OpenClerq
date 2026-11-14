#!/usr/bin/env node
/**
 * clerq-server: the OpenClerq gateway as a headless daemon.
 * See docs/SERVER.md. `clerq-server help` lists the commands.
 */

import { parseArgs, USAGE } from './args.js';
import { ConfigError, ensureHome, loadEnvFile, type Env } from './env.js';

async function main(argv: string[], env: Env): Promise<number | null> {
  const command = parseArgs(argv);
  switch (command.kind) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'error':
      process.stderr.write(`clerq-server: ${command.message}\n\n${USAGE}`);
      return 2;
    case 'version': {
      const { serverVersion, versionText } = await import('./version.js');
      const v = await serverVersion();
      process.stdout.write(command.json ? `${JSON.stringify(v)}\n` : versionText(v));
      return 0;
    }
    case 'healthcheck': {
      // The same settings the server reads, so a port set in ~/.clerq/.env counts.
      try {
        loadEnvFile(env, ensureHome(env));
      } catch {
        /* the check below says what is wrong with the settings */
      }
      const { healthcheck } = await import('./healthcheck.js');
      const result = await healthcheck(env, { timeoutMs: command.timeoutMs });
      (result.ok ? process.stdout : process.stderr).write(
        `${result.ok ? '' : 'unhealthy: '}${result.message}\n`
      );
      return result.ok ? 0 : 1;
    }
    case 'run': {
      const { serve } = await import('./serve.js');
      await serve(env);
      return null; // keeps running until a signal
    }
  }
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof ConfigError) {
      process.stderr.write(`clerq-server: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(
        `clerq-server: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
      );
      process.exitCode = 1;
    }
  }
);
