/**
 * Automation specs: the YAML file that describes one automation.
 *
 * This release reads a subset of the format in docs/ROADMAP.md §4. Keys that
 * belong to the format but are not implemented yet are refused by name rather
 * than ignored, so a spec never silently promises more than the runner does.
 * Every error carries the line and column it refers to.
 */

import cron from 'node-cron';
import { LineCounter, parseDocument, isMap, isScalar, isCollection, type Document } from 'yaml';

export type PermissionMode = 'acceptEdits' | 'default' | 'dontAsk' | 'plan';

export interface AutomationSpec {
  name: string;
  description?: string;
  /** Cron expression in the host's time zone. Absent: the automation only runs on demand. */
  schedule?: string;
  repo: { kind: 'local'; path: string; ref?: string };
  agent: {
    driver: 'claude-code';
    model?: string;
    permissionMode: PermissionMode;
    allowedTools: string[];
    /** Vault secret holding an API key for the agent. Absent: the CLI's own sign-in. */
    apiKeySecret?: string;
  };
  prompt: string;
  sandbox: { profile: 'native'; timeoutMs: number };
  gates: Array<{ run: string; timeoutMs: number }>;
  publish: {
    branch: string;
    push: boolean;
    pullRequest: 'draft' | 'none';
    onNoChanges: 'skip';
    /** Vault secret holding the forge token for pushing and opening the PR. */
    tokenSecret: string;
  };
  budget: { maxUsdPerRun?: number; maxUsdPerMonth?: number };
  approvals: { push: 'manual' | 'auto'; timeoutMs: number };
}

export class SpecError extends Error {
  readonly code = 'invalid_spec';
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number
  ) {
    super(line ? `Line ${line}, column ${column}: ${message}` : message);
    this.name = 'SpecError';
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_BRANCH = 'auto/{{automation}}/{{date}}-{{run}}';
const PERMISSION_MODES: PermissionMode[] = ['acceptEdits', 'default', 'dontAsk', 'plan'];

/** Keys of the documented format that this release does not run yet. */
const NOT_YET: Record<string, string> = {
  'on.events': 'event triggers',
  'on.catch_up': 'missed-schedule catch-up',
  'targets.max_parallel': 'fleet runs',
  'agent.model.fallback': 'model fallback',
  'agent.model.strategy': 'routing strategies',
  'sandbox.network': 'network restriction',
  'sandbox.filesystem': 'filesystem restriction',
  'publish.notify': 'notifications',
  'approvals.secrets_access': 'secret-access approvals',
};

/** Parse "20m", "90s", "2h", "500ms", or a number of seconds. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 1000;
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
  return n > 0 ? Math.round(n * unit) : null;
}

class Reader {
  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter
  ) {}

  /** Fail at a node's position. */
  failAt(node: unknown, message: string): never {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    if (!range) throw new SpecError(message);
    const pos = this.lines.linePos(range[0]);
    throw new SpecError(message, pos.line, pos.col);
  }

  /** Fail at the node `path` points to, or the nearest ancestor that exists. */
  fail(path: Array<string | number>, message: string): never {
    for (let n = path.length; n >= 0; n--) {
      const node = this.doc.getIn(path.slice(0, n), true) as { range?: [number, number, number] };
      if (node && node.range) {
        const pos = this.lines.linePos(node.range[0]);
        throw new SpecError(message, pos.line, pos.col);
      }
    }
    throw new SpecError(message);
  }

  /** The plain value at `path`: lists and mappings as arrays and objects. */
  get(path: Array<string | number>): unknown {
    const v = this.doc.getIn(path);
    return isCollection(v) ? v.toJSON() : v;
  }

  /** The keys of the map at `path`, refusing any not in `known`. */
  keys(path: string[], known: string[]): void {
    const node = path.length ? this.doc.getIn(path, true) : this.doc.contents;
    if (node === undefined || node === null) return;
    if (!isMap(node)) this.fail(path, `${path.join('.') || 'The spec'} must be a mapping.`);
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const full = [...path, key].join('.');
      if (NOT_YET[full]) {
        this.failAt(pair.key, `"${full}" (${NOT_YET[full]}) is not supported in this release.`);
      }
      if (!known.includes(key)) {
        this.failAt(pair.key, `Unknown key "${full}".`);
      }
    }
  }

  text(path: string[], required: true): string;
  text(path: string[], required?: false): string | undefined;
  text(path: string[], required = false): string | undefined {
    const v = this.get(path);
    if (v === undefined || v === null) {
      if (required) this.fail(path, `"${path.join('.')}" is required.`);
      return undefined;
    }
    if (typeof v !== 'string' || !v.trim()) {
      this.fail(path, `"${path.join('.')}" must be a non-empty string.`);
    }
    return v;
  }

  oneOf<T extends string>(path: string[], allowed: readonly T[], fallback: T): T {
    const v = this.get(path);
    if (v === undefined || v === null) return fallback;
    if (!allowed.includes(v as T)) {
      this.fail(path, `"${path.join('.')}" must be one of: ${allowed.join(', ')}.`);
    }
    return v as T;
  }

  bool(path: string[], fallback: boolean): boolean {
    const v = this.get(path);
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') this.fail(path, `"${path.join('.')}" must be true or false.`);
    return v;
  }

  money(path: string[]): number | undefined {
    const v = this.get(path);
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      this.fail(path, `"${path.join('.')}" must be a positive amount in US dollars.`);
    }
    return v;
  }

  duration(path: Array<string | number>, fallbackMs: number): number {
    const v = this.get(path);
    if (v === undefined || v === null) return fallbackMs;
    const ms = parseDuration(v);
    if (ms === null) {
      this.fail(path, `"${path.join('.')}" must be a duration such as 90s, 20m or 2h.`);
    }
    return ms;
  }

  secretName(path: string[], fallback?: string): string | undefined {
    const v = this.text(path) ?? fallback;
    if (v !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
      this.fail(path, `"${path.join('.')}" must be a secret name such as GITHUB_TOKEN.`);
    }
    return v;
  }
}

