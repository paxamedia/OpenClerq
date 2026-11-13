/**
 * The cursor-agent driver: Cursor's headless CLI, `cursor-agent -p` with
 * `--output-format stream-json`.
 *
 * The agent runs under the user's own Cursor sign-in (`cursor-agent login`).
 * Nothing here passes CURSOR_API_KEY unless the caller supplies one as a
 * secret.
 *
 * What the CLI offers, and what that means for a run:
 *   - Print mode writes files inside the workspace and rejects shell commands
 *     that are not on the user's own allowlist. `--force` would run
 *     everything, so this driver never passes it. `--trust` is passed because
 *     a headless run cannot answer the workspace-trust prompt, and the
 *     workspace is the worktree the caller just prepared.
 *   - There is no spend limit and the documented output carries no cost, so a
 *     run's cost is unknown (null) unless a newer CLI reports one.
 *   - Tool permissions come from the user's own cli.json, not from flags, so
 *     `allowedTools` cannot be passed.
 *
 * The stream-json shapes follow Cursor's output-format reference (system/init,
 * user, assistant, tool_call started | completed, result). Tool results are
 * only partly documented, so the parser reads them tolerantly, and it ignores
 * fields and events it does not know.
 */

import type { ExecResult } from '@clerq/sandbox';
import {
  apiErrorIn,
  containerAvailability,
  inContainer,
  capped,
  cliEnv,
  failed,
  flagsOf,
  missingFlags,
  num,
  probe,
  runCli,
} from './cli.js';
import { locate } from './locate.js';
import type {
  DetectOptions,
  Driver,
  DriverAvailability,
  DriverEvent,
  DriverResult,
  DriverRunInput,
} from './types.js';

const ID = 'cursor-agent';

export interface CursorAgentOptions {
  /** Path to the CLI. Defaults to CLERQ_CURSOR_BIN, then `cursor-agent` found on PATH. */
  bin?: string;
}

export const CURSOR_NOT_SIGNED_IN =
  'Cursor is not signed in on this machine. Run `cursor-agent login` in a terminal, or store an API key in the vault and name it in agent.api_key_secret.';

/**
 * The command line for one run. The prompt comes after `--`, so a prompt that
 * starts with a dash is not read as an option.
 *
 * Permission modes follow Claude Code's meaning, where anything not granted is
 * denied: only `acceptEdits` runs Cursor's agent mode, which edits the
 * workspace. `plan` is its planning mode. `default` and `dontAsk` both cannot
 * ask a person anything in an unattended run, so they get its read-only ask
 * mode.
 */
export function buildCursorArgs(input: DriverRunInput): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--trust'];
  const mode = input.permissionMode ?? 'acceptEdits';
  if (mode === 'plan') args.push('--mode', 'plan');
  else if (mode !== 'acceptEdits') args.push('--mode', 'ask');
  if (input.model) args.push('--model', input.model);
  args.push('--', input.prompt);
  return args;
}

/** What the caller asked for that this CLI cannot do, said once per run. */
function unsupported(input: DriverRunInput): string[] {
  const notes: string[] = [];
  if (input.maxBudgetUsd !== undefined) {
    notes.push(
      'cursor-agent has no spend limit, so the budget was not passed; the time limit applies.'
    );
  }
  if (input.allowedTools?.length) {
    notes.push(
      'cursor-agent takes no tool list, so allowed tools were not passed; its own cli.json applies.'
    );
  }
  return notes;
}

