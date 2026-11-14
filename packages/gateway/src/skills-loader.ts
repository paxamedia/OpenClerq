/**
 * Load skills from disk: list SKILL.md directories and parse frontmatter.
 */

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {
  FRONTMATTER,
  NO_NEEDS,
  parseChecksum,
  rawChecksumIn,
  readSkillNeeds,
  type SkillNeeds,
  type ToolCheck,
} from '@clerq/plugin-sdk/skill';
import { checkSkillTool } from './skills/tool-universe.js';

export interface SkillMeta {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  /** Agent hint: primary | fallback. System routes to primary or fallback per config; skills stay agent-agnostic. Deprecated: model (use agentHint). */
  agentHint?: 'primary' | 'fallback';
  /** @deprecated Use agentHint. Kept for backward compatibility. */
  model?: string;
  /** Keywords for skill-based routing. */
  triggers?: string[];
  /** JSON Schema for structured inputs. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for structured outputs. */
  outputSchema?: Record<string, unknown>;
  /** Slugs of skills this skill depends on. */
  dependsOn?: string[];
  /** What the manifest declares it needs (`tools_required`, `network_domains`, `filesystem_scope`). */
  needs?: SkillNeeds;
  /** The checksum its author wrote in SKILL.md, in `sha256:<hex>` form; absent when none or malformed. */
  checksum?: string;
  /** What is wrong with the manifest, in plain sentences. */
  warnings?: string[];
}

const FRONTMATTER_REGEX = FRONTMATTER;

/** The keys that are lists of text, which may be written as `[a, b]` or as `- a` lines. */
const LIST_KEYS = new Set(['tools_required', 'network_domains', 'filesystem_scope']);
const BLOCK_ITEM = /^\s+-(?:\s+(.*))?$/;

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === 'string') return v;
    } catch {
      // Not a JSON string: take what is between the quotes.
    }
    return t.slice(1, -1);
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