/** Parse and validate a spec. Throws SpecError with the line it refers to. */
export function parseSpec(source: string): AutomationSpec {
  if (typeof source !== 'string' || !source.trim()) {
    throw new SpecError('The spec is empty.');
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    const err = doc.errors[0];
    const pos = err.linePos?.[0];
    // The first line of a YAML error is the reason; the rest is a code frame.
    throw new SpecError(
      err.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''),
      pos?.line,
      pos?.col
    );
  }
  if (!isMap(doc.contents)) throw new SpecError('The spec must be a YAML mapping.');
  // Annotated so a call to r.fail() narrows types: TypeScript requires it for `never`.
  const r: Reader = new Reader(doc, lineCounter);

  r.keys(
    [],
    [
      'name',
      'description',
      'on',
      'targets',
      'agent',
      'prompt',
      'sandbox',
      'gates',
      'publish',
      'budget',
      'approvals',
    ]
  );

  const name = r.text(['name'], true);
  if (!NAME.test(name)) {
    r.fail(['name'], '"name" must be lowercase letters, digits and dashes, at most 63 characters.');
  }

  r.keys(['on'], ['schedule']);
  const schedule = r.text(['on', 'schedule']);
  if (schedule !== undefined && !cron.validate(schedule)) {
    r.fail(['on', 'schedule'], `"${schedule}" is not a valid cron expression.`);
  }

  r.keys(['targets'], ['repos']);
  const repos = r.get(['targets', 'repos']);
  if (!Array.isArray(repos) || repos.length === 0) {
    r.fail(
      ['targets', 'repos'],
      '"targets.repos" must list one repository, e.g. [local:~/code/app].'
    );
  }
  if (repos.length > 1) {
    r.fail(['targets', 'repos', 1], 'This release runs one repository per automation.');
  }
  const target = repos[0];
  if (typeof target !== 'string' || !target.startsWith('local:') || !target.slice(6).trim()) {
    r.fail(
      ['targets', 'repos', 0],
      'Repositories are given as local:<path> in this release; remote repositories come later.'
    );
  }
  const [repoPath, ref] = target.slice(6).trim().split('#');

  r.keys(['agent'], ['driver', 'model', 'permission_mode', 'allowed_tools', 'api_key_secret']);
  r.oneOf(['agent', 'driver'], ['claude-code'] as const, 'claude-code');
  if (r.get(['agent', 'driver']) === undefined) r.fail(['agent'], '"agent.driver" is required.');
  let model: string | undefined;
  const rawModel = r.get(['agent', 'model']);
  if (rawModel !== undefined && rawModel !== null && typeof rawModel === 'object') {
    r.keys(['agent', 'model'], ['primary']);
    model = r.text(['agent', 'model', 'primary'], true);
  } else {
    model = r.text(['agent', 'model']);
  }
  const allowedTools = r.get(['agent', 'allowed_tools']) ?? [];
  if (
    !Array.isArray(allowedTools) ||
    allowedTools.some((t) => typeof t !== 'string' || !t.trim())
  ) {
    r.fail(['agent', 'allowed_tools'], '"agent.allowed_tools" must be a list of tool names.');
  }

  const prompt = r.text(['prompt'], true);

  r.keys(['sandbox'], ['profile', 'timeout']);
  // Binding rule 4 in SECURITY.md: running without isolation must be chosen,
  // never fallen into. This release has no other profile to offer, so the
  // spec has to say so.
  const profile = r.get(['sandbox', 'profile']);
  if (profile === undefined || profile === null) {
    r.fail(
      ['sandbox'],
      'Automations run without isolation in this release: the agent and the gates have your ' +
        "account's access to files and the network. Add `sandbox: { profile: native }` to accept that."
    );
  }
  if (profile !== 'native') {
    r.fail(
      ['sandbox', 'profile'],
      'This release runs automations with the "native" profile only; seatbelt and container come later.'
    );
  }

  const gatesRaw = r.get(['gates']) ?? [];
  if (!Array.isArray(gatesRaw)) r.fail(['gates'], '"gates" must be a list.');
  const gates = gatesRaw.map((_, i) => {
    const node = r.get(['gates', i]);
    if (node && typeof node === 'object' && 'assert' in node) {
      r.fail(
        ['gates', i, 'assert'],
        'diff assertions ("assert:") are not supported in this release.'
      );
    }
    r.keys(['gates', String(i)], ['run', 'timeout']);
    return {
      run: r.text(['gates', String(i), 'run'], true),
      timeoutMs: r.duration(['gates', i, 'timeout'], 10 * 60_000),
    };
  });

  r.keys(['publish'], ['branch', 'push', 'pull_request', 'on_no_changes', 'token_secret']);
  const push = r.bool(['publish', 'push'], true);
  const pullRequest = r.oneOf(
    ['publish', 'pull_request'],
    ['draft', 'none'] as const,
    push ? 'draft' : 'none'
  );
  if (!push && pullRequest === 'draft') {
    r.fail(['publish', 'pull_request'], 'A pull request needs "publish.push: true".');
  }

  r.keys(['budget'], ['max_usd_per_run', 'max_usd_per_month', 'on_exceed']);
  r.oneOf(['budget', 'on_exceed'], ['pause_automation'] as const, 'pause_automation');

  r.keys(['approvals'], ['push', 'merge', 'timeout']);
  // Nothing here merges, so a merge approval can only ever be manual.
  r.oneOf(['approvals', 'merge'], ['manual'] as const, 'manual');

  return {
    name,
    description: r.text(['description']),
    schedule,
    repo: { kind: 'local', path: repoPath, ...(ref ? { ref } : {}) },
    agent: {
      driver: 'claude-code',
      ...(model ? { model } : {}),
      permissionMode: r.oneOf(['agent', 'permission_mode'], PERMISSION_MODES, 'acceptEdits'),
      allowedTools: (allowedTools as string[]).map((t) => t.trim()),
      ...(r.secretName(['agent', 'api_key_secret'])
        ? { apiKeySecret: r.secretName(['agent', 'api_key_secret']) }
        : {}),
    },
    prompt,
    sandbox: { profile: 'native', timeoutMs: r.duration(['sandbox', 'timeout'], 20 * 60_000) },
    gates,
    publish: {
      branch: r.text(['publish', 'branch']) ?? DEFAULT_BRANCH,
      push,
      pullRequest,
      onNoChanges: r.oneOf(['publish', 'on_no_changes'], ['skip'] as const, 'skip'),
      tokenSecret: r.secretName(['publish', 'token_secret'], 'GITHUB_TOKEN') as string,
    },
    budget: {
      maxUsdPerRun: r.money(['budget', 'max_usd_per_run']),
      maxUsdPerMonth: r.money(['budget', 'max_usd_per_month']),
    },
    approvals: {
      push: r.oneOf(['approvals', 'push'], ['manual', 'auto'] as const, 'manual'),
      timeoutMs: r.duration(['approvals', 'timeout'], 24 * 3_600_000),
    },
  };
}
