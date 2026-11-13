/**
 * The codex driver: OpenAI's Codex CLI, run non-interactively with
 * `codex exec --json`.
 *
 * The agent runs under the user's own sign-in (ChatGPT or an API key stored by
 * `codex login`). Nothing here passes CODEX_API_KEY unless the caller supplies
 * one as a secret.
 *
 * What the CLI offers, and what that means for a run:
 *   - Isolation is Codex's own sandbox, chosen with `--sandbox`. Edits are
 *     confined to the workspace. Codex keeps the network off in that mode, but
 *     OpenClerq's default is full access, and an agent that cannot install
 *     packages or fetch what a test needs is of little use; so the driver
 *     turns it on (`sandbox_workspace_write.network_access`) unless the caller
 *     asks for no network. The user's ~/.codex/config.toml is read as usual.
 *   - There is no spend limit and no cost in the output, only token counts. A
 *     run's cost is therefore unknown (null) and `maxBudgetUsd` cannot be
 *     passed; the run's time limit is the bound.
 *   - There is no tool allowlist; `allowedTools` cannot be passed.
 *
 * The JSONL event shapes follow OpenAI's exec_events reference
 * (thread.started, turn.started, item.started | updated | completed,
 * turn.completed, turn.failed, error). The parser ignores fields and items it
 * does not know, so a newer CLI that adds more still parses.
 */

import type { ExecResult } from '@clerq/sandbox';
import { capped, cliEnv, failed, num, probe, runCli } from './cli.js';
import { locate } from './locate.js';
import type {
  DetectOptions,
  Driver,
  DriverAvailability,
  DriverEvent,
  DriverResult,
  DriverRunInput,
} from './types.js';

const ID = 'codex';

export interface CodexOptions {
  /** Path to the CLI. Defaults to CLERQ_CODEX_BIN, then `codex` found on PATH. */
  bin?: string;
}

export const CODEX_NOT_SIGNED_IN =
  'Codex is not signed in on this machine. Run `codex login` in a terminal, or store an API key in the vault and name it in agent.api_key_secret.';

/** Codex's sandbox for each permission mode. Never the unrestricted one. */
function sandboxFor(mode: DriverRunInput['permissionMode']): 'read-only' | 'workspace-write' {
  // `acceptEdits` is the only mode that lets the agent change files. The rest
  // either ask first (which an unattended run cannot answer), plan, or allow
  // nothing beyond what was granted, and Codex's read-only sandbox is the
  // nearest of its three.
  return (mode ?? 'acceptEdits') === 'acceptEdits' ? 'workspace-write' : 'read-only';
}

/**
 * The command line for one run. The prompt comes after `--`, so a prompt that
 * starts with a dash is not read as an option.
 *
 * `--skip-git-repo-check` is safe here: the caller prepared the workspace, a
 * git worktree, and Codex's check exists to stop it starting in a directory
 * nobody chose. `--ephemeral` keeps an unattended run from leaving session
 * files behind.
 */
export function buildCodexArgs(input: DriverRunInput): string[] {
  const sandbox = sandboxFor(input.permissionMode);
  const args = [
    'exec',
    '--json',
    '--sandbox',
    sandbox,
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
  ];
  // Only workspace-write has a network setting; read-only has none to give.
  if (sandbox === 'workspace-write') {
    args.push(
      '--config',
      `sandbox_workspace_write.network_access=${input.sandbox?.network !== 'none'}`
    );
  }
  if (input.model) args.push('--model', input.model);
  args.push('--', input.prompt);
  return args;
}

/** What the caller asked for that this CLI cannot do, said once per run. */
function unsupported(input: DriverRunInput): string[] {
  const notes: string[] = [];
  if (input.maxBudgetUsd !== undefined) {
    notes.push('Codex has no spend limit, so the budget was not passed; the time limit applies.');
  }
  if (input.allowedTools?.length) {
    notes.push('Codex takes no tool list, so allowed tools were not passed; its sandbox applies.');
  }
  return notes;
}

