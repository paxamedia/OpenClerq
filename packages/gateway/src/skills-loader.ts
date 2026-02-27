/**
 * Load skills from disk: list SKILL.md directories and parse frontmatter.
 */

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

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
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseFrontmatter(md: string): Record<string, unknown> | null {
  const match = md.match(FRONTMATTER_REGEX);
  if (!match) return null;
  const block = match[1];
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val: unknown = line.slice(colon + 1).trim();
    if (typeof val === 'string') {
      if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
        try {
          val = JSON.parse(val.replace(/'/g, '"'));
        } catch {
          // keep as string
        }
      } else if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
    }
    out[key] = val;
  }
  return out;
}

export async function loadSkillsFromDir(skillsDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(skillsDir, { withFileTypes: true }).then((entries) =>
      entries.filter((e) => e.isDirectory()).map((e) => e.name)
    );
  } catch {
    return skills;
  }

  for (const name of dirs) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    try {
      const md = await fs.readFile(skillPath, 'utf8');
      const fm = parseFrontmatter(md);
      if (!fm) continue;
      const slug = (fm.slug as string) ?? name;
      skills.push({
        slug,
        name: (fm.name as string) ?? name,
        description: fm.description as string | undefined,
        version: fm.version as string | undefined,
        agentHint: (fm.agentHint as 'primary' | 'fallback') || undefined,
        model: (fm.model as string) || undefined,
        triggers: Array.isArray(fm.triggers) ? (fm.triggers as string[]) : undefined,
        inputSchema:
          fm.inputSchema && typeof fm.inputSchema === 'object' && !Array.isArray(fm.inputSchema)
            ? (fm.inputSchema as Record<string, unknown>)
            : undefined,
        outputSchema:
          fm.outputSchema && typeof fm.outputSchema === 'object' && !Array.isArray(fm.outputSchema)
            ? (fm.outputSchema as Record<string, unknown>)
            : undefined,
        dependsOn: Array.isArray(fm.dependsOn) ? (fm.dependsOn as string[]) : undefined,
      });
    } catch {
      // No SKILL.md or unreadable — skip
    }
  }

  return skills;
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
    dirs = await fs.readdir(skillsDir, { withFileTypes: true }).then((entries) =>
      entries.filter((e) => e.isDirectory()).map((e) => e.name)
    );
  } catch {
    return null;
  }
  for (const name of dirs) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    try {
      const md = await fs.readFile(skillPath, 'utf8');
      const fm = parseFrontmatter(md);
      if (!fm) continue;
      const s = (fm.slug as string) ?? name;
      if (s === slug) return name;
    } catch {
      if (name === slug) return name;
    }
  }
  return null;
}

/**
 * Load full SKILL.md content and parsed meta for a skill.
 */
export async function loadSkillContent(skillsDir: string, slug: string): Promise<{ meta: SkillMeta; body: string } | null> {
  const dirName = await findSkillDir(skillsDir, slug);
  if (!dirName) return null;
  const skillPath = path.join(skillsDir, dirName, 'SKILL.md');
  try {
    const md = await fs.readFile(skillPath, 'utf8');
    const match = md.match(FRONTMATTER_REGEX);
    if (!match) return null;
    const body = md.slice((match[0]?.length ?? 0)).trim();
    const fm = parseFrontmatter(md);
    if (!fm) return null;
    const meta: SkillMeta = {
      slug: (fm.slug as string) ?? dirName,
      name: (fm.name as string) ?? dirName,
      description: fm.description as string | undefined,
      version: fm.version as string | undefined,
      agentHint: (fm.agentHint as 'primary' | 'fallback') || undefined,
      model: (fm.model as string) || undefined,
      triggers: Array.isArray(fm.triggers) ? (fm.triggers as string[]) : undefined,
      inputSchema:
        fm.inputSchema && typeof fm.inputSchema === 'object' && !Array.isArray(fm.inputSchema)
          ? (fm.inputSchema as Record<string, unknown>)
          : undefined,
      outputSchema:
        fm.outputSchema && typeof fm.outputSchema === 'object' && !Array.isArray(fm.outputSchema)
          ? (fm.outputSchema as Record<string, unknown>)
          : undefined,
      dependsOn: Array.isArray(fm.dependsOn) ? (fm.dependsOn as string[]) : undefined,
    };
    return { meta, body };
  } catch {
    return null;
  }
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
  const content = await loadSkillContent(skillsDir, slug);
  if (!content) return false;
  const dirName = await findSkillDir(skillsDir, slug);
  if (!dirName) return false;
  const skillPath = path.join(skillsDir, dirName, 'SKILL.md');
  const fm: Record<string, unknown> = {
    slug: content.meta.slug,
    name: content.meta.name,
    description: content.meta.description,
    version: content.meta.version,
    agentHint: content.meta.agentHint,
    model: content.meta.model,
    triggers: content.meta.triggers,
    inputSchema: content.meta.inputSchema,
    outputSchema: content.meta.outputSchema,
    dependsOn: content.meta.dependsOn,
  };
  if (patch.inputSchema !== undefined) fm.inputSchema = patch.inputSchema ?? undefined;
  if (patch.outputSchema !== undefined) fm.outputSchema = patch.outputSchema ?? undefined;
  if (patch.dependsOn !== undefined) fm.dependsOn = patch.dependsOn ?? undefined;
  const out = frontmatterToString(fm) + '\n\n' + content.body;
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
