/**
 * Staging: a plugin, or a legacy module, is run and served from a copy of exactly the files
 * that were hashed.
 *
 * `pluginChecksumDetail` hashes the manifest and every file under the plugin's code paths (the
 * server entry's whole folder, the UI, the skills, the migrations). Staging reads each of those
 * files, checks it against the hash that was recorded when the decision was made (the approval
 * names that hash), and writes the verified bytes to
 *
 *   ~/.clerq/plugin-cache/<id>/<first 32 hex of the checksum>/<same relative path>
 *
 * The entry is imported from there, the UI is served from there, the skills are read from there
 * and the migrations come from there. So what runs is what was approved; a file the hash does
 * not cover is not copied and cannot be imported from the copy; and a changed plugin is a
 * different path, which is a new module for Node and for Bun alike (neither will import a changed
 * file again from the same path).
 *
 * What staging cannot stop is code that does not come from the copy: a bare package name
 * (`import 'express'`) is resolved by walking up from the cache folder to `~/node_modules`, and an
 * absolute path (`import(ctx.dir + …)` with a path outside the copy, or a path to the original
 * folder) is whatever is there. Those are outside the approval; a plugin that wants to be
 * covered bundles what it needs into its own folder.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clerqHome } from '@clerq/store';
import type { DiscoveredModule } from '../module-loader.js';

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** Where staged copies live: `~/.clerq/plugin-cache/<id>/<hash>/`. */
export function stageRoot(): string {
  return path.join(clerqHome(), 'plugin-cache');
}

/** A file the checksum covers, with its own hash. */
export interface StageFile {
  path: string;
  sha256: string;
}

export type Staged = { dir: string } | { changed: true } | { error: string };

/** Every file under `dir`, as `/`-separated paths relative to it. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(dir, next));
    else out.push(next);
  }
  return out;
}

/** Whether `dir` holds exactly `files`, with exactly their bytes. */
function holdsExactly(dir: string, files: readonly StageFile[]): boolean {
  try {
    const have = walk(dir).sort();
    const want = files.map((f) => f.path).sort();
    if (have.length !== want.length || have.some((p, i) => p !== want[i])) return false;
    return files.every((f) => sha256(fs.readFileSync(path.join(dir, f.path))) === f.sha256);
  } catch {
    return false;
  }
}

/**
 * Copy the files that were hashed to a folder named by the checksum, verifying each against its
 * recorded hash on the way. `changed` says a file is not what was read when the decision was made
 * (edited, gone), so the decision has to be made again. Copies of other versions of the plugin are
 * removed. The manifest is written from the text that was validated, not read again.
 */
export function stagePlugin(
  d: Pick<DiscoveredModule, 'id' | 'dir' | 'manifestText'>,
  facts: { checksum: string | null; files: readonly StageFile[] }
): Staged {
  if (!facts.checksum) return { error: 'The plugin has no checksum, so it cannot be staged.' };
  const folder = path.join(stageRoot(), d.id);
  const name = facts.checksum.slice(0, 32);
  const target = path.join(folder, name);
  try {
    if (holdsExactly(target, facts.files)) {
      sweep(folder, name);
      return { dir: target };
    }
    fs.rmSync(target, { recursive: true, force: true });
    const temp = path.join(folder, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
    try {
      for (const f of facts.files) {
        let bytes: Buffer;
        let mode = 0o600;
        if (f.path === 'manifest.json') {
          bytes = Buffer.from(d.manifestText);
        } else {
          const source = path.join(d.dir, f.path);
          try {
            bytes = fs.readFileSync(source);
            if (fs.statSync(source).mode & 0o100) mode = 0o700;
          } catch {
            fs.rmSync(temp, { recursive: true, force: true });
            return { changed: true };
          }
        }
        if (sha256(bytes) !== f.sha256) {
          fs.rmSync(temp, { recursive: true, force: true });
          return { changed: true };
        }
        const to = path.join(temp, f.path);
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        fs.writeFileSync(to, bytes, { mode });
      }
      fs.renameSync(temp, target);
    } catch (e) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw e;
    }
    sweep(folder, name);
    return { dir: target };
  } catch (e) {
    return {
      error: `The plugin could not be staged for loading: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Remove the other versions' copies, and half-written ones left by a process that died. */
function sweep(folder: string, keep: string): void {
  try {
    for (const other of fs.readdirSync(folder)) {
      if (other === keep) continue;
      const full = path.join(folder, other);
      // Another gateway's copy in progress is not ours to remove for ten minutes.
      if (other.startsWith('.tmp-') && Date.now() - fs.statSync(full).mtimeMs < 10 * 60_000)
        continue;
      fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}