const NOT_SIGNED_IN =
  /not (?:logged|signed) in|please (?:log|sign) in|run `?codex login|no (?:auth|credentials)|401 unauthorized|invalid(?: or missing)? api key|incorrect api key|missing bearer/i;

interface Item {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown[]; structured_content?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
  message?: string;
  prompt?: string | null;
}

function failedStatus(status: string | undefined): boolean {
  return status === 'failed' || status === 'declined';
}

/** Turns `codex exec --json` lines into driver events, and remembers how the run ended. */
export class CodexStream {
  private started = false;
  private called = new Set<string>();
  private lastMessage = '';
  private tokensIn = 0;
  private tokensOut = 0;
  private turns = 0;
  private completedTurn = false;
  private failure: string | null = null;
  private errors: string[] = [];
  private denials: Array<{ tool: string; input?: unknown }> = [];
  private stderrTail: string[] = [];

  constructor(
    private readonly model?: string,
    private readonly notes: string[] = []
  ) {}

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

    const events: DriverEvent[] = [];
    if (!this.started) {
      this.started = true;
      // Codex does not say which model it chose, only what it was asked for.
      events.push({ type: 'started', model: this.model });
    }

    switch (msg.type) {
      case 'item.started':
      case 'item.completed':
        events.push(...this.item(msg.type === 'item.completed', msg.item as Item | undefined));
        break;
      case 'turn.completed': {
        this.turns += 1;
        this.completedTurn = true;
        const usage = (msg.usage ?? {}) as Record<string, unknown>;
        // OpenAI counts cached input tokens inside input_tokens, so they are
        // not added again.
        this.tokensIn += num(usage.input_tokens);
        this.tokensOut += num(usage.output_tokens);
        break;
      }
      case 'turn.failed': {
        const error = msg.error as { message?: unknown } | undefined;
        this.completedTurn = false;
        this.failure = typeof error?.message === 'string' ? error.message : 'The turn failed.';
        break;
      }
      case 'error':
        // Not always fatal: Codex reports a dropped connection it is retrying.
        if (typeof msg.message === 'string') {
          this.errors.push(msg.message);
          events.push({ type: 'log', stream: 'stderr', line: msg.message });
        }
        break;
      default:
        break;
    }
    return events;
  }

  private call(id: string, name: string, input: unknown): DriverEvent[] {
    if (this.called.has(id)) return [];
    this.called.add(id);
    return [{ type: 'tool_call', id, name, input }];
  }

  private item(completed: boolean, item: Item | undefined): DriverEvent[] {
    if (!item || typeof item !== 'object') return [];
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'agent_message':
        if (!completed || typeof item.text !== 'string' || !item.text.trim()) return [];
        this.lastMessage = item.text;
        return [{ type: 'text', text: item.text }];

      case 'command_execution': {
        const events = this.call(id, 'Bash', { command: item.command ?? '' });
        if (!completed) return events;
        const code = typeof item.exit_code === 'number' ? item.exit_code : null;
        if (item.status === 'declined') {
          this.denials.push({ tool: 'Bash', input: { command: item.command ?? '' } });
        }
        const output = String(item.aggregated_output ?? '');
        events.push({
          type: 'tool_result',
          id,
          output: capped(code !== null && code !== 0 ? `${output}\n[exit ${code}]`.trim() : output),
          isError: failedStatus(item.status) || (code !== null && code !== 0),
        });
        return events;
      }

      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const events = this.call(id, 'Edit', { changes });
        if (!completed) return events;
        events.push({
          type: 'tool_result',
          id,
          output: changes.map((c) => `${c.kind ?? 'change'} ${c.path ?? ''}`.trim()).join('\n'),
          isError: failedStatus(item.status),
        });
        return events;
      }

      case 'mcp_tool_call': {
        const events = this.call(
          id,
          `mcp__${item.server ?? 'server'}__${item.tool ?? 'tool'}`,
          item.arguments ?? {}
        );
        if (!completed) return events;
        const text = item.error?.message ?? mcpText(item.result);
        events.push({
          type: 'tool_result',
          id,
          output: capped(text),
          isError: failedStatus(item.status) || Boolean(item.error),
        });
        return events;
      }

      case 'web_search': {
        const events = this.call(id, 'WebSearch', { query: item.query ?? '' });
        if (completed) events.push({ type: 'tool_result', id, output: '', isError: false });
        return events;
      }

      case 'collab_tool_call': {
        const events = this.call(id, `collab__${item.tool ?? 'call'}`, { prompt: item.prompt });
        if (completed) {
          events.push({ type: 'tool_result', id, output: '', isError: failedStatus(item.status) });
        }
        return events;
      }

      case 'error':
        // An item-level error is a message to the user, not the end of the run.
        return completed && typeof item.message === 'string'
          ? [{ type: 'log', stream: 'stderr', line: item.message }]
          : [];

      default:
        // reasoning and todo_list carry nothing a run view shows.
        return [];
    }
  }

  /** The outcome, from what the stream said and how the process ended. */
  finish(run: ExecResult): DriverResult {
    const base = {
      costUsd: null,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      turns: this.turns || undefined,
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

    const reason = this.failure ?? this.errors[this.errors.length - 1] ?? '';
    const evidence = [reason, ...this.stderrTail];
    if (!this.completedTurn && evidence.some((l) => NOT_SIGNED_IN.test(l))) {
      return { ...base, ok: false, summary: CODEX_NOT_SIGNED_IN };
    }

    // A failed turn can still exit 0, so the stream decides, not the exit code.
    if (this.failure !== null || !this.completedTurn || run.code !== 0) {
      if (reason) return { ...base, ok: false, summary: `Codex stopped: ${reason}` };
      const tail = this.stderrTail.slice(-5).join('\n');
      return {
        ...base,
        ok: false,
        summary: `codex exited with code ${run.code ?? 'none'} before finishing the turn.${
          tail ? `\n${tail}` : ''
        }`,
      };
    }

    return { ...base, ok: true, summary: this.lastMessage.trim() || 'Finished.' };
  }
}

function mcpText(result: Item['result']): string {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return result?.structured_content === undefined || result.structured_content === null
      ? ''
      : JSON.stringify(result.structured_content);
  }
  return content
    .map((c) =>
      c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''
    )
    .filter(Boolean)
    .join('\n');
}

export function codex(options: CodexOptions = {}): Driver {
  const configured = options.bin ?? process.env.CLERQ_CODEX_BIN;
  const find = () => configured || locate('codex');
  /** Where the CLI keeps its sign-in, when the user moved it. */
  const home = (): Record<string, string> =>
    process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {};

  async function detect(options: DetectOptions = {}): Promise<DriverAvailability> {
    const bin = find();
    if (!bin) {
      return {
        id: ID,
        available: false,
        reason:
          'Codex was not found. Install it (`npm install -g @openai/codex`) and sign in with `codex login`, or set CLERQ_CODEX_BIN to its path.',
      };
    }
    try {
      const v = await probe(bin, ['--version'], home());
      if (!v.ok) {
        return {
          id: ID,
          available: false,
          path: bin,
          reason: `\`codex --version\` failed: ${v.text.slice(0, 200)}`,
        };
      }
      const found: DriverAvailability = {
        id: ID,
        available: true,
        path: bin,
        version: /\d+\.\d+\.\d+\S*/.exec(v.text)?.[0],
      };
      // A key from the vault stands in for the sign-in, so there is nothing to check.
      if (options.apiKey) return found;

      // `codex login status` exits 0 when signed in. A CLI too old to have it
      // answers with a usage error, which says nothing about the account.
      const s = await probe(bin, ['login', 'status'], home());
      if (s.ok) return { ...found, signedIn: true };
      if (/not (?:logged|signed) in|logged out/i.test(s.text)) {
        return { ...found, available: false, signedIn: false, reason: CODEX_NOT_SIGNED_IN };
      }
      return found;
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
    const bin = find();
    if (!bin) {
      const { reason } = await detect();
      yield failed(reason ?? 'Codex was not found.');
      return;
    }
    yield* runCli({
      bin,
      args: buildCodexArgs(input),
      input,
      env: cliEnv(bin, input.env, home()),
      parser: new CodexStream(input.model, unsupported(input)),
    });
  }

  return { id: ID, detect, run };
}
