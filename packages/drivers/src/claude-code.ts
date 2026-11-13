/**
 * The claude-code driver: Claude Code's CLI in print mode, streaming JSON.
 *
 * The agent runs under the user's own Claude login or subscription. Nothing
 * here passes ANTHROPIC_API_KEY unless the caller supplies one as a secret:
 * Claude Code prefers an API key over a signed-in subscription, so inheriting
 * one by accident would move the user's runs onto API billing.
 */

import type { ExecResult } from '@clerq/sandbox';
import {
  apiErrorIn,
  capped,
  cliEnv,
  containerAvailability,
  failed,
  inContainer,
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

const ID = 'claude-code';

export interface ClaudeCodeOptions {
  /** Path to the CLI. Defaults to CLERQ_CLAUDE_BIN, then `claude` found on PATH. */
  bin?: string;
}

/**
 * The command line for one run. The prompt comes after `--`, so a prompt that
 * starts with a dash is not read as an option.
 */
export function buildClaudeArgs(input: DriverRunInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    input.permissionMode ?? 'acceptEdits',
  ];
  if (input.model) args.push('--model', input.model);
  if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd));
  if (input.allowedTools?.length) args.push('--allowedTools', ...input.allowedTools);
  args.push('--', input.prompt);
  return args;
}

interface ResultLine {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
  permission_denials?: Array<{ tool_name?: string; tool_input?: unknown }>;
}

const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key/i;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** Turns stream-json lines into driver events, and remembers how the run ended. */
export class ClaudeStream {
  private result: ResultLine | null = null;
  private stderrTail: string[] = [];

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

    switch (msg.type) {
      case 'system':
        if (msg.subtype !== 'init') return [];
        return [
          {
            type: 'started',
            model: typeof msg.model === 'string' ? msg.model : undefined,
            tools: Array.isArray(msg.tools) ? msg.tools.map(String) : undefined,
          },
        ];
      case 'assistant': {
        const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
        const events: DriverEvent[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            events.push({ type: 'text', text: block.text });
          } else if (block?.type === 'tool_use') {
            events.push({
              type: 'tool_call',
              id: String(block.id ?? ''),
              name: String(block.name ?? 'unknown'),
              input: block.input,
            });
          }
        }
        return events;
      }
      case 'user': {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return [];
        return (content as Array<Record<string, unknown>>)
          .filter((block) => block?.type === 'tool_result')
          .map((block) => ({
            type: 'tool_result' as const,
            id: String(block.tool_use_id ?? ''),
            output: capped(textOf(block.content)),
            isError: block.is_error === true,
          }));
      }
      case 'result':
        this.result = msg as ResultLine;
        return [];
      default:
        return [];
    }
  }

  /** The outcome, from the result line if the CLI got as far as writing one. */
  finish(run: ExecResult): DriverResult {
    const r = this.result;
    const usage = r?.usage ?? {};
    const base = {
      costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
      tokensIn:
        num(usage.input_tokens) +
        num(usage.cache_creation_input_tokens) +
        num(usage.cache_read_input_tokens),
      tokensOut: num(usage.output_tokens),
      turns: typeof r?.num_turns === 'number' ? r.num_turns : undefined,
      durationMs: run.durationMs,
      exitCode: run.code,
      timedOut: run.timedOut,
      cancelled: run.cancelled,
      permissionDenials: (r?.permission_denials ?? []).map((d) => ({
        tool: String(d.tool_name ?? 'unknown'),
        input: d.tool_input,
      })),
      warnings: run.warnings,
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
    if (NOT_SIGNED_IN.test(text) || this.stderrTail.some((l) => NOT_SIGNED_IN.test(l))) {
      return {
        ...base,
        ok: false,
        summary:
          'Claude Code is not signed in on this machine. Run `claude` in a terminal, sign in, and try again.',
      };
    }

    if (!r) {
      const tail = this.stderrTail.slice(-5).join('\n');
      return {
        ...base,
        ok: false,
        crashed: true,
        ...(apiErrorIn(this.stderrTail) ? { apiError: apiErrorIn(this.stderrTail) } : {}),
        summary: `claude exited with code ${run.code ?? 'none'} before reporting a result.${
          tail ? `\n${tail}` : ''
        }`,
      };
    }

    if (r.is_error || run.code !== 0) {
      const why =
        r.subtype && r.subtype.startsWith('error_')
          ? `Stopped: ${r.subtype.slice('error_'.length).replace(/_/g, ' ')}.`
          : 'The agent reported an error.';
      // A limit the CLI enforced (error_max_turns, error_max_budget_usd) is
      // never an API error, whatever the agent wrote. Otherwise only the CLI's
      // own "API Error: …" line, or its stderr, says the provider failed.
      const limit = r.subtype?.startsWith('error_max') ?? false;
      const apiError = limit
        ? undefined
        : /^API Error\b/.test(text)
          ? text.split('\n')[0].slice(0, 500)
          : apiErrorIn(this.stderrTail);
      return {
        ...base,
        ok: false,
        summary: text ? `${why} ${text}` : why,
        ...(apiError ? { apiError } : {}),
      };
    }

    return { ...base, ok: true, summary: text || 'Finished.' };
  }
}

export function claudeCode(options: ClaudeCodeOptions = {}): Driver {
  const configured = options.bin ?? process.env.CLERQ_CLAUDE_BIN;
  const find = () => configured || locate('claude');

  async function detect(options: DetectOptions = {}): Promise<DriverAvailability> {
    if (options.inContainer) return containerAvailability(ID, 'claude');
    const bin = find();
    if (!bin) {
      return {
        id: ID,
        available: false,
        reason:
          'Claude Code was not found. Install it and sign in, or set CLERQ_CLAUDE_BIN to its path.',
      };
    }
    try {
      const r = await probe(bin, ['--version']);
      if (!r.ok) {
        return {
          id: ID,
          available: false,
          path: bin,
          reason: `\`claude --version\` failed: ${r.text.slice(0, 200)}`,
        };
      }
      return { id: ID, available: true, path: bin, version: r.text.split(/\s+/)[0] };
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
    const bin = inContainer(input) ? 'claude' : find();
    if (!bin) {
      const { reason } = await detect();
      yield failed(reason ?? 'Claude Code was not found.');
      return;
    }

    const extra: Record<string, string> = {
      // An unattended run should not update the CLI under itself.
      DISABLE_AUTOUPDATER: '1',
    };
    if (process.env.CLAUDE_CONFIG_DIR) extra.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    // Under an egress allowlist, telemetry and error reporting would only be
    // refused at the proxy: the CLI is asked not to try.
    if (Array.isArray(input.sandbox?.network) || input.sandbox?.network === 'none') {
      extra.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    }

    yield* runCli({
      bin,
      args: buildClaudeArgs(input),
      input,
      env: cliEnv(bin, input.env, extra),
      parser: new ClaudeStream(),
    });
  }

  return { id: ID, detect, run };
}
