/**
 * @clerq/plugin-sdk/skill: what a skill's manifest says it needs, and how that is read.
 *
 * A skill is prompt text: a `SKILL.md` whose frontmatter may declare `tools_required`,
 * `network_domains`, `filesystem_scope` and a `checksum`. Everything here is pure (no file
 * system, no `node:crypto`), so the desktop app can say a skill's needs in words the same
 * way the gateway and the command line do. The checksum itself, which reads the skill's
 * folder, is in `@clerq/plugin-sdk/node`.
 *
 * Declaring is not permission. A skill says what its instructions expect; the user decides
 * whether to trust it, and the gateway uses the declaration only when the user has turned
 * enforcement on (docs/SKILLS.md).
 */

/** What a skill declares it needs. Each list may be empty: an empty list declares nothing. */
export interface SkillNeeds {
  /** Policy tool names or rules (`fs.read`, `group:fs`, `risk:read`) the instructions use. */
  tools: string[];
  /** Hosts the instructions expect to reach: `api.example.com` or `*.example.com`. */
  domains: string[];
  /** Paths the instructions expect to read or write: relative to the folder, or `~/…`. */
  paths: string[];
}

export const NO_NEEDS: SkillNeeds = Object.freeze({
  tools: Object.freeze([]) as unknown as string[],
  domains: Object.freeze([]) as unknown as string[],
  paths: Object.freeze([]) as unknown as string[],
}) as SkillNeeds;

/** The three keys of the manifest that declare needs, and the field of `SkillNeeds` each fills. */
export const NEEDS_KEYS = {
  tools_required: 'tools',
  network_domains: 'domains',
  filesystem_scope: 'paths',
} as const;

export type NeedsKey = keyof typeof NEEDS_KEYS;

/**
 * The frontmatter block of a SKILL.md: the file opens with `---`, and the block ends where a
 * later line starts with `---`. The same expression the gateway has always used.
 */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** A top-level `checksum:` line of the frontmatter. */
export const CHECKSUM_LINE = /^checksum[ \t]*:/;

/** `sha256:` and 64 hex digits. */
export const CHECKSUM_VALUE = /^sha256:([0-9a-fA-F]{64})$/;

/** A declared checksum, normalised to lower case; null when it is not in that form. */
export function parseChecksum(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = CHECKSUM_VALUE.exec(value.trim());
  return m ? `sha256:${m[1].toLowerCase()}` : null;
}

/**
 * Where the frontmatter's lines are in a SKILL.md, found with `FRONTMATTER` itself so this and
 * the reader never disagree: `region` is the block with the line ending that closes it, so it
 * is whole lines; `before` is the opening `---` line and `after` starts at the closing `---`.
 */
function frontmatterParts(text: string): { before: string; region: string; after: string } | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const open = text.indexOf('\n') + 1;
  const block = m[1];
  const eol = text.startsWith('\r\n', open + block.length) ? 2 : 1;
  const cut = open + block.length + eol;
  return { before: text.slice(0, open), region: text.slice(open, cut), after: text.slice(cut) };
}

const wholeLines = (region: string): string[] => region.match(/[^\n]*\n/g) ?? [];

/**
 * The text of a SKILL.md without its `checksum:` line, which is what the checksum is over
 * (a checksum cannot be over itself). Every top-level line of the frontmatter that starts
 * with `checksum:` is dropped, whole, with its line ending; nothing else changes, byte for
 * byte. Pass text decoded as latin1 to keep every byte (`Buffer.toString('latin1')`).
 */
export function withoutChecksumLine(text: string): string {
  const parts = frontmatterParts(text);
  if (!parts) return text;
  const kept = wholeLines(parts.region).filter((line) => !CHECKSUM_LINE.test(line));
  return parts.before + kept.join('') + parts.after;
}

/**
 * The SKILL.md with its `checksum:` line set to `value` (added at the end of the frontmatter,
 * replacing the ones there). Returns null when the text has no frontmatter. Removing the line
 * again gives the same text `withoutChecksumLine` gives for the original.
 */
export function withChecksumLine(text: string, value: string): string | null {
  const parts = frontmatterParts(text);
  if (!parts) return null;
  const kept = wholeLines(parts.region).filter((line) => !CHECKSUM_LINE.test(line));
  const crlf = parts.before.endsWith('\r\n');
  return `${parts.before}${kept.join('')}checksum: ${value}${crlf ? '\r\n' : '\n'}${parts.after}`;
}