const NOT_SIGNED_IN =
  /not (?:logged|signed) in|please (?:log|sign) in|run `?(?:cursor-)?agent login|authentication (?:required|failed)|not authenticated|invalid api key/i;

/** The names the run view already knows from other drivers. */
const TOOL_NAMES: Record<string, string> = {
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  delete: 'Delete',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'LS',
  todo: 'TodoWrite',
};

function toolName(key: string, args: Record<string, unknown> | undefined): string {
  if (key === 'function') return String(args?.name ?? 'function');
  const base = key.replace(/ToolCall$/, '');
  return TOOL_NAMES[base] ?? base.charAt(0).toUpperCase() + base.slice(1);
}

function parseArgs(args: Record<string, unknown> | undefined, key: string): unknown {
  if (key !== 'function') return args;
  const raw = args?.arguments;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Text for a tool result, and whether it was a failure or a refusal. */
function describeResult(result: unknown): { text: string; isError: boolean; refused: boolean } {
  if (result === undefined || result === null) return { text: '', isError: false, refused: false };
  if (typeof result !== 'object') return { text: String(result), isError: false, refused: false };
  const r = result as Record<string, unknown>;

  if ('rejected' in r) {
    return { text: render(r.rejected), isError: true, refused: true };
  }
  for (const key of ['error', 'failure']) {
    if (key in r) return { text: render(r[key]), isError: true, refused: false };
  }
  const body = 'success' in r ? r.success : r;
  const exit =
    body && typeof body === 'object' ? (body as { exitCode?: unknown }).exitCode : undefined;
  return {
    text: render(body),
    isError: typeof exit === 'number' && exit !== 0,
    refused: false,
  };
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return value === undefined ? '' : String(value);
  const v = value as Record<string, unknown>;
  if (typeof v.content === 'string') return v.content;
  if (typeof v.stdout === 'string' || typeof v.stderr === 'string') {
    return [v.stdout, v.stderr].filter((t): t is string => typeof t === 'string' && !!t).join('\n');
  }
  if (typeof v.path === 'string' && typeof v.linesCreated === 'number') {
    return `Wrote ${v.linesCreated} lines to ${v.path}`;
  }
  if (typeof v.message === 'string') return v.message;
  if (typeof v.reason === 'string') return v.reason;
  return JSON.stringify(value);
}

interface ResultLine {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
}

/** The first of these keys that holds a number, for CLIs that name usage either way. */
function pick(usage: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) if (typeof usage[key] === 'number') return num(usage[key]);
  return 0;
}

/** Turns stream-json lines into driver events, and remembers how the run ended. */
export class CursorStream {
  private result: ResultLine | null = null;
  private called = new Set<string>();
  private lastText = '';
  private denials: Array<{ tool: string; input?: unknown }> = [];
  private stderrTail: string[] = [];

  constructor(private readonly notes: string[] = []) {}

  consume(line: string, stream: 'stdout' | 'stderr'): DriverEvent[] {
    if (!line.trim()) return [];
    if (stream === 'stderr') {
      this.stderrTail = [...this.stderrTail, line].slice(-20);
      return [{ type: 'log', stream, line }];
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [{ type: 'log', stream, line }];
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg))
      return [{ type: 'log', stream, line }];

    switch (msg.type) {
      case 'system':
        if (msg.subtype !== 'init') return [];
        return [{ type: 'started', model: typeof msg.model === 'string' ? msg.model : undefined }];

      case 'assistant': {
        const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
        const events: DriverEvent[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            this.lastText = block.text;
            events.push({ type: 'text', text: block.text });
          }
        }
        return events;
      }

      case 'tool_call':
        return this.tool(msg);

      case 'result':
        this.result = msg as ResultLine;
        return [];

      default:
        // `user` echoes the prompt; unknown events are for newer CLIs.
        return [];
    }
  }

  private tool(msg: Record<string, unknown>): DriverEvent[] {
    const id = String(msg.call_id ?? '');
    const wrapper = msg.tool_call as Record<string, Record<string, unknown>> | undefined;
    const key = wrapper ? Object.keys(wrapper)[0] : undefined;
    if (!key) return [];
    const body = wrapper?.[key] ?? {};
    const args = body.args as Record<string, unknown> | undefined;
    const name = toolName(key, args);

    const events: DriverEvent[] = [];
    if (!this.called.has(id)) {
      this.called.add(id);
      events.push({ type: 'tool_call', id, name, input: parseArgs(args, key) });
    }
    if (msg.subtype === 'completed') {
      const outcome = describeResult(body.result);
      if (outcome.refused) this.denials.push({ tool: name, input: parseArgs(args, key) });
      events.push({
        type: 'tool_result',
        id,
        output: capped(outcome.text),
        isError: outcome.isError,
      });
    }
    return events;
  }

  /** The outcome, from the result line if the CLI got as far as writing one. */
  finish(run: ExecResult): DriverResult {
    const r = this.result;
    const usage = r?.usage ?? {};
    const base = {
      costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
      tokensIn:
        pick(usage, 'input_tokens', 'inputTokens') +
        pick(usage, 'cache_creation_input_tokens', 'cacheWriteTokens') +
        pick(usage, 'cache_read_input_tokens', 'cacheReadTokens'),
      tokensOut: pick(usage, 'output_tokens', 'outputTokens'),
      durationMs: run.durationMs,
      exitCode: run.code,
      timedOut: run.timedOut,
      cancelled: run.cancelled,
      permissionDenials: this.denials,
      warnings: [...run.warnings, ...this.notes],
    };

    if (run.cancelled) return { ...base, ok: false, summary: 'Cancelled.' };
    if (run.timedOut) {
      return {
        ...base,
        ok: false,
        summary: `Timed out after ${Math.round(run.durationMs / 1000)}s.`,
      };
    }

    const text = (r?.result ?? '').trim();
    // Only a run that failed can have failed for want of a sign-in. A run that
    // succeeded may well talk about authentication ("Fixed the 401 handler")
    // or print warnings to stderr.
    const failed = !r || r.is_error === true || run.code !== 0;
    if (
      failed &&
      (NOT_SIGNED_IN.test(text) || this.stderrTail.some((l) => NOT_SIGNED_IN.test(l)))
    ) {
      return { ...base, ok: false, summary: CURSOR_NOT_SIGNED_IN };
    }

    if (!r) {
      const tail = this.stderrTail.slice(-5).join('\n');
      return {
        ...base,
        ok: false,
        crashed: true,
        ...(apiErrorIn(this.stderrTail) ? { apiError: apiErrorIn(this.stderrTail) } : {}),
        summary: `cursor-agent exited with code ${run.code ?? 'none'} before reporting a result.${
          tail ? `\n${tail}` : ''
        }`,
      };
    }

    if (r.is_error || run.code !== 0) {
      const why = 'The agent reported an error.';
      const apiError = apiErrorIn(this.stderrTail);
      return {
        ...base,
        ok: false,
        summary: text ? `${why} ${text}` : why,
        ...(apiError ? { apiError } : {}),
      };
    }

    return { ...base, ok: true, summary: text || this.lastText.trim() || 'Finished.' };
  }
}

export function cursorAgent(options: CursorAgentOptions = {}): Driver {
  const configured = options.bin ?? process.env.CLERQ_CURSOR_BIN;
  const find = () => configured || locate('cursor-agent');
  /** Where the CLI keeps its sign-in, when the user moved it. */
  const home = (): Record<string, string> =>
    process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {};

  async function detect(options: DetectOptions = {}): Promise<DriverAvailability> {
    if (options.inContainer) return containerAvailability(ID, 'cursor-agent');
    const bin = find();
    if (!bin) {
      return {
        id: ID,
        available: false,
        reason:
          'Cursor\'s CLI was not found. Install it (`curl https://cursor.com/install -fsS | bash`) and sign in with `cursor-agent login`, or set CLERQ_CURSOR_BIN to its path (newer installs also name it "agent").',
      };
    }
    try {
      const v = await probe(bin, ['--version'], home());
      if (!v.ok) {
        return {
          id: ID,
          available: false,
          path: bin,
          reason: `\`cursor-agent --version\` failed: ${v.text.slice(0, 200)}`,
        };
      }
      const found: DriverAvailability = {
        id: ID,
        available: true,
        path: bin,
        version: v.text.split(/\s+/)[0] || undefined,
      };
      // The options a run passes, found in the CLI's own help: an older
      // cursor-agent that lacks one would otherwise fail every run.
      const wanted = flagsOf(
        buildCursorArgs({
          prompt: '',
          cwd: '',
          permissionMode: options.permissionMode,
          model: options.model,
        })
      );
      const missing = await missingFlags(bin, ['--help'], wanted, home());
      if (missing.length > 0) {
        const who = found.version ? `Cursor's CLI ${found.version}` : "Cursor's CLI";
        return {
          ...found,
          available: false,
          reason: `${who} does not list ${missing.join(', ')} in \`cursor-agent --help\`, which OpenClerq passes to it. Update it (\`cursor-agent update\`).`,
        };
      }

      // A key from the vault stands in for the sign-in, so there is nothing to check.
      if (options.apiKey) return found;

      // The exit code of `status` is not documented, so the words decide.
      const s = await probe(bin, ['status'], home());
      if (/not (?:logged|signed) in|not authenticated|logged out/i.test(s.text)) {
        return { ...found, available: false, signedIn: false, reason: CURSOR_NOT_SIGNED_IN };
      }
      return s.ok ? { ...found, signedIn: true } : found;
    } catch (e) {
      return {
        id: ID,
        available: false,
        path: bin,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function* run(input: DriverRunInput): AsyncIterable<DriverEvent> {
    const bin = inContainer(input) ? 'cursor-agent' : find();
    if (!bin) {
      const { reason } = await detect();
      yield failed(reason ?? "Cursor's CLI was not found.");
      return;
    }
    yield* runCli({
      bin,
      args: buildCursorArgs(input),
      input,
      env: cliEnv(bin, input.env, home()),
      parser: new CursorStream(unsupported(input)),
    });
  }

  return { id: ID, detect, run };
}
