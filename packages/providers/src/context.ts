/**
 * Context management for a conversation that outgrows its model's window.
 *
 * Five pieces, each usable on its own:
 *
 *   estimateTokens     A heuristic count, used until the provider reports one.
 *   contextBudget      How many input tokens a model can take, from the
 *                      registry's context window less room for the answer.
 *   truncateOutput     Cuts a long tool result, saying in the text that it was
 *                      cut and how to get the rest.
 *   Conversation       Pinned context (system prompt, task, spec), which is
 *                      never compacted, plus a rolling history.
 *   compact / trim     Summarise older turns through the model, or drop them
 *                      when that fails, keeping the most recent rounds whole.
 *
 * Nothing here calls a model itself: compaction takes the summariser as a
 * function, so the caller decides which model pays for it and records the call.
 */

import type { ModelSpec } from './index.js';
import {
  textOf,
  type ContentBlock,
  type ConversationMessage,
  type ToolDefinition,
} from './messages.js';

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Tokens in `text`, estimated.
 *
 * The heuristic: one token per four ASCII characters, and one per character
 * outside ASCII. English prose and code run at three to four characters a
 * token in current tokenizers; Chinese, Japanese and Korean run at about one,
 * and a count by characters alone would undercount them several times over.
 * It errs high rather than low, which is the safe side for a budget. Provider
 * counts replace it whenever a call reports them; see Conversation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

/** Per message: the role and the framing every vendor adds. */
const MESSAGE_OVERHEAD = 4;

function blockTokens(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return estimateTokens(b.text);
    case 'tool_use':
      return estimateTokens(b.name) + estimateTokens(JSON.stringify(b.input ?? {})) + 8;
    case 'tool_result':
      return estimateTokens(b.content) + 8;
    case 'reasoning':
      return estimateTokens(JSON.stringify(b.data ?? ''));
  }
}

export function estimateMessageTokens(m: ConversationMessage): number {
  const body =
    typeof m.content === 'string'
      ? estimateTokens(m.content)
      : m.content.reduce((n, b) => n + blockTokens(b), 0);
  return body + MESSAGE_OVERHEAD;
}

