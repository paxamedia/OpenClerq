/**
 * The chat console's two jobs: talk to a model, and compare several.
 *
 * Every message is a run, so a conversation leaves the same durable trace an
 * automation does — including what each model call cost. Nothing here reaches
 * the filesystem or a tool: a raw conversation is a text channel, and the
 * policy engine has nothing to decide about it.
 */

import { chat } from '../agent/llm-provider.js';
import { recordRun, currentRunId } from '../runs.js';
import {
  addMessage,
  conversation,
  getSession,
  listMessages,
  updateSession,
  SessionError,
  type Message,
  type PipelineMode,
} from './sessions.js';
import { getStore } from '../store.js';

/** The managed pipeline, injected so this module stays free of the agent wiring. */
export type ManagedPipeline = (
  message: string,
  model?: string
) => Promise<{ explanation: string; model?: string; skillSlug?: string }>;

export interface SendInput {
  sessionId: string;
  text: string;
  /** Overrides the session's mode for this message alone. */
  mode?: PipelineMode;
  model?: string;
  onDelta?: (text: string) => void;
  managed?: ManagedPipeline;
}

export interface SendResult {
  runId: string;
  message: Message;
}

function requireText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SessionError('message text is required.');
  }
  return text;
}

/** Name an untitled conversation after its opening line. */
function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export async function sendMessage(input: SendInput): Promise<SendResult> {
  const session = getSession(input.sessionId);
  if (!session) throw new SessionError(`No session ${input.sessionId}.`);
  const text = requireText(input.text);
  const mode: PipelineMode = input.mode ?? session.mode;
  const model = input.model ?? session.model ?? undefined;

  addMessage(session.id, { role: 'user', content: text });
  if (!session.title) updateSession(session.id, { title: titleFrom(text) });

  let runId = '';
  const message = await recordRun({ trigger: 'manual', message: text }, async () => {
    runId = currentRunId() as string;

    if (mode === 'managed') {
      if (!input.managed) throw new SessionError('The managed pipeline is not available here.');
      const result = await input.managed(text, model);
      return addMessage(session.id, {
        role: 'assistant',
        content: result.explanation,
        meta: { mode, model: result.model, skillSlug: result.skillSlug, runId },
      });
    }

    // Raw: the conversation as it stands, and nothing else. No system prompt.
    const res = await chat({
      messages: conversation(session.id),
      model,
      onDelta: input.onDelta,
    });
    return addMessage(session.id, {
      role: 'assistant',
      content: res.text,
      meta: {
        mode,
        provider: res.provider,
        model: res.model,
        tokensIn: res.usage.inputTokens,
        tokensOut: res.usage.outputTokens,
        usageReported: res.usageReported,
        costUsd: res.costUsd,
        latencyMs: res.latencyMs,
        // Raw mode exists to answer "what exactly was sent?".
        request: res.request,
        runId,
      },
    });
  });

  return { runId, message };
}

export interface ComparisonColumn {
  model: string;
  provider?: string;
  text?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
  latencyMs?: number;
}

export interface CompareResult {
  runId: string;
  messageId: number;
  columns: ComparisonColumn[];
}

/**
 * Send one message to several models at once.
 *
 * A model that fails becomes a column with an error, not a failed comparison:
 * the point is to see how they differ, and "this one refused" is a result.
 */
export async function compare(input: {
  sessionId: string;
  text: string;
  models: string[];
  managed?: never;
}): Promise<CompareResult> {
  const session = getSession(input.sessionId);
  if (!session) throw new SessionError(`No session ${input.sessionId}.`);
  const text = requireText(input.text);
  if (!Array.isArray(input.models) || input.models.length < 2) {
    throw new SessionError('Comparison needs at least two models.');
  }
  if (input.models.length > 8) {
    throw new SessionError('Comparison is limited to eight models at a time.');
  }

  const history = conversation(session.id);
  addMessage(session.id, { role: 'user', content: text });
  if (!session.title) updateSession(session.id, { title: titleFrom(text) });
  const messages = [...history, { role: 'user' as const, content: text }];

  let runId = '';
  const columns = await recordRun({ trigger: 'manual', message: text }, async () => {
    runId = currentRunId() as string;
    return Promise.all(
      input.models.map(async (model): Promise<ComparisonColumn> => {
        try {
          const res = await chat({ messages, model });
          return {
            model: `${res.provider}/${res.model}`,
            provider: res.provider,
            text: res.text,
            tokensIn: res.usage.inputTokens,
            tokensOut: res.usage.outputTokens,
            costUsd: res.costUsd,
            latencyMs: res.latencyMs,
          };
        } catch (e) {
          return { model, error: e instanceof Error ? e.message : String(e) };
        }
      })
    );
  });

  // The first answer stands as the turn until a human promotes another, so the
  // conversation can continue either way.
  const chosen = columns.findIndex((c) => c.text !== undefined);
  const message = addMessage(session.id, {
    role: 'assistant',
    content: chosen === -1 ? '' : (columns[chosen].text ?? ''),
    meta: { mode: 'compare', chosen: chosen === -1 ? null : chosen, columns, runId },
  });

  return { runId, messageId: message.id, columns };
}

/** Make another column of a comparison the canonical turn. */
export function promote(sessionId: string, messageId: number, index: number): Message {
  const message = listMessages(sessionId).find((m) => m.id === messageId);
  if (!message) throw new SessionError(`No message ${messageId} in ${sessionId}.`);
  const columns = message.meta?.columns as ComparisonColumn[] | undefined;
  if (!columns) throw new SessionError('That message is not a comparison.');
  const column = columns[index];
  if (!column || column.text === undefined) {
    throw new SessionError(`Column ${index} has no answer to promote.`);
  }

  // The alternatives stay on the message; promoting chooses, it does not discard.
  getStore()
    .prepare('UPDATE messages SET content = ? WHERE id = ? AND session_id = ?')
    .run(
      JSON.stringify({ text: column.text, meta: { ...message.meta, chosen: index } }),
      messageId,
      sessionId
    );
  return { ...message, content: column.text, meta: { ...message.meta, chosen: index } };
}
