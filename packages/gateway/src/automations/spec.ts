/**
 * Automation specs: the YAML file that describes one automation.
 *
 * This release reads a subset of the format in docs/ROADMAP.md §4. Keys that
 * belong to the format but are not implemented yet are refused by name rather
 * than ignored, so a spec never silently promises more than the runner does.
 * Every error carries the line and column it refers to.
 */

import cron from 'node-cron';
import { DRIVER_CAPABILITIES, DRIVER_IDS, allowedToolProblem, type DriverId } from '@clerq/drivers';
import { MEMORY_TYPES, isMemoryType, type MemoryType } from '@clerq/policy';
import { LineCounter, parseDocument, isMap, isScalar, isCollection, type Document } from 'yaml';
import { AssertionSyntaxError, parseAssertion, type DiffAssertion } from './diff-assert.js';

export type PermissionMode = 'acceptEdits' | 'default' | 'dontAsk' | 'plan';

/** A gate: a command that must exit 0, or an assertion about the run's diff. */
export type GateSpec =
  | { run: string; timeoutMs: number }
  | { assert: string; check: DiffAssertion };

export function isAssertion(gate: GateSpec): gate is { assert: string; check: DiffAssertion } {
  return 'assert' in gate;
}

export interface AutomationSpec {
  name: string;
  description?: string;
  /** Cron expression in the host's time zone. Absent: the automation only runs on demand. */
  schedule?: string;
  /**
   * A slot missed while the machine slept or the gateway was down runs once
   * when it is noticed. Off: missed slots are skipped, and that is recorded.
   */
  catchUp: boolean;
  repo: { kind: 'local'; path: string; ref?: string };
  agent: {
    driver: DriverId;
    model?: string;
    permissionMode: PermissionMode;
    allowedTools: string[];
    /** Vault secret holding an API key for the agent. Absent: the CLI's own sign-in. */
    apiKeySecret?: string;
    /**
     * Models to run the agent again with, one at a time and in order, when the
     * gates fail: `agent.model.escalate`.
     */
    escalate: string[];
    /**
     * Models to use instead, in order, when the one in use is unavailable (the
     * provider is down, overloaded or rate limiting, or has no key):
     * `agent.model.fallback`. Not for a run that was given a model by hand.
     */
    fallback: string[];
  };
  prompt: string;
  sandbox: { profile: 'native'; timeoutMs: number };
  gates: GateSpec[];
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
  /** Further attempts after a transient failure, and the wait before the first of them. */
  retry: { maxRetries: number; backoffMs: number };
  /**
   * What the run may read of memory: the types whose records bear on the
   * prompt are added to it. Empty (the default): none, so an unattended run
   * does not send saved notes to a model unless the spec says so.
   */
  memory: { read: MemoryType[] };
}

/** The most `retry.max_retries` may be. */
export const MAX_RETRIES = 10;
/** The most `agent.model.escalate` may list. */
export const MAX_ESCALATIONS = 5;
/** The most `agent.model.fallback` may list. */
export const MAX_FALLBACKS = 5;

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
  // Targets are one repository per automation in this release, and an
  // automation runs once at a time, so there is nothing to run in parallel.
  'targets.max_parallel': 'fleet runs across several repositories',
  'agent.model.strategy':
    'routing strategies such as cost_aware, quality_first, race and consensus',
  'sandbox.network': 'network restriction',
  'sandbox.filesystem': 'filesystem restriction',
  'publish.notify': 'notifications',
  'approvals.secrets_access': 'secret-access approvals',
};