export function estimateToolTokens(tools: ToolDefinition[]): number {
  return tools.reduce(
    (n, t) =>
      n +
      estimateTokens(t.name) +
      estimateTokens(t.description) +
      estimateTokens(JSON.stringify(t.inputSchema)),
    0
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Assumed when the registry does not say how large a model's window is. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

export interface ContextBudget {
  /** The model's context window, in tokens. */
  window: number;
  /** False when the registry gave no window and the default was assumed. */
  known: boolean;
  /** Input tokens a request may use: the window less the answer and a margin. */
  budget: number;
}

/**
 * The input a model can take. `maxOutputTokens` is reserved for the answer;
 * `margin` (default 10%) absorbs estimation error.
 */
export function contextBudget(
  model: Pick<ModelSpec, 'context'>,
  opts: { maxOutputTokens: number; margin?: number }
): ContextBudget {
  const known = typeof model.context === 'number' && model.context > 0;
  const window = known ? (model.context as number) : DEFAULT_CONTEXT_WINDOW;
  const margin = opts.margin ?? 0.1;
  const budget = Math.max(1_000, Math.floor((window - opts.maxOutputTokens) * (1 - margin)));
  return { window, known, budget };
}

// ---------------------------------------------------------------------------
// Tool-output truncation
// ---------------------------------------------------------------------------

export interface Truncated {
  text: string;
  truncated: boolean;
  /** Characters left out. */
  omitted: number;
}

/**
 * Cut `text` to about `maxChars`, keeping the start and the end (where a test
 * run's failures and a command's error usually are), with a marker in the
 * middle that tells the model what was cut. `hint` says how to get the rest,
 * e.g. "Read the file with offset 400 to see more."
 */
export function truncateOutput(
  text: string,
  opts: { maxChars: number; hint?: string; tailShare?: number }
): Truncated {
  if (text.length <= opts.maxChars) return { text, truncated: false, omitted: 0 };
  const tailShare = opts.tailShare ?? 0.3;
  const tailLen = Math.floor(opts.maxChars * tailShare);
  const headLen = Math.max(0, opts.maxChars - tailLen);
  const omitted = text.length - headLen - tailLen;
  const marker =
    `\n[… output truncated: ${omitted} of ${text.length} characters cut here.` +
    `${opts.hint ? ` ${opts.hint}` : ''}]\n`;
  return {
    text: `${text.slice(0, headLen)}${marker}${tailLen > 0 ? text.slice(text.length - tailLen) : ''}`,
    truncated: true,
    omitted,
  };
}

// ---------------------------------------------------------------------------
// Conversation: pinned context plus rolling history
// ---------------------------------------------------------------------------

export interface CompactionRecord {
  /** `summary` when the model summarised the older turns; `dropped` when they were cut. */
  method: 'summary' | 'dropped';
  /** Messages folded into the summary, or dropped. */
  compactedMessages: number;
  /** Messages kept as they were. */
  keptMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  /** The summary text, when there is one. */
  summary?: string;
  /** Why summarising failed, when it did. */
  error?: string;
}

export interface ConversationOptions {
  system: string;
  /** Turns that stay at the start, verbatim, however long the conversation runs. */
  pinned: ConversationMessage[];
  /** The input token budget, usually contextBudget(...).budget. */
  budget: number;
  tools?: ToolDefinition[];
}

/** How much of the budget the most recent turns may keep through a compaction. */
const KEEP_SHARE = 0.3;
/** Compaction is skipped unless it frees at least this share of the budget. */
const MIN_FREE_SHARE = 0.15;
/** Characters of a tool result shown to the summariser. */
const TRANSCRIPT_RESULT_CHARS = 1_500;

export const SUMMARY_PROMPT =
  'Summarise the work so far for your own later use: what was asked, what you found ' +
  '(files, functions, commands and their results), what you changed, what failed, and ' +
  'what is left to do. Keep paths, names and numbers exact. Plain text, no preamble.';

/**
 * A conversation whose start is pinned and whose history rolls.
 *
 * The token count starts from the heuristic and is replaced by the provider's
 * own count once a call reports one: `recordUsage` notes how many input tokens
 * the provider counted for the request `forRequest` returned, and later
 * estimates add the heuristic only for what has been appended since.
 */
export class Conversation {
  readonly system: string;
  readonly pinned: ConversationMessage[];
  readonly budget: number;
  private readonly tools: ToolDefinition[];
  private history: ConversationMessage[] = [];
  /** What compaction has summarised so far, carried into every later summary. */
  private summary: string | null = null;
  private summarised = 0;
  /** Messages dropped without a summary. */
  private dropped = 0;
  private sentLength = 0;
  private calibration: { length: number; tokens: number } | null = null;

  constructor(opts: ConversationOptions) {
    this.system = opts.system;
    this.pinned = opts.pinned;
    this.budget = opts.budget;
    this.tools = opts.tools ?? [];
  }

  append(message: ConversationMessage): void {
    this.history.push(message);
  }

  /** The history after the pinned turns and any context note. */
  get turns(): readonly ConversationMessage[] {
    return this.history;
  }

  /**
   * The note that stands for compacted history: the summary, and a word on
   * anything dropped. Kept apart from the history, so a later drop can never
   * throw away a summary that was paid for.
   */
  private note(): ConversationMessage | null {
    const parts: string[] = [];
    if (this.summary) {
      parts.push(
        `[Context note: ${this.summarised} earlier messages were summarised to save room. ` +
          `Re-read any file you need exact contents of.]\n\n${this.summary}`
      );
    }
    if (this.dropped > 0) {
      parts.push(
        `[Context note: ${this.dropped} earlier messages were removed to save room. ` +
          'Re-read any file you need, and check git status for what has changed so far.]'
      );
    }
    return parts.length ? { role: 'user', content: parts.join('\n\n') } : null;
  }

  /** Everything to send: pinned turns, the context note if any, then the history. */
  messages(): ConversationMessage[] {
    const note = this.note();
    return [...this.pinned, ...(note ? [note] : []), ...this.history];
  }

  /** The messages for the next request; remembers what was sent, for `recordUsage`. */
  forRequest(): ConversationMessage[] {
    this.sentLength = this.history.length;
    return this.messages();
  }

  /** The provider's count of input tokens for the last request. */
  recordUsage(inputTokens: number): void {
    if (inputTokens > 0) this.calibration = { length: this.sentLength, tokens: inputTokens };
  }

  /** The heuristic count of everything, ignoring any provider count. */
  heuristicTokens(): number {
    return (
      estimateTokens(this.system) +
      estimateToolTokens(this.tools) +
      this.messages().reduce((n, m) => n + estimateMessageTokens(m), 0)
    );
  }

  /** Input tokens the next request will use: the provider's count plus what was added since. */
  estimate(): number {
    const c = this.calibration;
    if (!c || c.length > this.history.length) return this.heuristicTokens();
    return (
      c.tokens + this.history.slice(c.length).reduce((n, m) => n + estimateMessageTokens(m), 0)
    );
  }

  /** True when the next request would use more than `share` of the budget. */
  overBudget(share = 0.85): boolean {
    return this.estimate() > this.budget * share;
  }

  /** Tokens of the pinned context alone, which no compaction can reduce. */
  pinnedTokens(): number {
    return (
      estimateTokens(this.system) +
      estimateToolTokens(this.tools) +
      this.pinned.reduce((n, m) => n + estimateMessageTokens(m), 0)
    );
  }

  /**
   * Where the history can be cut: before an assistant turn, so a tool call is
   * never separated from its result. Returns the earliest such point whose
   * tail fits in `keepTokens`, or the last one when even the final round does
   * not fit; null when there is nothing older than the latest round to fold away.
   */
  private cutPoint(keepTokens: number): number | null {
    const points: number[] = [];
    for (let i = 1; i < this.history.length; i++) {
      if (this.history[i].role === 'assistant') points.push(i);
    }
    if (points.length === 0) return null;
    const sizes = this.history.map(estimateMessageTokens);
    for (const p of points) {
      const tail = sizes.slice(p).reduce((n, x) => n + x, 0);
      if (tail <= keepTokens) return p;
    }
    return points[points.length - 1];
  }

  /**
   * Fold the older history into a summary written by `summarise`, which is
   * given the previous summary and a transcript of the turns since. The latest
   * rounds are kept as they were, minus their opaque reasoning, which a vendor
   * may refuse once the turns before it have changed. When `summarise` throws,
   * or is null, the older history is dropped instead and the previous summary
   * stays.
   *
   * Returns null, doing nothing, when there is nothing older than the latest
   * round, or when folding it away would free less than `minFreeTokens`
   * (default 15% of the budget): a conversation whose pinned task or latest
   * round alone is near the budget would otherwise pay for a summary every turn.
   */
  async compact(
    summarise: ((transcript: string) => Promise<string>) | null,
    opts: { keepTokens?: number; minFreeTokens?: number } = {}
  ): Promise<CompactionRecord | null> {
    const cut = this.cutPoint(opts.keepTokens ?? Math.floor(this.budget * KEEP_SHARE));
    if (cut === null) return null;
    const older = this.history.slice(0, cut);
    const freed = older.reduce((n, m) => n + estimateMessageTokens(m), 0);
    if (freed < (opts.minFreeTokens ?? Math.floor(this.budget * MIN_FREE_SHARE))) return null;
    const before = this.estimate();
    const kept = this.history.slice(cut).map(stripReasoning);

    let summary: string | undefined;
    let error: string | undefined;
    if (summarise) {
      try {
        const earlier = this.summary ? `EARLIER SUMMARY:\n${this.summary}\n\n` : '';
        // The summariser's own request has to fit as well.
        const transcript = truncateOutput(`${earlier}${renderTranscript(older)}`, {
          maxChars: Math.max(4_000, this.budget * 2),
          tailShare: 0.5,
        }).text;
        summary = (await summarise(transcript)).trim() || undefined;
        if (!summary) error = 'The summary came back empty.';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    if (summary) {
      this.summary = summary;
      this.summarised += older.length;
    } else {
      this.dropped += older.length;
    }
    this.history = kept;
    this.calibration = null;
    return {
      method: summary ? 'summary' : 'dropped',
      compactedMessages: older.length,
      keptMessages: kept.length,
      tokensBefore: before,
      tokensAfter: this.estimate(),
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Drop the older history without a summary: the rolling fallback when the
   * request would not fit otherwise. Any earlier summary is kept.
   */
  trim(
    opts: { keepTokens?: number; minFreeTokens?: number } = {}
  ): Promise<CompactionRecord | null> {
    return this.compact(null, { minFreeTokens: 0, ...opts });
  }
}

function stripReasoning(m: ConversationMessage): ConversationMessage {
  if (typeof m.content === 'string') return m;
  const content = m.content.filter((b) => b.type !== 'reasoning');
  return { ...m, content: content.length ? content : [{ type: 'text', text: '(no text)' }] };
}

/** The history as plain text, for the summariser. */
export function renderTranscript(messages: ConversationMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      lines.push(`${m.role.toUpperCase()}: ${m.content}`);
      continue;
    }
    const text = textOf(m.content);
    if (text) lines.push(`${m.role.toUpperCase()}: ${text}`);
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        lines.push(
          `TOOL CALL ${b.name}: ${truncateOutput(JSON.stringify(b.input ?? {}), { maxChars: 500 }).text}`
        );
      } else if (b.type === 'tool_result') {
        const body = truncateOutput(b.content, { maxChars: TRANSCRIPT_RESULT_CHARS }).text;
        lines.push(`TOOL RESULT${b.isError ? ' (error)' : ''}: ${body}`);
      }
    }
  }
  return lines.join('\n');
}
