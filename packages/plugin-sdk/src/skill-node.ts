/**
 * The checksum of a skill's folder, and reading the folder once.
 *
 * A skill's trust is the hash of the exact bytes the user approved, so the gateway must use
 * the bytes it hashed. `readSkillDir` reads every file in the folder one time, hashes what it
 * read, and hands back the SKILL.md it read: the instructions come from those bytes, not from a
 * second read that a file could change between.
 *
 * ```ts
 * import { skillChecksum } from '@clerq/plugin-sdk/node';
 * console.log(await skillChecksum('./my-skill')); // sha256:…
 * ```
 *
 * The value is SHA-256 over `clerq-skill-checksum-v1\n` and then `<path>\0<sha256 of the file>\n`
 * for every file in the folder, sorted by path (`/` between names, compared as text), with the one
 * `checksum:` line of SKILL.md's frontmatter left out. Links inside the folder are refused, not
 * followed: what they point at is not the folder's.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withChecksumLine, withoutChecksumLine } from './skill.js';

/** Raised with a sentence that can be shown as it is. */
export class SkillFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFilesError';
  }
}

/** Names the operating system adds to a folder on its own, and version-control folders; not the skill's. */
const IGNORED = (name: string) =>
  name === '.DS_Store' ||
  name === 'Thumbs.db' ||
  name === 'desktop.ini' ||
  name === '.git' ||
  name.startsWith('._');

export const SKILL_MAX_FILES = 5_000;
export const SKILL_MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;

const sha = (data: crypto.BinaryLike) => crypto.createHash('sha256').update(data).digest('hex');
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface SkillFile {
  /** Relative to the skill's folder, with `/`. */
  path: string;
  sha256: string;
  size: number;
}

export interface SkillRead {
  /** `sha256:<hex>` over the files as read. */
  checksum: string;
  /** Every file, sorted by path. SKILL.md's hash is over it without its `checksum:` line. */
  files: SkillFile[];
  /** SKILL.md as read, byte for byte; null when the folder has none. */
  skillMd: Buffer | null;
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Read every file of a skill's folder once and hash it.
 *
 * Throws `SkillFilesError` for a link anywhere inside it (the folder itself may be reached by a
 * link, as `clerq skill checksum` is given a path), a name with a control character, more than
 * 5,000 files or 64 MiB, or a file that cannot be read. A file is opened without following a
 * link at its last step, so one swapped in after the folder was listed is refused, and what was
 * read is what was hashed.
 */
export async function readSkillDir(dir: string): Promise<SkillRead> {
  let root: string;
  try {
    root = await fs.promises.realpath(dir);
    if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new SkillFilesError(`${dir} is not a folder.`);
  }

  const files: SkillFile[] = [];
  let skillMd: Buffer | null = null;
  let bytes = 0;

  const walk = async (rel: string, abs: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new SkillFilesError(`${rel || '.'} is nested too deeply.`);
    const entries = (await fs.promises.readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      if (IGNORED(entry.name)) continue;
      const here = rel ? `${rel}/${entry.name}` : entry.name;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f]/.test(entry.name)) {
        throw new SkillFilesError(`"${here}" has a control character in its name.`);
      }
      if (entry.isSymbolicLink()) {
        throw new SkillFilesError(
          `"${here}" is a link. A skill's folder may not contain links: what one points at is not part of the skill.`
        );
      }
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(here, child, depth + 1);
      } else if (entry.isFile()) {
        if (files.length >= SKILL_MAX_FILES) {
          throw new SkillFilesError(`The skill has more than ${SKILL_MAX_FILES} files.`);
        }
        let data: Buffer;
        try {
          const handle = await fs.promises.open(child, fs.constants.O_RDONLY | O_NOFOLLOW);
          try {
            const st = await handle.stat();
            if (!st.isFile()) throw new SkillFilesError(`"${here}" is not a regular file.`);
            if (bytes + st.size > SKILL_MAX_BYTES) {
              throw new SkillFilesError('The skill has more than 64 MiB of files.');
            }
            data = await handle.readFile();
            // What was read counts, whatever the file said it was.
            bytes += data.length;
            if (bytes > SKILL_MAX_BYTES) {
              throw new SkillFilesError('The skill has more than 64 MiB of files.');
            }
          } finally {
            await handle.close();
          }
        } catch (e) {
          if (e instanceof SkillFilesError) throw e;
          const code = (e as NodeJS.ErrnoException).code;
          throw new SkillFilesError(
            code === 'ELOOP' || code === 'EMLINK'
              ? `"${here}" is a link. A skill's folder may not contain links.`
              : `"${here}" could not be read (${code ?? 'error'}).`
          );
        }
        if (here === 'SKILL.md') {
          skillMd = data;
          files.push({
            path: here,
            sha256: sha(Buffer.from(withoutChecksumLine(data.toString('latin1')), 'latin1')),
            size: data.length,
          });
        } else {
          files.push({ path: here, sha256: sha(data), size: data.length });
        }
      }
      // Sockets, FIFOs and devices are not part of a skill; they are not read.
    }
  };
  await walk('', root, 0);

  files.sort(byPath);
  const h = crypto.createHash('sha256');
  h.update('clerq-skill-checksum-v1\n');
  for (const f of files) h.update(`${f.path}\0${f.sha256}\n`);
  return { checksum: `sha256:${h.digest('hex')}`, files, skillMd };
}

/** The checksum of the skill in `dir`. See {@link readSkillDir}. */
export async function skillChecksum(dir: string): Promise<string> {
  return (await readSkillDir(dir)).checksum;
}

/**
 * Put the folder's checksum into SKILL.md's frontmatter as `checksum: sha256:<hex>` (replacing a
 * line that was there), and return it. The value does not change by being written: the line is
 * not part of what is hashed. Throws `SkillFilesError` when there is no SKILL.md or it has no
 * frontmatter.
 */
export async function writeSkillChecksum(dir: string): Promise<string> {
  const read = await readSkillDir(dir);
  if (!read.skillMd) throw new SkillFilesError(`There is no SKILL.md in ${dir}.`);
  const text = read.skillMd.toString('latin1');
  const next = withChecksumLine(text, read.checksum);
  if (next === null) {
    throw new SkillFilesError(
      'SKILL.md has no frontmatter (a block between two "---" lines at the top), so there is nowhere to write the checksum.'
    );
  }
  const file = path.join(await fs.promises.realpath(dir), 'SKILL.md');
  // Written through the same no-follow open that read it.
  const handle = await fs.promises.open(
    file,
    fs.constants.O_WRONLY | fs.constants.O_TRUNC | O_NOFOLLOW
  );
  try {
    await handle.writeFile(Buffer.from(next, 'latin1'));
  } finally {
    await handle.close();
  }
  return read.checksum;
}