/** What to say after a refusal in NOT_YET, where there is something to do instead. */
const NOT_YET_HINT: Record<string, string> = {
  'agent.model.strategy':
    'They are planned after 1.0. To use another model when one is unavailable, list it in ' +
    '"agent.model.fallback"; to run a stronger one when a gate fails, list it in "agent.model.escalate".',
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

  /**
   * Fail at a node's position, or `offset` characters into a single-line
   * scalar's value (past its opening quote, if it has one).
   */
  failAt(node: unknown, message: string, offset = 0): never {
    const n = node as { range?: [number, number, number]; type?: string } | null;
    const range = n?.range;
    if (!range) throw new SpecError(message);
    let at = range[0];
    // Only where the text maps one to one onto the source: one line, no escapes.
    const oneLine = this.lines.linePos(range[0]).line === this.lines.linePos(range[1]).line;
    if (offset > 0 && isScalar(node) && oneLine) {
      if (n?.type === 'PLAIN') at += offset;
      else if (n?.type === 'QUOTE_SINGLE') at += offset + 1;
    }
    const pos = this.lines.linePos(at);
    throw new SpecError(message, pos.line, pos.col);
  }

  /** The node at `path`, as YAML has it. */
  node(path: Array<string | number>): unknown {
    return this.doc.getIn(path, true);
  }

  /** A whole number at `path`, from `min` to `max`. */
  count(path: string[], fallback: number, min: number, max: number): number {
    const v = this.get(path);
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.fail(path, `"${path.join('.')}" must be a whole number from ${min} to ${max}.`);
    }
    return v;
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
        this.failAt(
          pair.key,
          `"${full}" (${NOT_YET[full]}) is not supported in this release.` +
            (NOT_YET_HINT[full] ? ` ${NOT_YET_HINT[full]}` : '')
        );
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
      'retry',
      'memory',
    ]
  );

  const name = r.text(['name'], true);
  if (!NAME.test(name)) {
    r.fail(['name'], '"name" must be lowercase letters, digits and dashes, at most 63 characters.');
  }

  r.keys(['on'], ['schedule', 'catch_up']);
  const schedule = r.text(['on', 'schedule']);
  if (schedule !== undefined && !cron.validate(schedule)) {
    r.fail(['on', 'schedule'], `"${schedule}" is not a valid cron expression.`);
  }
  const catchUp = r.bool(['on', 'catch_up'], false);
  if (catchUp && schedule === undefined) {
    r.fail(['on', 'catch_up'], '"on.catch_up" needs "on.schedule": there are no slots to miss.');
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
  const driver = r.oneOf(['agent', 'driver'], DRIVER_IDS, 'claude-code');
  if (r.get(['agent', 'driver']) === undefined) r.fail(['agent'], '"agent.driver" is required.');
  const caps = DRIVER_CAPABILITIES[driver];
  let model: string | undefined;
  let escalate: string[] = [];
  let fallback: string[] = [];
  const rawModel = r.get(['agent', 'model']);
  if (rawModel !== undefined && rawModel !== null && typeof rawModel === 'object') {
    r.keys(['agent', 'model'], ['primary', 'escalate', 'fallback']);
    model =
      driver === 'builtin'
        ? r.text(['agent', 'model', 'primary'], true)
        : r.text(['agent', 'model', 'primary']);
    const list = r.get(['agent', 'model', 'escalate']);
    if (list !== undefined && list !== null) {
      if (!Array.isArray(list) || list.length === 0) {
        r.fail(
          ['agent', 'model', 'escalate'],
          '"agent.model.escalate" must list one or more models, e.g. [anthropic/claude-opus-4-1].'
        );
      }
      if (list.length > MAX_ESCALATIONS) {
        r.fail(
          ['agent', 'model', 'escalate', MAX_ESCALATIONS],
          `"agent.model.escalate" may list at most ${MAX_ESCALATIONS} models.`
        );
      }
      escalate = list.map((m, i) => {
        if (typeof m !== 'string' || !m.trim()) {
          r.fail(['agent', 'model', 'escalate', i], 'Each escalation model must be a model name.');
        }
        return m.trim();
      });
      // The model is passed to the CLI as it is, so it must take one.
      if (!caps.models) {
        r.fail(
          ['agent', 'model', 'escalate'],
          `"agent.model.escalate" is not supported by the ${driver} driver: ${caps.label}'s CLI cannot be told which model to use.`
        );
      }
      escalate.forEach((m, i) => {
        if (m === model || escalate.indexOf(m) !== i) {
          r.fail(
            ['agent', 'model', 'escalate', i],
            `"${m}" is already ${m === model ? 'the primary model' : 'listed'}; escalation needs a different model at each step.`
          );
        }
      });
    }
    const alternatives = r.get(['agent', 'model', 'fallback']);
    if (alternatives !== undefined && alternatives !== null) {
      if (!Array.isArray(alternatives) || alternatives.length === 0) {
        r.fail(
          ['agent', 'model', 'fallback'],
          '"agent.model.fallback" must list one or more models, e.g. [openai/gpt-5-mini].'
        );
      }
      if (alternatives.length > MAX_FALLBACKS) {
        r.fail(
          ['agent', 'model', 'fallback', MAX_FALLBACKS],
          `"agent.model.fallback" may list at most ${MAX_FALLBACKS} models.`
        );
      }
      fallback = alternatives.map((m, i) => {
        if (typeof m !== 'string' || !m.trim()) {
          r.fail(['agent', 'model', 'fallback', i], 'Each fallback model must be a model name.');
        }
        return m.trim();
      });
      // The model is passed to the CLI as it is, so it must take one.
      if (!caps.models) {
        r.fail(
          ['agent', 'model', 'fallback'],
          `"agent.model.fallback" is not supported by the ${driver} driver: ${caps.label}'s CLI cannot be told which model to use.`
        );
      }
      fallback.forEach((m, i) => {
        if (m === model || fallback.indexOf(m) !== i) {
          r.fail(
            ['agent', 'model', 'fallback', i],
            `"${m}" is already ${m === model ? 'the primary model' : 'listed'}; fallback needs a different model at each step.`
          );
        }
      });
    }
  } else {
    model = r.text(['agent', 'model']);
  }
  // The builtin agent calls a model API itself, so it has to know whose.
  if (driver === 'builtin') {
    const modelPath =
      typeof rawModel === 'object' && rawModel ? ['agent', 'model', 'primary'] : ['agent', 'model'];
    if (!model) {
      r.fail(
        ['agent'],
        'The builtin driver needs "agent.model" as provider/model, e.g. anthropic/claude-sonnet-4-5.'
      );
    }
    const qualified = (ref: string, path: Array<string | number>) => {
      const slash = ref.indexOf('/');
      if (slash <= 0 || slash === ref.length - 1) {
        r.fail(
          path,
          `"${ref}" must name the provider too, as provider/model (e.g. anthropic/${ref}).`
        );
      }
    };
    qualified(model, modelPath);
    escalate.forEach((m, i) => qualified(m, ['agent', 'model', 'escalate', i]));
    fallback.forEach((m, i) => qualified(m, ['agent', 'model', 'fallback', i]));
  }
  const allowedTools = r.get(['agent', 'allowed_tools']) ?? [];
  if (
    !Array.isArray(allowedTools) ||
    allowedTools.some((t) => typeof t !== 'string' || !t.trim())
  ) {
    r.fail(['agent', 'allowed_tools'], '"agent.allowed_tools" must be a list of tool names.');
  }
  if (allowedTools.length > 0 && !caps.allowedTools) {
    r.fail(
      ['agent', 'allowed_tools'],
      `"agent.allowed_tools" is not supported by the ${driver} driver: ${caps.label}'s CLI takes no tool list. ` +
        'Limit the agent with "agent.permission_mode" instead.'
    );
  }
  if (driver === 'builtin') {
    allowedTools.forEach((rule, i) => {
      const problem = allowedToolProblem(String(rule).trim());
      if (problem) r.fail(['agent', 'allowed_tools', i], problem);
    });
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
  const gates = gatesRaw.map((_, i): GateSpec => {
    const node = r.get(['gates', i]);
    if (node && typeof node === 'object' && 'assert' in node) {
      r.keys(['gates', String(i)], ['assert']);
      const text = r.text(['gates', String(i), 'assert'], true);
      try {
        return { assert: text.trim(), check: parseAssertion(text) };
      } catch (e) {
        if (!(e instanceof AssertionSyntaxError)) throw e;
        r.failAt(r.node(['gates', i, 'assert']), e.message, e.offset);
      }
    }
    if (node && typeof node === 'object' && !('run' in node)) {
      r.fail(['gates', i], 'A gate is "run: <command>" or "assert: diff.<name> …".');
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
  // A budget the agent's CLI cannot keep is refused, not quietly ignored.
  if (r.get(['budget', 'max_usd_per_run']) != null && !caps.budgetLimit) {
    r.fail(
      ['budget', 'max_usd_per_run'],
      `"budget.max_usd_per_run" is not supported by the ${driver} driver: ${caps.label}'s CLI has no spend limit. ` +
        'Bound a run with "sandbox.timeout" instead.'
    );
  }
  if (r.get(['budget', 'max_usd_per_month']) != null && !caps.reportsCost) {
    r.fail(
      ['budget', 'max_usd_per_month'],
      `"budget.max_usd_per_month" is not supported by the ${driver} driver: ${caps.label}'s CLI does not report what a run costs, ` +
        'so there is nothing to add up.'
    );
  }

  r.keys(['approvals'], ['push', 'merge', 'timeout']);
  // Nothing here merges, so a merge approval can only ever be manual.
  r.oneOf(['approvals', 'merge'], ['manual'] as const, 'manual');

  r.keys(['retry'], ['max_retries', 'backoff']);
  const maxRetries = r.count(['retry', 'max_retries'], 0, 0, MAX_RETRIES);
  const backoffMs = r.duration(['retry', 'backoff'], 60_000);
  if (backoffMs > 3_600_000) {
    r.fail(['retry', 'backoff'], '"retry.backoff" may be at most 1h; it doubles with each retry.');
  }

  r.keys(['memory'], ['read']);
  const memoryRead = r.get(['memory', 'read']);
  let readTypes: MemoryType[] = [];
  if (memoryRead !== undefined && memoryRead !== null) {
    if (!Array.isArray(memoryRead) || memoryRead.length === 0) {
      r.fail(
        ['memory', 'read'],
        `"memory.read" must list one or more of ${MEMORY_TYPES.join(', ')}, e.g. [preference, procedure].`
      );
    }
    readTypes = memoryRead.map((t, i) => {
      if (!isMemoryType(t)) {
        r.fail(
          ['memory', 'read', i],
          `"${String(t)}" is not a kind of memory. Use ${MEMORY_TYPES.join(', ')}.`
        );
      }
      if (memoryRead.indexOf(t) !== i) r.fail(['memory', 'read', i], `"${t}" is listed twice.`);
      return t;
    });
  }

  return {
    name,
    description: r.text(['description']),
    schedule,
    catchUp,
    repo: { kind: 'local', path: repoPath, ...(ref ? { ref } : {}) },
    agent: {
      driver,
      ...(model ? { model } : {}),
      permissionMode: r.oneOf(['agent', 'permission_mode'], PERMISSION_MODES, 'acceptEdits'),
      allowedTools: (allowedTools as string[]).map((t) => t.trim()),
      ...(r.secretName(['agent', 'api_key_secret'])
        ? { apiKeySecret: r.secretName(['agent', 'api_key_secret']) }
        : {}),
      escalate,
      fallback,
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
    retry: { maxRetries, backoffMs },
    memory: { read: readTypes },
  };
}