/** `[a, "b, c", 'd']` as a list; commas inside quotes stay. */
function flowList(text: string): string[] {
  const inner = text.trim().slice(1, -1);
  const items: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += inner[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  items.push(cur);
  return items.map(unquote).filter((x) => x !== '');
}

/**
 * The frontmatter of a SKILL.md as a flat record, line by line, as it has always been read:
 * `key: value`, a value in `[…]` or `{…}` as JSON (single quotes allowed), a quoted value without
 * its quotes. The three manifest lists (`tools_required`, `network_domains`, `filesystem_scope`)
 * are also read from `[a, b]` with plain words and from `- item` lines under the key; nothing
 * else about how a file is read changed. Not a YAML parser, on purpose: it would read
 * `version: 2026.10` as a number and `triggers: [a, b]` (a list a file has today that reads as
 * text and so routes nothing) as a list, and refuses text that loads now.
 */
export function parseFrontmatter(md: string): Record<string, unknown> | null {
  const match = md.match(FRONTMATTER_REGEX);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val: unknown = line.slice(colon + 1).trim();
    if (typeof val === 'string') {
      if (LIST_KEYS.has(key) && val === '') {
        const items: string[] = [];
        while (i + 1 < lines.length && BLOCK_ITEM.test(lines[i + 1])) {
          const item = BLOCK_ITEM.exec(lines[++i])?.[1];
          if (item !== undefined && item.trim() !== '') items.push(unquote(item));
        }
        if (items.length > 0) val = items;
      } else if (LIST_KEYS.has(key) && val.startsWith('[') && val.endsWith(']')) {
        val = flowList(val);
      } else if (
        (val.startsWith('[') && val.endsWith(']')) ||
        (val.startsWith('{') && val.endsWith('}'))
      ) {
        try {
          val = JSON.parse(val.replace(/'/g, '"'));
        } catch {
          // keep as string
        }
      } else if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        // YAML accepts either quote style; only double quotes were handled
        // before, so 'single-quoted' values kept their quotes and broke slug
        // lookups silently.
        val = val.slice(1, -1);
      }
    }
    out[key] = val;
  }
  return out;
}

/** A SKILL.md read: what it says about itself, its instructions, and what is wrong with it. */
export interface ParsedSkill {
  meta: SkillMeta;
  /** The instructions: everything after the frontmatter, trimmed. */
  body: string;
  /** The raw frontmatter, for a writer that must keep what it does not know. */
  frontmatter: Record<string, unknown>;
}

function objectOf(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Read a SKILL.md's text. `dirName` is the folder's name, the slug and name when the file gives
 * none. Null when the text has no frontmatter, which is not a skill. `checkTool` says what is
 * wrong with a name in `tools_required`; by default, the gateway's own tools.
 */
export function parseSkillMd(
  md: string,
  dirName: string,
  checkTool: ToolCheck = checkSkillTool
): ParsedSkill | null {
  const match = md.match(FRONTMATTER_REGEX);
  if (!match) return null;
  const fm = parseFrontmatter(md);
  if (!fm) return null;
  // The author's checksum is the one on a line of its own in the first column: the line that is
  // left out of what is hashed. An indented `checksum:` (it would be part of the hash) is not it.
  const declared = rawChecksumIn(md);
  const { needs, warnings } = readSkillNeeds({ ...fm, checksum: declared }, checkTool);
  const checksum = parseChecksum(declared);
  // Text where text is meant: a value that came out as a list or an object is not a name.
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const meta: SkillMeta = {
    slug: text(fm.slug)?.trim() ? (fm.slug as string) : dirName,
    name: text(fm.name)?.trim() ? (fm.name as string) : dirName,
    description: text(fm.description),
    version: text(fm.version),
    agentHint: (text(fm.agentHint) as 'primary' | 'fallback') || undefined,
    model: text(fm.model) || undefined,
    triggers: Array.isArray(fm.triggers) ? (fm.triggers as string[]) : undefined,
    inputSchema: objectOf(fm.inputSchema),
    outputSchema: objectOf(fm.outputSchema),
    dependsOn: Array.isArray(fm.dependsOn) ? (fm.dependsOn as string[]) : undefined,
    needs,
    ...(checksum ? { checksum } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return { meta, body: md.slice(match[0]?.length ?? 0).trim(), frontmatter: fm };
}

/** The skills in one folder, folder by folder: each skill's folder name and what its SKILL.md says. */
export async function listSkillDirs(
  skillsDir: string
): Promise<Array<{ dirName: string; meta: SkillMeta }>> {
  let dirs: string[] = [];
  try {
    // By name, so which of two equal matches comes first does not depend on the file system.
    dirs = await fs.readdir(skillsDir, { withFileTypes: true }).then((entries) =>
      entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    );
  } catch {
    return [];
  }
  const out: Array<{ dirName: string; meta: SkillMeta }> = [];
  for (const name of dirs) {
    try {
      const md = await fs.readFile(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
      const parsed = parseSkillMd(md, name);
      if (parsed) out.push({ dirName: name, meta: parsed.meta });
    } catch {
      // No SKILL.md or unreadable — skip
    }
  }
  return out;
}

export async function loadSkillsFromDir(skillsDir: string): Promise<SkillMeta[]> {
  return (await listSkillDirs(skillsDir)).map((s) => s.meta);
}

export interface SkillFrontmatterPatch {
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  dependsOn?: string[] | null;
}

/**
 * Find the directory name for a skill by slug. Returns the first match.
 */
export async function findSkillDir(skillsDir: string, slug: string): Promise<string | null> {
  let dirs: string[] = [];
  try {
    dirs = await fs
      .readdir(skillsDir, { withFileTypes: true })
      .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return null;
  }
  for (const name of dirs) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    try {
      const md = await fs.readFile(skillPath, 'utf8');
      const parsed = parseSkillMd(md, name);
      if (!parsed) continue;
      if (parsed.meta.slug === slug) return name;
    } catch {
      if (name === slug) return name;
    }
  }
  return null;
}

/**
 * Load full SKILL.md content and parsed meta for a skill.
 */
export async function loadSkillContent(
  skillsDir: string,
  slug: string
): Promise<{ meta: SkillMeta; body: string } | null> {
  const dirName = await findSkillDir(skillsDir, slug);
  if (!dirName) return null;
  const skillPath = path.join(skillsDir, dirName, 'SKILL.md');
  try {
    const parsed = parseSkillMd(await fs.readFile(skillPath, 'utf8'), dirName);
    return parsed ? { meta: parsed.meta, body: parsed.body } : null;
  } catch {
    return null;
  }
}

/**
 * Load a skill from the first of several skills directories that has it, in
 * the order given — the same precedence the skill list uses.
 */
export async function loadSkillContentFrom(
  skillsDirs: string[],
  slug: string
): Promise<{ meta: SkillMeta; body: string } | null> {
  for (const dir of skillsDirs) {
    const content = await loadSkillContent(dir, slug);
    if (content) return content;
  }
  return null;
}

function frontmatterToString(fm: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      lines.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else if (typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Update skill frontmatter (schemas, dependencies) and write back to SKILL.md.
 */
export async function saveSkillFrontmatter(
  skillsDir: string,
  slug: string,
  patch: SkillFrontmatterPatch
): Promise<boolean> {
  const dirName = await findSkillDir(skillsDir, slug);
  if (!dirName) return false;
  const skillPath = path.join(skillsDir, dirName, 'SKILL.md');
  let parsed: ParsedSkill | null;
  try {
    parsed = parseSkillMd(await fs.readFile(skillPath, 'utf8'), dirName);
  } catch {
    return false;
  }
  if (!parsed) return false;
  // Every key the file has is kept (the manifest's `tools_required`, `network_domains`,
  // `filesystem_scope` and `checksum` among them), in the order it had them; the patch changes
  // only what it names. The `checksum:` line is kept as it was: the file no longer matches it,
  // which the trust state then says.
  const fm: Record<string, unknown> = { ...parsed.frontmatter };
  if (patch.inputSchema !== undefined) fm.inputSchema = patch.inputSchema ?? undefined;
  if (patch.outputSchema !== undefined) fm.outputSchema = patch.outputSchema ?? undefined;
  if (patch.dependsOn !== undefined) fm.dependsOn = patch.dependsOn ?? undefined;
  const out = frontmatterToString(fm) + '\n\n' + parsed.body;
  await fs.writeFile(skillPath, out, 'utf8');
  return true;
}

/**
 * Resolve skills directory: CLERQ_SKILLS_DIR or repo clerq/skills.
 */
export function getSkillsDir(): string {
  if (process.env.CLERQ_SKILLS_DIR) {
    return process.env.CLERQ_SKILLS_DIR;
  }
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'skills'),
    path.join(cwd, '..', 'skills'),
    path.join(cwd, '..', '..', 'skills'),
  ];
  for (const dir of candidates) {
    if (fssync.existsSync(dir)) return dir;
  }
  return path.join(cwd, '..', '..', 'skills');
}