/**
 * The checksum a SKILL.md declares in its frontmatter, as `sha256:<hex>`; null when it has none
 * or the line is not in that form. When the line is there more than once, the last one is read,
 * as the gateway's frontmatter reader does.
 */
export function declaredChecksumIn(text: string): string | null {
  const parts = frontmatterParts(text);
  if (!parts) return null;
  let value: string | null = null;
  for (const line of wholeLines(parts.region)) {
    if (!CHECKSUM_LINE.test(line)) continue;
    const raw = line.slice(line.indexOf(':') + 1).trim();
    const unquoted = raw.length >= 2 && /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    value = parseChecksum(unquoted);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reading the declarations

/** Whether `host` is a plain host name or `*.host`: no scheme, port, path or other punctuation. */
export function hostProblem(host: string): string | null {
  if (host === '') return 'is empty';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    return 'is a URL; write only the host, like api.example.com';
  }
  if (host.includes('/')) return 'has a path; write only the host, like api.example.com';
  if (host.includes('@')) return 'has a user name; write only the host';
  if (host.includes(':')) return 'has a port; write only the host, like api.example.com';
  if (/\s/.test(host)) return 'has a space in it';
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  if (bare === '' || bare.includes('*'))
    return 'uses "*" somewhere it is not allowed; only "*." at the start';
  const labels = bare.split('.');
  const label = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/i;
  if (labels.some((l) => !label.test(l))) return 'is not a host name';
  return null;
}

/** Whether `path` is a path a skill may declare; otherwise the plain reason it is not. */
export function scopeProblem(path: string): string | null {
  if (path === '') return 'is empty';
  if (path.includes('\0')) return 'has a NUL character';
  if (path.includes('\\')) return 'has a backslash; use / between folders';
  if (path === '/' || path === '~/') return 'is the whole file system or the whole home folder';
  if (path.split('/').some((s) => s === '..')) return 'leaves the folder with ".."';
  if (path.startsWith('/')) {
    return 'is an absolute path; use a path relative to the folder, or one starting with ~/';
  }
  if (/^[a-zA-Z]:/.test(path)) return 'is an absolute path; use a path relative to the folder';
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/')) {
    return "names another user's home; only ~ or ~/… are understood";
  }
  return null;
}

/** Tidy a path as the author wrote it: no `./` in front, no doubled or trailing-less slashes. */
export function tidyScope(path: string): string {
  let p = path.trim().replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p === '' ? '.' : p;
}

/** What `check` says of a tool rule: null when it is fine, else the words after the name. */
export type ToolCheck = (rule: string) => string | null;

function listOf(
  raw: unknown,
  key: string,
  warnings: string[]
): { items: string[]; present: boolean } {
  if (raw === undefined || raw === null) return { items: [], present: false };
  if (typeof raw === 'string') {
    // A single entry written bare is read as a list of one, and the author is told.
    if (raw.trim() === '') return { items: [], present: false };
    warnings.push(
      `${key} should be a list, like ${key}: [${raw.trim()}]. It was read as one entry.`
    );
    return { items: [raw.trim()], present: true };
  }
  if (!Array.isArray(raw)) {
    warnings.push(`${key} should be a list; it was ignored.`);
    return { items: [], present: false };
  }
  const items: string[] = [];
  let odd = 0;
  for (const v of raw) {
    if (typeof v === 'string' && v.trim() !== '') items.push(v.trim());
    else odd += 1;
  }
  if (odd > 0)
    warnings.push(`${key} has ${odd} entr${odd === 1 ? 'y' : 'ies'} that are not text; ignored.`);
  return { items, present: true };
}

/**
 * Read the three declarations from a skill's parsed frontmatter, and say what is wrong with
 * them. Never throws. Entries that cannot be understood (a URL as a host, `..` in a path) are
 * dropped with a warning, which only ever narrows what the skill declares. A tool name that
 * is not known is **kept**, with a warning: it matches nothing, so narrowing to it offers no
 * tool, and a typo cannot widen what the model is offered.
 */
