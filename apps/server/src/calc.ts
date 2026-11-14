/**
 * Where the calculation engine is. `CLERQ_CALC_PATH` wins; otherwise a
 * `clerq-calc` next to this program (the layout of a release tarball and of
 * the container image); otherwise the gateway's own default.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Env } from './env.js';

export function calcNextTo(
  execPath: string,
  platform: string = process.platform,
  exists: (file: string) => boolean = fs.existsSync
): string | null {
  const file = path.join(
    path.dirname(execPath),
    platform === 'win32' ? 'clerq-calc.exe' : 'clerq-calc'
  );
  return exists(file) ? file : null;
}

/**
 * Sets `CLERQ_CALC_PATH` in `env` to the `clerq-calc` next to `execPath` when
 * it is not set already and there is one. Returns where it came from.
 */
export function chooseCalcPath(
  env: Env,
  execPath: string = process.execPath,
  exists?: (file: string) => boolean,
  platform?: string
): 'env' | 'next-to-executable' | 'default' {
  if (env.CLERQ_CALC_PATH?.trim()) return 'env';
  const beside = calcNextTo(execPath, platform, exists);
  if (!beside) return 'default';
  env.CLERQ_CALC_PATH = beside;
  return 'next-to-executable';
}
