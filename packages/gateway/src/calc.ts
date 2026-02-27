/**
 * Invoke Rust arithmetic engine (clerq-calc) via subprocess.
 * All sensitive calculations run locally and are logged.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface EvalCalcRequest {
  expression?: string;
  inputs?: Record<string, number>;
  spec?: {
    id?: string;
    formulas: Record<string, string>;
    output_names?: string[];
  };
}

export interface EvalCalcResponse {
  values: Record<string, number>;
  proof: {
    calculation_id: string;
    timestamp: string;
    scope: string;
    operation: string;
    proof_hash: string;
    engine_version: string;
    is_audit_ready: boolean;
  };
}

export function getCalcBinaryPath(): string {
  if (process.env.CLERQ_CALC_PATH) {
    return process.env.CLERQ_CALC_PATH;
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  return path.join(repoRoot, 'packages', 'calculation-core', 'target', 'release', 'clerq-calc');
}

export function runEvalCalc(
  req: EvalCalcRequest,
  binaryPath: string
): Promise<EvalCalcResponse> {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({
      operation: 'eval',
      expression: req.expression,
      inputs: req.inputs ?? {},
      spec: req.spec,
    }) + '\n';

    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { console.warn('[Clerq] clerq-calc stderr:', chunk.trim()); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`clerq-calc exited with code ${code}`));
        return;
      }
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? stdout.trim();
      try {
        resolve(JSON.parse(line) as EvalCalcResponse);
      } catch (e) {
        reject(new Error(`clerq-calc invalid JSON: ${line}`));
      }
    });

    child.stdin.write(input, (err) => {
      if (err) reject(err);
      else child.stdin.end();
    });
  });
}
