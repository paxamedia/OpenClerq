/**
 * Conversations with tools, in one shape for every adapter.
 *
 * A caller builds the conversation from these types and never sees a vendor's
 * wire format. The adapters translate both ways:
 *
 *   anthropic       `tools[].input_schema`; `tool_use` blocks in the assistant
 *                   turn; `tool_result` blocks in the next user turn; streamed
 *                   tool input arrives as `input_json_delta` fragments.
 *   openai-compat   `tools[].function.parameters`; `message.tool_calls` with
 *                   arguments as a JSON string; one `role: "tool"` message per
 *                   result; streamed calls arrive as `delta.tool_calls[index]`
 *                   fragments.
 *
 * Reasoning a model returns alongside its answer (Anthropic `thinking` blocks
 * with their signatures, the `reasoning_content` some OpenAI-compatible servers
 * send) is kept opaque and handed back unchanged to the adapter that produced
 * it. Anthropic rejects a tool turn whose thinking was edited or dropped; a
 * different adapter never receives it.
 */

import type { AdapterKind } from './index.js';

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolDefinition {
  /** Letters, digits, `_` and `-`, at most 64 characters: both vendors' rule. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** Opaque model output, replayed unchanged to the adapter that produced it. */
  | { type: 'reasoning'; adapter: AdapterKind; data: unknown };

/** One turn. Plain text, or blocks when the turn carries tool calls or results. */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** A tool call the model made, with its input parsed. */
export interface ToolCall {
  id: string;
  name: string;
  /** The parsed input. `{}` when it could not be parsed; see `inputError`. */
  input: unknown;
  /** Set when the model's input was not valid JSON: the raw text, for the error result. */
  inputError?: string;
}

/**
 * Why the model stopped, normalised.
 *
 *   end_turn    finished its answer
 *   tool_use    wants its tool calls run
 *   max_tokens  hit the output limit (or the context window); the turn is incomplete
 *   refusal     declined, or a content filter stopped it
 *   other       anything else; `rawStopReason` says what
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** The text of a turn, whatever its shape. */
export function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function anthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function openAiTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** Messages API turns. A string turn stays a string, as before tools existed. */
export function anthropicMessages(messages: ConversationMessage[]): unknown[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const content: unknown[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          // The API refuses an empty text block.
          if (b.text) content.push({ type: 'text', text: b.text });
          break;
        case 'tool_use':
          content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          });
          break;
        case 'reasoning':
          if (b.adapter === 'anthropic') content.push(b.data);
          break;
      }
    }
    return { role: m.role, content };
  });
}

/**
 * Chat-completions messages. A user turn's tool results become one
 * `role: "tool"` message each, ahead of any text in that turn; an assistant
 * turn's tool calls go in `tool_calls`, with arguments as a JSON string.
 */
export function openAiMessages(messages: ConversationMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = textOf(m.content);
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        }
      }
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    const calls = m.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
    );
    const reasoning = m.content.find(
      (b): b is Extract<ContentBlock, { type: 'reasoning' }> =>
        b.type === 'reasoning' && b.adapter === 'openai-compat'
    );
    out.push({
      role: 'assistant',
      // What the vendor's own response carries when the turn is only tool calls.
      content: text || (calls.length ? null : ''),
      ...(calls.length
        ? {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
            })),
          }
        : {}),
      ...(reasoning ? (reasoning.data as Record<string, unknown>) : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ParsedTurn {
  content: ContentBlock[];
  toolCalls: ToolCall[];
  stopReason: StopReason;
  rawStopReason?: string;
}

/** Parse a tool call's JSON input, keeping the raw text when it does not parse. */
export function parseToolInput(raw: string): { input: unknown; inputError?: string } {
  if (!raw.trim()) return { input: {} };
  try {
    const input = JSON.parse(raw) as unknown;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { input: {}, inputError: raw };
    }
    return { input };
  } catch {
    return { input: {}, inputError: raw };
  }
}

function toolCallsOf(content: ContentBlock[], errors: Map<string, string>): ToolCall[] {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input,
      ...(errors.has(b.id) ? { inputError: errors.get(b.id) } : {}),
    }));
}

export function anthropicStop(raw: string | undefined): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return raw === undefined ? 'end_turn' : 'other';
  }
}

export function openAiStop(raw: string | undefined | null): StopReason {
  switch (raw) {
    case 'stop':
    case null:
    case undefined:
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/**
 * Some servers end a turn that called tools with "stop". A turn with tool calls
 * is a tool turn unless it was cut off or refused.
 */
function settle(stop: StopReason, toolCalls: ToolCall[]): StopReason {
  return toolCalls.length > 0 && (stop === 'end_turn' || stop === 'other') ? 'tool_use' : stop;
}

/** An Anthropic message's content, as blocks. */
export function anthropicTurn(data: {
  content?: Array<Record<string, unknown>>;
  stop_reason?: string;
}): ParsedTurn {
  const content: ContentBlock[] = [];
  for (const b of data.content ?? []) {
    if (b.type === 'text') {
      if (typeof b.text === 'string' && b.text) content.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        input: b.input && typeof b.input === 'object' ? b.input : {},
      });
    } else {
      // thinking, redacted_thinking, and anything newer: replayed as received.
      content.push({ type: 'reasoning', adapter: 'anthropic', data: b });
    }
  }
  const toolCalls = toolCallsOf(content, new Map());
  return {
    content,
    toolCalls,
    stopReason: settle(anthropicStop(data.stop_reason), toolCalls),
    rawStopReason: data.stop_reason,
  };
}