export function readSkillNeeds(
  frontmatter: Record<string, unknown>,
  checkTool: ToolCheck = () => null
): { needs: SkillNeeds; warnings: string[] } {
  const warnings: string[] = [];

  const tools = [...new Set(listOf(frontmatter.tools_required, 'tools_required', warnings).items)];
  for (const t of tools) {
    const why = checkTool(t);
    if (why) warnings.push(`tools_required: "${t}" ${why}`);
  }

  const domains: string[] = [];
  for (const raw of listOf(frontmatter.network_domains, 'network_domains', warnings).items) {
    const host = raw.toLowerCase();
    const why = hostProblem(host);
    if (why) warnings.push(`network_domains: "${raw}" ${why}.`);
    else if (!domains.includes(host)) domains.push(host);
  }

  const paths: string[] = [];
  for (const raw of listOf(frontmatter.filesystem_scope, 'filesystem_scope', warnings).items) {
    const why = scopeProblem(raw);
    if (why) {
      warnings.push(`filesystem_scope: "${raw}" ${why}.`);
      continue;
    }
    const p = tidyScope(raw);
    if (!paths.includes(p)) paths.push(p);
  }

  const declared = frontmatter.checksum;
  if (declared !== undefined && parseChecksum(declared) === null) {
    warnings.push(
      'checksum should look like sha256: followed by 64 hexadecimal digits; it was ignored.'
    );
  }

  return { needs: { tools, domains, paths }, warnings };
}

/** Whether a skill declares nothing at all. */
export function declaresNothing(needs: SkillNeeds): boolean {
  return needs.tools.length === 0 && needs.domains.length === 0 && needs.paths.length === 0;
}

/** Needs with every list sorted and free of repeats: two that mean the same are equal. */
export function canonicalNeeds(needs: SkillNeeds): SkillNeeds {
  const list = (xs: readonly string[]) => [...new Set(xs)].sort();
  return { tools: list(needs.tools), domains: list(needs.domains), paths: list(needs.paths) };
}

export type NeedKey = 'tools' | 'domains' | 'paths';

export interface NeedLine {
  key: NeedKey;
  label: string;
  summary: string;
  items: string[];
}

/** Every need a skill declares, in plain words; nothing for what it leaves out. */
export function describeSkillNeeds(needs: SkillNeeds): NeedLine[] {
  const lines: NeedLine[] = [];
  if (needs.tools.length > 0) {
    lines.push({
      key: 'tools',
      label: 'Use tools',
      summary: 'Its instructions use these tools.',
      items: needs.tools,
    });
  }
  if (needs.domains.length > 0) {
    lines.push({
      key: 'domains',
      label: 'Reach websites',
      summary: 'Its instructions expect to connect to these hosts.',
      items: needs.domains,
    });
  }
  if (needs.paths.length > 0) {
    lines.push({
      key: 'paths',
      label: 'Use files',
      summary: 'Its instructions expect to read or change files at these paths.',
      items: needs.paths,
    });
  }
  return lines;
}

export interface NeedChange {
  change: 'added' | 'removed';
  key: NeedKey;
  item: string;
  /** "Now says it uses fs.write", "No longer says it reaches api.example.com". */
  text: string;
}

const VERB: Record<NeedKey, { now: string; no: string }> = {
  tools: { now: 'Now says it uses the tool', no: 'No longer says it uses the tool' },
  domains: { now: 'Now says it reaches', no: 'No longer says it reaches' },
  paths: { now: 'Now says it uses the path', no: 'No longer says it uses the path' },
};

/** What a skill's declared needs gained and lost between two versions of its manifest. */
export function diffSkillNeeds(before: SkillNeeds, after: SkillNeeds): NeedChange[] {
  const a = canonicalNeeds(before);
  const b = canonicalNeeds(after);
  const out: NeedChange[] = [];
  for (const key of ['tools', 'domains', 'paths'] as const) {
    for (const item of b[key]) {
      if (!a[key].includes(item)) {
        out.push({ change: 'added', key, item, text: `${VERB[key].now} ${item}` });
      }
    }
    for (const item of a[key]) {
      if (!b[key].includes(item)) {
        out.push({ change: 'removed', key, item, text: `${VERB[key].no} ${item}` });
      }
    }
  }
  return out;
}

/** The nearest of `known` to `name`, when one is near enough to be a likely typo; else undefined. */
export function nearestName(name: string, known: readonly string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '.');
  const want = norm(name);
  let best: { name: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(want, norm(k));
    if (d <= Math.max(2, Math.floor(k.length / 4)) && (!best || d < best.d)) best = { name: k, d };
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