/** A chat-completions choice's message, as blocks. */
export function openAiTurn(choice: {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
}): ParsedTurn {
  const message = choice.message ?? {};
  return openAiAssembled(
    {
      text: message.content ?? '',
      reasoning: message.reasoning_content ?? '',
      calls: (message.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? '',
        args: c.function?.arguments ?? '',
      })),
    },
    choice.finish_reason
  );
}

function openAiAssembled(
  parts: {
    text: string;
    reasoning: string;
    calls: Array<{ id: string; name: string; args: string }>;
  },
  finish: string | null | undefined
): ParsedTurn {
  const content: ContentBlock[] = [];
  if (parts.reasoning) {
    content.push({
      type: 'reasoning',
      adapter: 'openai-compat',
      data: { reasoning_content: parts.reasoning },
    });
  }
  if (parts.text) content.push({ type: 'text', text: parts.text });
  const errors = new Map<string, string>();
  for (const c of parts.calls) {
    const parsed = parseToolInput(c.args);
    if (parsed.inputError !== undefined) errors.set(c.id, parsed.inputError);
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: parsed.input });
  }
  const toolCalls = toolCallsOf(content, errors);
  return {
    content,
    toolCalls,
    stopReason: settle(openAiStop(finish), toolCalls),
    rawStopReason: finish ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * Builds the assistant turn from Messages API stream events. Blocks are keyed
 * by their index; tool input and thinking signatures arrive in fragments.
 */
export class AnthropicTurnBuilder {
  private readonly blocks = new Map<number, Record<string, unknown>>();
  private readonly json = new Map<number, string>();
  private stop: string | undefined;

  /** Returns the text delta, if the event carried one. */
  consume(event: Record<string, unknown>): string | undefined {
    const index = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start') {
      const block = { ...((event.content_block as Record<string, unknown>) ?? {}) };
      this.blocks.set(index, block);
      if (block.type === 'tool_use') this.json.set(index, '');
      return undefined;
    }
    if (event.type === 'content_block_delta') {
      const delta = (event.delta as Record<string, unknown>) ?? {};
      const block = this.blocks.get(index) ?? { type: 'text', text: '' };
      this.blocks.set(index, block);
      switch (delta.type) {
        case 'text_delta':
          block.text = `${String(block.text ?? '')}${String(delta.text ?? '')}`;
          return String(delta.text ?? '');
        case 'input_json_delta':
          this.json.set(index, `${this.json.get(index) ?? ''}${String(delta.partial_json ?? '')}`);
          return undefined;
        case 'thinking_delta':
          block.thinking = `${String(block.thinking ?? '')}${String(delta.thinking ?? '')}`;
          return undefined;
        case 'signature_delta':
          block.signature = `${String(block.signature ?? '')}${String(delta.signature ?? '')}`;
          return undefined;
        default:
          return undefined;
      }
    }
    if (event.type === 'message_delta') {
      const delta = event.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) this.stop = delta.stop_reason;
    }
    return undefined;
  }

  finish(): ParsedTurn {
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);
    const errors = new Map<string, string>();
    const raw = ordered.map(([index, block]) => {
      if (block.type !== 'tool_use') return block;
      // Parsed strictly: a fragment list cut short must not become a partial input.
      const parsed = parseToolInput(this.json.get(index) ?? '');
      if (parsed.inputError !== undefined) errors.set(String(block.id ?? ''), parsed.inputError);
      return { ...block, input: parsed.input };
    });
    const turn = anthropicTurn({ content: raw, stop_reason: this.stop });
    const toolCalls = toolCallsOf(turn.content, errors);
    return { ...turn, toolCalls };
  }
}

/** Builds the assistant turn from chat-completions stream chunks. */
export class OpenAiTurnBuilder {
  private text = '';
  private reasoning = '';
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finishReason: string | null | undefined;

  consume(event: Record<string, unknown>): string | undefined {
    const choice = (
      event.choices as
        | Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>
        | undefined
    )?.[0];
    if (!choice) return undefined;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content) this.reasoning += delta.reasoning_content;
    for (const [i, c] of (delta.tool_calls ?? []).entries()) {
      const index = c.index ?? i;
      const call = this.calls.get(index) ?? { id: '', name: '', args: '' };
      if (c.id) call.id = c.id;
      if (c.function?.name) call.name += c.function.name;
      if (c.function?.arguments) call.args += c.function.arguments;
      this.calls.set(index, call);
    }
    if (delta.content) {
      this.text += delta.content;
      return delta.content;
    }
    return undefined;
  }

  finish(): ParsedTurn {
    return openAiAssembled(
      {
        text: this.text,
        reasoning: this.reasoning,
        calls: [...this.calls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, c]) => ({ ...c, id: c.id || `call_${index}` })),
      },
      this.finishReason
    );
  }
}
